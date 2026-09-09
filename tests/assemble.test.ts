/**
 * Assembling an incident from a scenario.
 *
 * The interesting cases are the scenarios built to be awkward: a provider that
 * says nothing on purpose, a log window that is truncated, and one whose right
 * answer is that there is not enough to tell. Every one of them must produce a
 * valid incident, because "this is hard to diagnose" is not "this is malformed".
 */
import { describe, it, expect } from "vitest";
import { normaliseRef, withResolvedRefs, assembleIncident, checkProvenance, concludeIncident, incidentIdFor, readRegistry, recordAgentResult, resultBelongsHere, resolveRef, runnableAgents, serviceFromTags } from "../src/core/assemble.js";
import { listScenarios, fixtureProvider} from "../src/providers/fixtures.js";
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
  // Not a count: the registry declares which scenarios exist, and a directory
  // that is not in it has no incident number, so the two must agree.
  it("has every registered scenario, so nothing below passes on an empty set", () => {
    expect(all.length, "no scenario directories were found").toBeGreaterThan(0);
    expect(all.slice().sort(), "the directories and scenarios/registry.json disagree")
      .toEqual(Object.keys(REGISTRY.numbers).sort());
    expect(all).toContain("insufficient-evidence");
  });

  it("assembles each one and validates it", () => {
    all.forEach((scenario, i) => {
      const a = assembleIncident(scenario, 1, { root: SCENARIOS });
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
    const a = assembleIncident("image-pull-failure", 1, { root: SCENARIOS });
    expect(a.state).toBe("assembled");
    if (a.state !== "assembled") return;
    expect(a.incident.observations).toHaveProperty("metrics", null);
    expect(a.failures, "a stated nothing is not a failure").toEqual([]);
  });

  it("assembles the one whose logs are truncated, keeping the flag", () => {
    const a = assembleIncident("readiness-probe-failure", 1, { root: SCENARIOS });
    expect(a.state).toBe("assembled");
    if (a.state !== "assembled") return;
    expect((a.incident.observations as { logs: { truncated: boolean } }).logs.truncated).toBe(true);
  });

  it("assembles the one whose right answer is that there is not enough", () => {
    // "Hard to diagnose" is not "malformed". If this refused to assemble, the
    // system could never report insufficient evidence at all.
    const a = assembleIncident("insufficient-evidence", 1, { root: SCENARIOS });
    expect(a.state).toBe("assembled");
  });

  it("refuses a scenario that does not exist rather than inventing one", () => {
    const a = assembleIncident("no-such-scenario", 1, { root: SCENARIOS });
    expect(a.state).toBe("refused");
  });

  it("refuses to build an incident when every observation failed", () => {
    // Three failed reads are not three established absences. Building one would
    // produce a document asserting things nobody looked at.
    const root = new URL("./fixtures/all-broken/", import.meta.url).pathname;
    const a = assembleIncident("container-oom", 1, { root });
    expect(a.state).toBe("refused");
    if (a.state !== "refused") return;
    expect(a.reason).toContain("every observation failed");
  });

  it("assembles when two of three slots failed, since one reading is a reading", () => {
    // Codex, chunk 2: the tests covered three failures and normal scenarios,
    // never the boundary the rule actually states. This is that boundary.
    const root = new URL("./fixtures/two-broken/", import.meta.url).pathname;
    const a = assembleIncident("container-oom", 1, { root });
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
    const a = assembleIncident("image-pull-failure", 1, { root: SCENARIOS });
    if (a.state !== "assembled") throw new Error("not assembled");
    expect(runnableAgents(a.incident).sort()).toEqual(["kubernetes", "logs"]);
  });

  it("refuses to build a context for a slot nothing was collected from", () => {
    const a = assembleIncident("image-pull-failure", 1, { root: SCENARIOS });
    if (a.state !== "assembled") throw new Error("not assembled");
    const r = assembleObservingContext("metrics", a.incident);
    expect(r.state).toBe("unavailable");
  });

  it("builds contexts that survive the provenance check for every scenario", () => {
    // The isolation property, checked across all five without spending anything.
    all.forEach((scenario, i) => {
      const a = assembleIncident(scenario, 1, { root: SCENARIOS });
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
    const a = assembleIncident("image-pull-failure", 1, { root: SCENARIOS });
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
    /*
     * Two findings, because the verdict below cites the image as its
     * contradicting evidence and a root cause result may only cite what an
     * agent actually reported. Until 2026-09-07 nothing checked that, so this
     * fixture cited a path no agent had ever mentioned and still recorded.
     */
    const k = recordAgentResult(a.incident, { agent: "kubernetes", status: "ok",
      findings: [{ fact: "OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" },
                 { fact: "the deployment image", source_ref: "deployment.image" }],
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

  /*
   * A subagent on 2026-09-07 followed one invented path all the way to a green
   * report. The root cause branch of checkAgainstObservation returned before the
   * findings loop — its comment said there was no slot to resolve against —
   * so a verdict citing `series[0].points[3].value` on an incident whose
   * metrics slot is null was recorded, concluded, promoted into
   * analysis.evidence, and then scored CORRECT, because must_cite pools
   * source_refs from every agent including this one. The agent that invents a
   * path satisfies the requirement to cite it.
   *
   * The prompt already said "Only cite what the agents reported" and "copy a
   * source_ref verbatim from an entry in agent_results". Nothing enforced it.
   */
  /*
   * Who was asked must be who answered.
   *
   * A subagent ran the generated node code end to end on 2026-09-07: the node
   * that had just asked the LOGS agent did not pass what it asked, so a reply
   * labelled `"agent": "kubernetes"` — citing a path that resolves in the
   * kubernetes slot — was recorded, and the chain concluded CONTAINER_OOM at
   * 85% with two kubernetes entries and no logs analysis at all. Conclude only
   * counts root_cause results, so nothing downstream noticed. A skipped agent
   * recorded as a successful step.
   */
  /*
   * Three state-machine holes a subagent found on 2026-09-07 by running the
   * sequences rather than reading them.
   */
  it("refuses to conclude an incident that has already concluded", () => {
    const first = concludeIncident(withAgents(VERDICT));
    expect(first.state, "the honest path must still work").toBe("concluded");
    if (first.state !== "concluded") return;

    const again = concludeIncident(first.incident);
    expect(again.state, "a second conclusion would replace a verdict silently").toBe("refused");
    if (again.state === "refused") expect(again.reason).toMatch(/not investigating/);

    // Every status that is not `investigating` is a conclusion of some kind,
    // including the honest refusal — re-concluding that replaces "no cause"
    // with an answer, which is the erasure this guards.
    for (const status of ["diagnosed", "closed", "failed", "insufficient_evidence"]) {
      const r = concludeIncident({ ...withAgents(VERDICT), status });
      expect(r.state, `${status} must not be concluded again`).toBe("refused");
    }
  });

  it("refuses a second result from an agent that has already reported", () => {
    /*
     * Recorded three times, all valid, until 2026-09-07 — and the thread then
     * told a reader that kubernetes had both failed and succeeded, because the
     * report counts agents with status error and that count was ATTEMPTS.
     */
    const a = assembleIncident("container-oom", 1, { root: SCENARIOS });
    if (a.state !== "assembled") throw new Error("not assembled");
    const reply = { agent: "kubernetes", status: "ok",
      findings: [{ fact: "OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
      hypotheses: [], confidence: 0.5 };

    const once = recordAgentResult(a.incident, reply);
    expect(once.state).toBe("recorded");
    if (once.state !== "recorded") return;

    const twice = recordAgentResult(once.incident, reply);
    expect(twice.state, "a retry is not a second agent").toBe("refused");
    if (twice.state === "refused") expect(twice.reason).toMatch(/already reported/);

    // A different agent is still welcome, or this refuses the whole chain.
    const other = recordAgentResult(once.incident, { agent: "logs", status: "no_data",
      findings: [], hypotheses: [], confidence: 0 });
    expect(other.state).toBe("recorded");
  });

  it("refuses a reply from an agent other than the one that was asked", () => {
    const a = assembleIncident("container-oom", 1, { root: SCENARIOS });
    if (a.state !== "assembled") throw new Error("not assembled");
    const asKubernetes = { agent: "kubernetes", status: "ok",
      findings: [{ fact: "OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
      hypotheses: [], confidence: 0.5 };

    const wrong = recordAgentResult(a.incident, asKubernetes, "logs");
    expect(wrong.state, "a kubernetes answer to a logs question must be refused").toBe("refused");
    if (wrong.state === "refused") expect(wrong.reason).toMatch(/logs was asked/);

    // The same reply, to the question it actually answers.
    expect(recordAgentResult(a.incident, asKubernetes, "kubernetes").state).toBe("recorded");
    // And a caller that does not know stays free to say nothing.
    expect(recordAgentResult(a.incident, asKubernetes).state).toBe("recorded");
  });

  /*
   * A citation must name something the observation carries, not something every
   * object has. A subagent probed this on 2026-09-07: `toString`,
   * `hasOwnProperty` and `pods[0].constructor` all resolved, so a finding
   * citing `toString` passed the check that exists to refuse a path pointing
   * nowhere — and was then stored as the working spelling a human is told to
   * follow.
   */
  it("refuses a citation that names a property every object has", () => {
    const obs = { pods: [{ phase: "Running" }], events: [], deployment: { image: "x" } };
    for (const ref of ["toString", "hasOwnProperty", "constructor", "pods[0].constructor",
                       "observation.toString", "valueOf"]) {
      expect(normaliseRef(obs, ref), `${ref} names nothing in the observation`).toBeNull();
    }
    // And real paths still resolve, or this refuses everything.
    for (const ref of ["pods[0].phase", "deployment.image", "events"]) {
      expect(normaliseRef(obs, ref), `${ref} is a real path and must resolve`).toBe(ref);
    }
    // length is an own property of an array and names a number a reader can
    // count. Kept on purpose; the defect was the shape that names nothing.
    expect(normaliseRef(obs, "pods.length")).toBe("pods.length");
  });

  it("refuses a root cause verdict citing a path no agent reported", () => {
    const bad = { ...VERDICT, findings: [{ fact: "invented", source_ref: "series[0].points[3].value" }],
      hypotheses: [] };
    expect(() => withAgents(bad), "an invented citation must not be recordable").toThrow(/no agent reported/);

    // And the honest case still records, or this refuses everything.
    const good = { ...VERDICT,
      findings: [{ fact: "OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" }] };
    expect(() => withAgents(good)).not.toThrow();
  });

  it("keeps contradicting findings as evidence against, rather than dropping them", () => {
    // A diagnosis that quietly discards what argues against it looks stronger
    // than it is, and the schema has a slot for exactly this.
    /*
     * The verdict must SAY the image contradicts it. Until 2026-09-07 `against`
     * was "every finding not in supported_by", so this fixture proved the
     * inference rather than the rule — and a neutral observation the verdict
     * merely did not cite was written into the document as an objection. The
     * test blessed the defect by calling that finding "the contradicting one"
     * when nothing had said it was.
     */
    const r = concludeIncident(withAgents({ ...VERDICT,
      findings: [...VERDICT.findings, { fact: "the deployment image did not change", source_ref: "deployment.image" }],
      hypotheses: [{ ...VERDICT.hypotheses[0], contradicted_by: ["deployment.image"] }] }));
    expect(r.state).toBe("concluded");
    if (r.state !== "concluded") return;
    const evidence = (r.incident.analysis as { evidence: Array<{ supports: string }> }).evidence;
    expect(evidence.some((e) => e.supports === "against"), "the contradicting finding was dropped").toBe(true);
  });
});

describe("an observation must have been gathered under the request we issued", () => {
  /*
   * Every test here goes through assembleIncident.
   *
   * Grok, 2026-09-05: five of the seven tests this replaces called the helper
   * directly, while the file's own comment said a helper-only test would not
   * notice the call being removed from assembly. So the check could have been
   * deleted from the merge path and the suite stayed green.
   */
  const withStamp = (root: string, over: Record<string, unknown> = {}) =>
    assembleIncident("container-oom", 1, { root, ...over });

  it("assembles every scenario, and every slot carries the issued collection", () => {
    // The happy path used to assert only that it assembled, so deleting the
    // check would have left it green. It reads the stamp now.
    for (const s of listScenarios(SCENARIOS)) {
      const a = assembleIncident(s, 1, { root: SCENARIOS });
      expect(a.state, `${s}: ${a.state === "refused" ? a.reason : ""}`).toBe("assembled");
      if (a.state !== "assembled") continue;

      const observations = a.incident.observations as Record<string, unknown>;
      const ids = new Set<string>();
      let collected = 0;
      for (const slot of ["kubernetes", "logs", "metrics"]) {
        const o = observations[slot];
        if (o === null) continue;
        collected += 1;
        const p = (o as { provenance?: Record<string, unknown> }).provenance;
        expect(p, `${s}/${slot} carries no provenance`).toBeDefined();
        expect(p!.requested_for, `${s}/${slot} names another incident`).toBe(a.incident.incident_id);
        expect(p!.cluster).toBe(a.incident.cluster);
        expect(p!.namespace).toBe(a.incident.namespace);
        ids.add(String(p!.collection_id));
      }
      expect(collected, `${s} collected nothing, so its provenance is vacuous`).toBeGreaterThan(0);
      expect(ids.size, `${s} slots came from ${ids.size} collections`).toBe(1);
      const first = [...ids].at(0) ?? "";
      expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("refuses a provider that stamps its answer with another collection", () => {
    // The fixture claims a collection and an incident it was not gathered
    // under. A provider contradicting its own request is refused rather than
    // quietly overwritten.
    const a = withStamp(new URL("./fixtures/wrong-incident/", import.meta.url).pathname);
    expect(a.state).toBe("refused");
    if (a.state !== "refused") return;
    expect(a.reason).toContain("INC-2026-0909");
  });

  it("refuses an answer whose stamp disagrees about the namespace", () => {
    // Grok, 2026-09-05, and then found again by a mutation: the provider used
    // to overwrite a claimed stamp with ours, which erased exactly the
    // disagreement worth knowing about. An answer agreeing about the collection
    // and naming another tenant's namespace was silently normalised.
    const a = withStamp(new URL("./fixtures/wrong-namespace/", import.meta.url).pathname);
    expect(a.state).toBe("refused");
    if (a.state !== "refused") return;
    expect(a.reason).toContain("another-tenant");
    expect(a.reason).toContain("namespace");
  });

  it("refuses a nothing that arrives with a foreign stamp", () => {
    // Codex, 2026-09-05: the sentinel was recognised before the stamp was
    // checked, so "we have nothing for you" was the one answer believed without
    // ever being looked at. An answer carrying both the sentinel and another
    // tenant's namespace became a trusted absence.
    const a = withStamp(new URL("./fixtures/nothing-but-foreign/", import.meta.url).pathname);
    expect(a.state).toBe("refused");
    if (a.state !== "refused") return;
    expect(a.reason).toContain("another-tenant");
  });

  it("refuses an answer that claims to come from another collector", () => {
    // Codex, 2026-09-05: the provider field was neither compared nor kept. An
    // answer saying where it came from was silently renamed into one of ours.
    const a = withStamp(new URL("./fixtures/foreign-provider/", import.meta.url).pathname);
    expect(a.state).toBe("refused");
    if (a.state !== "refused") return;
    expect(a.reason).toContain("somebody-elses-collector");
  });

  it("writes the three collection answers into the document itself", () => {
    // Codex, 2026-09-05, High: the failures were handed back beside the
    // incident, so anything reading the document alone saw null and could not
    // tell "the provider looked and found nothing" from "nobody looked". An
    // unchecked source is not a clean source.
    const root = new URL("./fixtures/two-broken/", import.meta.url).pathname;
    const a = assembleIncident("container-oom", 1, { root });
    expect(a.state, a.state === "refused" ? a.reason : "").toBe("assembled");
    if (a.state !== "assembled") return;

    const c = a.incident.collection as Record<string, { state: string; kind?: string; reason?: string } | undefined>;
    const at = (slot: string) => c[slot] ?? { state: "(missing)", kind: undefined, reason: undefined };
    expect(at("kubernetes").state).toBe("collected");
    for (const slot of ["logs", "metrics"]) {
      expect(at(slot).state, `${slot} was unreadable and the document must say so`).toBe("failed");
      expect(at(slot).kind).toBe("unreadable");
      expect(at(slot).reason, `${slot} must carry why`).toContain("not JSON");
    }
  });

  it("records an established absence as nothing, not as a failure", () => {
    // The other half. If both became "failed" the document would be honest and
    // useless; if both became "nothing" it would be readable and wrong.
    const root = new URL("./fixtures/partial/", import.meta.url).pathname;
    const a = assembleIncident("container-oom", 1, { root });
    expect(a.state, a.state === "refused" ? a.reason : "").toBe("assembled");
    if (a.state !== "assembled") return;
    const c = a.incident.collection as Record<string, { state: string } | undefined>;
    expect(c.metrics?.state, "the fixture says __nothing explicitly").toBe("nothing");
    expect(c.logs?.state, "the file is simply not there").toBe("failed");
  });

  it("stamps from the request rather than reading the answer", () => {
    // Two runs of one scenario share a collection; two scenarios do not. If the
    // id came from the payload, both would be whatever the file said.
    const one = assembleIncident("container-oom", 1, { root: SCENARIOS });
    const again = assembleIncident("container-oom", 1, { root: SCENARIOS });
    const other = assembleIncident("cpu-throttling", 1, { root: SCENARIOS });
    if (one.state !== "assembled" || again.state !== "assembled" || other.state !== "assembled") throw new Error("x");
    const idOf = (i: Record<string, unknown>) => {
      const k = (i.observations as Record<string, { provenance?: { collection_id?: string } } | null>).kubernetes;
      return String(k?.provenance?.collection_id ?? "");
    };
    expect(idOf(one.incident)).toBe(idOf(again.incident));
    expect(idOf(one.incident)).not.toBe(idOf(other.incident));
  });

  it("refuses a collection id that is not a real one", () => {
    const a = assembleIncident("container-oom", 1, { root: SCENARIOS, collectionId: "not-a-uuid" });
    expect(a.state).toBe("refused");
    if (a.state !== "refused") return;
    expect(a.reason).toContain("must be a uuid");
  });

  it("checks the namespace, not only the cluster", () => {
    // Grok, 2026-09-05: namespace was required by the schema and read by
    // nothing, while it is the field that actually partitions tenant data.
    const request = { collection_id: "aaaaaaaa-0000-4000-8000-000000000000",
      incident_id: "INC-2026-0101", cluster: "prod-eu", namespace: "production" };
    const stamped = (over: Record<string, unknown>) => ({
      kubernetes: { state: "collected" as const, slot: "kubernetes" as const,
        data: { provenance: { ...request, requested_for: request.incident_id, provider: "x", ...over } } },
      logs: { state: "nothing" as const, slot: "logs" as const },
      metrics: { state: "nothing" as const, slot: "metrics" as const },
    });
    expect(checkProvenance(stamped({}), request)).toBeNull();
    expect(checkProvenance(stamped({ namespace: "another-tenant" }), request)).toContain("namespace another-tenant");
    expect(checkProvenance(stamped({ cluster: "staging-us" }), request)).toContain("cluster staging-us");
    expect(checkProvenance(stamped({ collection_id: "bbbbbbbb-0000-4000-8000-000000000000" }), request)).toContain("not the aaaaaaaa");
  });

  it("refuses a null stamp rather than throwing on it", () => {
    // Grok, 2026-09-05: null is not undefined, so the missing-provenance branch
    // was skipped and the next line threw. A crash is not a refusal.
    const request = { collection_id: "aaaaaaaa-0000-4000-8000-000000000000",
      incident_id: "INC-2026-0101", cluster: "prod-eu", namespace: "production" };
    const obs = {
      kubernetes: { state: "collected" as const, slot: "kubernetes" as const, data: { provenance: null } },
      logs: { state: "nothing" as const, slot: "logs" as const },
      metrics: { state: "nothing" as const, slot: "metrics" as const },
    };
    expect(() => checkProvenance(obs, request)).not.toThrow();
    expect(checkProvenance(obs, request)).toContain("no provenance");
  });

  it("says nothing was established when nothing was collected", () => {
    // One collected slot used to make the collection check vacuously true.
    const request = { collection_id: "aaaaaaaa-0000-4000-8000-000000000000",
      incident_id: "INC-2026-0101", cluster: "prod-eu", namespace: "production" };
    const none = {
      kubernetes: { state: "nothing" as const, slot: "kubernetes" as const },
      logs: { state: "nothing" as const, slot: "logs" as const },
      metrics: { state: "nothing" as const, slot: "metrics" as const },
    };
    expect(checkProvenance(none, request)).toContain("nothing whose provenance could be established");
  });
});

describe("a path spelled with the wrapper it came in", () => {
  /*
   * Measured on the fourth live run, 2026-09-06: the model wrote
   * `observation.events[0].message` and the answer was refused. Every prompt
   * warns against the prefix twice, and it happened anyway, because the object
   * the model is looking at is literally called `observation`.
   *
   * The first fix stripped the prefix inside the resolver. Both reviewers
   * refused it: the stored citation stayed unfollowable, so the check and the
   * audit trail disagreed. What is normalised is the SPELLING, and the spelling
   * that works is what gets written down.
   */
  const observation = { events: [{ message: "Failed to pull image" }], pods: [{ name: "p" }] };

  it("accepts the wrapper spelling and answers with the one that resolves", () => {
    expect(normaliseRef(observation, "events[0].message")).toBe("events[0].message");
    expect(normaliseRef(observation, "observation.events[0].message")).toBe("events[0].message");
  });

  it("still refuses a path that resolves to nothing, however it is spelled", () => {
    expect(normaliseRef(observation, "observation.events[3].message")).toBeNull();
    expect(normaliseRef(observation, "observation.nowhere")).toBeNull();
    expect(normaliseRef(observation, "nowhere")).toBeNull();
  });

  it("refuses the wrapper on its own, which names everything and so names nothing", () => {
    // Codex, 2026-09-06: an empty remainder resolves to the whole observation.
    expect(normaliseRef(observation, "observation.")).toBeNull();
    expect(normaliseRef(observation, "")).toBeNull();
  });

  it("prefers a field genuinely called observation over the alias", () => {
    // Grok: startsWith cannot tell an envelope prefix from a real field name,
    // so the literal path is tried first and a real field is never shadowed.
    const nested = { observation: { note: "the real one" }, note: "the root one" };
    expect(normaliseRef(nested, "observation.note")).toBe("observation.note");
    expect(resolveRef(nested, normaliseRef(nested, "observation.note")!)).toBe("the real one");
  });

  it("writes the working spelling into the incident, not the one the model sent", () => {
    /*
     * The point of the whole change. A citation the machine approved and a
     * human cannot follow is worse than a refusal — the refusal at least says
     * something is wrong.
     */
    const result = {
      agent: "kubernetes", status: "ok",
      findings: [{ fact: "an image could not be pulled", source_ref: "observation.events[0].message" }],
      hypotheses: [{ code: "IMAGE_PULL_FAILURE", statement: "s", supported_by: ["observation.events[0].message"] }],
      confidence: 0.8,
    };
    const r = withResolvedRefs(observation, result);
    expect(r.state).toBe("rewritten");
    if (r.state !== "rewritten") return;
    const out = r.result as typeof result;
    expect(out.findings[0]!.source_ref, "the stored citation must resolve").toBe("events[0].message");
    expect(out.hypotheses[0]!.supported_by, "supported_by must travel with it").toEqual(["events[0].message"]);
    expect(resolveRef(observation, out.findings[0]!.source_ref)).toBe("Failed to pull image");
    expect(r.changed, "and it must say how many it rewrote").toBe(1);
  });

  it("counts every rewritten finding, not every distinct spelling", () => {
    /*
     * Codex, 2026-09-06: the count was `rewritten.size`, the number of distinct
     * spellings. Two findings carrying the same wrapper-prefixed citation are
     * both rewritten and reported one — the metric is how many citations the
     * model wrote wrong, and it must not shrink because it repeated itself.
     * The earlier test asserted only "greater than zero" and could not see it.
     */
    const twice = {
      agent: "kubernetes", status: "ok",
      findings: [
        { fact: "one", source_ref: "observation.events[0].message" },
        { fact: "and again", source_ref: "observation.events[0].message" },
      ],
      hypotheses: [], confidence: 0.5,
    };
    const r = withResolvedRefs(observation, twice);
    expect(r.state).toBe("rewritten");
    if (r.state !== "rewritten") return;
    expect(r.changed, "two findings were rewritten, however many spellings that was").toBe(2);
  });

  it("stores the working spelling through recordAgentResult, not only in the helper", () => {
    /*
     * The mutation for this survived a test that called the helper directly:
     * replacing the call inside recordAgentResult changed nothing the test
     * looked at. What matters is what ends up in the incident.
     */
    const a = assembleIncident("image-pull-failure", 1, {});
    expect(a.state, a.state === "refused" ? a.reason : "").toBe("assembled");
    if (a.state !== "assembled") return;

    const obs = (a.incident.observations as Record<string, unknown>)["kubernetes"] as Record<string, unknown>;
    const events = obs["events"] as Array<Record<string, unknown>>;
    expect(events.length, "the fixture must have an event to cite").toBeGreaterThan(0);

    const r = recordAgentResult(a.incident, {
      agent: "kubernetes", status: "ok",
      findings: [{ fact: "an image could not be pulled", source_ref: "observation.events[0].message" }],
      hypotheses: [{ code: "IMAGE_PULL_FAILURE", statement: "s", supported_by: ["observation.events[0].message"] }],
      confidence: 0.8,
    });
    expect(r.state, r.state === "refused" ? `${r.reason} ${JSON.stringify(r.errors)}` : "").toBe("recorded");
    if (r.state !== "recorded") return;

    const stored = ((r.incident.analysis as Record<string, unknown>)["agents"] as Array<Record<string, unknown>>)[0]!;
    const ref = (stored["findings"] as Array<Record<string, unknown>>)[0]!["source_ref"];
    expect(ref, "the incident must carry the spelling that resolves").toBe("events[0].message");
    expect(resolveRef(obs, String(ref)), "and it must lead somewhere").toBeDefined();
  });

  it("leaves a result alone when nothing needed rewriting", () => {
    const result = { agent: "kubernetes", status: "ok",
      findings: [{ fact: "f", source_ref: "events[0].message" }], hypotheses: [], confidence: 0.5 };
    const r = withResolvedRefs(observation, result);
    expect(r.state).toBe("rewritten");
    if (r.state !== "rewritten") return;
    expect(r.result).toBe(result);
    expect(r.changed, "nothing changed, and it says so").toBe(0);
  });

  it("refuses rather than storing a citation it could not rewrite", () => {
    /*
     * Codex, 2026-09-06: this used to fail open. A citation that could not be
     * normalised was left as it was, and the incident then carried a path
     * nobody can follow. "Could not rewrite" is not "nothing to rewrite", and
     * the case where they differ is exactly the case where silence is worst:
     * being handed the wrong observation.
     */
    const result = { agent: "kubernetes", status: "ok",
      findings: [{ fact: "f", source_ref: "observation.nowhere" }], hypotheses: [], confidence: 0.5 };
    const r = withResolvedRefs(observation, result);
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("observation.nowhere");
  });

  it("carries the rewrite into contradicted_by as well as supported_by", () => {
    // Codex, same review: the comment promised both lists and the code moved
    // one, so a normalised finding named in contradicted_by made the incident
    // invalid the moment it was attached.
    const result = {
      agent: "kubernetes", status: "ok",
      findings: [{ fact: "f", source_ref: "observation.events[0].message" }],
      hypotheses: [{ code: "IMAGE_PULL_FAILURE", statement: "s",
        supported_by: ["observation.events[0].message"],
        contradicted_by: ["observation.events[0].message"] }],
      confidence: 0.8,
    };
    const r = withResolvedRefs(observation, result);
    expect(r.state).toBe("rewritten");
    if (r.state !== "rewritten") return;
    const h = (r.result.hypotheses as Array<Record<string, unknown>>)[0]!;
    expect(h.supported_by).toEqual(["events[0].message"]);
    expect(h.contradicted_by, "contradicted_by must travel too").toEqual(["events[0].message"]);
  });
});

/*
 * Collection goes through the Provider contract, and that is what makes
 * checkProvenance's refusals reachable at all.
 *
 * assembleIncident called readScenario from the fixture implementation
 * directly, so every collected observation arriving at checkProvenance had just
 * been stamped from that exact request — its five disagreement refusals could
 * not fire from this entry point under any fixture on disk. The comment above
 * that call said so. A check that is written and unreachable from the entry
 * point that matters is the shape this project keeps finding elsewhere.
 *
 * A subagent costed the change on 2026-09-07 and its verdict is what these
 * tests spend: the deployed workflow gains nothing — incidents are assembled at
 * generate time and inlined — so what is bought is exactly this reachability.
 */
describe("observations are collected through the provider contract", () => {
  const request = { collection_id: "aaaaaaaa-0000-4000-8000-000000000000" };
  void request;

  it("builds the same incident through the contract as it did through the implementation", () => {
    // The default path is a fixtureProvider, so nothing changed for any caller.
    const a = assembleIncident("container-oom", 1, { root: SCENARIOS });
    expect(a.state).toBe("assembled");
    if (a.state !== "assembled") return;
    const b = assembleIncident("container-oom", 1, { root: SCENARIOS, provider: fixtureProvider(SCENARIOS) });
    expect(b.state).toBe("assembled");
    if (b.state !== "assembled") return;
    expect(JSON.stringify(b.incident)).toBe(JSON.stringify(a.incident));
  });

  it("refuses a provider that returns an observation with no provenance", () => {
    /*
     * The refusal that could not fire. This provider does what a real one
     * would if it built its own Observation instead of going through readSlot:
     * it hands back data with no stamp at all.
     */
    const unstamped = {
      name: "no-stamp", exercised: true, unexercisedBecause: "",
      read: (_scenario: string, slot: "kubernetes" | "logs" | "metrics") =>
        ({ state: "collected" as const, slot, data: { pods: [], events: [], deployment: {} } }),
    };
    const r = assembleIncident("container-oom", 1, { root: SCENARIOS, provider: unstamped });
    expect(r.state, "an unstamped observation must not become an incident").toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toMatch(/provenance/i);
  });

  it("refuses a provider that answers about a different slot than the one asked for", () => {
    /*
     * One line away from real: kubernetesProvider is declared `read():
     * Observation` and returns slot "kubernetes" whatever it is asked about.
     * Filing that under the slot we asked for would make one provider's
     * confusion look like three collections.
     */
    const confused = {
      name: "always-kubernetes", exercised: true, unexercisedBecause: "",
      read: (_scenario: string, _slot: "kubernetes" | "logs" | "metrics") =>
        ({ state: "nothing" as const, slot: "kubernetes" as const }),
    };
    const r = assembleIncident("container-oom", 1, { root: SCENARIOS, provider: confused });
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toMatch(/answered about kubernetes when asked for logs/);
  });
});
