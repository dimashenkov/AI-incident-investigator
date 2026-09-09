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
import { readdirSync } from "node:fs";
import type { Stub } from "./helpers/run-workflow.js";
import { runCode, runScenario, STUB_AGENTS, envelope, runSetExpression, newHistory, NOT_AN_ENVELOPE } from "./helpers/run-workflow.js";
// @ts-expect-error - plain .mjs script, no types
import { generate } from "../scripts/generate-workflow.mjs";
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

  it("refuses a contaminated slot rather than skipping it as an absence", async () => {
    /*
     * The other way a skip can be wrong, and the one that was live.
     *
     * The branch asked the collection record alone and threw the context's
     * reason away — so a context refused for CONTAMINATION, the one thing
     * checkSourceForForeignIncidents exists to catch, was printed as "the
     * provider reported an established absence", the chain carried on, and the
     * run scored correct. Three of the eight scenarios declare an absence for a
     * slot, so the trigger is in the shipped fixtures.
     *
     * Exercised by running the Record node's code directly, because a whole
     * chain cannot easily be made to contaminate itself.
     */
    const { workflow } = await generate();
    const node = workflow.nodes.find((n: { name: string }) => n.name === "Record logs")!;
    const jsCode = (node.parameters as { jsCode: string }).jsCode;

    const clean = await runScenario("image-pull-failure");
    const incident = (clean.incident ?? {}) as Record<string, unknown>;
    // A slot that legitimately declares an absence, with another incident's id
    // planted where the source check will find it.
    const poisoned = {
      ...incident,
      analysis: { ...(incident.analysis as Record<string, unknown>),
        agents: [{ agent: "kubernetes", status: "ok",
          findings: [{ fact: "INC-2026-9999 was also affected", source_ref: "pods[0].phase" }],
          hypotheses: [], confidence: 0.5 }] },
    };

    /*
     * `skipped` on the way in, so the node walks past the reply block and
     * reaches the decision about the NEXT agent — which is where the skip is
     * chosen. The first version of this test sent `recorded` with no reply and
     * was refused three lines earlier, so it passed with the defect in place
     * and the gate said so.
     */
    const out = runCode(jsCode, [{ json: { index: 0, state: "skipped", scenario: "image-pull-failure",
      incident: poisoned } }])[0]!.json as Record<string, unknown>;
    expect(out.state, "contamination must never be reported as an established absence").not.toBe("skipped");
    expect(String(out.skipped_because ?? "")).not.toMatch(/established absence/);
    expect(String(out.reason ?? ""), "and the real reason must reach the report")
      .toMatch(/another incident/);
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

  it("keeps an answer whose own text contains a fenced block", async () => {
    /*
     * The fence was searched for BEFORE the answer was parsed, so a fence
     * appearing inside a JSON string value — a quoted log line, which is
     * exactly what these agents are asked to cite — matched, the expression
     * took the quoted fragment as the whole answer, and parsing it failed. A
     * valid reply became null and the chain refused AFTER that agent was paid.
     * Codex reproduced it against the committed expression on 2026-09-09.
     */
    const node = await collectNode("kubernetes");
    const answer = {
      agent: "kubernetes", status: "ok",
      findings: [{
        fact: "the event says: ```Readiness probe failed: HTTP probe failed with statuscode: 503```",
        source_ref: "events[0].message",
      }],
      hypotheses: [], confidence: 0.4,
    };
    const out = runSetExpression(node, envelope(answer as unknown as Record<string, unknown>), {}, "Assemble");
    expect(out.reply, "a fence inside the text is not the wrapper around it").toEqual(answer);
  });

  it("reads an answer that is fenced AND encoded as a string", async () => {
    /*
     * The string unwrap ran before the fence, so a fence whose contents are a
     * JSON-encoded object parsed to a string, failed the plain-object test, and
     * a paid answer became null. Codex reproduced it on 2026-09-09 against the
     * expression as it stood after the previous fix — the fix that was written
     * to close this class.
     */
    const node = await collectNode("kubernetes");
    const answer = { agent: "kubernetes", status: "ok", findings: [], hypotheses: [], confidence: 0 };
    const content = "```json\n" + JSON.stringify(JSON.stringify(answer)) + "\n```";
    const out = runSetExpression(node, { choices: [{ message: { content } }] }, {}, "Assemble");
    expect(out.reply, "one layer of encoding is unwrapped on both paths").toEqual(answer);
  });

  it("reads the first fenced block that is an answer, when the reply carries two", async () => {
    /*
     * Three versions of this expression, each wrong in a different direction,
     * and each cost a paid answer:
     *
     *   lazy fence   -> closed on the first pair of backticks INSIDE a string
     *                   value, truncating a reply that quoted a log line
     *   greedy fence -> ran from the first opening fence to the last closing
     *                   one, so a reply with TWO blocks captured the markers
     *                   between them and parsed as nothing
     *
     * Codex found each in turn on 2026-09-09, one after the other fix. The
     * answer is not a third regex: the blocks are walked, and the greedy span
     * is only the last resort.
     */
    const node = await collectNode("logs");
    const answer = { agent: "logs", status: "no_data", findings: [], hypotheses: [], confidence: 0 };
    const fence = (body: string) => "```json\n" + body + "\n```";
    /*
     * Both orders, and the block that is NOT the answer is not an object.
     *
     * Answer first kills a greedy span that swallows the markers between the
     * two. Answer SECOND kills a reader that tries only one block. The other
     * block is prose rather than `{}` on purpose: `{}` IS a plain object, and
     * asking the expression to pass over it would be asking it to judge which
     * object is the answer — that is validation, and it belongs to the node
     * after this one.
     */
    for (const content of [
      fence(JSON.stringify(answer)) + "\n\nand here is the shape I used:\n\n" + fence("agent, status, findings"),
      "here is the shape I used:\n\n" + fence("agent, status, findings") + "\n\n" + fence(JSON.stringify(answer)),
    ]) {
      const out = runSetExpression(node, { choices: [{ message: { content } }] }, {}, "Record kubernetes");
      expect(out.reply, `two blocks must not swallow each other: ${content.slice(0, 40)}`).toEqual(answer);
    }
  });

  it("still recovers an answer whose own strings contain backticks, even when fenced", async () => {
    // The case the greedy span exists for, kept working beside the walk above.
    const node = await collectNode("kubernetes");
    const answer = {
      agent: "kubernetes", status: "ok",
      findings: [{ fact: "the event says ```probe failed```", source_ref: "events[0].message" }],
      hypotheses: [], confidence: 0.3,
    };
    const content = "```json\n" + JSON.stringify(answer) + "\n```";
    const out = runSetExpression(node, { choices: [{ message: { content } }] }, {}, "Assemble");
    expect(out.reply, "an inner pair of backticks does not close the fence").toEqual(answer);
  });

  it("still unwraps a fence that really does wrap the whole answer", async () => {
    // The other half: a model that fences its reply must still be read.
    const node = await collectNode("kubernetes");
    const answer = { agent: "kubernetes", status: "ok", findings: [], hypotheses: [], confidence: 0 };
    const fenced = "```json\n" + JSON.stringify(answer) + "\n```";
    const out = runSetExpression(node, { choices: [{ message: { content: fenced } }] }, {}, "Assemble");
    expect(out.reply).toEqual(answer);
  });

  it("turns an unparseable answer into null rather than throwing inside n8n", async () => {
    // A throwing expression stops the workflow with an n8n error, which is a
    // different and much worse report than "the agent returned nothing".
    const node = await collectNode("logs");
    const out = runSetExpression(node, { choices: [{ message: { content: "sorry, no JSON today" } }] },
      { incident: {}, scenario: "container-oom" }, "Record kubernetes");
    expect(out.reply).toBeNull();
  });

  /*
   * Every 200 that is not the OpenAI envelope, which the suite could not
   * express until 2026-09-07.
   *
   * A subagent measured each of these against the generated expression: all
   * four threw a raw TypeError inside the deployed Set node, halting the
   * execution and giving the caller an n8n error naming `choices` rather than
   * the chain's own "returned nothing that could be read as an answer". The
   * test above is named for exactly this and covered the one body shape that
   * cannot throw, because the harness only ever built real envelopes.
   */
  /*
   * Through the whole chain, not against the merge function.
   *
   * A subagent showed on 2026-09-07 that the node which had just asked the LOGS
   * agent did not pass what it asked, so a reply labelled `"agent":
   * "kubernetes"` was recorded and the chain concluded at 85% with two
   * kubernetes entries and no logs analysis. The unit test for that refusal
   * lives in tests/assemble.test.ts — and a mutation removing the argument from
   * the NODE left it green, because the unit test never travels through the
   * node. This one does.
   */
  /*
   * The thread, produced by the chain rather than by a test calling the
   * reporter directly.
   *
   * A subagent grepped every jsCode in the generated workflow on 2026-09-07 and
   * found reportIncident in none of them: the chain ended at Conclude, and the
   * only callers of the file that writes the thread were two test files. So the
   * caveats it exists to produce had never once been in what a live run emits,
   * and every prompt round had been measured against an answer object instead.
   */
  it("produces the thread a person reads, from the chain and not from a test", async () => {
    const out = await runScenario("container-oom");
    expect(out.state, "the chain must still conclude").toBe("concluded");

    const thread = out.thread as string[] | undefined;
    expect(thread, "the deployed chain produced no thread at all").toBeDefined();
    expect(thread!.length, "an empty thread would pass every assertion below").toBeGreaterThan(2);

    const joined = thread!.join(" ");
    expect(joined, "the thread must open on this incident").toContain("INC-");
    expect(joined, "and reach a verdict").toContain("Root cause:");
    expect(joined, "carrying the caveat that nothing checks the number")
      .toContain("nothing here checks it");

    // And the conversation on the incident is what the thread was read from,
    // so the document a later reader loads says the same as the run reported.
    const conv = ((out.incident as Record<string, unknown>).conversation ?? {}) as Record<string, unknown>;
    const messages = (conv.messages ?? []) as Array<{ text: string }>;
    expect(messages.map((m) => m.text)).toEqual(thread);
  });

  it("keeps the conclusion when the thread cannot be written, rather than losing both", async () => {
    /*
     * The expensive half is already paid for by the time Report runs, so a
     * refusal to append a sentence must not throw the answer away.
     *
     * Exercised by RUNNING the Report node against an item whose conversation
     * belongs to another incident — the one refusal the reporter makes that a
     * whole-chain run cannot produce. The first version of this test asserted
     * `report_refused` was undefined on a happy path, which is the same as
     * asserting nothing: the mutation that made a refusal discard the
     * conclusion survived it, and the gate said so.
     */
    const { workflow } = await generate();
    const node = workflow.nodes.find((n: { name: string }) => n.name === "Report")!;
    const jsCode = (node.parameters as { jsCode: string }).jsCode;

    const concluded = await runScenario("container-oom");
    expect(concluded.state).toBe("concluded");
    const incident = concluded.incident as Record<string, unknown>;
    const foreign = {
      ...incident,
      conversation: { ...(incident.conversation as Record<string, unknown>),
        incident_id: "INC-2026-9999", thread_id: "thread-INC-2026-9999", messages: [] },
    };

    const out = runCode(jsCode, [{ json: { ...concluded, incident: foreign } }])[0]!.json as Record<string, unknown>;
    expect(out.report_refused, "the refusal must be visible rather than silent").toBeTruthy();
    expect(String(out.report_refused)).toMatch(/INC-2026-9999|belongs to/);
    expect(out.state, "and the conclusion must survive it").toBe("concluded");
    expect(out.root_cause_code, "the answer the models were paid for is still here").toBeTruthy();
  });

  it("refuses, in the deployed chain, an answer from an agent it did not ask", async () => {
    const lying: Record<string, Stub> = {
      ...STUB_AGENTS,
      // The logs agent answers, and says it is the kubernetes agent — citing a
      // path that really does resolve in the kubernetes slot, so nothing but
      // the identity check can catch it.
      logs: () => ({ agent: "kubernetes", status: "ok",
        findings: [{ fact: "OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
        hypotheses: [], confidence: 0.5 }),
    };
    const out = await runScenario("container-oom", lying);
    expect(out.state, "a mislabelled answer must not conclude").toBe("refused");
    expect(String(out.reason)).toMatch(/logs was asked/);
  });

  it("turns a 200 that is not the model's envelope into null, not a TypeError", async () => {
    const node = await collectNode("logs");
    for (const [what, body] of Object.entries(NOT_AN_ENVELOPE)) {
      const out = runSetExpression(node, body, { incident: {}, scenario: "container-oom" }, "Record kubernetes");
      expect(out.reply, `${what} must become null rather than throw`).toBeNull();
    }
    expect(Object.keys(NOT_AN_ENVELOPE).length,
      "this would pass on an empty set of bodies").toBeGreaterThan(3);
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

/*
 * Every scenario, through the GENERATED nodes.
 *
 * Three of the eight had ever travelled the deployed code; the other five were
 * exercised only by tests/full-run.test.ts, which imports the local modules. So
 * a paid run on five of eight scenarios would have been the first time that
 * node code ran on them — measured by a subagent on 2026-09-09, and the exact
 * shape this project keeps finding: a harness standing in for the thing.
 */
describe("the Assemble node decides a skip the same way the Record node does", () => {
  it("asks both conditions in both carriers, so one cannot be taught and the other left behind", async () => {
    /*
     * One rule, two carriers. The Record node was taught on 2026-09-07 to ask
     * BOTH whether the collection record declares an absence and whether the
     * context was refused for an empty slot; the Assemble node was left asking
     * only the first, so a kubernetes slot carrying somebody else's incident id
     * would have printed "the provider reported an established absence" and the
     * chain would have carried on. A subagent found the second carrier on
     * 2026-09-09.
     *
     * Asserted against the generated code rather than through a run, and that
     * is a limitation stated rather than hidden: the Assemble node builds the
     * incident itself from the scenario name, so nothing can hand it a
     * contaminated one. The branch is unreachable today because kubernetes is
     * collected in all eight shipped scenarios — a fixture, not a guarantee.
     * What IS checkable is that the two carriers ask the same question.
     */
    const { workflow } = await generate();
    const codeOf = (name: string) => {
      const n = workflow.nodes.find((x: { name: string }) => x.name === name);
      expect(n, `${name} is not in the generated workflow`).toBeDefined();
      return (n!.parameters as { jsCode: string }).jsCode;
    };
    for (const name of ["Assemble", "Record kubernetes", "Record logs", "Record metrics"]) {
      const code = codeOf(name);
      const skips = code.includes("established absence");
      if (!skips) continue;
      expect(code, `${name} decides a skip from the record alone, without asking why the context was refused`)
        .toMatch(/state === "nothing" && [\w.]*why === "empty-slot"/);
    }
  });
});

describe("every scenario travels the generated workflow at least once", () => {
  const ALL = readdirSync(new URL("../scenarios/", import.meta.url).pathname, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();

  it("has scenarios to run at all", () => {
    expect(ALL.length, "no scenarios; every test below would pass on nothing").toBeGreaterThan(3);
  });

  for (const scenario of ALL) {
    it(`assembles, asks and concludes ${scenario} through the deployed nodes`, async () => {
      const r = await runScenario(scenario);
      /*
       * The STUB answers are fixed, so this says nothing about whether a model
       * would answer well. What it establishes is that the node code — assemble,
       * the four gates, the four Collect expressions, the four Record nodes,
       * Conclude and Report — runs end to end on this incident without throwing
       * and without refusing for a structural reason.
       */
      expect(r.state, r.state === "refused" ? String(r.reason) : "").toBe("concluded");
      expect(typeof r.incident, "the concluded incident comes back").toBe("object");
    });
  }
});
