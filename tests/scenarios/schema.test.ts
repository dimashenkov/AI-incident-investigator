/**
 * Every test here is written against a specific way the system could lie.
 * "Valid object passes" is worth one test; the rest are objects that a real
 * agent could plausibly emit and that must be refused.
 */
import { describe, it, expect } from "vitest";
import { validate } from "../../src/schema/validate.js";

const OK_CONVERSATION = {
  provider: "fake-slack",
  channel_id: "fake-prod-incidents",
  thread_id: "thread-INC-2026-0001",
  incident_id: "INC-2026-0001",
  messages: [],
};

const OK_INCIDENT = {
  incident_id: "INC-2026-0001",
  status: "investigating",
  service: "payment-api",
  namespace: "production",
  cluster: "prod-eu",
  started_at: "2026-09-04T10:30:00Z",
  source: { provider: "fake-datadog", alert: { id: "alert-1", title: "High memory on payment-api", triggered_at: "2026-09-04T10:29:00Z" } },
  observations: { kubernetes: null, logs: null, metrics: null },
  // Three answers per slot, recorded in the document. Everything here is a
  // deliberate "the provider said there was nothing", not a slot nobody read.
  collection: { kubernetes: { state: "nothing" }, logs: { state: "nothing" }, metrics: { state: "nothing" } },
  analysis: { agents: [], root_cause_code: null, root_cause: null, confidence: null, evidence: [] },
  remediation: { recommended_actions: [] },
  conversation: OK_CONVERSATION,
};

/*
 * A refusal has to be the refusal the test is named for.
 *
 * Codex, 2026-09-05: "refuses status error with findings attached" kept a
 * non-empty hypotheses list and a confidence of 0.9, so the object was invalid
 * for two unrelated reasons — delete the rule the test is about and it still
 * passes. Naming the error makes the assertion about this test.
 */
function expectInvalid(name: Parameters<typeof validate>[0], data: unknown, names: string) {
  const r = validate(name, data);
  expect(r.state, `expected invalid, got ${JSON.stringify(r)}`).toBe("invalid");
  if (r.state !== "invalid") return;
  const said = r.errors.join(" ;; ");
  expect(said, `refused, but for something other than ${names}`).toContain(names);
}

describe("the validator itself", () => {
  it("reports unchecked, not valid, for a schema it does not have", () => {
    // The dangerous failure is a typo'd schema name reading as a clean pass.
    const r = validate("incidnet" as never, {});
    expect(r.state).toBe("unchecked");
  });

  it("accepts a well-formed incident", () => {
    expect(validate("incident", OK_INCIDENT).state).toBe("valid");
  });
});

describe("incident: absence is not consent", () => {
  it("refuses an incident with observations missing entirely", () => {
    const { observations, ...rest } = OK_INCIDENT;
    expectInvalid("incident", rest, "required property 'observations'");
  });

  it("refuses an observation key that is simply absent rather than null", () => {
    // A missing key and an explicit null are different claims: "never collected"
    // versus "collected, found nothing". Only the second may be silent.
    expectInvalid("incident", {
      ...OK_INCIDENT,
      observations: { kubernetes: null, logs: null },
    }, "/observations must have required property 'metrics'");
  });

  it("refuses an unknown top-level field, so a typo cannot ride along unread", () => {
    expectInvalid("incident", { ...OK_INCIDENT, rootcause: "CONTAINER_OOM" }, "must NOT have additional properties");
  });
});

describe("incident: a diagnosis must carry its evidence", () => {
  it("refuses status diagnosed with no root cause code", () => {
    expectInvalid("incident", { ...OK_INCIDENT, status: "diagnosed" }, "/analysis/root_cause_code must be string");
  });

  it("refuses status diagnosed with a code but zero evidence", () => {
    expectInvalid("incident", {
      ...OK_INCIDENT,
      status: "diagnosed",
      analysis: {
        agents: [],
        root_cause_code: "CONTAINER_OOM",
        root_cause: "Container exceeded its memory limit",
        confidence: 0.94,
        evidence: [],
      },
    }, "/analysis/evidence must NOT have fewer than 1 items");
  });

  it("refuses diagnosed carrying INSUFFICIENT_EVIDENCE as its code", () => {
    // Otherwise "we could not tell" gets reported through the same door as a finding.
    expectInvalid("incident", {
      ...OK_INCIDENT,
      status: "diagnosed",
      analysis: {
        agents: [],
        root_cause_code: "INSUFFICIENT_EVIDENCE",
        root_cause: "unclear",
        confidence: 0.2,
        evidence: [{ source: "kubernetes", fact: "something" }],
      },
    }, "/analysis/root_cause_code must NOT be valid");
  });

  it("refuses status insufficient_evidence that names a real cause anyway", () => {
    expectInvalid("incident", {
      ...OK_INCIDENT,
      status: "insufficient_evidence",
      analysis: {
        agents: [],
        root_cause_code: "CONTAINER_OOM",
        root_cause: "OOM",
        confidence: 0.9,
        evidence: [],
      },
    }, "/analysis/root_cause_code must be equal to constant");
  });

  it("refuses a confidence above 1", () => {
    expectInvalid("incident", {
      ...OK_INCIDENT,
      analysis: { ...OK_INCIDENT.analysis, confidence: 1.4 },
    }, "/analysis/confidence must be <= 1");
  });
});

describe("agent-result: an error must not smuggle findings", () => {
  const OK_AGENT = {
    agent: "kubernetes",
    status: "ok",
    findings: [{ fact: "container terminated OOMKilled", source_ref: "pods[0].lastState.terminated.reason" }],
    hypotheses: [
      { code: "CONTAINER_OOM", statement: "memory limit exceeded", supported_by: ["pods[0].lastState.terminated.reason"] },
    ],
    confidence: 0.9,
  };

  it("accepts a well-formed agent result", () => {
    expect(validate("agent-result", OK_AGENT).state).toBe("valid");
  });

  it("refuses status error with findings attached", () => {
    expectInvalid("agent-result", { ...OK_AGENT, status: "error", error: "timeout" }, "/findings must NOT have more than 0 items");
  });

  it("refuses status error with no error text", () => {
    expectInvalid("agent-result", { ...OK_AGENT, status: "error", findings: [], hypotheses: [], confidence: 0 }, "required property 'error'");
  });

  it("refuses status no_data that reports findings anyway", () => {
    expectInvalid("agent-result", { ...OK_AGENT, status: "no_data", hypotheses: [], confidence: 0 }, "/findings must NOT have more than 0 items");
  });

  it("refuses a finding with no source_ref", () => {
    // A fact nobody can trace back to an observation is an opinion.
    expectInvalid("agent-result", { ...OK_AGENT, findings: [{ fact: "looks like OOM" }] }, "/findings/0 must have required property 'source_ref'");
  });

  it("refuses a hypothesis supported by nothing", () => {
    expectInvalid("agent-result", {
      ...OK_AGENT,
      hypotheses: [{ code: "CONTAINER_OOM", statement: "memory", supported_by: [] }],
    }, "/hypotheses/0/supported_by must NOT have fewer than 1 items");
  });

  it("refuses hypotheses with no findings behind them", () => {
    expectInvalid("agent-result", { ...OK_AGENT, findings: [] }, "/findings must NOT have fewer than 1 items");
  });
});

describe("conversation: a thread belongs to exactly one incident", () => {
  it("accepts a well-formed conversation", () => {
    expect(validate("conversation", OK_CONVERSATION).state).toBe("valid");
  });

  it("refuses a thread id that is not derived from an incident id", () => {
    expectInvalid("conversation", { ...OK_CONVERSATION, thread_id: "thread-42" }, "/thread_id must match pattern");
  });

  it("refuses a thread that exists without naming its incident", () => {
    expectInvalid("conversation", { ...OK_CONVERSATION, incident_id: null }, "/incident_id must be string");
  });

  it("refuses a message that carries no incident id of its own", () => {
    // Stamping every message is what makes a leak visible without running a model.
    expectInvalid("conversation", {
      ...OK_CONVERSATION,
      messages: [{ role: "user", text: "why OOM?", ts: "2026-09-04T10:31:00Z" }],
    }, "/messages/0 must have required property 'incident_id'");
  });
});

describe("remediation: read-only means read-only", () => {
  const OK_ACTION = {
    type: "increase_memory_limit",
    risk: "medium",
    requires_approval: true,
    rationale: "container hit its limit at 507Mi of 512Mi",
    executed: false,
    target: { kind: "Deployment", name: "payment-api", namespace: "production" },
  };

  it("accepts a well-formed recommendation", () => {
    expect(validate("remediation", OK_ACTION).state).toBe("valid");
  });

  it("refuses a state-changing action that claims it needs no approval", () => {
    expectInvalid("remediation", { ...OK_ACTION, requires_approval: false }, "/requires_approval must be equal to constant");
  });

  // Codex, 2026-09-05: one test said "or" and asserted one half, so deleting
  // the requires_approval rule left it green. A test that claims two rules has
  // to break on either — which means it is two tests.
  it("refuses no_action that claims risk", () => {
    expectInvalid("remediation", {
      type: "no_action", risk: "high", requires_approval: false, rationale: "wait", executed: false,
    }, "/risk must be equal to constant");
  });

  it("refuses no_action that demands approval", () => {
    expectInvalid("remediation", {
      type: "no_action", risk: "low", requires_approval: true, rationale: "wait", executed: false,
    }, "/requires_approval must be equal to constant");
  });

  it("accepts the no_action these two refusals are built on", () => {
    // The precondition. Without it both refusals above would pass against an
    // object that cannot validate for reasons neither test is about.
    const r = validate("remediation", {
      type: "no_action", risk: "low", requires_approval: false, rationale: "wait", executed: false,
    });
    expect(r.state, JSON.stringify(r)).toBe("valid");
  });

  it("refuses an action type the agent invented", () => {
    expectInvalid("remediation", { ...OK_ACTION, type: "drop_database" }, "/type must be equal to one of the allowed values");
  });

  it("refuses executed: true, so the day something runs an action every check fails loudly", () => {
    expectInvalid("remediation", { ...OK_ACTION, executed: true }, "/executed must be equal to constant");
  });

  it("refuses an action that simply omits executed", () => {
    // Codex, chunk 0 round 2: the field said "always false" and was not required,
    // so every action that never mentioned it read as read-only compliance that
    // nobody had stated. Silence claiming to be a promise is the whole defect.
    const { executed, ...rest } = OK_ACTION;
    expectInvalid("remediation", rest, "required property 'executed'");
  });

  it("refuses an action with no rationale", () => {
    const { rationale, ...rest } = OK_ACTION;
    expectInvalid("remediation", rest, "required property 'rationale'");
  });
});
