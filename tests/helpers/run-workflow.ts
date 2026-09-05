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
export function envelope(answer: Reply): Record<string, unknown> {
  return { choices: [{ message: { content: answer === null ? "not json at all" : JSON.stringify(answer) } }] };
}

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
  previousName: string,
  previousItem: Record<string, unknown>,
): Record<string, unknown> {
  const raw = node?.parameters?.jsonOutput;
  if (typeof raw !== "string" || !raw.startsWith("={{") || !raw.trimEnd().endsWith("}}")) {
    throw new Error("the Collect node no longer carries an n8n expression; this harness is testing nothing");
  }
  const body = raw.slice(raw.indexOf("{{") + 2, raw.lastIndexOf("}}"));
  const $ = (name: string) => {
    if (name !== previousName) throw new Error(`the expression reaches for ${name}, which is not the node before it`);
    return { item: { json: previousItem } };
  };
  const fn = new Function("$json", "$", `"use strict"; return (${body});`) as
    (j: unknown, d: unknown) => string;
  return JSON.parse(fn(current, $)) as Record<string, unknown>;
}

/** Execute one Code node body exactly as n8n would. */
function runCode(body: string, items: Item[]): Item[] {
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
   * so exercising a different set means building them here and substituting
   * them into the item the node produces — which is what the webhook body would
   * have selected. Only the incident changes; every node still runs as written.
   */
  fixtureRoot?: string,
): Promise<Record<string, unknown> & { state: string }> {
  const { workflow } = await generate();
  const byName: Record<string, { parameters: { jsCode?: string; jsonOutput?: string; conditions?: { conditions?: Array<Record<string, unknown>> } } } | undefined> = Object.fromEntries(
    workflow.nodes.map((n: { name: string }) => [n.name, n]),
  );

  const codeOf = (name: string) => {
    const c = byName[name]?.parameters?.jsCode;
    if (typeof c !== "string") throw new Error(`node ${name} carries no code; the workflow shape changed`);
    return c;
  };

  let items = runCode(codeOf("Assemble"), [{ json: { body: { scenario } } }]);
  let previousName = "Assemble";

  if (fixtureRoot !== undefined) {
    const root = new URL(fixtureRoot, import.meta.url).pathname;
    const a = assembleIncident(scenario, 1, { root });
    if (a.state !== "assembled") throw new Error(`the fixture root does not assemble: ${a.reason}`);
    // Re-run Assemble's own logic on the substituted incident by handing the
    // first Record node the shape Assemble would have produced.
    const ctx = assembleCheckedContext("kubernetes", a.incident);
    if (ctx.state !== "assembled") throw new Error(`kubernetes context: ${ctx.reason}`);
    items = [{ json: { index: 0, state: "asking", agent: "kubernetes", scenario,
      incident: a.incident, prompt: ctx.prompt, payload: ctx.payload } }];
  }

  for (const agent of ["kubernetes", "logs", "metrics", "root-cause"]) {
    const cur = items[0]?.json ?? {};
    if (cur.state === "refused") break;

    /*
     * The gate's own expression decides, not this harness. Measured on the
     * first live run: a refused item flowed into the next HTTP node and was
     * charged for the agents before it.
     */
    const gate = byName[`Ask ${agent}?`];
    if (gate === undefined) throw new Error(`no gate before Ask ${agent}; the workflow shape changed`);
    if (!runIfExpression(gate, cur)) {
      items = runCode(codeOf(`Record ${agent}`), [{ json: cur }]);
      previousName = `Record ${agent}`;
      continue;
    }

    /*
     * The Ask node is an HTTP call, so the stub stands in for the model — but
     * the Collect node in between is OURS, and it used to be stood in for as
     * well. Codex, 2026-09-05: "this bypasses both actual HTTP-node execution
     * and the Collect Set expression", so an expression error, a changed
     * response envelope or a broken item link was untested.
     *
     * The stub now returns the API's envelope, and the Set expression is
     * evaluated as written, with $json and $() supplied the way n8n does.
     */
    const stub = stubs[agent];
    const answer = stub === undefined ? null : stub(cur.payload as Record<string, unknown>);
    const httpResponse = envelope(answer);
    const collect = byName[`Collect ${agent}`];
    if (collect === undefined) throw new Error(`no Collect ${agent} node; the workflow shape changed`);
    items = [{ json: runSetExpression(collect, httpResponse, previousName, cur) }];
    items = runCode(codeOf(`Record ${agent}`), items);
    previousName = `Record ${agent}`;
  }

  const cur = items[0]?.json ?? {};
  if (cur.state === "refused") return cur as Record<string, unknown> & { state: string };
  const out = runCode(codeOf("Conclude"), [{ json: cur }]);
  return (out[0]?.json ?? { state: "empty" }) as Record<string, unknown> & { state: string };
}

runScenario.runtime = runtimeOnce;
runScenario.generated = () => generate();
runScenario.model = MODEL;
