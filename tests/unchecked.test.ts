/**
 * What happens when the validator itself cannot run.
 *
 * Every one of these branches was unreachable from the suite until 2026-09-07.
 * A subagent asked which branches no test reaches and found the cause: not one
 * test file imported src/core/merge.ts or src/core/thread.ts. Everything went
 * through the assemble.ts and report.ts wrappers, which bind the real ajv
 * validator — and ajv either accepts or rejects, so `unchecked` never appeared.
 *
 * That matters more than a coverage number. merge.ts's own header lists, among
 * the four defects it was written to fix: "when the post-attach check came back
 * unchecked, it still said the reply made the incident invalid, blaming the
 * model for a validator that could not run". The fix was there; nothing
 * exercised it, so nothing would have noticed it going away.
 *
 * These tests inject a validator, which is exactly why merge.ts takes one as a
 * parameter rather than importing it.
 */
import { describe, it, expect } from "vitest";
import { recordAgentResult, concludeIncident, type Validate } from "../src/core/merge.js";
import { reportIncident, appendMessage } from "../src/core/thread.js";

/** A validator that cannot answer — a schema that failed to compile. */
const broken: Validate = () => ({ state: "unchecked", reason: "schema compilation failed: boom" });

/** A validator that answers, so a test can show the difference. */
const accepts: Validate = () => ({ state: "valid" });

const INCIDENT = () => ({
  incident_id: "INC-2026-0001", status: "investigating", service: "payment-api",
  namespace: "production", cluster: "prod-eu", started_at: "2026-09-04T10:30:00Z",
  source: { provider: "fake-datadog", alert: { id: "a", title: "t", triggered_at: "2026-09-04T10:29:00Z" } },
  observations: { kubernetes: { pods: [{ phase: "Running" }] }, logs: null, metrics: null },
  collection: { kubernetes: { state: "collected" }, logs: { state: "nothing" }, metrics: { state: "nothing" } },
  analysis: { agents: [], root_cause_code: null, root_cause: null, confidence: null, evidence: [] },
  remediation: { recommended_actions: [] },
  conversation: { provider: "fake-slack", channel_id: "c", thread_id: "thread-INC-2026-0001",
    incident_id: "INC-2026-0001", messages: [] },
});

const RESULT = {
  agent: "kubernetes", status: "ok",
  findings: [{ fact: "the pod is running", source_ref: "pods[0].phase" }],
  hypotheses: [], confidence: 0.5,
};

describe("a validator that could not run is not a validator that said no", () => {
  it("blames the validator, not the reply, when the incident cannot be checked", () => {
    const r = recordAgentResult(broken, INCIDENT(), RESULT);
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    /*
     * The distinction the header calls one of the four fixed defects: this must
     * not read as "your reply is bad". Nobody looked at the reply.
     */
    expect(r.reason, "an unrunnable validator must not be reported as an invalid reply")
      .toMatch(/could not validate/);
    expect(r.reason).not.toMatch(/invalid/);
    expect(r.reason).toContain("boom");
  });

  it("says the same about the check that runs after attaching", () => {
    // The first check passes, the second cannot run — a validator that dies
    // between the two calls, which is what a schema reload looks like.
    let calls = 0;
    const diesLate: Validate = () => {
      calls += 1;
      return calls <= 2 ? { state: "valid" } : { state: "unchecked", reason: "the schema went away" };
    };
    const r = recordAgentResult(diesLate, INCIDENT(), RESULT);
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toMatch(/could not validate the incident after attaching/);
    expect(r.reason).toContain("the schema went away");
  });

  it("refuses to conclude on a validator that cannot answer", () => {
    const inc = INCIDENT();
    inc.analysis.agents = [{ agent: "root_cause", status: "ok",
      findings: [{ fact: "f", source_ref: "pods[0].phase" }],
      hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: ["pods[0].phase"] }],
      confidence: 0.7 }] as never;
    const r = concludeIncident(broken, inc);
    expect(r.state, "a conclusion nothing could check is not a conclusion").toBe("refused");
    if (r.state === "refused") expect(r.reason).toMatch(/could not validate/);
  });

  it("refuses to write a thread message it could not check", () => {
    const conversation = INCIDENT().conversation;
    const r = appendMessage(broken, conversation, {
      role: "system", text: "x", ts: "2026-09-04T10:40:00Z", incident_id: "INC-2026-0001",
    });
    expect(r.state).toBe("refused");
    if (r.state === "refused") expect(String(r.reason)).toMatch(/invalid|check/i);
  });

  it("still works when the validator answers, or these prove nothing", () => {
    // The precondition. Every assertion above is about a refusal, and a
    // function that refuses everything would satisfy all of them.
    const r = recordAgentResult(accepts, INCIDENT(), RESULT);
    expect(r.state, "the honest path must still record").toBe("recorded");

    const ok = reportIncident(accepts, INCIDENT(), "2026-09-04T10:40:00Z");
    expect(ok.state, "and the thread must still be writable").toBe("reported");
  });
});
