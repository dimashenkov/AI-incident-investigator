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
  analysis: { agents: [], root_cause_code: null, root_cause: null, confidence: null, evidence: [] },
  remediation: { recommended_actions: [] },
  conversation: OK_CONVERSATION,
};

function expectInvalid(name: Parameters<typeof validate>[0], data: unknown) {
  const r = validate(name, data);
  expect(r.state, `expected invalid, got ${r.state}`).toBe("invalid");
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
    expectInvalid("incident", rest);
  });

  it("refuses an observation key that is simply absent rather than null", () => {
    // A missing key and an explicit null are different claims: "never collected"
    // versus "collected, found nothing". Only the second may be silent.
    expectInvalid("incident", {
      ...OK_INCIDENT,
      observations: { kubernetes: null, logs: null },
    });
  });

  it("refuses an unknown top-level field, so a typo cannot ride along unread", () => {
    expectInvalid("incident", { ...OK_INCIDENT, rootcause: "CONTAINER_OOM" });
  });
});

describe("incident: a diagnosis must carry its evidence", () => {
  it("refuses status diagnosed with no root cause code", () => {
    expectInvalid("incident", { ...OK_INCIDENT, status: "diagnosed" });
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
    });
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
    });
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
    });
  });

  it("refuses a confidence above 1", () => {
    expectInvalid("incident", {
      ...OK_INCIDENT,
      analysis: { ...OK_INCIDENT.analysis, confidence: 1.4 },
    });
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
    expectInvalid("agent-result", { ...OK_AGENT, status: "error", error: "timeout" });
  });

  it("refuses status error with no error text", () => {
    expectInvalid("agent-result", { ...OK_AGENT, status: "error", findings: [], hypotheses: [], confidence: 0 });
  });

  it("refuses status no_data that reports findings anyway", () => {
    expectInvalid("agent-result", { ...OK_AGENT, status: "no_data", hypotheses: [], confidence: 0 });
  });

  it("refuses a finding with no source_ref", () => {
    // A fact nobody can trace back to an observation is an opinion.
    expectInvalid("agent-result", { ...OK_AGENT, findings: [{ fact: "looks like OOM" }] });
  });

  it("refuses a hypothesis supported by nothing", () => {
    expectInvalid("agent-result", {
      ...OK_AGENT,
      hypotheses: [{ code: "CONTAINER_OOM", statement: "memory", supported_by: [] }],
    });
  });

  it("refuses hypotheses with no findings behind them", () => {
    expectInvalid("agent-result", { ...OK_AGENT, findings: [] });
  });
});

describe("conversation: a thread belongs to exactly one incident", () => {
  it("accepts a well-formed conversation", () => {
    expect(validate("conversation", OK_CONVERSATION).state).toBe("valid");
  });

  it("refuses a thread id that is not derived from an incident id", () => {
    expectInvalid("conversation", { ...OK_CONVERSATION, thread_id: "thread-42" });
  });

  it("refuses a thread that exists without naming its incident", () => {
    expectInvalid("conversation", { ...OK_CONVERSATION, incident_id: null });
  });

  it("refuses a message that carries no incident id of its own", () => {
    // Stamping every message is what makes a leak visible without running a model.
    expectInvalid("conversation", {
      ...OK_CONVERSATION,
      messages: [{ role: "user", text: "why OOM?", ts: "2026-09-04T10:31:00Z" }],
    });
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
    expectInvalid("remediation", { ...OK_ACTION, requires_approval: false });
  });

  it("refuses no_action that demands approval or claims risk", () => {
    expectInvalid("remediation", {
      type: "no_action", risk: "high", requires_approval: true, rationale: "wait",
    });
  });

  it("refuses an action type the agent invented", () => {
    expectInvalid("remediation", { ...OK_ACTION, type: "drop_database" });
  });

  it("refuses executed: true, so the day something runs an action every check fails loudly", () => {
    expectInvalid("remediation", { ...OK_ACTION, executed: true });
  });

  it("refuses an action that simply omits executed", () => {
    // Codex, chunk 0 round 2: the field said "always false" and was not required,
    // so every action that never mentioned it read as read-only compliance that
    // nobody had stated. Silence claiming to be a promise is the whole defect.
    const { executed, ...rest } = OK_ACTION;
    expectInvalid("remediation", rest);
  });

  it("refuses an action with no rationale", () => {
    const { rationale, ...rest } = OK_ACTION;
    expectInvalid("remediation", rest);
  });
});
