import { describe, it, expect } from "vitest";
import { validate } from "../../src/schema/validate.js";
import remediationSchema from "../../schemas/remediation.schema.json" with { type: "json" };

const CONV = { provider: "fake-slack", channel_id: "fake-prod-incidents", thread_id: "thread-INC-2026-0001", incident_id: "INC-2026-0001", messages: [] };
const INC = {
  incident_id: "INC-2026-0001", status: "investigating", service: "payment-api", namespace: "production",
  cluster: "prod-eu", started_at: "2026-09-04T10:30:00Z", source: { provider: "fake-datadog", alert: {} },
  observations: { kubernetes: null, logs: null, metrics: null },
  analysis: { agents: [], root_cause_code: null, root_cause: null, confidence: null, evidence: [] },
  remediation: { recommended_actions: [] }, conversation: CONV,
};
const AGENT = {
  agent: "kubernetes", status: "ok",
  findings: [{ fact: "f", source_ref: "r" }],
  hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: ["r"] }], confidence: 0.9,
};
const probe = (n: string, name: any, data: unknown) => it(n, () => {
  // Asserting "invalid" specifically, not "not valid": an "unchecked" result
  // means the schema stopped compiling, which is a different failure and must
  // not be able to make this suite look green.
  expect(validate(name, data).state, `${n} -> ${JSON.stringify(validate(name, data))}`).toBe("invalid");
});

/**
 * Every case here passed validation on 2026-09-04 and should not have.
 *
 * They come from a subagent asked one question about the standing schemas:
 * find every place where a missing, empty, or unstated value still validates.
 * It returned eleven; all eleven were confirmed by running them through the
 * validator before a single line was changed, and each one below fails without
 * the fix that followed it.
 */
describe("absence is not consent — cases that used to pass", () => {
  probe("1 all-null conversation", "conversation", { provider: "fake-slack", channel_id: null, thread_id: null, incident_id: null, messages: [] });
  probe("2 thread/incident mismatch", "conversation", { ...CONV, thread_id: "thread-INC-2026-0009", incident_id: "INC-2026-0007" });
  probe("2b message names another incident", "conversation", { ...CONV, messages: [{ role: "agent", text: "x", ts: "2026-01-01T00:00:00Z", incident_id: "INC-2026-0003" }] });
  probe("3 diagnosed with zero agents", "incident", { ...INC, status: "diagnosed", analysis: { agents: [], root_cause_code: "CONTAINER_OOM", root_cause: "r", confidence: 0.9, evidence: [{ source: "logs", fact: "f" }] } });
  probe("4 diagnosed on against-evidence", "incident", { ...INC, status: "diagnosed", analysis: { agents: [], root_cause_code: "CONTAINER_OOM", root_cause: "r", confidence: 0.9, evidence: [{ source: "logs", fact: "f", supports: "against" }] } });
  probe("5 supported_by empty string", "agent-result", { ...AGENT, hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: [""] }] });
  probe("6 empty target on state change", "remediation", { type: "restart_deployment", risk: "high", requires_approval: true, rationale: "r", executed: false, target: {} });
  probe("7 diagnosed at confidence 0", "incident", { ...INC, status: "diagnosed", analysis: { agents: [], root_cause_code: "CONTAINER_OOM", root_cause: "r", confidence: 0, evidence: [{ source: "logs", fact: "f" }] } });
  probe("9 empty alert object", "incident", { ...INC, source: { provider: "fake-datadog", alert: {} } });
  probe("9b alert with invented key", "incident", { ...INC, source: { provider: "fake-datadog", alert: { titel: "typo" } } });
  probe("10 agent message with no citation", "conversation", { ...CONV, messages: [{ role: "agent", text: "OOM", ts: "2026-01-01T00:00:00Z", incident_id: "INC-2026-0001" }] });
  probe("11 status ok carrying an error", "agent-result", { ...AGENT, error: "boom" });

  // Codex, chunk 0 round 4: the empty-target test used one action type, so two
  // state-changing actions validated while naming nothing they would change.
  // A rule about a category is tested over the whole category, never one member.
  //
  // The list is READ FROM THE SCHEMA, not retyped here. Writing it out again was
  // the round-4 defect happening a second time in the file that was supposed to
  // fix it: a seventh action type added to the schema would simply never be
  // tested, and the suite would stay green while saying nothing about it.
  const STATE_CHANGING: string[] = remediationSchema.$defs.stateChangingType.enum;

  it("leaves no action type outside a category, and none in both", () => {
    // Codex, chunk 0 round 5: the six values lived in the general type enum as
    // well as in $defs, so a new action could be added to the flat list, be
    // missing from the category, and then require neither approval nor a target
    // while every test stayed green. The type is composed from the two
    // categories now, and this test is what keeps the composition honest:
    // an action that belongs to neither has no rule attached to it at all.
    const nonStateChanging: string[] = remediationSchema.$defs.nonStateChangingType.enum;
    const composed = remediationSchema.properties.type.anyOf.map((b: { $ref: string }) => b.$ref);

    expect(composed).toEqual(["#/$defs/stateChangingType", "#/$defs/nonStateChangingType"]);
    expect(STATE_CHANGING.length).toBeGreaterThan(0);
    expect(nonStateChanging.length).toBeGreaterThan(0);
    expect(STATE_CHANGING.filter((t) => nonStateChanging.includes(t))).toEqual([]);
  });

  it("attaches the approval and target rules to the category, not to a copy of it", () => {
    // Both conditionals must point at the same carrier. If one is ever inlined
    // again, the two rules can disagree about what changes state.
    const refs = remediationSchema.allOf
      .map((c: { if?: { properties?: { type?: { $ref?: string } } } }) => c.if?.properties?.type?.$ref)
      .filter((r: string | undefined) => r !== undefined);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(refs).size, `rules point at different carriers: ${refs.join(", ")}`).toBe(1);
  });

  for (const type of STATE_CHANGING) {
    probe(`6/${type} names nothing it would change`, "remediation", {
      type, risk: "high", requires_approval: true, rationale: "r", executed: false,
    });
    probe(`6/${type} carries an empty target`, "remediation", {
      type, risk: "high", requires_approval: true, rationale: "r", executed: false, target: {},
    });
    probe(`6/${type} claims it needs no approval`, "remediation", {
      type, risk: "high", requires_approval: false, rationale: "r", executed: false,
      target: { kind: "Deployment", name: "payment-api", namespace: "production" },
    });
  }

  it("accepts every state-changing action once it names a target and asks for approval", () => {
    for (const type of STATE_CHANGING) {
      const ok = {
        type, risk: "medium", requires_approval: true, rationale: "r", executed: false,
        target: { kind: "Deployment", name: "payment-api", namespace: "production" },
      };
      expect(validate("remediation", ok).state, `${type} -> ${JSON.stringify(validate("remediation", ok))}`).toBe("valid");
    }
  });

  it("still accepts a well-formed incident, so none of this was bought by refusing everything", () => {
    const ok = {
      ...INC,
      source: { provider: "fake-datadog", alert: { id: "a-1", title: "High memory", triggered_at: "2026-09-04T10:29:00Z" } },
    };
    expect(validate("incident", ok).state, JSON.stringify(validate("incident", ok))).toBe("valid");
  });

  it("accepts a diagnosis that carries everything a diagnosis must carry", () => {
    const ok = {
      ...INC,
      status: "diagnosed",
      source: { provider: "fake-datadog", alert: { id: "a-1", title: "High memory", triggered_at: "2026-09-04T10:29:00Z" } },
      analysis: {
        agents: [AGENT],
        root_cause_code: "CONTAINER_OOM",
        root_cause: "Container exceeded its memory limit",
        confidence: 0.94,
        evidence: [{ source: "kubernetes", fact: "OOMKilled", supports: "for" }],
      },
    };
    expect(validate("incident", ok).state, JSON.stringify(validate("incident", ok))).toBe("valid");
  });

  it("actually applies the cross-file reference, rather than ignoring an unresolved one", () => {
    // conversation.schema.json now points at incident.schema.json $defs for the
    // evidence source. A $ref that failed to resolve could look like a schema
    // with no constraint at all, and every value would pass. So: a source that
    // is not in the shared list must be refused from inside the OTHER file.
    const leaked = {
      ...CONV,
      messages: [{
        role: "agent", text: "OOM", ts: "2026-01-01T00:00:00Z", incident_id: "INC-2026-0001",
        cited_evidence: [{ source: "invented-source", fact: "f" }],
      }],
    };
    expect(validate("conversation", leaked).state, JSON.stringify(validate("conversation", leaked))).toBe("invalid");
  });

  it("accepts a source that is in the shared list, so the rule is not simply refusing everything", () => {
    const ok = {
      ...CONV,
      messages: [{
        role: "agent", text: "OOM", ts: "2026-01-01T00:00:00Z", incident_id: "INC-2026-0001",
        cited_evidence: [{ source: "kubernetes", fact: "OOMKilled" }],
      }],
    };
    expect(validate("conversation", ok).state, JSON.stringify(validate("conversation", ok))).toBe("valid");
  });

  it("applies the shared severity reference from agent-result too", () => {
    const bad = { ...AGENT, findings: [{ fact: "f", source_ref: "r", severity: "apocalyptic" }] };
    expect(validate("agent-result", bad).state).toBe("invalid");
    const good = { ...AGENT, findings: [{ fact: "f", source_ref: "r", severity: "critical" }] };
    expect(validate("agent-result", good).state, JSON.stringify(validate("agent-result", good))).toBe("valid");
  });

  // Codex, chunk 0 round 11: supported_by was traced back to a finding and
  // contradicted_by was not, so a hypothesis could be weakened by evidence that
  // does not exist. A rule about evidence references holds for both lists.
  for (const field of ["supported_by", "contradicted_by"]) {
    probe(`${field} cites a finding that does not exist`, "agent-result", {
      ...AGENT,
      hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: ["r"], [field]: ["no-such-ref"] }],
    });
    probe(`${field} holds an empty reference`, "agent-result", {
      ...AGENT,
      hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: ["r"], [field]: [""] }],
    });
  }

  it("traces contradicting evidence back to a finding, not only supporting evidence", () => {
    // Named statically on purpose: a mutation points at this test by name, and
    // a name built inside a loop cannot be found in the source by that check.
    const bad = {
      ...AGENT,
      hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: ["r"], contradicted_by: ["no-such-ref"] }],
    };
    const r = validate("agent-result", bad);
    expect(r.state, JSON.stringify(r)).toBe("invalid");
    expect(JSON.stringify(r)).toContain("contradicted_by");
  });

  it("accepts a hypothesis whose contradictions trace back to real findings", () => {
    const ok = {
      ...AGENT,
      findings: [{ fact: "f", source_ref: "r" }, { fact: "g", source_ref: "r2" }],
      hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: ["r"], contradicted_by: ["r2"] }],
    };
    expect(validate("agent-result", ok).state, JSON.stringify(validate("agent-result", ok))).toBe("valid");
  });

  it("refuses an empty object as a collected observation", () => {
    // Codex, chunk 0 round 13: {} said "collected, and here is what we found"
    // while carrying exactly what null already says honestly — nothing.
    for (const slot of ["kubernetes", "logs", "metrics"]) {
      const bad = { ...INC, observations: { kubernetes: null, logs: null, metrics: null, [slot]: {} } };
      expect(validate("incident", bad).state, `${slot}: ${JSON.stringify(validate("incident", bad))}`).toBe("invalid");
    }
  });

  it("still accepts null for a slot nothing was collected from", () => {
    // null and {} must stay different claims: "never collected" versus
    // "collected, found nothing" is the distinction this whole file is about.
    // INC itself is deliberately invalid here — its alert is one of the cases
    // above — so the positive assertion is made on a complete object.
    const base = {
      ...INC,
      source: { provider: "fake-datadog", alert: { id: "a-1", title: "t", triggered_at: "2026-09-04T10:29:00Z" } },
    };
    expect(validate("incident", base).state, JSON.stringify(validate("incident", base))).toBe("valid");
    const withData = { ...base, observations: { kubernetes: { pods: [] }, logs: null, metrics: null } };
    expect(validate("incident", withData).state, JSON.stringify(validate("incident", withData))).toBe("valid");
  });
});
