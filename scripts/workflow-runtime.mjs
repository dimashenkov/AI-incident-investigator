/**
 * The JavaScript that runs inside every n8n Code node.
 *
 * Assembled here, in memory, from the same sources the tests run against:
 *
 *   - the standalone validators, built from schemas/ by build-core.mjs
 *   - src/core/merge.ts, transpiled by the TypeScript compiler in this process
 *   - the four prompt files, verbatim
 *
 * Nothing is read out of out/ and nothing is hand-ported. A hand-written copy
 * of the merge rules for the node would be a second carrier: two implementations
 * of one rule that agree until they stop, and the deployed one is the copy
 * nobody runs tests against.
 *
 * The Code node has no filesystem and no require outside a two-name allowlist,
 * so everything travels embedded. That is the whole reason this file exists.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { buildCore } from "./build-core.mjs";
// Imported for its side effect, and that is the point: it installs the resolve
// hook that lets `await import("../src/**.ts")` below work. Leaving it to the
// caller meant every child process needed a --import flag, and the gate's drift
// probe is exactly the caller who forgot — it reported "could not establish"
// rather than a drift, which is at least the honest failure.
import "./ts-from-js.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The four prompts, by the agent name the context assembler uses. */
export function readPrompts(dir = resolve(ROOT, "prompts")) {
  const out = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith("-agent.md")).sort()) {
    out[f.replace(/-agent\.md$/, "")] = readFileSync(resolve(dir, f), "utf8");
  }
  return out;
}

/**
 * Transpile one TypeScript source to the JavaScript the node will run.
 *
 * Type stripping only — no downlevelling, no module wrapper. The node runs on
 * modern V8, and a transform that changed semantics would make the deployed
 * behaviour differ from the tested behaviour in ways nothing here would catch.
 */
export function transpile(file) {
  const source = readFileSync(resolve(ROOT, file), "utf8");
  const out = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: false,
      removeComments: false,
    },
    fileName: file,
  });
  const js = out.outputText;

  /*
   * What the Code node cannot run, refused here rather than deployed.
   *
   * Found by the local run on 2026-09-05: a stray `import.meta.url` survived
   * transpiling and every node threw before doing anything. The generator had
   * no opinion about it, so the workflow was produced, committed and would have
   * been deployed. Each entry below is a thing the node genuinely cannot do —
   * not a style rule — and the list grows when one gets through.
   */
  const forbidden = [
    { what: /^\s*import\s/gm, why: "a runtime import; the node's require is a two-name allowlist" },
    { what: /^\s*export\s+\{[^}]*\}\s*from\b/gm, why: "a re-export, which has no meaning in a script" },
    // Codex, 2026-09-05: the static-import pattern does not match `import(...)`,
    // and a dynamic import is the same unavailable thing spelled differently.
    { what: /\bimport\s*\(/g, why: "a dynamic import" },
    { what: /\bimport\.meta\b/g, why: "import.meta, which does not exist outside a module" },
    { what: /\brequire\s*\(/g, why: "a require call" },
    { what: /\bprocess\./g, why: "process, which the node does not provide" },
    { what: /\b__dirname\b|\b__filename\b/g, why: "a CommonJS path global" },
  ];
  const found = forbidden
    .map((f) => ({ ...f, hits: [...js.matchAll(f.what)].length }))
    .filter((f) => f.hits > 0);
  if (found.length > 0) {
    throw new Error(
      `${file} cannot run in the n8n Code node: ` +
      found.map((f) => `${f.hits}× ${f.why}`).join("; "),
    );
  }

  const script = js.replace(/^export\s+/gm, "");

  /*
   * A blocklist can only refuse what somebody thought of, so the result is also
   * parsed as the kind of code the node runs.
   *
   * Codex, 2026-09-05: "parse or check the emitted JavaScript structurally".
   * `new Function` compiles a function body in script mode — the same mode a
   * Code node uses — so anything left that is only legal in a module throws
   * here rather than at three in the morning inside n8n.
   */
  try {
    // eslint-disable-next-line no-new-func
    new Function(script);
  } catch (e) {
    throw new Error(`${file} does not compile as a script: ${e instanceof Error ? e.message : String(e)}`);
  }
  return script;
}

/** Assemble every scenario, so the node never needs the scenarios directory. */
export async function assembledIncidents() {
  const { assembleIncident } = await import("../src/core/assemble.ts");
  const { listScenarios } = await import("../src/providers/fixtures.ts");
  const out = {};
  const refused = [];
  for (const s of listScenarios()) {
    const a = assembleIncident(s, 1, {});
    if (a.state !== "assembled") { refused.push(`${s}: ${a.reason}`); continue; }
    out[s] = a.incident;
  }
  // A scenario that cannot be assembled is not a scenario the workflow may
  // silently omit — the deployed workflow would then offer four of five and
  // nothing would say which one went missing.
  if (refused.length > 0) throw new Error(`cannot assemble: ${refused.join("; ")}`);
  if (Object.keys(out).length === 0) throw new Error("no scenario assembled; the workflow would carry nothing to investigate");
  return out;
}

/**
 * The shared prelude every Code node begins with.
 *
 * `validate` here is the standalone core wearing the same three-state shape the
 * injected validator has locally. That is the join: merge.ts cannot tell which
 * one it was handed, which is what makes it one carrier rather than two.
 */
export async function buildRuntime() {
  const core = buildCore().code;
  const merge = transpile("src/core/merge.ts");
  const slice = transpile("src/agents/slice.ts");
  /*
   * The cross-field constraints, from the same source the tests run.
   *
   * build-core.mjs generates only the ajv validators, so until 2026-09-07 the
   * deployed node ran the schemas and nothing else — and a collection claiming
   * "collected" over a null observation, a thread id naming another incident,
   * and a message stamped with a foreign incident id were all VALID in n8n and
   * invalid locally. Measured through the real generated core, not read.
   */
  const invariants = transpile("src/schema/invariants.ts");
  /*
   * The thread a person reads. Carried since 2026-09-07, when a subagent
   * grepped every jsCode in the generated workflow and found reportIncident in
   * none of them: the chain ended at Conclude, and every caveat that file
   * produces was absent from what a live run emitted.
   */
  const thread = transpile("src/core/thread.ts");
  const prompts = readPrompts();
  const incidents = await assembledIncidents();

  const prelude = `// GENERATED — do not edit. Regenerate with: node --import ./scripts/ts-from-js.mjs scripts/generate-workflow.mjs
// ---- validators, generated from schemas/ ----
// Wrapped, because the standalone code assigns onto \`exports\`, and a Code node
// has neither. The wrapper is the only thing between it and a ReferenceError.
const module = { exports: {} };
const exports = module.exports;
(function (module, exports) {
${core}
})(module, exports);
const validators = module.exports;

// ---- src/schema/invariants.ts, transpiled in memory ----
${invariants}

// ---- the three-state validator merge.ts expects ----
function validate(name, data) {
  const fn = validators["validate_" + String(name).replace(/-/g, "_")];
  if (typeof fn !== "function") return { state: "unchecked", reason: "no such schema: " + name };
  if (!fn(data)) {
    return { state: "invalid", errors: (fn.errors || []).map(function (e) {
      return (e.instancePath === "" ? "(root)" : e.instancePath) + " " + (e.message || "failed");
    }) };
  }
  // The same second half src/schema/validate.ts runs, so "valid" means one
  // thing here and in a unit test. It did not until 2026-09-07.
  const cross = invariantErrors(name, data);
  if (cross.length > 0) return { state: "invalid", errors: cross };
  return { state: "valid" };
}

// ---- src/core/merge.ts, transpiled in memory ----
${merge}

// ---- src/agents/slice.ts, transpiled in memory ----
${slice}

// ---- src/core/thread.ts, transpiled in memory ----
${thread}

// ---- the prompts, verbatim ----
const PROMPTS = ${JSON.stringify(prompts)};

// ---- the assembled incidents, one per scenario ----
const INCIDENTS = ${JSON.stringify(incidents)};
`;
  return { prelude, core, merge, slice, prompts, incidents };
}

/**
 * The four agents, in the order the workflow runs them.
 *
 * Order matters and is not incidental: the root cause agent receives the other
 * three results and never the observations, so it cannot introduce a fact with
 * nothing behind it. Running it first would give it nothing to weigh.
 */
export const AGENT_ORDER = ["kubernetes", "logs", "metrics", "root-cause"];

/**
 * The node that picks the incident and prepares the first agent's question.
 *
 * The webhook carries a scenario NAME, never an incident. Accepting an incident
 * from the caller would make the deployed workflow's answer depend on whatever
 * was posted to it, and every claim about isolation would then be a claim about
 * the caller's manners.
 */
export function assembleNodeCode() {
  return `
const items = $input.all();
return items.map(function (item, index) {
  const body = (item.json && item.json.body) || {};
  const scenario = body.scenario;

  if (typeof scenario !== "string" || !Object.prototype.hasOwnProperty.call(INCIDENTS, scenario)) {
    return { json: { index, state: "refused", reason: "no such scenario: " + String(scenario) +
      "; this workflow carries " + Object.keys(INCIDENTS).join(", ") } };
  }

  // Copied, not referenced. The embedded incident is the same object on every
  // execution of this workflow, and a run that mutated it would change what the
  // next run investigates.
  const incident = JSON.parse(JSON.stringify(INCIDENTS[scenario]));

  const before = validate("incident", incident);
  if (before.state !== "valid") {
    return { json: { index, state: "refused",
      reason: "the embedded incident does not validate: " + (before.errors || [before.reason]).join("; ") } };
  }

  const ctx = buildCheckedContext("kubernetes", incident, PROMPTS["kubernetes"]);
  if (ctx.state === "assembled") {
    return { json: { index, state: "asking", agent: "kubernetes", scenario: scenario,
      incident: incident, prompt: ctx.prompt, payload: ctx.payload } };
  }
  const kubeRecord = (incident.collection || {})["kubernetes"] || {};
  if (kubeRecord.state === "nothing") {
    return { json: { index, state: "skipped", agent: "kubernetes", scenario: scenario,
      incident: incident, skipped_because: "kubernetes had nothing to read: the provider reported an established absence" } };
  }
  return { json: { index, state: "refused", reason: "kubernetes: " + ctx.reason } };
});
`;
}

/**
 * The node that records one agent's answer and prepares the next question.
 *
 * Every refusal here is terminal and says which agent produced it. Codex, on an
 * earlier version of the local chain: an answer that fails to attach must not
 * be reported as the model's fault when the incident was already invalid, and
 * must not be skipped so the run continues without it. It stops.
 */
export function recordNodeCode(agent, next) {
  const nextLiteral = next === null ? "null" : JSON.stringify(next);
  return `
const AGENT = ${JSON.stringify(agent)};
const NEXT = ${nextLiteral};

const items = $input.all();
return items.map(function (item, index) {
  const j = item.json || {};

  // A previous node already refused. Carried through untouched: a later node
  // that "recovers" from an earlier refusal is how a refused run turns into a
  // clean-looking answer.
  if (j.state === "refused") return { json: j };

  const incident = j.incident;

  // Nothing was asked, because the slot before this one was empty. There is no
  // reply to record; the incident simply travels on.
  if (j.state !== "skipped") {
    const reply = j.reply;
    if (typeof reply !== "object" || reply === null) {
      return { json: { index, state: "refused", agent: AGENT,
        reason: AGENT + " returned nothing that could be read as an answer" } };
    }
    // The node knows who it asked, and says so. The schema spells root-cause
    // with an underscore; the node names it with a hyphen.
    const recorded = recordAgentResult(validate, incident, reply, AGENT.replace("-", "_"));
    if (recorded.state !== "recorded") {
      return { json: { index, state: "refused", agent: AGENT,
        reason: AGENT + ": " + recorded.reason, errors: recorded.errors || [] } };
    }
    j.incident = recorded.incident;
    // Carried out of the run: how many citations the model wrote in a spelling
    // that had to be normalised. Zero and four are different runs.
    j.normalised = (j.normalised || 0) + (recorded.normalised || 0);
  }

  if (NEXT === null) {
    return { json: { index, state: "recorded", agent: AGENT, scenario: j.scenario,
      incident: j.incident, normalised: j.normalised || 0 } };
  }

  const ctx = buildCheckedContext(NEXT, j.incident, PROMPTS[NEXT]);
  if (ctx.state === "assembled") {
    return { json: { index, state: "asking", agent: NEXT, scenario: j.scenario,
      incident: j.incident, prompt: ctx.prompt, payload: ctx.payload,
      normalised: j.normalised || 0 } };
  }

  /*
   * An agent with nothing to read is skipped, not refused.
   *
   * Measured on the first live run, 2026-09-05: two scenarios declare
   * "__nothing" for metrics on purpose, and the whole incident was refused
   * because one of three agents had no observation. An established absence is
   * an answer; refusing the investigation over it throws away the two agents
   * that did have something.
   *
   * The decision is read from the incident's own collection record, NOT from
   * the text of a reason. Codex, the same day: matching a substring means any
   * future failure whose message happens to contain those words becomes a skip,
   * and the rule breaks silently the day someone rewords a sentence. The
   * document already says which slots hold an established absence; that is the
   * thing to ask.
   */
  /*
   * Only an agent that reads a slot can be skipped for an empty one.
   *
   * Grok, 2026-09-06, traced this and reached the wrong conclusion — the chain
   * does work — but landed on something real: the root cause agent reads no
   * slot, AGENT_SLOT gives null for it, and collection[null] is undefined, so
   * the branch happened to refuse for the right reason by accident. A line that
   * is correct by luck is a line nobody can reason about.
   */
  const slot = AGENT_SLOT[NEXT];
  if (slot === null || slot === undefined) {
    return { json: { index, state: "refused", agent: NEXT,
      reason: NEXT + " reads no observation slot, so its context failing is a refusal and never a skip: " + ctx.reason } };
  }
  const collection = (j.incident && j.incident.collection) || {};
  const record = collection[slot] || {};
  if (record.state === "nothing") {
    return { json: { index, state: "skipped", agent: NEXT, scenario: j.scenario,
      incident: j.incident, normalised: j.normalised || 0,
      skipped_because: NEXT + " had nothing to read: the provider reported an established absence" } };
  }
  return { json: { index, state: "refused", agent: NEXT, reason: NEXT + ": " + ctx.reason } };
});
`;
}

/**
 * The last node: promote the root cause agent's hypothesis into the incident.
 *
 * concludeIncident is the same function the local tests exercise, transpiled
 * into this workflow. Nothing about the verdict is decided here.
 */
/**
 * The last node: say what happened, in the incident's own thread.
 *
 * Free and deterministic — it reads fields already on the incident and asks no
 * model. It runs after Conclude so the verdict exists to be reported.
 *
 * A refusal to report does NOT discard the conclusion. The chain has already
 * done the expensive work; losing it because a sentence could not be appended
 * would be paying for an answer and throwing it away. The item carries the
 * conclusion plus `report_refused`, so the failure is visible rather than
 * silent, and a reader can still see what was concluded.
 */
export function reportNodeCode() {
  return `
const items = $input.all();
return items.map(function (item, index) {
  const j = item.json || {};
  if (j.state === "refused") return { json: j };
  if (j.state !== "concluded") {
    return { json: { index, state: "refused",
      reason: "the item reached the report in state " + JSON.stringify(j.state) +
        ", which this chain does not produce" } };
  }

  /*
   * The timestamp comes from the incident, not from the clock.
   *
   * A clock here would make two runs of the same incident produce different
   * documents, and the drift check compares documents. collected_at is when
   * this incident's evidence was gathered, which is the honest moment to stamp
   * a report of it.
   */
  const inc = j.incident || {};
  const at = inc.started_at || "1970-01-01T00:00:00Z";

  const reported = reportIncident(validate, inc, at);
  if (reported.state !== "reported") {
    return { json: Object.assign({}, j, { report_refused: reported.reason }) };
  }
  const next = Object.assign({}, inc, { conversation: reported.conversation });
  return { json: Object.assign({}, j, { incident: next,
    thread: (reported.conversation.messages || []).map(function (m) { return m.text; }) }) };
});
`;
}

export function concludeNodeCode() {
  return `
const items = $input.all();
return items.map(function (item, index) {
  const j = item.json || {};
  if (j.state === "refused") return { json: j };

  /*
   * Only a state this chain produced may arrive here.
   *
   * Codex, 2026-09-05: the gates treat everything that is not "asking" alike,
   * so an item in any other state walks every false branch and lands here
   * intact. If it carried a verdict from somewhere else, this node would
   * promote it — a conclusion the run never reached, wearing the run's name.
   */
  if (j.state !== "recorded" && j.state !== "skipped") {
    return { json: { index, state: "refused",
      reason: "the item reached the end in state " + JSON.stringify(j.state) +
        ", which this chain does not produce; refusing rather than concluding from it" } };
  }

  /*
   * And the root cause agent must have answered in THIS execution.
   *
   * Same review: an incident that already carried a root cause result would
   * otherwise be concluded without any agent being asked. The check is on the
   * agents recorded in the document, because that is what concludeIncident
   * reads — and the last thing this chain does before here is record it.
   */
  const agents = ((j.incident || {}).analysis || {}).agents || [];
  const asked = agents.filter(function (a) { return a && a.agent === "root_cause"; });
  if (asked.length !== 1) {
    return { json: { index, state: "refused",
      reason: "the incident carries " + asked.length + " root cause results; exactly one is expected, " +
        "and a conclusion drawn from any other number did not come from this run" } };
  }

  const concluded = concludeIncident(validate, j.incident);
  if (concluded.state !== "concluded") {
    return { json: { index, state: "refused", reason: "conclude: " + concluded.reason, errors: concluded.errors || [] } };
  }

  const analysis = concluded.incident.analysis || {};
  return { json: { index, state: "concluded", scenario: j.scenario,
    normalised: j.normalised || 0,
    root_cause_code: analysis.root_cause_code,
    root_cause: analysis.root_cause,
    confidence: analysis.confidence,
    evidence: analysis.evidence,
    incident: concluded.incident } };
});
`;
}
