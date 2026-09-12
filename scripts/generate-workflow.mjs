/**
 * Generate the n8n workflow from the assembled core.
 *
 * The generated JSON is a DERIVED ARTIFACT, not a source of truth. Codex was
 * explicit about this when the chunk was scoped: the schemas, the deterministic
 * core, the template below and this generator are authoritative; workflows/*.json
 * is reproducible output that happens to be committed so drift can be detected
 * against it.
 *
 * The consequence is a rule: nobody edits workflows/*.json. Anything that must
 * change in the deployed workflow changes here or in the core, and the file is
 * regenerated. A gate check compares the committed file against a fresh
 * generation, so an edit made directly to it fails rather than survives.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

import { buildRuntime, assembleNodeCode, recordNodeCode, concludeNodeCode, reportNodeCode, AGENT_ORDER } from "./workflow-runtime.mjs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = resolve(ROOT, "out/core.js");
const OUT = resolve(ROOT, "workflows/incident.json");

/**
 * The webhook path is fixed and committed, not random.
 *
 * A generated random path would differ on every run and make drift detection
 * meaningless — every comparison would report a difference that means nothing,
 * and the real differences would drown in it.
 */
export const WEBHOOK_PATH = "ai-sre-incident";

/**
 * The node the core runs in.
 *
 * The wrapper exists because the Code node has no module system: `exports` is
 * undefined and `module` carries only an empty exports (measured, see
 * docs/n8n-spike.md §9). So the CommonJS artifact is handed its own.
 */
/**
 * The node that asks one agent, through the OpenAI credential in n8n.
 *
 * The prompt and the payload come from the item, never from this file. A node
 * that carried its own prompt would be a second copy of what the context
 * assembler produced, and the isolation checks would be checking something
 * other than what was sent.
 *
 * temperature 0 and a fixed model, because a run that cannot be repeated cannot
 * be compared with the previous one, and comparison is the only thing that
 * makes a second run worth its cost.
 */
function askNode(agent, position) {
  return {
    id: `ask-${agent}`,
    name: `Ask ${agent}`,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position,
    credentials: { openAiApi: { id: OPENAI_CREDENTIAL.id, name: OPENAI_CREDENTIAL.name } },
    parameters: {
      method: "POST",
      url: "https://api.openai.com/v1/chat/completions",
      authentication: "predefinedCredentialType",
      nodeCredentialType: "openAiApi",
      sendBody: true,
      specifyBody: "json",
      /*
       * NO `temperature` since 2026-09-11, and it is a loss, not a tidy-up.
       *
       * The body sent `temperature: 0` so that two runs could be compared. On
       * `gpt-5` OpenAI refuses it outright — HTTP 400, „Unsupported value:
       * 'temperature' does not support 0 with this model. Only the default (1)
       * value is supported." Read out of execution 296 by the owner's local
       * n8n agent; the call was rejected at validation, before any inference,
       * so nothing was billed.
       *
       * Omitting the field takes the model's default, which is 1. So runs on
       * this model are NOT repeatable in the way every comparison so far
       * assumed, and a difference between two of them can be the sampling
       * rather than the change. That is stated in LIMITATIONS rather than
       * papered over, and it is the price of asking this model anything.
       */
      jsonBody: "={{ JSON.stringify({ model: " + JSON.stringify(modelFor(agent)) + ", "
        + "response_format: { type: 'json_object' }, messages: [ "
        + "{ role: 'system', content: $json.prompt }, "
        + "{ role: 'user', content: JSON.stringify($json.payload) } ] }) }}",
      options: {},
    },
  };
}

/**
 * Pull the model's answer out of the API response and put the incident back.
 *
 * n8n replaces the item with the HTTP response, so everything the chain was
 * carrying is gone by the time the next Code node runs. This puts it back from
 * the node before — and it is a Set node rather than Code so the join is
 * visible in the editor rather than buried in three hundred kilobytes.
 */
/**
 * The gate that keeps a refusal out of a paid call.
 *
 * Measured on the first live run, 2026-09-05, and it cost money to learn: a
 * Record node refused, the item flowed on regardless, and the next HTTP node
 * built a request with an undefined prompt. OpenAI answered 400 — after being
 * paid for the two agents that ran before it. A refusal that keeps spending is
 * the worst shape a refusal can have.
 *
 * True asks the agent. False walks past it to the next gate, and the last
 * gate's false goes to Conclude, which passes a refusal through untouched. So a
 * skipped agent and a refused run both reach the end without another call.
 */
function gateNode(agent, position) {
  return {
    id: `gate-${agent}`,
    name: `Ask ${agent}?`,
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
        combinator: "and",
        conditions: [{
          id: `is-asking-${agent}`,
          operator: { type: "string", operation: "equals" },
          leftValue: "={{ $json.state }}",
          rightValue: "asking",
        }],
      },
      options: {},
    },
  };
}

function collectNode(agent, from, position) {
  return {
    id: `collect-${agent}`,
    name: `Collect ${agent}`,
    type: "n8n-nodes-base.set",
    typeVersion: 3.4,
    position,
    parameters: {
      mode: "raw",
      /*
       * Unwraps the two shapes a model reaches for even under json_object mode.
       *
       * Grok, 2026-09-05, on the run about to be paid for: a fenced block and a
       * single-key wrapper are the common ways an otherwise correct answer is
       * thrown away. Both are cheap to accept and neither loosens the schema —
       * whatever comes out still goes through recordAgentResult.
       *
       * Anything else still becomes null, which the next node reports as the
       * agent returning nothing readable. Guessing further would be inventing
       * an answer on the model's behalf.
       */
      /*
       * `raw` beside `reply`, and it survives a reply that could not be read.
       *
       * The model's own words were parsed and then dropped: Record stored the
       * PARSED object and the text disappeared. So a refused answer could not
       * be looked at afterwards — you knew only that it was refused — and a run
       * already paid for could not be scored again with a corrected scorer,
       * which is the one thing the rule about re-judging a run depends on.
       *
       * Two separate immediately-invoked functions rather than one that returns
       * both, because the reply parser has a dozen early returns and threading a
       * second value through every one of them is how the raw text would come to
       * be dropped on the path nobody tested. This one has a single return.
       */
      jsonOutput: `={{ JSON.stringify(Object.assign({}, $('${from}').item.json, { raw: (function () {`
        + ` var c = $json && $json.choices;`
        + ` var m = Array.isArray(c) && c.length > 0 && c[0] ? c[0].message : null;`
        + ` var t = m ? m.content : null;`
        + ` return typeof t === 'string' ? t : null; })(),`
        /*
         * What the call cost, from the reply that carries it.
         *
         * The webhook answer carries no usage, so `node scripts/spend.mjs`
         * reports sixteen runs it could not price — the number is a floor and
         * says so. The reply from the model DOES carry it, and nothing read it
         * until 2026-09-10, when the owner's local n8n agent read execution 260
         * node by node and found 11 249 input tokens where this project had
         * been counting 4 213.
         *
         * Its own function, for the reason the one above has: threading a value
         * through a parser with a dozen early returns is how it comes to be
         * dropped on the path nobody tested.
         */
        + ` usage: (function () {`
        + ` var u = $json && $json.usage;`
        + ` if (!u || typeof u !== 'object') return null;`
        + ` return { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens,`
        + ` cached_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0 }; })(),`
        /*
         * The model that ANSWERED, from the reply that names it.
         *
         * Collect kept `usage` and dropped `$json.model`, so a trace could say
         * how many tokens a call cost but not which model spent them — and the
         * pinned model and the model that replied are not guaranteed equal (a
         * provider can route or downgrade). Grok, 2026-09-12, named this as the
         * first honest gap in the Langfuse trace protocol. Missing is null, never
         * a guess: a reply that carries no model name is unestablished, not the
         * pinned one restated.
         */
        + ` model: (function () { var mm = $json && $json.model; return (typeof mm === 'string' && mm) ? mm : null; })(),`
        + ` reply: (function () {`
        /*
         * Four unguarded property accesses used to stand here, with the
         * try/catch wrapped around JSON.parse only. A subagent measured what a
         * 200 that is not the OpenAI envelope does on 2026-09-07: a gateway's
         * HTML error page, `{choices: []}`, `{error: {...}}` and
         * `{choices: [{}]}` all threw a raw TypeError inside n8n, halting the
         * execution — while the test named "turns an unparseable answer into
         * null rather than throwing inside n8n" covered the ONE body shape that
         * cannot throw, because the harness only ever builds real envelopes.
         *
         * Reading the path defensively turns every one of them into null, which
         * the next node already reports as the agent returning nothing readable.
         */
        + ` var c = $json && $json.choices;`
        + ` var m = Array.isArray(c) && c.length > 0 && c[0] ? c[0].message : null;`
        + ` var t = m ? m.content : null;`
        + ` if (typeof t !== 'string') return null;`
        + ` var plain = function (v) { return v !== null && typeof v === 'object' && !Array.isArray(v); };`
        + ` var read = function (x) { try { return JSON.parse(x); } catch (e) { return undefined; } };`
        + ` var o = read(t);`
        + ` if (typeof o === 'string') { var inner = read(o); if (plain(inner)) o = inner; else t = o; }`
        + ` var asObject = function (x) {`
        + `   var v = read(x);`
        + `   if (typeof v === 'string') { var i2 = read(v); return plain(i2) ? i2 : undefined; }`
        + `   return plain(v) ? v : undefined;`
        + ` };`
        + ` if (!plain(o)) {`
        + `   var re = /\`\`\`(?:json)?\\s*([\\s\\S]*?)\`\`\`/g, m1, got;`
        + `   while ((m1 = re.exec(t)) !== null) { got = asObject(m1[1]); if (got) { o = got; break; } }`
        + `   if (!plain(o)) { var g = t.match(/\`\`\`(?:json)?\\s*([\\s\\S]*)\`\`\`/); if (g) { got = asObject(g[1]); if (got) o = got; } }`
        + ` }`
        + ` if (!plain(o)) return null;`
        // One key whose value is an object is never an agent result — a valid
        // one carries five. So the wrapper can be unwrapped without asking
        // whether the thing inside looks like a result: that question was a
        // guard that could not change any outcome, and a guard that cannot
        // change an outcome is a line that reads as protection and is not.
        + ` var k = Object.keys(o);`
        + ` if (k.length === 1 && o[k[0]] && typeof o[k[0]] === 'object' && !Array.isArray(o[k[0]])) return o[k[0]];`
        + ` return o; })() })) }}`,
      options: {},
    },
  };
}

/** The model every agent is asked with, named once. */
/**
 * The model that CONCLUDES, and the one that collects.
 *
 * Two, since 2026-09-11, and the split is measured rather than tidy.
 *
 * `gpt-5` answered the one question this project could not answer any other
 * way: thirty recorded hypotheses across two smaller models and eight rounds
 * of prompts carried `contradicted_by` in none, and it produced dissent at 0.35
 * confidence with no prompt change at all. So the concluding agent keeps it.
 *
 * But four sequential `gpt-5` calls took 183 seconds and the gateway cuts the
 * connection at about 100, so the answer existed and could not be delivered.
 * Measured at the nodes: 9152 hidden reasoning tokens, of which the three
 * collection agents spent 6272 — on work that is EXTRACTION, not reasoning.
 * They read one slice and report what is in it; the judgement is the
 * concluding agent's, and that is where the tokens are worth their seconds.
 *
 * The owner chose this over lowering the reasoning effort, which would have
 * risked the dissent that had just been bought.
 */
export const MODEL = "gpt-5";

/** What the three collection agents ask. They extract; they do not conclude. */
export const COLLECTION_MODEL = "gpt-5-mini";

/** Which model one agent asks. */
export function modelFor(agent) {
  return agent === "root-cause" ? MODEL : COLLECTION_MODEL;
}

/**
 * Which stored credential the HTTP nodes use.
 *
 * Measured on 2026-09-05, on the first live run: naming only the credential
 * TYPE is not enough. n8n answered "Credentials not found" at the first agent
 * and the run stopped before any model call — free, and a good way to find out.
 *
 * The id is a pointer, not a secret: the key itself never leaves the n8n
 * instance, and drift detection masks this field precisely because it
 * legitimately differs per instance. The NAME is compared, so a workflow
 * pointed at a different account is drift rather than a surprise.
 *
 * FIXED, not read from the environment.
 *
 * They were `process.env.N8N_OPENAI_CREDENTIAL_ID ?? "…"`, and the comment here
 * claimed that produced the same bytes — true only when nobody has the variable
 * set. A subagent measured the rest on 2026-09-07: with either variable
 * exported, generation produces a different file, so a developer whose shell
 * carries them (the same shell that must source the n8n env for release,
 * verify-deployment and record-baseline) commits a workflow that is green
 * locally and permanently red everywhere else.
 *
 * Worse in one direction than the other. Drift masks `credentials/*​/id` and
 * compares `name` — so the NAME variable at least shows up as drift, while the
 * ID variable changes the committed artifact byte for byte and the only check
 * written to explain such a change is deliberately blind to it. A failure with
 * no diagnostic pointing anywhere near its cause.
 *
 * This was the ONLY non-hermetic input in the whole generation path; every
 * directory read in it already sorts, and nothing else touches a clock or a
 * random source. Pointing at another instance is now an edit to this file,
 * which is a change a diff can show.
 */
export const OPENAI_CREDENTIAL = {
  id: "fcCTZNZiEZhLkGHD",
  name: "OpenAI account",
};

export function buildWorkflow(runtime, { name = "AI SRE — incident investigation" } = {}) {
  const code = (id, nodeName, body, position) => ({
    id,
    name: nodeName,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    parameters: { language: "javaScript", mode: "runOnceForAllItems", jsCode: runtime.prelude + body },
  });

  const nodes = [
    {
      id: "incident-webhook",
      name: "Incident Webhook",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2,
      position: [0, 0],
      /*
       * The webhook answers on RECEIPT, not at the end of the chain.
       *
       * With `lastNode` the HTTP response waited for the whole investigation,
       * and n8n Cloud's gateway cuts at about 100 seconds. Measured on
       * 2026-09-11: a four-model chain finished at ~183s and the caller got
       * HTTP 524 while the execution was `status: success` — the answer was
       * bought, produced, and unreachable. Twice.
       *
       * `onReceived` removes the deadline instead of racing it. The cost is
       * that a 200 now means accepted rather than answered, so the runner
       * binds a submission token before the call and reads the finished report
       * out of the execution afterwards. See docs/async-shape.md.
       */
      parameters: { path: WEBHOOK_PATH, httpMethod: "POST", responseMode: "onReceived" },
    },
    code("assemble", "Assemble", assembleNodeCode(), [220, 0]),
  ];

  const connections = {
    "Incident Webhook": { main: [[{ node: "Assemble", type: "main", index: 0 }]] },
  };

  let previous = "Assemble";
  let x = 440;
  AGENT_ORDER.forEach((agent, i) => {
    const next = AGENT_ORDER[i + 1] ?? null;
    const gate = `Ask ${agent}?`;
    const ask = `Ask ${agent}`;
    const collect = `Collect ${agent}`;
    const record = `Record ${agent}`;

    nodes.push(gateNode(agent, [x, 0]));
    nodes.push(askNode(agent, [x + 180, 0]));
    nodes.push(collectNode(agent, previous, [x + 360, 0]));
    nodes.push(code(`record-${agent}`, record, recordNodeCode(agent, next), [x + 540, 0]));

    connections[previous] = { main: [[{ node: gate, type: "main", index: 0 }]] };
    // Output 0 is true, output 1 is false. The false branch is filled in below,
    // once the node it should jump to is known.
    connections[gate] = { main: [[{ node: ask, type: "main", index: 0 }], []] };
    connections[ask] = { main: [[{ node: collect, type: "main", index: 0 }]] };
    connections[collect] = { main: [[{ node: record, type: "main", index: 0 }]] };

    // False goes to this agent's Record node, not past it.
    //
    // Measured on the second live run, 2026-09-06: routing false to the NEXT
    // gate skipped the agent AND everything after it, so an incident whose
    // metrics were absent reached Conclude having never asked the root cause
    // agent. Record is what prepares the next question; a skipped agent still
    // has to pass through it, which is exactly what it does with state
    // "skipped" — it records nothing and builds the next context.
    connections[gate].main[1] = [{ node: record, type: "main", index: 0 }];

    previous = record;
    x += 740;
  });

  nodes.push(code("conclude", "Conclude", concludeNodeCode(), [x, 0]));
  connections[previous] = { main: [[{ node: "Conclude", type: "main", index: 0 }]] };

  /*
   * And then the thread, which is the only part a person reads.
   *
   * It was not here at all until 2026-09-07. The chain ended at Conclude and
   * returned an answer object, so every caveat src/core/thread.ts produces —
   * "could not read its source", "which is its own estimate and nothing here
   * checks it", the objection spelled out — existed only in tests. Free and
   * deterministic: it reads the incident and asks no model.
   */
  nodes.push(code("report", "Report", reportNodeCode(), [x + 740, 0]));
  connections["Conclude"] = { main: [[{ node: "Report", type: "main", index: 0 }]] };



  return { name, nodes, connections, settings: { executionOrder: "v1" } };
}

/** Stable JSON: key order fixed, so regeneration cannot produce a spurious diff. */
export function serialise(workflow) {
  return JSON.stringify(workflow, null, 2) + "\n";
}

/**
 * Generate from the schemas, not from whatever is lying in out/.
 *
 * Codex, chunk 1 parts 1-2: this used to read out/core.js off disk. The
 * comparison test then proved only that the committed workflow matched a
 * workflow built from whatever core happened to be there — so a schema change
 * could leave the core stale, the workflow stale, and the test green. The gate
 * made it worse by running the tests before the build, so it could validate the
 * old workflow and then refresh the core.
 *
 * Building in memory makes the chain source -> artifact -> workflow unbroken:
 * there is no intermediate file to be out of date.
 */
export async function generate() {
  const runtime = await buildRuntime();
  const workflow = buildWorkflow(runtime);
  const text = serialise(workflow);
  return { workflow, text, sha256: createHash("sha256").update(text).digest("hex") };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { text, sha256 } = await generate();
  mkdirSync(dirname(OUT), { recursive: true });
  const changed = !existsSync(OUT) || readFileSync(OUT, "utf8") !== text;
  writeFileSync(OUT, text);
  process.stdout.write(`workflows/incident.json ${text.length} bytes, sha256 ${sha256.slice(0, 12)}… ${changed ? "(changed)" : "(unchanged)"}\n`);
}
