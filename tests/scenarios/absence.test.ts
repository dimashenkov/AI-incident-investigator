import { describe, it, expect } from "vitest";
import { validate } from "../../src/schema/validate.js";
import { readFileSync } from "node:fs";
import remediationSchema from "../../schemas/remediation.schema.json" with { type: "json" };

const CONV = { provider: "fake-slack", channel_id: "fake-prod-incidents", thread_id: "thread-INC-2026-0001", incident_id: "INC-2026-0001", messages: [] };
const INC = {
  incident_id: "INC-2026-0001", status: "investigating", service: "payment-api", namespace: "production",
  cluster: "prod-eu", started_at: "2026-09-04T10:30:00Z",
  /*
   * A COMPLETE alert, and that is the whole point of this line.
   *
   * Until 2026-09-07 this base carried `alert: {}` — itself one of the cases
   * below — so every probe spreading INC was refused for the missing alert
   * before its own rule was ever consulted. A subagent asked one question about
   * this file and showed it by deleting the diagnosed rules from the schema:
   * probes 3, 4 and 7 stayed "invalid" with the rule they name removed, and 9b
   * never reached additionalProperties at all. Four tests spent their lives
   * proving the alert was empty.
   *
   * The file already knew — two tests further down build a valid base with a
   * comment saying exactly this. They were fixed one at a time; the base was
   * not, so the trap stayed for whatever was written next.
   */
  source: { provider: "fake-datadog", alert: { id: "a-1", title: "t", triggered_at: "2026-09-04T10:29:00Z" } },
  observations: { kubernetes: null, logs: null, metrics: null },
  // Three answers per slot, recorded in the document. Everything here is a
  // deliberate "the provider said there was nothing", not a slot nobody read.
  collection: { kubernetes: { state: "nothing" }, logs: { state: "nothing" }, metrics: { state: "nothing" } },
  analysis: { agents: [], root_cause_code: null, root_cause: null, confidence: null, evidence: [] },
  remediation: { recommended_actions: [] }, conversation: CONV,
};
const AGENT = {
  agent: "kubernetes", status: "ok",
  findings: [{ fact: "f", source_ref: "r" }],
  hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: ["r"] }], confidence: 0.9,
};
/**
 * One case that must be refused, and — where it matters — the rule that refuses it.
 *
 * `because` is a fragment of the error message. Asserting only "invalid" cannot
 * tell WHICH rule did the refusing, and on 2026-09-07 a subagent showed what
 * that costs: with the diagnosed rules deleted from the schema outright, three
 * of these probes stayed green, because a different rule was refusing them all
 * along. A test that cannot say why it passed cannot notice its subject being
 * removed.
 */
const probe = (n: string, name: any, data: unknown, because?: string) => it(n, () => {
  // Asserting "invalid" specifically, not "not valid": an "unchecked" result
  // means the schema stopped compiling, which is a different failure and must
  // not be able to make this suite look green.
  const r = validate(name, data);
  expect(r.state, `${n} -> ${JSON.stringify(r)}`).toBe("invalid");
  if (because !== undefined && r.state === "invalid") {
    expect(r.errors.join("; "), `${n} was refused, but not for the reason it names`).toContain(because);
  }
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
  /*
   * The precondition every probe below rests on. Without it a base that goes
   * invalid for an unrelated reason makes all of them pass while testing
   * nothing — which is what happened here for three days.
   */
  it("starts from a base that is itself valid, or nothing below is about its rule", () => {
    const r = validate("incident", INC);
    expect(r.state, JSON.stringify(r)).toBe("valid");
  });

  probe("1 all-null conversation", "conversation", { provider: "fake-slack", channel_id: null, thread_id: null, incident_id: null, messages: [] });
  probe("2 thread/incident mismatch", "conversation", { ...CONV, thread_id: "thread-INC-2026-0009", incident_id: "INC-2026-0007" });
  probe("2b message names another incident", "conversation", { ...CONV, messages: [{ role: "agent", text: "x", ts: "2026-01-01T00:00:00Z", incident_id: "INC-2026-0003" }] });
  probe("3 diagnosed with zero agents", "incident", { ...INC, status: "diagnosed", analysis: { agents: [], root_cause_code: "CONTAINER_OOM", root_cause: "r", confidence: 0.9, evidence: [{ source: "logs", fact: "f" }] } },
    "/analysis/agents");
  probe("4 diagnosed on against-evidence", "incident", { ...INC, status: "diagnosed", analysis: { agents: [], root_cause_code: "CONTAINER_OOM", root_cause: "r", confidence: 0.9, evidence: [{ source: "logs", fact: "f", supports: "against" }] } },
    "/analysis");
  probe("5 supported_by empty string", "agent-result", { ...AGENT, hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: [""] }] });
  probe("6 empty target on state change", "remediation", { type: "restart_deployment", risk: "high", requires_approval: true, rationale: "r", executed: false, target: {} });
  probe("7 diagnosed at confidence 0", "incident", { ...INC, status: "diagnosed", analysis: { agents: [], root_cause_code: "CONTAINER_OOM", root_cause: "r", confidence: 0, evidence: [{ source: "logs", fact: "f" }] } },
    "/analysis");
  probe("9 empty alert object", "incident", { ...INC, source: { provider: "fake-datadog", alert: {} } },
    "must have required property");
  // A complete alert PLUS a key nobody declared, so what refuses it is
  // additionalProperties and not the three keys the old fixture was missing.
  probe("9b alert with invented key", "incident",
    { ...INC, source: { provider: "fake-datadog", alert: { id: "a-1", title: "t", triggered_at: "2026-09-04T10:29:00Z", titel: "typo" } } },
    "must NOT have additional properties");
  probe("10 agent message with no citation", "conversation", { ...CONV, messages: [{ role: "agent", text: "OOM", ts: "2026-01-01T00:00:00Z", incident_id: "INC-2026-0001" }] });
  probe("11 status ok carrying an error", "agent-result", { ...AGENT, error: "boom" });

  /*
   * Found on 2026-09-07 by a subagent that constructed objects and ran them
   * through the real validator rather than reading the schemas. Every one of
   * these was VALID.
   */
  probe("12 diagnosed on an agent that could not run", "incident",
    { ...INC, status: "diagnosed", analysis: { agents: [{ agent: "kubernetes", status: "error",
        error: "cluster unreachable", findings: [], hypotheses: [], confidence: 0 }],
      root_cause_code: "CONTAINER_OOM", root_cause: "the container ran out of memory", confidence: 0.9,
      evidence: [{ source: "kubernetes", fact: "OOMKilled", supports: "for" }] } },
    "/analysis/agents");
  probe("13 failed while carrying a confident cause", "incident",
    { ...INC, status: "failed", analysis: { agents: [], root_cause_code: "CONTAINER_OOM",
      root_cause: "r", confidence: 1, evidence: [{ source: "kubernetes", fact: "f", supports: "for" }] } },
    "/analysis/root_cause_code");
  probe("21 a container that terminated for no reason", "incident",
    { ...INC,
      observations: { logs: null, metrics: null,
        kubernetes: { provenance: { collection_id: "aaaaaaaa-0000-4000-8000-000000000000",
            requested_for: "INC-2026-0001", cluster: "prod-eu", namespace: "production",
            provider: "fake-kubernetes" },
          collected_at: "2026-09-04T10:31:00Z", events: [],
          pods: [{ name: "p", namespace: "production", phase: "Running", restart_count: 1,
            containers: [{ name: "c", ready: false, restart_count: 1,
              limits: { memory: "1Gi", cpu: "1" }, requests: { memory: "512Mi", cpu: "500m" },
              last_state: {} }] }],
          deployment: { name: "d", namespace: "production", image: "i",
            replicas: { desired: 1, ready: 0, available: 0 } } } },
      collection: { kubernetes: { state: "collected" }, logs: { state: "nothing" }, metrics: { state: "nothing" } } },
    "must have required property 'terminated'");
  probe("14 investigating while carrying a cause", "incident",
    { ...INC, analysis: { agents: [], root_cause_code: "CONTAINER_OOM", root_cause: "r",
      confidence: 0.8, evidence: [{ source: "kubernetes", fact: "f", supports: "for" }] } },
    "/analysis/root_cause_code");
  probe("15 no_data carrying an error text", "agent-result",
    { agent: "logs", status: "no_data", error: "connection refused", findings: [], hypotheses: [], confidence: 0 },
    "must NOT be valid");
  probe("16 ok with nothing found and confidence anyway", "agent-result",
    { agent: "logs", status: "ok", findings: [], hypotheses: [], confidence: 1 },
    "/confidence");
  probe("17 one citation both supporting and contradicting", "agent-result",
    { agent: "metrics", status: "ok",
      findings: [{ fact: "cpu 100%", source_ref: "series[0].points[3].value" }],
      hypotheses: [{ code: "CPU_THROTTLING", statement: "throttled",
        supported_by: ["series[0].points[3].value"],
        contradicted_by: ["series[0].points[3].value"] }], confidence: 0.8 },
    "both supporting and contradicting");
  probe("18 slots gathered for another incident", "incident",
    { ...INC,
      observations: { logs: null, metrics: null,
        kubernetes: { provenance: { collection_id: "11111111-0000-4000-8000-000000000000",
            requested_for: "INC-2026-9999", cluster: "prod-eu", namespace: "production",
            provider: "fake-kubernetes" },
          collected_at: "2026-09-04T10:31:00Z", pods: [], events: [],
          deployment: { name: "d", namespace: "production", image: "i",
            replicas: { desired: 1, ready: 1, available: 1 } } } },
      collection: { kubernetes: { state: "collected" }, logs: { state: "nothing" }, metrics: { state: "nothing" } } },
    "but this incident is INC-2026-0001");
  probe("19 insufficient evidence, held with confidence", "incident",
    { ...INC, status: "insufficient_evidence",
      analysis: { agents: [{ agent: "root_cause", status: "ok",
          findings: [{ fact: "f", source_ref: "pods[0].phase" }], hypotheses: [], confidence: 0.95 }],
        root_cause_code: "INSUFFICIENT_EVIDENCE",
        root_cause: "The evidence collected does not support naming a cause.",
        confidence: 0.95, evidence: [] } },
    "/analysis/confidence");
  probe("20 closed while carrying a live diagnosis", "incident",
    { ...INC, status: "closed", analysis: { agents: [], root_cause_code: "CONTAINER_OOM",
      root_cause: "r", confidence: 0.9, evidence: [{ source: "kubernetes", fact: "f", supports: "for" }] } },
    "/analysis/root_cause_code");

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
    // INC is deliberately invalid — its alert is one of the cases above — so a
    // test built on it is refused before the slot is ever looked at. This one
    // was, for as long as it has existed. VALID is the complete object, and the
    // precondition below is what keeps that true.
    const VALID = { ...INC,
      source: { provider: "fake-datadog", alert: { id: "a-1", title: "t", triggered_at: "2026-09-04T10:29:00Z" } } };
    expect(validate("incident", VALID).state,
      `the base must be valid, or nothing below is about the slot: ${JSON.stringify(validate("incident", VALID))}`).toBe("valid");
    for (const slot of ["kubernetes", "logs", "metrics"]) {
      const bad = { ...VALID, observations: { kubernetes: null, logs: null, metrics: null, [slot]: {} } };
      const r = validate("incident", bad);
      expect(r.state, `${slot}: ${JSON.stringify(r)}`).toBe("invalid");
      if (r.state !== "invalid") continue;
      // Naming the rule that does the refusing. minProperties used to, and no
      // longer exists anywhere in schemas/ — the fixture contracts took over.
      // A test that asserted only "invalid" survived both that replacement and
      // an invalid base, which is how it spent its whole life proving nothing.
      expect(r.errors.join("; "), `${slot} was refused for something other than being empty`)
        .toContain(`/observations/${slot} must have required property`);
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
    // A collected observation now has to have the shape its fixture contract
    // declares. `{ pods: [] }` used to pass here, which meant "collected" could
    // be claimed by an object that said nothing.
    // The stamp is applied by the provider from the request; a hand-built
    // observation has to carry one or the schema refuses it.
    const collected = { ...JSON.parse(readFileSync(new URL("../../scenarios/container-oom/kubernetes.json", import.meta.url).pathname, "utf8")),
      provenance: { collection_id: "aaaaaaaa-0000-4000-8000-000000000000", requested_for: "INC-2026-0001",
        cluster: "prod-eu", namespace: "production", provider: "fake-kubernetes" } };
    const withData = { ...base, observations: { kubernetes: collected, logs: null, metrics: null },
      collection: { kubernetes: { state: "collected" }, logs: { state: "nothing" }, metrics: { state: "nothing" } } };
    expect(validate("incident", withData).state, JSON.stringify(validate("incident", withData))).toBe("valid");
  });
});
