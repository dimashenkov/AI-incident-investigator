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
import { runScenario, STUB_AGENTS, envelope, runSetExpression } from "./helpers/run-workflow.js";
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
    const out = runSetExpression(node, envelope({ agent: "kubernetes", status: "ok" }), "Assemble", before);
    expect(out.incident).toEqual(before.incident);
    expect(out.scenario).toBe("container-oom");
    expect(out.reply).toEqual({ agent: "kubernetes", status: "ok" });
  });

  it("turns an unparseable answer into null rather than throwing inside n8n", async () => {
    // A throwing expression stops the workflow with an n8n error, which is a
    // different and much worse report than "the agent returned nothing".
    const node = await collectNode("logs");
    const out = runSetExpression(node, { choices: [{ message: { content: "sorry, no JSON today" } }] },
      "Record kubernetes", { incident: {}, scenario: "container-oom" });
    expect(out.reply).toBeNull();
  });

  it("reaches back to the node immediately before it, not to some other one", async () => {
    // The item link is the part that silently breaks when nodes are reordered.
    const node = await collectNode("metrics");
    expect(() => runSetExpression(node, envelope({}), "Some Other Node", {}))
      .toThrow(/not the node before it/);
  });
});
