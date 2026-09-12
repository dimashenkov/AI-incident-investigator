/**
 * Run the generated workflow's Code nodes locally, with a stubbed model.
 *
 * The node bodies are executed as written, in a sandbox holding exactly what
 * n8n provides: `$input.all()`, and for the Set nodes the named earlier item.
 * Nothing is reimplemented here — a harness that re-created the chain would
 * test the harness.
 *
 * The stub answers FROM THE PAYLOAD it is handed. Grok, 2026-09-05, on an
 * earlier version of a full-run test: planting the expected answer in the stub
 * makes "an assertion about the stub, advertised as an assertion about the
 * chain". So the stub reads the observation it was given and reports what is
 * there; if the chain ever hands it the wrong slice, its answer changes.
 */
// @ts-expect-error - plain .mjs script, no types
import { generate, MODEL } from "../../scripts/generate-workflow.mjs";
// @ts-expect-error - plain .mjs script, no types
import { buildRuntime } from "../../scripts/workflow-runtime.mjs";
import { assembleIncident } from "../../src/core/assemble.js";
import { assembleCheckedContext } from "../../src/agents/context.js";

export type Reply = Record<string, unknown> | null;
export type Stub = (payload: Record<string, unknown>) => Reply;

/** What each stubbed agent answers, derived from what it was actually given. */
export const STUB_AGENTS: Record<string, Stub> = {
  kubernetes: (payload) => {
    const o = payload.observation as Record<string, unknown>;
    const pods = (o?.pods ?? []) as Array<Record<string, unknown>>;
    const containers = (pods[0]?.containers ?? []) as Array<Record<string, unknown>>;
    const c = containers[0];
    const reason = ((c?.last_state as Record<string, unknown>)?.terminated as Record<string, unknown>)?.reason;
    /*
     * Cites the path it actually resolved, never a path it hoped for.
     *
     * The first version always cited the terminated reason, which exists only
     * where a container terminated — the same defect Grok found in the prompt's
     * example, reproduced here. A stub that cites what is not there tests the
     * citation check rather than the chain.
     */
    const ref = reason === undefined ? "collected_at" : "pods[0].containers[0].last_state.terminated.reason";
    return {
      agent: "kubernetes", status: "ok",
      findings: [{ fact: reason === undefined
          ? `the observation was collected at ${String(o?.collected_at)}`
          : `the container terminated with ${String(reason)}`,
        source_ref: ref }],
      hypotheses: reason === "OOMKilled"
        ? [{ code: "CONTAINER_OOM", statement: "the container exceeded its memory limit",
             supported_by: [ref] }]
        : [],
      confidence: reason === "OOMKilled" ? 0.9 : 0.2,
    };
  },
  logs: (payload) => {
    const o = payload.observation as Record<string, unknown>;
    const lines = (o?.lines ?? []) as Array<Record<string, unknown>>;
    return {
      agent: "logs", status: lines.length > 0 ? "ok" : "no_data",
      findings: lines.length > 0
        ? [{ fact: `the log window holds ${lines.length} line(s)`, source_ref: "lines[0].message" }]
        // no_data forbids findings: an absence reported as a finding is the
        // schema's way of keeping "I looked and saw nothing" from growing
        // content.
        : [],
      hypotheses: [], confidence: lines.length > 0 ? 0.4 : 0,
    };
  },
  metrics: (payload) => {
    const o = payload.observation as Record<string, unknown>;
    const series = (o?.series ?? []) as Array<Record<string, unknown>>;
    return {
      agent: "metrics", status: series.length > 0 ? "ok" : "no_data",
      findings: series.length > 0
        ? [{ fact: `${series.length} series were collected`, source_ref: "series[0].points[0].value" }]
        : [],
      hypotheses: [], confidence: series.length > 0 ? 0.4 : 0,
    };
  },
  "root-cause": (payload) => {
    // Weighs only what the other agents reported, which is all it is given.
    //
    // It answers with agent "root_cause", not "root-cause". The hyphen names
    // the prompt file and the context; the underscore is the schema's enum, and
    // the prompt tells the model so. Two spellings of one thing, deliberate and
    // tested — tests/agents.test.ts holds that the prompt's own example uses
    // the underscore, so the boundary cannot drift unnoticed.
    const results = (payload.agent_results ?? []) as Array<Record<string, unknown>>;
    const supported = results.flatMap((r) => (r.hypotheses ?? []) as Array<Record<string, unknown>>);
    const top = supported[0];
    const refs = results.flatMap((r) => ((r.findings ?? []) as Array<Record<string, unknown>>).map((f) => f.source_ref));
    return top === undefined
      ? { agent: "root_cause", status: "ok", findings: [], hypotheses: [],
          confidence: 0 }
      : { agent: "root_cause", status: "ok",
          findings: [{ fact: String(top.statement), source_ref: String(refs[0]) }],
          hypotheses: [{ code: String(top.code), statement: String(top.statement),
            supported_by: (top.supported_by ?? []) as string[] }],
          confidence: 0.85 };
  },
};

type Item = { json: Record<string, unknown> };

/**
 * What the OpenAI chat completions API actually returns.
 *
 * Written here rather than assumed by the Set node: if the envelope changes,
 * this is the one place that has to change, and every test notices.
 */
export function envelope(answer: Reply, usage?: Record<string, unknown>): Record<string, unknown> {
  /*
   * `usage` is part of what the API returns, and the harness could not carry it
   * until 2026-09-11 — so the expression that reads it had no test, and a live
   * run came back with `usage_by_agent` empty while the expression sat in the
   * deployed node looking correct. A helper that cannot produce a field is a
   * helper that hides every defect in reading it.
   */
  const out: Record<string, unknown> = {
    choices: [{ message: { content: answer === null ? "not json at all" : JSON.stringify(answer) } }],
  };
  if (usage !== undefined) out["usage"] = usage;
  return out;
}

/**
 * A 200 that is NOT the OpenAI envelope, which the harness could not express.
 *
 * A subagent found it on 2026-09-07: `envelope()` was the only thing ever
 * substituted for an HTTP node, so every body the suite could build carried
 * `choices[0].message.content`. The four shapes below each threw a raw
 * TypeError in the deployed Set node — a gateway's HTML error page, an empty
 * choices array, an error object, a choice with no message — and the test named
 * "turns an unparseable answer into null rather than throwing inside n8n"
 * covered the one shape that cannot throw.
 *
 * These are real bodies. HTTP 200 with an HTML error page is what a proxy in
 * front of an API returns; `{error: {...}}` at 200 is what some gateways do
 * with an upstream failure.
 */
export const NOT_AN_ENVELOPE: Record<string, Record<string, unknown>> = {
  "a gateway's HTML error page": { data: "<html><body>502 Bad Gateway</body></html>" },
  "an empty choices array": { choices: [] },
  "an error object at status 200": { error: { message: "upstream failed", code: "bad_gateway" } },
  "a choice with no message": { choices: [{}] },
  "a message with a null content": { choices: [{ message: { content: null } }] },
};

/**
 * Evaluate an IF node's condition the way n8n does.
 *
 * Written after the second time a harness stood in for a node instead of
 * running it: the gate that keeps a refusal out of a paid call was "tested" by
 * the harness deciding for itself, so a mutation to the gate's own expression
 * changed nothing. Only the string that ships decides here.
 */
export function runIfExpression(node: { parameters?: { conditions?: { conditions?: Array<Record<string, unknown>> } } },
  current: Record<string, unknown>): boolean {
  const list = node?.parameters?.conditions?.conditions;
  if (!Array.isArray(list) || list.length !== 1) {
    throw new Error("the gate no longer carries exactly one condition; this harness is testing nothing");
  }
  const c = list[0]!;
  const op = (c.operator as { operation?: string })?.operation;
  if (op !== "equals") throw new Error(`the gate compares with ${String(op)}, which this harness does not evaluate`);
  const raw = String(c.leftValue);
  if (!raw.startsWith("={{")) throw new Error("the gate's left side is not an expression");
  const body = raw.slice(raw.indexOf("{{") + 2, raw.lastIndexOf("}}"));
  const left = (new Function("$json", `"use strict"; return (${body});`) as (j: unknown) => unknown)(current);
  return left === c.rightValue;
}

/**
 * Evaluate a Set node's jsonOutput expression the way n8n does.
 *
 * n8n expressions are `={{ ... }}`; inside, `$json` is the current item and
 * `$("Node Name").item.json` reaches back to a named node's item. Both are
 * supplied here, so the expression under test is the string that ships.
 */
export function runSetExpression(
  node: { parameters: { jsonOutput?: string } },
  current: Record<string, unknown>,
  /** What each earlier node produced, by name — the same thing $() reaches for. */
  earlier: ((name: string) => Record<string, unknown>) | Record<string, unknown>,
  previousName?: string,
): Record<string, unknown> {
  const raw = node?.parameters?.jsonOutput;
  if (typeof raw !== "string" || !raw.startsWith("={{") || !raw.trimEnd().endsWith("}}")) {
    throw new Error("the Collect node no longer carries an n8n expression; this harness is testing nothing");
  }
  const body = raw.slice(raw.indexOf("{{") + 2, raw.lastIndexOf("}}"));
  const $ = (name: string) => {
    if (typeof earlier === "function") return { item: { json: earlier(name) } };
    if (previousName !== undefined && name !== previousName) {
      throw new Error(`the expression reaches for ${name}, which is not the node before it`);
    }
    return { item: { json: earlier } };
  };
  const fn = new Function("$json", "$", `"use strict"; return (${body});`) as
    (j: unknown, d: unknown) => string;
  return JSON.parse(fn(current, $)) as Record<string, unknown>;
}

/** Execute one Code node body exactly as n8n would. */
export function runCode(body: string, items: Item[]): Item[] {
  const fn = new Function("$input", `"use strict";\n${body}`) as (i: unknown) => Item[];
  return fn({ all: () => items });
}

async function runtimeOnce() {
  return buildRuntime();
}

export async function runScenario(
  scenario: string,
  stubs: Record<string, Stub> = STUB_AGENTS,
  /**
   * A fixture root to assemble from instead of the real scenarios.
   *
   * The generated Assemble node carries the incidents built at generate time,
   * so exercising a different set means substituting the incident it produces.
   * Only that changes; every node still runs as written.
   */
  fixtureRoot?: string,
): Promise<Record<string, unknown> & { state: string }> {
  const { workflow } = await generate();
  const byName: Record<string, WorkflowNode | undefined> = Object.fromEntries(
    workflow.nodes.map((n: WorkflowNode) => [n.name, n]),
  );
  const connections: Connections = workflow.connections;

  /*
   * The chain is walked through its own connections, not through an order this
   * file remembers.
   *
   * Three times now a harness that assumed the order hid a defect in the
   * wiring — most recently on 2026-09-06, when a gate's false branch jumped
   * past the node that prepares the next question, so an incident with no
   * metrics reached the end having never asked the root cause agent. Every test
   * passed, because the harness went where the workflow was supposed to go.
   */
  let at = "Assemble";
  let item: Record<string, unknown> = runCode(nodeCode(byName, "Assemble"),
    [{ json: { body: { scenario } } }])[0]!.json;

  if (fixtureRoot !== undefined) {
    const root = new URL(fixtureRoot, import.meta.url).pathname;
    const a = assembleIncident(scenario, 1, { root });
    if (a.state !== "assembled") throw new Error(`the fixture root does not assemble: ${a.reason}`);
    const ctx = assembleCheckedContext("kubernetes", a.incident);
    if (ctx.state !== "assembled") throw new Error(`kubernetes context: ${ctx.reason}`);
    item = { index: 0, state: "asking", agent: "kubernetes", scenario,
      incident: a.incident, prompt: ctx.prompt, payload: ctx.payload };
  }

  let previousName = at;
  const { remember, lastOf } = newHistory();
  // The Set node reaches back to the node before it, and Assemble is the first
  // such node. Without this the very first lookup finds nothing.
  remember("Assemble", item);

  for (let step = 0; step < 60; step += 1) {
    const outgoing = connections[at];
    if (outgoing === undefined) break;

    let branch = 0;
    const node = byName[at];
    if (node?.type === "n8n-nodes-base.if") branch = runIfExpression(node, item) ? 0 : 1;

    /*
     * One target per branch, refused rather than assumed.
     *
     * Codex, 2026-09-06: following only [0] would walk a fan-out wrongly and
     * say nothing about it. This chain is deliberately a single line; the day
     * it is not, this throws instead of quietly testing one half of it.
     */
    const targets = outgoing.main[branch] ?? [];
    if (targets.length > 1) {
      throw new Error(`${at} branch ${branch} fans out to ${targets.length} nodes; this harness walks one line and would test only the first`);
    }
    const target = targets[0]?.node;
    if (target === undefined) throw new Error(`${at} has no branch ${branch}; the run would stop with no answer`);

    const next = byName[target];
    if (next === undefined) throw new Error(`${at} points at ${target}, which does not exist`);

    // The Slack chain after Report is a live-only side effect (Slack gate ->
    // lookup -> post -> took -> ok -> record). This harness runs the
    // INVESTIGATION, not the delivery, so it stops the moment it reaches the
    // Slack namespace — the current item is Report's output, the investigation
    // result, which the delivery does not change. The `Slack ` prefix is a
    // deliberate namespace for the delivery nodes, not a single hard-coded name;
    // the type check is defence in case one is ever renamed.
    const isAsk = next.type === "n8n-nodes-base.httpRequest" && target.startsWith("Ask ");
    if (target.startsWith("Slack ")
        || next.type === "n8n-nodes-base.dataTable"
        || (next.type === "n8n-nodes-base.httpRequest" && !isAsk)) {
      break;
    }

    if (next.type === "n8n-nodes-base.httpRequest") {
      // The model, replaced by a stub answering from the payload it is handed.
      const agent = target.replace(/^Ask /, "");
      const stub = stubs[agent];
      const answered = stub === undefined ? null : stub(item.payload as Record<string, unknown>);
      /*
       * A stub may hand back a whole HTTP body instead of an agent result, so a
       * test can put a shape through that is not the OpenAI envelope at all.
       * The marker is deliberately ugly: a real agent result never carries it.
       */
      /*
       * A stub that wants to say what the call cost returns `__usage` beside
       * its answer, and the harness lifts it into the envelope where the API
       * puts it. Without this the expression that reads `usage` could not be
       * exercised at all, which is how a live run came back with an empty
       * `usage_by_agent` while the code looked right.
       */
      let spokenUsage: Record<string, unknown> | undefined = undefined;
      let spokenAnswer: Reply = answered;
      if (answered !== null && typeof answered === "object" && "__usage" in answered) {
        const copy: Record<string, unknown> = { ...(answered as Record<string, unknown>) };
        spokenUsage = copy["__usage"] as Record<string, unknown>;
        delete copy["__usage"];
        spokenAnswer = copy as Reply;
      }
      item = (answered !== null && typeof answered === "object" && "__rawBody" in answered)
        ? (answered as { __rawBody: Record<string, unknown> }).__rawBody
        : envelope(spokenAnswer, spokenUsage);
    } else if (next.type === "n8n-nodes-base.set") {
      item = runSetExpression(next, item, lastOf);
    } else if (next.type === "n8n-nodes-base.code") {
      item = runCode(nodeCode(byName, target), [{ json: item }])[0]!.json;
      previousName = target;
    } else if (next.type !== "n8n-nodes-base.if") {
      // An IF changes nothing about the item, only where it goes. Anything else
      // is a node type this harness does not execute, and passing the item
      // through it would be the harness pretending the node did nothing.
      throw new Error(`${target} is a ${next.type}, which this harness does not execute`);
    }

    // Remembered under the node that produced it. Keyed by previousName it
    // clobbered Assemble's output with the HTTP envelope, and the incident
    // disappeared two steps later.
    remember(target, item);
    at = target;
    /*
     * The walk used to stop at Conclude, hard-coded.
     *
     * That is why nothing noticed the deployed chain had no thread: the harness
     * could not have reached a node after Conclude even once one existed. A
     * stopping rule written as a node NAME cannot see the workflow growing —
     * so it stops at whatever was last on the day it was written.
     *
     * It stops where the workflow stops now: at a node nothing leads out of.
     */
    if (connections[target] === undefined) break;
  }

  return item as Record<string, unknown> & { state: string };
}

type WorkflowNode = { name: string; type: string; parameters: Record<string, unknown> };
type Connections = Record<string, { main: Array<Array<{ node: string }>> }>;

/*
 * What each node produced, for THIS run only.
 *
 * Codex, 2026-09-06: a module-level object is shared between runs, so two
 * scenarios executing together overwrite each other's named outputs and
 * $("Assemble") reads another incident. And a lookup that returns {} for a node
 * which never ran turns a wiring mistake into a quietly empty object — the
 * defect this file exists to catch, inside the thing catching it.
 */
type History = { remember(name: string, item: Record<string, unknown>): void; lastOf(name: string): Record<string, unknown> };

/** Only a mutation uses this: the shared map the per-run one replaced. */
const SHARED_HISTORY = new Map<string, Record<string, unknown>>();

export function newHistory(): History {
  const seen = new Map<string, Record<string, unknown>>();
  return {
    remember: (name, item) => { seen.set(name, item); },
    lastOf: (name) => {
      const found = seen.get(name);
      if (found === undefined) {
        throw new Error(`the expression reaches for ${name}, which has not run in this execution`);
      }
      return found;
    },
  };
}

function nodeCode(byName: Record<string, WorkflowNode | undefined>, name: string): string {
  const c = byName[name]?.parameters?.jsCode;
  if (typeof c !== "string") throw new Error(`node ${name} carries no code; the workflow shape changed`);
  return c;
}

runScenario.runtime = runtimeOnce;
runScenario.generated = () => generate();
runScenario.model = MODEL;
