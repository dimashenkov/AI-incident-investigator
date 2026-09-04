/**
 * What an agent is given, before any model sees it.
 *
 * Codex, first review of the plan: "Model-output assertions alone are
 * insufficient because a model may ignore leaked data." A model handed another
 * incident's data that happened not to mention it would pass an output test
 * while the leak sat there in the prompt. So the assembled context is the thing
 * under test, and none of this costs anything to run.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  assembleObservingContext, assembleRootCauseContext, checkProvenance,
  foreignIncidentIds, deepDiffPaths, readPrompt, OBSERVING_AGENTS, AGENT_SLOT, type AgentName,
} from "../src/agents/context.js";

const SCENARIOS = new URL("../scenarios/", import.meta.url).pathname;
const K8S = JSON.parse(readFileSync(`${SCENARIOS}container-oom/kubernetes.json`, "utf8"));
const LOGS = JSON.parse(readFileSync(`${SCENARIOS}container-oom/logs.json`, "utf8"));
const METRICS = JSON.parse(readFileSync(`${SCENARIOS}container-oom/metrics.json`, "utf8"));

const AGENT_RESULT = {
  agent: "kubernetes", status: "ok",
  findings: [{ fact: "OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
  hypotheses: [{ code: "CONTAINER_OOM", statement: "memory limit exceeded", supported_by: ["pods[0].containers[0].last_state.terminated.reason"] }],
  confidence: 0.9,
};

const incident = (id: string, over: Record<string, unknown> = {}) => ({
  incident_id: id,
  observations: { kubernetes: K8S, logs: LOGS, metrics: METRICS },
  analysis: { agents: [AGENT_RESULT] },
  ...over,
});

/**
 * What each prompt must instruct.
 *
 * Codex, chunk 2: asserting that a word appears in a file establishes nothing —
 * "findings do not need a source_ref" would satisfy a substring check for
 * source_ref. Each prompt therefore declares its rules as ids, and the test
 * requires both the id and the prose that carries it. Removing an instruction
 * means removing its id, and the test fails; leaving the id while deleting the
 * prose fails too.
 */
const REQUIRED_RULES: Record<string, Array<{ id: string; prose: RegExp }>> = {
  kubernetes: [
    { id: "finding-needs-source-ref", prose: /Every finding needs a `source_ref`/ },
    { id: "no-data-is-an-answer", prose: /status: "no_data"/ },
    { id: "error-is-not-no-data", prose: /must not arrive as the same one|different answers/ },
    { id: "do-not-diagnose", prose: /Do not diagnose/ },
    { id: "hypothesis-cites-own-findings", prose: /Every hypothesis needs `supported_by`/ },
  ],
  logs: [
    { id: "finding-needs-source-ref", prose: /Every finding needs a `source_ref`/ },
    { id: "no-data-is-an-answer", prose: /status: "no_data"/ },
    { id: "error-is-not-no-data", prose: /status: "error"/ },
    { id: "do-not-diagnose", prose: /Do not diagnose/ },
    { id: "truncation-limits-conclusions", prose: /truncated/ },
    { id: "window-limits-conclusions", prose: /`window`/ },
  ],
  metrics: [
    { id: "finding-needs-source-ref", prose: /Every finding needs a `source_ref`/ },
    { id: "no-data-is-an-answer", prose: /status: "no_data"/ },
    { id: "error-is-not-no-data", prose: /Could-not-read and found-nothing/ },
    { id: "do-not-diagnose", prose: /Do not diagnose/ },
    { id: "state-the-unit", prose: /Always state the unit/ },
  ],
  "root-cause": [
    { id: "insufficient-evidence-is-an-answer", prose: /`INSUFFICIENT_EVIDENCE` is a real answer/ },
    { id: "record-contradicting-evidence", prose: /Contradicting evidence is recorded, not dropped/ },
    { id: "lower-confidence-on-conflict", prose: /Lower the confidence when evidence conflicts/ },
    { id: "cite-only-what-agents-reported", prose: /Only cite what the agents reported/ },
    { id: "error-is-not-no-data", prose: /is not an agent that found nothing/ },
  ],
};

describe("every prompt carries the rules its schema will enforce", () => {
  it("finds a prompt file for every agent", () => {
    for (const agent of [...OBSERVING_AGENTS, "root-cause"] as AgentName[]) {
      expect(readPrompt(agent), `no prompt for ${agent}`).toBeTruthy();
    }
  });

  for (const [agent, rules] of Object.entries(REQUIRED_RULES)) {
    it(`states every required rule in the ${agent} prompt, in both id and prose`, () => {
      const p = readPrompt(agent as AgentName)!;
      for (const rule of rules) {
        expect(p, `${agent}: rule id ${rule.id} is not declared`).toContain(`\`${rule.id}\``);
        expect(rule.prose.test(p), `${agent}: rule ${rule.id} has no prose behind its id`).toBe(true);
      }
    });
  }

  it("declares no rule id that no test knows about", () => {
    // A prompt could otherwise grow an id that looks checked and is not.
    for (const [agent, rules] of Object.entries(REQUIRED_RULES)) {
      const declared = [...readPrompt(agent as AgentName)!.matchAll(/^- `([a-z-]+)`$/gm)].map((m) => m[1]);
      expect(declared.sort(), `${agent} declares ids no test covers`).toEqual(rules.map((r) => r.id).sort());
    }
  });

  it("requires the root cause agent to cite only what agents reported", () => {
    // The rule Codex found missing from the tests entirely. Named statically
    // because a mutation points at it, and a name built inside a loop cannot be
    // found in the source by that check.
    const p = readPrompt("root-cause")!;
    const rule = REQUIRED_RULES["root-cause"]!.find((r) => r.id === "cite-only-what-agents-reported")!;
    expect(p, "the rule id is not declared").toContain("`cite-only-what-agents-reported`");
    expect(rule.prose.test(p), "the rule id is declared but its prose is gone").toBe(true);
  });
});

describe("an agent receives one incident and one slot", () => {
  it("gives an observing agent only the slot it reads", () => {
    const r = assembleObservingContext("logs", incident("INC-2026-0001"));
    expect(r.state).toBe("assembled");
    if (r.state !== "assembled") return;
    expect(r.payload.observation).toEqual(LOGS);
    // The other two slots must not be there at all — not empty, absent.
    expect(JSON.stringify(r.payload)).not.toContain("OOMKilled");
    expect(JSON.stringify(r.payload)).not.toContain("container_memory_working_set_bytes");
  });

  it("copies only what was asked for, so an unknown field cannot ride along", () => {
    // An allow-list cannot be surprised by a field nobody thought of, because it
    // never copies one. A deny-list would have to anticipate every one of them.
    const withExtra = incident("INC-2026-0001", { secret_notes: "INC-2026-0009 was worse" });
    const r = assembleObservingContext("kubernetes", withExtra);
    expect(r.state).toBe("assembled");
    if (r.state !== "assembled") return;
    expect(Object.keys(r.payload).sort()).toEqual(["incident_id", "observation"]);
    expect(JSON.stringify(r.payload)).not.toContain("INC-2026-0009");
  });

  it("refuses rather than guessing when the slot was never collected", () => {
    const r = assembleObservingContext("metrics", incident("INC-2026-0001", {
      observations: { kubernetes: K8S, logs: LOGS, metrics: null },
    }));
    expect(r.state).toBe("unavailable");
    if (r.state !== "unavailable") return;
    expect(r.reason).toContain("nothing was collected");
  });

  it("refuses an incident with no id, since nothing could be checked afterwards", () => {
    const { incident_id, ...rest } = incident("INC-2026-0001");
    const r = assembleObservingContext("logs", rest as Record<string, unknown>);
    expect(r.state).toBe("unavailable");
  });

  it("gives the root cause agent the agent results and NOT the observations", () => {
    // It must weigh what the agents reported. Handing it the raw observations
    // would let it introduce a fact with nothing behind it to trace.
    const r = assembleRootCauseContext(incident("INC-2026-0001"));
    expect(r.state).toBe("assembled");
    if (r.state !== "assembled") return;
    expect(Object.keys(r.payload).sort()).toEqual(["agent_results", "incident_id"]);
    expect(JSON.stringify(r.payload)).not.toContain("container_memory_working_set_bytes");
  });

  it("refuses to ask for a conclusion when no agent ran", () => {
    const r = assembleRootCauseContext(incident("INC-2026-0001", { analysis: { agents: [] } }));
    expect(r.state).toBe("unavailable");
    if (r.state !== "unavailable") return;
    expect(r.reason).toContain("no agent results");
  });
});

describe("isolation is proved by provenance, not by recognising anything", () => {
  it("passes a context that is exactly the slice it was supposed to be", () => {
    const inc = incident("INC-2026-0001");
    expect(checkProvenance(assembleObservingContext("kubernetes", inc), inc)).toEqual({ state: "clean" });
  });

  it("catches foreign content that looks like nothing we know", () => {
    // Codex, chunk 2: the previous check matched an INC pattern and therefore
    // reported clean for a copied log line carrying another customer's
    // password. Provenance does not need to recognise the leak — anything that
    // was not in the slice makes the payload differ from what it should be.
    const inc = incident("INC-2026-0001");
    const leaked = assembleObservingContext("logs", inc);
    expect(leaked.state).toBe("assembled");
    if (leaked.state !== "assembled") return;
    (leaked.payload.observation as { lines: unknown[] }).lines.push({
      ts: "2026-09-04T10:00:00Z", level: "info", container: "other",
      message: "customer B database password is hunter2",
    });
    const r = checkProvenance(leaked, inc);
    expect(r.state, "a leak with no recognisable pattern must still be caught").toBe("foreign");
  });

  it("catches a foreign incident id too, since that also departs from the slice", () => {
    const inc = incident("INC-2026-0001");
    const ctx = assembleObservingContext("kubernetes", inc);
    if (ctx.state !== "assembled") throw new Error("not assembled");
    (ctx.payload as Record<string, unknown>).also = "see INC-2026-0009";
    expect(checkProvenance(ctx, inc).state).toBe("foreign");
  });

  it("names where the payload departed, not merely that it did", () => {
    const inc = incident("INC-2026-0001");
    const ctx = assembleObservingContext("metrics", inc);
    if (ctx.state !== "assembled") throw new Error("not assembled");
    (ctx.payload.observation as { series: Array<{ unit: string }> }).series[0]!.unit = "furlongs";
    const r = checkProvenance(ctx, inc);
    expect(r.state).toBe("foreign");
    if (r.state !== "foreign") return;
    expect(r.paths[0]).toContain("/observation/series/0/unit");
  });

  it("reports unchecked, not clean, when the context could not be assembled", () => {
    // Nothing to inspect is not the absence of a leak. Reporting clean here
    // would mean a context that was never built passes the isolation check.
    const inc = incident("INC-2026-0001", { observations: { kubernetes: K8S, logs: LOGS, metrics: null } });
    expect(checkProvenance(assembleObservingContext("metrics", inc), inc).state).toBe("unchecked");
  });

  it("does not let a later mutation of the incident change a checked context", () => {
    // Codex, chunk 2: the payload used to hold a live reference into the
    // incident, so data could travel after the check that was meant to stop it.
    const inc = incident("INC-2026-0001");
    const ctx = assembleObservingContext("logs", inc);
    if (ctx.state !== "assembled") throw new Error("not assembled");
    (inc.observations.logs as { lines: unknown[] }).lines.push({ ts: "x", level: "info", container: "c", message: "INC-2026-0009" });
    expect(JSON.stringify(ctx.payload)).not.toContain("INC-2026-0009");
  });

  it("ignores an inherited slot, which no one put in the incident", () => {
    const base = { observations: { kubernetes: { poisoned: true } } };
    const inc = Object.create(base) as Record<string, unknown>;
    inc.incident_id = "INC-2026-0001";
    const r = assembleObservingContext("kubernetes", inc);
    expect(r.state).toBe("unavailable");
  });

  it("keeps the id scan as a separate, weaker check that says what it is", () => {
    // It catches one specific mistake quickly. It is not evidence of isolation,
    // and the name says so.
    expect(foreignIncidentIds({ a: "INC-2026-0009" }, "INC-2026-0001")).toEqual(["INC-2026-0009"]);
    expect(foreignIncidentIds({ "INC-2026-0007": 1 }, "INC-2026-0001")).toEqual(["INC-2026-0007"]);
    expect(foreignIncidentIds({ a: [[["INC-2026-0001"]]] }, "INC-2026-0001")).toEqual([]);
    // ...and it cannot see this at all, which is why it is not the main check.
    expect(foreignIncidentIds({ a: "customer B password hunter2" }, "INC-2026-0001")).toEqual([]);
  });

  it("reports a length change in an array rather than only element differences", () => {
    expect(deepDiffPaths([1, 2], [1, 2, 3])).toContain("/(length)");
  });

  it("maps every observing agent to a distinct slot, and root cause to none", () => {
    const slots = OBSERVING_AGENTS.map((a) => AGENT_SLOT[a]);
    expect(new Set(slots).size).toBe(OBSERVING_AGENTS.length);
    expect(AGENT_SLOT["root-cause"]).toBeNull();
  });
});
