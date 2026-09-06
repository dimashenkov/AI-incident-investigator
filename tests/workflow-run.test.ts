/**
 * The generated workflow, executed locally against a stubbed model.
 *
 * This is the test that would have told me the deployed workflow does not work,
 * and there was none: the previous suite proved the workflow FILE matched a
 * fresh generation, which is a statement about bytes, not about behaviour.
 *
 * Each Code node's body is run in a sandbox holding exactly what n8n gives it —
 * `$input.all()` and, for the Set nodes, the named earlier item. Nothing here
 * calls a model: the stub answers from the payload it is handed, so a run that
 * "passes" because the answer was planted cannot happen.
 */
import { describe, it, expect } from "vitest";
import { runScenario, STUB_AGENTS, envelope, runSetExpression, newHistory } from "./helpers/run-workflow.js";
import { listScenarios } from "../src/providers/fixtures.js";

const SCENARIOS = new URL("../scenarios/", import.meta.url).pathname;

describe("the generated workflow investigates, not merely validates", () => {
  it("carries every scenario, so none can be quietly missing from the deployment", async () => {
    const { incidents } = await runScenario.runtime();
    expect(Object.keys(incidents).sort()).toEqual(listScenarios(SCENARIOS).sort());
  });

  it("refuses a scenario it does not carry, and says which it has", async () => {
    const r = await runScenario("no-such-scenario");
    expect(r.state).toBe("refused");
    expect(r.reason).toContain("container-oom");
  });

  it("runs container-oom end to end and concludes", async () => {
    const r = await runScenario("container-oom");
    expect(r.state, r.state === "refused" ? `${r.reason} ${JSON.stringify(r.errors)}` : "").toBe("concluded");
    if (r.state !== "concluded") return;
    expect(r.root_cause_code).toBe("CONTAINER_OOM");
    expect(Array.isArray(r.evidence) && r.evidence.length, "a conclusion with no evidence").toBeGreaterThan(0);
  });

  it("stops on an answer the schema refuses, rather than carrying on without it", async () => {
    // The dangerous shape is a chain that skips an agent and still concludes:
    // the verdict then rests on less than it claims, and nothing says so.
    const r = await runScenario("container-oom", {
      ...STUB_AGENTS,
      logs: () => ({ agent: "logs", status: "ok", findings: [{ fact: "x" }], hypotheses: [], confidence: 0.5 }),
    });
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.agent).toBe("logs");
    expect(r.reason).toContain("does not validate");
  });

  it("stops when an agent returns nothing readable", async () => {
    const r = await runScenario("container-oom", { ...STUB_AGENTS, metrics: () => null });
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("metrics");
  });

  it("gives each agent only its own slot, and the root cause agent no observations at all", async () => {
    const seen: Record<string, unknown> = {};
    await runScenario("container-oom", {
      ...STUB_AGENTS,
      kubernetes: (payload) => { seen.kubernetes = payload; return STUB_AGENTS.kubernetes!(payload); },
      "root-cause": (payload) => { seen.rootCause = payload; return STUB_AGENTS["root-cause"]!(payload); },
    });
    const k = seen.kubernetes as Record<string, unknown>;
    expect(Object.keys(k).sort()).toEqual(["incident_id", "observation"]);
    const rc = seen.rootCause as Record<string, unknown>;
    expect(Object.keys(rc).sort()).toEqual(["agent_results", "incident_id"]);
    expect(JSON.stringify(rc), "the root cause agent must not receive observations").not.toContain("collected_at");
  });

  it("skips an agent whose slot holds an established absence, rather than refusing the incident", async () => {
    /*
     * Measured on the first live run, 2026-09-05: two scenarios declare
     * "__nothing" for metrics on purpose, and the whole incident was refused
     * because one of three agents had nothing to read. An established absence
     * is an answer; refusing over it throws away the agents that did have
     * something — and, before the gate existed, it also kept spending.
     */
    for (const scenario of ["image-pull-failure", "insufficient-evidence"]) {
      const r = await runScenario(scenario);
      expect(r.state, r.state === "refused" ? String(r.reason) : "").toBe("concluded");
    }
  });

  it("refuses a slot that could not be read, rather than skipping it like an absence", async () => {
    /*
     * The case that separates the two ways of deciding a skip.
     *
     * Codex, 2026-09-05: keying on the words "nothing was collected" in a
     * reason string makes any failure phrased that way into a skip. A slot
     * nobody could READ produces exactly that phrase — the observation is null
     * either way — so the substring version quietly skips a broken provider and
     * concludes without it. The document's own collection record says "failed"
     * there and "nothing" for a declared absence, and that is what is asked.
     */
    const r = await runScenario("container-oom", STUB_AGENTS, "../fixtures/two-broken/");
    expect(r.state, "a slot that could not be read must not be treated as an absence").toBe("refused");
    if (r.state !== "refused") return;
    expect(String(r.reason)).toContain("logs");
  });

  it("refuses, never skips, when the agent that reads no slot cannot be given a context", async () => {
    /*
     * Grok, 2026-09-06: the root cause agent reads no observation slot, so
     * AGENT_SLOT gives null and collection[null] is undefined — the branch
     * refused for the right reason by accident. A line correct by luck is a
     * line nobody can reason about, and the day a slot record is keyed
     * differently it would start skipping the one agent that must always run.
     */
    const { workflow } = await runScenario.generated();
    const record = workflow.nodes.find((n: { name: string }) => n.name === "Record metrics");
    const run = (json: Record<string, unknown>) =>
      (new Function("$input", `"use strict";\n${record.parameters.jsCode}`) as (i: unknown) => Array<{ json: Record<string, unknown> }>)(
        { all: () => [{ json }] },
      )[0]!.json;

    // An incident with no agent results at all: the root cause context cannot
    // assemble, and there is nothing to weigh.
    const out = run({ state: "skipped", scenario: "x",
      incident: { incident_id: "INC-2026-0101", analysis: { agents: [] }, collection: {} } });
    expect(out.state, "the agent that weighs the others must never be skipped").toBe("refused");
    expect(String(out.reason)).toContain("reads no observation slot");
  });

  it("counts the citations it had to normalise, so an ignored instruction still shows", async () => {
    /*
     * Grok, 2026-09-06: a refused source_ref used to be the only evidence that
     * a model had ignored an instruction given twice in its own words.
     * Normalising it away makes obeyed and ignored look identical. The answer
     * is not to go back to refusing — it is to keep counting.
     */
    const obedient = await runScenario("container-oom");
    expect(obedient.state).toBe("concluded");
    expect(obedient.normalised, "the stub writes plain paths").toBe(0);

    const wrapping = await runScenario("container-oom", {
      ...STUB_AGENTS,
      kubernetes: (payload) => {
        const answer = STUB_AGENTS.kubernetes!(payload) as Record<string, unknown>;
        const findings = (answer.findings as Array<Record<string, unknown>>)
          .map((f) => ({ ...f, source_ref: `observation.${String(f.source_ref)}` }));
        return { ...answer, findings, hypotheses: [] };
      },
    });
    expect(wrapping.state, wrapping.state === "refused" ? String(wrapping.reason) : "").toBe("concluded");
    expect(wrapping.normalised, "a wrapper-spelled citation must still be counted").toBeGreaterThan(0);
  });

  it("stops when the model answers with something that is not JSON", async () => {
    // The most likely real failure, and the one a stub that always returns an
    // object cannot produce: the model writes prose, or fences the JSON.
    const r = await runScenario("container-oom", {
      ...STUB_AGENTS,
      logs: () => "here is what I found:" as unknown as null,
    });
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.agent).toBe("logs");
  });
});

describe("the Set node that joins the answer back to the incident", () => {
  /*
   * It is ours, it is an n8n expression rather than code, and nothing tested
   * it: the harness used to do its job instead. Codex, 2026-09-05 — an
   * expression error, a changed response envelope or a broken item link would
   * all have passed.
   */
  const collectNode = async (agent: string) => {
    const { workflow } = await runScenario.generated();
    return workflow.nodes.find((n: { name: string }) => n.name === `Collect ${agent}`);
  };

  it("puts the previous item back and hangs the parsed answer beside it", async () => {
    const node = await collectNode("kubernetes");
    const before = { incident: { incident_id: "INC-2026-0101" }, scenario: "container-oom", state: "asking" };
    const out = runSetExpression(node, envelope({ agent: "kubernetes", status: "ok" }), before, "Assemble");
    expect(out.incident).toEqual(before.incident);
    expect(out.scenario).toBe("container-oom");
    expect(out.reply).toEqual({ agent: "kubernetes", status: "ok" });
  });

  it("accepts a fenced answer, which is the commonest way a correct one is thrown away", async () => {
    // Grok, 2026-09-05, before the first paid run: a model wraps JSON in a
    // markdown fence even under json_object mode, and a correct answer is then
    // discarded for its packaging.
    const node = await collectNode("kubernetes");
    const answer = { agent: "kubernetes", status: "ok" };
    const fenced = { choices: [{ message: { content: "```json\n" + JSON.stringify(answer) + "\n```" } }] };
    const out = runSetExpression(node, fenced, { incident: {} }, "Assemble");
    expect(out.reply).toEqual(answer);
  });

  it("unwraps a single-key wrapper, because one key is never a whole agent result", async () => {
    const node = await collectNode("logs");
    const answer = { agent: "logs", status: "ok" };
    const wrapped = envelope({ result: answer } as unknown as Record<string, unknown>);
    expect(runSetExpression(node, wrapped, {}, "Record kubernetes").reply).toEqual(answer);

    // A single key whose value is not an object is left alone: there is nothing
    // inside it that could be a result.
    const oneKey = envelope({ agent: "logs" });
    expect(runSetExpression(node, oneKey, {}, "Record kubernetes").reply).toEqual({ agent: "logs" });
  });

  it("still refuses an array or a bare string, rather than guessing further", async () => {
    // Guessing past this would be inventing an answer on the model's behalf.
    const node = await collectNode("metrics");
    expect(runSetExpression(node, envelope([{ agent: "metrics" }] as unknown as Record<string, unknown>), {}, "Record logs").reply).toBeNull();
    expect(runSetExpression(node, { choices: [{ message: { content: "\"just a string\"" } }] }, {}, "Record logs").reply).toBeNull();
  });

  it("turns an unparseable answer into null rather than throwing inside n8n", async () => {
    // A throwing expression stops the workflow with an n8n error, which is a
    // different and much worse report than "the agent returned nothing".
    const node = await collectNode("logs");
    const out = runSetExpression(node, { choices: [{ message: { content: "sorry, no JSON today" } }] },
      { incident: {}, scenario: "container-oom" }, "Record kubernetes");
    expect(out.reply).toBeNull();
  });

  it("reaches back to the node immediately before it, not to some other one", async () => {
    // The item link is the part that silently breaks when nodes are reordered.
    const node = await collectNode("metrics");
    expect(() => runSetExpression(node, envelope({}), {}, "Some Other Node"))
      .toThrow(/not the node before it/);
  });

});

describe("what may reach the conclusion", () => {
  /*
   * Codex, 2026-09-05: the gates treat every state that is not "asking" alike,
   * so an item in any other state walks every false branch and arrives intact.
   * If it carried a verdict from elsewhere, Conclude would promote it — a
   * conclusion the run never reached, wearing the run's name.
   */
  const concludeCode = async () => {
    const { workflow } = await runScenario.generated();
    return workflow.nodes.find((n: { name: string }) => n.name === "Conclude").parameters.jsCode as string;
  };

  const run = (code: string, json: Record<string, unknown>) =>
    (new Function("$input", `"use strict";\n${code}`) as (i: unknown) => Array<{ json: Record<string, unknown> }>)(
      { all: () => [{ json }] },
    )[0]!.json;

  it("refuses a state this chain does not produce, rather than concluding from it", async () => {
    const code = await concludeCode();
    for (const state of ["asking", "injected", undefined, ""]) {
      const out = run(code, { state, incident: { analysis: { agents: [{ agent: "root_cause" }] } } });
      expect(out.state, `state ${JSON.stringify(state)} was concluded`).toBe("refused");
      expect(String(out.reason)).toContain("this chain does not produce");
    }
  });

  it("refuses when the root cause agent did not answer in this run", async () => {
    // A verdict already sitting in the incident is not a verdict this run
    // reached. Exactly one, because two is not this run either.
    const code = await concludeCode();
    for (const agents of [[], [{ agent: "kubernetes" }], [{ agent: "root_cause" }, { agent: "root_cause" }]]) {
      const out = run(code, { state: "recorded", incident: { analysis: { agents } } });
      expect(out.state, `${agents.length} agents was concluded`).toBe("refused");
      expect(String(out.reason)).toContain("root cause results");
    }
  });

  it("still passes a refusal through untouched", async () => {
    const code = await concludeCode();
    const out = run(code, { state: "refused", agent: "logs", reason: "logs: something" });
    expect(out.state).toBe("refused");
    expect(out.reason).toBe("logs: something");
  });

});

describe("the harness refuses rather than assuming", () => {
  /*
   * Codex, 2026-09-06, on the harness itself. Every entry here is a way it
   * could walk something and report success about a shape it never executed —
   * which is the defect it exists to catch, one level up.
   */
  it("keeps each run's node outputs to itself", () => {
    /*
     * Asserted on the history directly, because the harness is synchronous:
     * two runScenario calls never interleave, so a shared history would corrupt
     * nothing today and the mutation for it survived. The property is real
     * anyway — the day anything here awaits mid-run, a shared map is one
     * incident reading another's — and this is where it is held.
     */
    const one = newHistory();
    const two = newHistory();
    one.remember("Assemble", { scenario: "container-oom" });
    two.remember("Assemble", { scenario: "readiness-probe-failure" });
    expect(one.lastOf("Assemble")).toEqual({ scenario: "container-oom" });
    expect(two.lastOf("Assemble")).toEqual({ scenario: "readiness-probe-failure" });
    expect(() => newHistory().lastOf("Assemble"), "a fresh history must know nothing").toThrow(/has not run/);
  });

  it("refuses to reach for a node that has not run", () => {
    // Returning {} for a node that never ran turns a wiring mistake into a
    // quietly empty object.
    const node = { parameters: { jsonOutput: "={{ JSON.stringify($('Nowhere').item.json) }}" } };
    expect(() => runSetExpression(node, {}, (name: string) => {
      throw new Error(`the expression reaches for ${name}, which has not run in this execution`);
    })).toThrow(/has not run in this execution/);
  });
});
