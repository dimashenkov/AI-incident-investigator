/**
 * Assembling an incident from a scenario.
 *
 * The interesting cases are the scenarios built to be awkward: a provider that
 * says nothing on purpose, a log window that is truncated, and one whose right
 * answer is that there is not enough to tell. Every one of them must produce a
 * valid incident, because "this is hard to diagnose" is not "this is malformed".
 */
import { describe, it, expect } from "vitest";
import { assembleIncident, concludeIncident, incidentIdFor, readRegistry, recordAgentResult, resultBelongsHere, resolveRef, runnableAgents, serviceFromTags } from "../src/core/assemble.js";
import { listScenarios } from "../src/providers/fixtures.js";
import { validate } from "../src/schema/validate.js";
import { assembleObservingContext, checkPayloadIsExactlyTheSlice } from "../src/agents/context.js";

const SCENARIOS = new URL("../scenarios/", import.meta.url).pathname;
const all = listScenarios(SCENARIOS);
const REGISTRY = readRegistry(SCENARIOS)!;

const OK_RESULT = {
  agent: "kubernetes", status: "ok",
  findings: [{ fact: "OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
  hypotheses: [{ code: "CONTAINER_OOM", statement: "memory limit exceeded", supported_by: ["pods[0].containers[0].last_state.terminated.reason"] }],
  confidence: 0.9,
};

describe("every scenario assembles into a valid incident", () => {
  it("has the five scenarios the plan calls for", () => {
    expect(all.length).toBe(5);
    expect(all).toContain("insufficient-evidence");
  });

  it("assembles each one and validates it", () => {
    all.forEach((scenario, i) => {
      const a = assembleIncident(scenario, i + 1, { root: SCENARIOS });
      expect(a.state, `${scenario}: ${a.state === "refused" ? `${a.reason} ${JSON.stringify(a.errors)}` : ""}`).toBe("assembled");
      if (a.state !== "assembled") return;
      expect(validate("incident", a.incident).state).toBe("valid");
    });
  });

  it("gives every scenario a distinct incident id", () => {
    const ids = all.map((s, i) => incidentIdFor(s, i + 1, REGISTRY));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("takes the service from the alert tags rather than guessing", () => {
    const a = assembleIncident("cpu-throttling", 1, { root: SCENARIOS });
    expect(a.state).toBe("assembled");
    if (a.state !== "assembled") return;
    expect(a.incident.service).toBe("report-worker");
  });

  it("falls back to a named unknown rather than to an empty string", () => {
    // An empty service would validate against minLength 1? No — and that is the
    // point: a placeholder that fails the schema is better than one that passes
    // while meaning nothing.
    expect(serviceFromTags({ tags: ["env:production"] })).toBeNull();
    expect(serviceFromTags({})).toBeNull();
  });
});

describe("scenarios built to be awkward still assemble", () => {
  it("assembles the one whose metrics say nothing on purpose", () => {
    // image-pull-failure has a metrics fixture carrying the nothing sentinel.
    const a = assembleIncident("image-pull-failure", 2, { root: SCENARIOS });
    expect(a.state).toBe("assembled");
    if (a.state !== "assembled") return;
    expect(a.incident.observations).toHaveProperty("metrics", null);
    expect(a.failures, "a stated nothing is not a failure").toEqual([]);
  });

  it("assembles the one whose logs are truncated, keeping the flag", () => {
    const a = assembleIncident("readiness-probe-failure", 3, { root: SCENARIOS });
    expect(a.state).toBe("assembled");
    if (a.state !== "assembled") return;
    expect((a.incident.observations as { logs: { truncated: boolean } }).logs.truncated).toBe(true);
  });

  it("assembles the one whose right answer is that there is not enough", () => {
    // "Hard to diagnose" is not "malformed". If this refused to assemble, the
    // system could never report insufficient evidence at all.
    const a = assembleIncident("insufficient-evidence", 4, { root: SCENARIOS });
    expect(a.state).toBe("assembled");
  });

  it("refuses a scenario that does not exist rather than inventing one", () => {
    const a = assembleIncident("no-such-scenario", 5, { root: SCENARIOS });
    expect(a.state).toBe("refused");
  });

  it("refuses to build an incident when every observation failed", () => {
    // Three failed reads are not three established absences. Building one would
    // produce a document asserting things nobody looked at.
    const root = new URL("./fixtures/all-broken/", import.meta.url).pathname;
    const a = assembleIncident("container-oom", 6, { root });
    expect(a.state).toBe("refused");
    if (a.state !== "refused") return;
    expect(a.reason).toContain("every observation failed");
  });

  it("assembles when two of three slots failed, since one reading is a reading", () => {
    // Codex, chunk 2: the tests covered three failures and normal scenarios,
    // never the boundary the rule actually states. This is that boundary.
    const root = new URL("./fixtures/two-broken/", import.meta.url).pathname;
    const a = assembleIncident("container-oom", 7, { root });
    expect(a.state).toBe("assembled");
    if (a.state !== "assembled") return;
    expect(a.failures).toHaveLength(2);
    expect(a.incident.observations).toHaveProperty("logs", null);
  });

  it("gives every pair of scenarios different ids at every sequence", () => {
    // Codex, chunk 2, twice: first the scenario was ignored, then it was folded
    // into a hundred-value hash — "not injective… the test checks only one
    // selected pair, so it does not establish the claimed invariant". So the
    // test now walks every pair at several sequences instead of one pair once.
    const ids = new Set<string>();
    for (const s of all) {
      for (const seq of [1, 2, 7, 99]) {
        const id = incidentIdFor(s, seq, REGISTRY);
        expect(ids.has(id), `${s}@${seq} collides with an id already issued`).toBe(false);
        ids.add(id);
      }
    }
    expect(ids.size).toBe(all.length * 4);
  });

  it("gives one scenario the same id every time, so re-running collides rather than multiplies", () => {
    expect(incidentIdFor("container-oom", 1, REGISTRY)).toBe(incidentIdFor("container-oom", 1, REGISTRY));
  });

  it("refuses a scenario with no number rather than inventing one at call time", () => {
    // A number invented on the spot is exactly the thing that moves later.
    expect(() => incidentIdFor("invented", 1, REGISTRY)).toThrow(/no number in scenarios\/registry\.json/);
  });

  it("keeps an id stable when a scenario that sorts earlier is added", () => {
    // Codex, chunk 2: deriving the number from sorted position meant a new
    // scenario sorting before an existing one renumbered it — and with it its
    // Slack thread id. An id that changes when an unrelated file appears is not
    // an id. The registry is appended to, so the old number stays where it was.
    const before = incidentIdFor("insufficient-evidence", 1, REGISTRY);
    const grown = { next_free: REGISTRY.next_free + 1, numbers: { ...REGISTRY.numbers, "aaa-new-scenario": REGISTRY.next_free } };
    expect(incidentIdFor("insufficient-evidence", 1, grown)).toBe(before);
  });

  it("refuses to issue ids at all when the registry is missing", () => {
    // Numbering without the register would hand out ids that move next time.
    expect(() => incidentIdFor("container-oom", 1, null)).toThrow(/registry\.json is missing/);
  });

  it("produces ids the incident schema accepts, for every scenario and sequence", () => {
    for (const s of all) {
      for (const seq of [1, 99]) expect(incidentIdFor(s, seq, REGISTRY)).toMatch(/^INC-\d{4}-\d{4}$/);
    }
  });

  it("refuses a sequence number that cannot make a valid id", () => {
    expect(() => incidentIdFor("container-oom", 0, REGISTRY)).toThrow();
    expect(() => incidentIdFor("container-oom", 100, REGISTRY)).toThrow();
  });
});

describe("only agents with something to read can run", () => {
  it("lists the slots that hold data, not all three", () => {
    const a = assembleIncident("image-pull-failure", 2, { root: SCENARIOS });
    if (a.state !== "assembled") throw new Error("not assembled");
    expect(runnableAgents(a.incident).sort()).toEqual(["kubernetes", "logs"]);
  });

  it("refuses to build a context for a slot nothing was collected from", () => {
    const a = assembleIncident("image-pull-failure", 2, { root: SCENARIOS });
    if (a.state !== "assembled") throw new Error("not assembled");
    const r = assembleObservingContext("metrics", a.incident);
    expect(r.state).toBe("unavailable");
  });

  it("builds contexts that survive the provenance check for every scenario", () => {
    // The isolation property, checked across all five without spending anything.
    all.forEach((scenario, i) => {
      const a = assembleIncident(scenario, i + 1, { root: SCENARIOS });
      if (a.state !== "assembled") throw new Error(`${scenario} did not assemble`);
      for (const slot of runnableAgents(a.incident)) {
        const ctx = assembleObservingContext(slot as never, a.incident);
        expect(checkPayloadIsExactlyTheSlice(ctx, a.incident), `${scenario}/${slot}`).toEqual({ state: "clean" });
      }
    });
  });
});

describe("an agent result is checked before it is attached", () => {
  const base = () => {
    const a = assembleIncident("container-oom", 1, { root: SCENARIOS });
    if (a.state !== "assembled") throw new Error("not assembled");
    return a.incident;
  };

  it("records a valid result", () => {
    const r = recordAgentResult(base(), OK_RESULT);
    expect(r.state).toBe("recorded");
    if (r.state !== "recorded") return;
    expect((r.incident.analysis as { agents: unknown[] }).agents).toHaveLength(1);
  });

  it("refuses a result citing a finding it never reported", () => {
    // An invalid result inside a valid incident is the shape that passes the
    // incident check and poisons everything downstream.
    const r = recordAgentResult(base(), { ...OK_RESULT, hypotheses: [{ code: "CONTAINER_OOM", statement: "x", supported_by: ["nowhere"] }] });
    expect(r.state).toBe("refused");
  });

  it("says the result was invalid, not that attaching broke the incident", () => {
    // Both checks would refuse this. The first one exists so the message names
    // what is actually wrong: a caller told "attaching made the incident
    // invalid" has to go looking for which part.
    const r = recordAgentResult(base(), { ...OK_RESULT, hypotheses: [{ code: "CONTAINER_OOM", statement: "x", supported_by: ["nowhere"] }] });
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toBe("the agent result does not validate");
  });

  it("refuses a result that claims an error and findings at once", () => {
    const r = recordAgentResult(base(), { ...OK_RESULT, status: "error", error: "boom" });
    expect(r.state).toBe("refused");
  });

  it("does not mutate the incident it was given", () => {
    const incident = base();
    recordAgentResult(incident, OK_RESULT);
    expect((incident.analysis as { agents: unknown[] }).agents).toHaveLength(0);
  });

  it("keeps the incident valid after attaching", () => {
    const r = recordAgentResult(base(), OK_RESULT);
    if (r.state !== "recorded") throw new Error("not recorded");
    expect(validate("incident", r.incident).state).toBe("valid");
  });

});

describe("a reply must belong to the incident it is recorded on", () => {
  const base = () => {
    const a = assembleIncident("container-oom", 1, { root: SCENARIOS });
    if (a.state !== "assembled") throw new Error("not assembled");
    return a.incident;
  };

  it("refuses a finding citing a path that resolves to nothing in that observation", () => {
    // Codex, 2026-09-05, verified before accepting: a reply citing
    // "nowhere_at_all" was recorded. Schema-valid and about nothing.
    const alien = { agent: "kubernetes", status: "ok",
      findings: [{ fact: "from another incident entirely", source_ref: "nowhere_at_all" }],
      hypotheses: [], confidence: 0.9 };
    const r = recordAgentResult(base(), alien);
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("resolves to nothing");
  });

  it("accepts a finding whose path does resolve", () => {
    const good = { agent: "kubernetes", status: "ok",
      findings: [{ fact: "OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
      hypotheses: [], confidence: 0.5 };
    expect(recordAgentResult(base(), good).state).toBe("recorded");
  });

  it("refuses a result for a slot where nothing was collected", () => {
    // image-pull-failure states it has no metrics. An agent reporting on it
    // never ran, whatever the reply says.
    const a = assembleIncident("image-pull-failure", 2, { root: SCENARIOS });
    if (a.state !== "assembled") throw new Error("not assembled");
    const r = recordAgentResult(a.incident, { agent: "metrics", status: "ok",
      findings: [{ fact: "x", source_ref: "series[0]" }], hypotheses: [], confidence: 0.5 });
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("nothing was collected");
  });

  it("refuses a root cause result before any agent has reported", () => {
    const r = recordAgentResult(base(), { agent: "root_cause", status: "ok",
      findings: [{ fact: "memory", source_ref: "agents[0]" }],
      hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: ["agents[0]"] }], confidence: 0.9 });
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("before any agent has reported");
  });

  it("refuses rather than throwing when the incident has no analysis", () => {
    // Grok, 2026-09-05, verified: this threw a TypeError. A crash is not a
    // refusal — no reason, no errors, nothing a human can read.
    const r = recordAgentResult({ incident_id: "INC-2026-0101" }, { agent: "kubernetes", status: "no_data", findings: [], hypotheses: [], confidence: 0 });
    expect(r.state).toBe("refused");
  });

  it("says the incident was already invalid rather than blaming the reply", () => {
    // Grok, 2026-09-05: the refusal said the attach broke the incident even
    // when the incident arrived broken, or when the validator could not run.
    const broken = { ...base(), rootcause: "a typo that was there before" };
    const r = recordAgentResult(broken, { agent: "kubernetes", status: "no_data", findings: [], hypotheses: [], confidence: 0 });
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("already invalid");
  });

  it("refuses to replace an agents list that is not a list", () => {
    // Replacing it would silently discard whatever turns were there.
    const odd = { ...base(), analysis: { ...(base().analysis as object), agents: "not a list" } };
    const r = recordAgentResult(odd, { agent: "kubernetes", status: "no_data", findings: [], hypotheses: [], confidence: 0 });
    expect(r.state).toBe("refused");
  });

  it("resolves a path the way a source_ref is written", () => {
    expect(resolveRef({ pods: [{ name: "p" }] }, "pods[0].name")).toBe("p");
    expect(resolveRef({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(resolveRef({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(resolveRef(null, "a")).toBeUndefined();
  });

  it("names what is wrong rather than returning a bare boolean", () => {
    expect(resultBelongsHere(base(), { agent: "kubernetes", findings: [] })).toBeNull();
    expect(resultBelongsHere(base(), {})).toContain("names no agent");
  });

});

describe("the verdict becomes the incident's own", () => {
  const withAgents = (verdict: unknown) => {
    const a = assembleIncident("container-oom", 1, { root: SCENARIOS });
    if (a.state !== "assembled") throw new Error("not assembled");
    const k = recordAgentResult(a.incident, { agent: "kubernetes", status: "ok",
      findings: [{ fact: "OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
      hypotheses: [{ code: "CONTAINER_OOM", statement: "memory limit exceeded", supported_by: ["pods[0].containers[0].last_state.terminated.reason"] }],
      confidence: 0.9 });
    if (k.state !== "recorded") throw new Error(`kubernetes: ${k.reason}`);
    if (verdict === null) return k.incident;
    const r = recordAgentResult(k.incident, verdict);
    if (r.state !== "recorded") throw new Error(`verdict: ${r.reason} ${JSON.stringify(r.errors)}`);
    return r.incident;
  };

  const VERDICT = {
    agent: "root_cause", status: "ok",
    findings: [{ fact: "container terminated OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
    hypotheses: [{ code: "CONTAINER_OOM", statement: "the container exceeded its memory limit",
      supported_by: ["pods[0].containers[0].last_state.terminated.reason"] }],
    confidence: 0.9,
  };

  it("writes the cause, the confidence and the evidence onto the incident", () => {
    // Codex, 2026-09-05: "nothing updates incident status or its root-cause
    // fields" — the one answer the system exists to produce had no way to
    // become the incident's own.
    const r = concludeIncident(withAgents(VERDICT));
    expect(r.state, r.state === "refused" ? `${r.reason} ${JSON.stringify(r.errors)}` : "").toBe("concluded");
    if (r.state !== "concluded") return;
    const analysis = r.incident.analysis as Record<string, unknown>;
    expect(r.incident.status).toBe("diagnosed");
    expect(analysis.root_cause_code).toBe("CONTAINER_OOM");
    expect(analysis.confidence).toBe(0.9);
    expect((analysis.evidence as unknown[]).length).toBeGreaterThan(0);
  });

  it("records no hypothesis as insufficient evidence, not as still investigating", () => {
    // Leaving it at investigating would mean the run produced nothing, when in
    // fact it produced the honest answer.
    const r = concludeIncident(withAgents({ ...VERDICT, hypotheses: [], confidence: 0.2 }));
    expect(r.state).toBe("concluded");
    if (r.state !== "concluded") return;
    expect(r.incident.status).toBe("insufficient_evidence");
    expect((r.incident.analysis as Record<string, unknown>).root_cause_code).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("refuses two hypotheses rather than picking one", () => {
    const r = concludeIncident(withAgents({ ...VERDICT, hypotheses: [
      VERDICT.hypotheses[0]!,
      { code: "CPU_THROTTLING", statement: "or maybe cpu", supported_by: ["pods[0].containers[0].last_state.terminated.reason"] }] }));
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("judgement it did not make");
  });

  it("refuses a hypothesis citing nothing the agent reported", () => {
    // The validator's cross-field invariant already refuses this at recording
    // time, so the incident is built by hand to reach the promotion step at
    // all. The branch stays because the two checks answer to different owners:
    // one guards what is stored, the other what becomes the verdict.
    const incident = withAgents(null);
    const analysis = incident.analysis as Record<string, unknown>;
    const smuggled = {
      ...incident,
      analysis: { ...analysis, agents: [...(analysis.agents as unknown[]), {
        agent: "root_cause", status: "ok",
        findings: [{ fact: "f", source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
        hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: ["events[0].reason"] }],
        confidence: 0.9 }] },
    };
    const r = concludeIncident(smuggled);
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("cites no finding");
  });

  it("leaves evidence empty when there is no conclusion for it to support", () => {
    // Every entry must say whether it supports or contradicts the conclusion.
    // With no conclusion, calling a fact "against" a cause nobody named would
    // be an invented stance. The facts stay in analysis.agents, where they were
    // reported — nothing is lost, and nothing is claimed.
    const r = concludeIncident(withAgents({ ...VERDICT, hypotheses: [], confidence: 0.2 }));
    expect(r.state).toBe("concluded");
    if (r.state !== "concluded") return;
    expect((r.incident.analysis as { evidence: unknown[] }).evidence).toEqual([]);
    expect(((r.incident.analysis as { agents: unknown[] }).agents).length).toBeGreaterThan(1);
  });

  it("refuses to conclude before the root cause agent has reported", () => {
    const r = concludeIncident(withAgents(null));
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("has not reported");
  });

  it("keeps contradicting findings as evidence against, rather than dropping them", () => {
    // A diagnosis that quietly discards what argues against it looks stronger
    // than it is, and the schema has a slot for exactly this.
    const r = concludeIncident(withAgents({ ...VERDICT,
      findings: [...VERDICT.findings, { fact: "the deployment image did not change", source_ref: "deployment.image" }] }));
    expect(r.state).toBe("concluded");
    if (r.state !== "concluded") return;
    const evidence = (r.incident.analysis as { evidence: Array<{ supports: string }> }).evidence;
    expect(evidence.some((e) => e.supports === "against"), "the contradicting finding was dropped").toBe(true);
  });
});
