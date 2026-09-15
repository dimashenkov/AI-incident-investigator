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
    // On a provider error (429, quota, 5xx) DO NOT kill the execution — send the item
    // out the error output (index 1) so it can fall over to Grok, announced. Without
    // this the whole run dies and records `unestablished` with no reason (2026-09-13).
    onError: "continueErrorOutput",
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
 * The Grok fallback for one agent (owner, 2026-09-13, variant A — every agent).
 *
 * Reached only from `Ask <agent>`'s ERROR output. It re-asks the SAME question of
 * Grok over the xAI API (OpenAI-compatible, so the response shape Collect unwraps is
 * identical), then feeds the SAME `Collect <agent>` node — so the failover is
 * transparent to everything downstream except that the reply now names grok-4.3
 * rather than the OpenAI model, which is the announcement: the trace shows Grok
 * answered, never a silent swap. prompt and payload are read from the gate node (a
 * shared upstream), not from the errored item, so they are always present.
 *
 * LIMITATIONS, stated not hidden (Grok, 2026-09-13): (1) the failover is announced by
 * WHICH model answered (model_by_agent carries grok-4.3), but the primary's error
 * REASON — the 429 or quota text — is not carried into the record; the n8n execution
 * log has it, the answer does not. (2) An OpenAI call that times out or 5xx's AFTER it
 * was accepted can be billed even though Grok then answers too — one incident, two
 * charges. Neither is a live leak; both are real-deploy costs to weigh.
 */
function grokNode(agent, position) {
  const gate = `Ask ${agent}?`;
  return {
    id: `grok-${agent}`,
    name: `Grok ${agent}`,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position,
    // If Grok ALSO fails (e.g. the API rejects response_format), do not kill the
    // execution after already paying — send the item on so Collect records it as
    // unreadable (unestablished) rather than the run dying (Grok, 2026-09-13).
    onError: "continueErrorOutput",
    credentials: { httpHeaderAuth: { id: GROK_CREDENTIAL.id, name: GROK_CREDENTIAL.name } },
    parameters: {
      method: "POST",
      url: GROK_URL,
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
      sendBody: true,
      specifyBody: "json",
      // prompt/payload read from the gate with `.first()`, not `.item`: the item
      // arrives here through Ask's ERROR output, and paired-item across an error
      // branch is fragile (the listener uses `.first()` for the same reason). The
      // flow carries one incident, so `.first()` is the same item, robustly.
      jsonBody: "={{ JSON.stringify({ model: " + JSON.stringify(GROK_MODEL) + ", "
        + "response_format: { type: 'json_object' }, messages: [ "
        + "{ role: 'system', content: $('" + gate + "').first().json.prompt }, "
        + "{ role: 'user', content: JSON.stringify($('" + gate + "').first().json.payload) } ] }) }}",
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
      jsonOutput: `={{ JSON.stringify(Object.assign({}, $('${from}').first().json, { raw: (function () {`
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

/*
 * The fallback model provider (owner, 2026-09-13): a SECOND model, Grok via the xAI
 * API, that answers when the primary (OpenAI) call errors — announced, not silent, so
 * the trace shows Grok answered and never blends the failover into a normal answer.
 * xAI is OpenAI-compatible (same /chat/completions body and response shape), reached
 * over a generic Header Auth credential (`Authorization: Bearer <xai key>`) exactly
 * like Slack — the key never enters this file. The credential id/name and the model
 * are constants for the same hermetic reason as OPENAI_CREDENTIAL. GROK_MODEL is the
 * cheapest clean xAI model at the time of writing; the exact id is server-validated,
 * confirmed only on the first live call. See docs/credentials.md.
 */
export const GROK_CREDENTIAL = {
  id: "Sreprau5RgIFeMqG",
  name: "grok",
};
export const GROK_MODEL = "grok-4.3";
const GROK_URL = "https://api.x.ai/v1/chat/completions";

/*
 * The real Slack post (decision B, 2026-09-12). The whole chain — rowNotExists ->
 * post -> took -> IF -> insert — was built and proven live in a scratch workflow
 * before being written here: the first run posted to #incidents and recorded the
 * ts, the second run for the same incident was dropped by rowNotExists and posted
 * nothing (sequential dedup). See docs/slack-setup.md.
 *
 * The credential is a generic Header Auth (`Authorization: Bearer <bot token>`),
 * referenced by id+name exactly like OPENAI_CREDENTIAL — the token never enters
 * this file or the workflow JSON. `authentication` is `genericCredentialType` (not
 * `predefinedCredentialType`, which is for service-specific creds and silently
 * sent no header — measured `not_authed`). The channel and the table id are
 * constants, not env, for the same hermetic reason the OpenAI credential is.
 */
export const SLACK_CREDENTIAL = {
  id: "eOVr6fQ0yzz3yiwO",
  name: "Header Auth account",
};
const SLACK_CHANNEL = "C0C1AQLTRM4";
const THREAD_TABLE = "HXGSOCOFnTmnAZtJ";
/* The raw observations, stored per incident_id as a durable per-incident record.
 * Written on an independent branch off Report (never into the Slack body — the
 * observations must not leak to Slack; the store is private to the n8n instance).
 * Created 2026-09-12 to let the two-way bot answer from the full data; that reader
 * was REMOVED 2026-09-13 (Grok leak review — the reply path answers from the
 * curated report, so a stored credential is never fetched into a model prompt).
 * The write is kept as an audit record; nothing reads it now. A pointer, not a
 * secret. */
const INCIDENT_DATA_TABLE = "rKZEwVRRLB3Xb6LR";
/* The SIMULATED Datadog registrations, one row per incident_id. A pointer, not a
 * secret. Created 2026-09-12. Nothing is ever sent to Datadog — this is the mock's
 * system of record. */
const DATADOG_TABLE = "A1V7WCnaRAdGhtwW";

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

    const grok = `Grok ${agent}`;
    nodes.push(gateNode(agent, [x, 0]));
    nodes.push(askNode(agent, [x + 180, 0]));
    nodes.push(grokNode(agent, [x + 180, 180]));
    nodes.push(collectNode(agent, previous, [x + 360, 0]));
    nodes.push(code(`record-${agent}`, record, recordNodeCode(agent, next), [x + 540, 0]));

    connections[previous] = { main: [[{ node: gate, type: "main", index: 0 }]] };
    // Output 0 is true, output 1 is false. The false branch is filled in below,
    // once the node it should jump to is known.
    connections[gate] = { main: [[{ node: ask, type: "main", index: 0 }], []] };
    // Ask output 0 is success -> Collect; output 1 is the ERROR output (onError:
    // continueErrorOutput) -> Grok fallback, which then joins the SAME Collect.
    connections[ask] = { main: [[{ node: collect, type: "main", index: 0 }], [{ node: grok, type: "main", index: 0 }]] };
    /*
     * Grok's success (0) goes straight to Collect. Its ERROR (1) goes through a marker
     * node first, then to the SAME Collect.
     *
     * Both outputs used to wire directly to Collect: correct behaviour (a Grok that
     * also fails lands as an unreadable reply rather than killing a run already paid
     * for) but "Grok answered" and "Grok failed" were indistinguishable at the wire
     * level, so no trace could ever say which happened (prd-agent-n8n, 2026-09-15).
     * The marker makes the failure observable without a second Collect — Grok refused
     * the split, because two Collect nodes would duplicate the defensive unwrap that
     * is the one thing that must not drift into two copies.
     */
    const grokFailed = `${grok} failed`;
    nodes.push({
      id: `grok-failed-${agent}`, name: grokFailed, type: "n8n-nodes-base.set", typeVersion: 3.4,
      position: [x + 270, 300],
      parameters: { mode: "raw",
        jsonOutput: "={{ JSON.stringify(Object.assign({}, $json, { grok_error: true, grok_error_at: " + JSON.stringify(agent) + " })) }}",
        options: {} },
    });
    connections[grok] = { main: [[{ node: collect, type: "main", index: 0 }], [{ node: grokFailed, type: "main", index: 0 }]] };
    connections[grokFailed] = { main: [[{ node: collect, type: "main", index: 0 }]] };
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

  /*
   * Record usage — the token counts, made durable (prd-agent-n8n, 2026-09-15).
   *
   * The Collect nodes compute `usage_by_agent` and every Record node carries it
   * faithfully — and then nothing stored it: the numbers survived only inside the n8n
   * execution record, which n8n PRUNES. That breaks this repo's own rule (every paid
   * call records an artifact at the time of the call), and the honest answer to "what
   * did last month cost" would simply vanish with the retention window.
   *
   * PARALLEL off Conclude, deliberately — an earlier version put it SERIALLY between
   * Conclude and Report and Grok blocked it (2026-09-15): an n8n dataTable node can
   * REPLACE the item with the written row, this repo already knows it (the listener's
   * `Fetch thread` reads `$('Handle')`, and `Slack took` reads `$('Report')`, for exactly
   * that reason), and `Report` refuses anything whose `state` is not "concluded". So a
   * store on the line could have swallowed the whole report — four paid calls spent and
   * nothing posted, which is far worse than the lost token counts it fixes. Off to the
   * side it cannot touch what Report receives.
   *
   * Grok refused a NEW table: it upserts into the SAME incident table keyed by
   * incident_id, and `Record incident data` was given the same columns so its later
   * upsert of that row carries them forward instead of wiping them. This is n8n-side
   * evidence, not a spend.mjs artifact: spend.mjs still reads only disk
   * (docs/spend-counter.md), and nothing here makes it touch the network.
   */
  const usageTable = { __rl: true, mode: "id", value: INCIDENT_DATA_TABLE };
  nodes.push({
    id: "store-usage", name: "Record usage", type: "n8n-nodes-base.dataTable", typeVersion: 1.1,
    position: [x + 740, 220],
    parameters: { resource: "row", operation: "upsert", dataTableId: usageTable,
      filters: { conditions: [{ keyName: "incident_id", condition: "eq",
        keyValue: "={{ $json.incident.incident_id }}" }] },
      columns: { mappingMode: "defineBelow",
        /*
         * Carries `data` too, symmetrically (Grok, 2026-09-15, third round).
         *
         * This node and `Record incident data` now upsert the SAME row in PARALLEL, and
         * a defineBelow upsert blanks the columns it does not name. Naming only the usage
         * columns here would wipe the observations whenever this one happens to write
         * last — the mirror image of the defect the carried columns down there fix. Both
         * writers now name every column, so whichever lands last writes the same values.
         */
        value: {
          incident_id: "={{ $json.incident.incident_id }}",
          data: "={{ JSON.stringify($json.incident.observations || {}) }}",
          usage: "={{ JSON.stringify($json.usage_by_agent || {}) }}",
          models: "={{ JSON.stringify($json.model_by_agent || {}) }}",
          execution_id: "={{ String($execution.id) }}",
        },
        matchingColumns: ["incident_id"], schema: [
          { id: "incident_id", displayName: "incident_id", type: "string", canBeUsedToMatch: true, required: false, display: true, defaultMatch: false },
          { id: "data", displayName: "data", type: "string", canBeUsedToMatch: false, required: false, display: true, defaultMatch: false },
          { id: "usage", displayName: "usage", type: "string", canBeUsedToMatch: false, required: false, display: true, defaultMatch: false },
          { id: "models", displayName: "models", type: "string", canBeUsedToMatch: false, required: false, display: true, defaultMatch: false },
          { id: "execution_id", displayName: "execution_id", type: "string", canBeUsedToMatch: false, required: false, display: true, defaultMatch: false },
        ] } },
    // Storing the usage must never cost the run: a data-table failure here would
    // otherwise throw away an investigation that is already paid for and concluded.
    onError: "continueRegularOutput",
  });
  connections["Conclude"] = { main: [[
    { node: "Report", type: "main", index: 0 },
    { node: "Record usage", type: "main", index: 0 },
  ]] };

  /*
   * And then the real Slack post — the visible end of the prototype (decision B).
   *
   * Report -> Slack gate -> Slack lookup -> Slack post -> Slack took -> Slack ok
   * -> Slack record. Every shape here was proven live in a scratch workflow before
   * being written (see SLACK_CREDENTIAL above).
   *
   *  - Slack gate: only an item carrying an incident_id posts. Report emits
   *    refused items too; posting one would send an empty message. The gate reads
   *    the id defensively so an undefined incident does not throw.
   *  - Slack lookup: `rowNotExists` is the dedup, not a Get — Get ERRORS on a miss
   *    and kills the chain (measured); rowNotExists passes a miss through UNCHANGED
   *    and drops a hit, so an incident already posted opens no second thread. This
   *    closes the SEQUENTIAL retry only; two simultaneous runs is the recorded
   *    SKIP-Redis limitation (n8n Cloud runs webhooks concurrently, measured).
   *  - Slack post: chat.postMessage with Block Kit `blocks` (slackReport) and the
   *    plain thread as the `text` fallback — never the incident or the
   *    observations, which would leak to a foreign disk the way content-capture
   *    to Langfuse would. slackReport builds the blocks from this incident's own
   *    curated fields (cluster, namespace, the offending pod, the thread lines),
   *    not from the observation blob, so the formatted message carries no more
   *    than the plain one did.
   *  - Slack took + Slack ok: Slack returns HTTP 200 even on {ok:false}, so the ts
   *    is taken only when ok===true and non-empty, and only then does record run.
   *    An empty ts must never be written — it would poison the dictionary forever.
   *  - Slack record: insert (not upsert) is safe because rowNotExists already
   *    proved no row exists on this branch.
   */
  const sx = x + 740;
  const ifOptions = { caseSensitive: true, typeValidation: "strict", version: 2 };
  const dtId = { __rl: true, mode: "id", value: THREAD_TABLE };

  nodes.push({
    id: "slack-gate", name: "Slack gate", type: "n8n-nodes-base.if", typeVersion: 2.2,
    position: [sx + 740, 0],
    parameters: { conditions: { options: ifOptions, combinator: "and", conditions: [{
      leftValue: "={{ ($json.incident && $json.incident.incident_id) ? $json.incident.incident_id : '' }}",
      rightValue: "", operator: { type: "string", operation: "notEmpty" } }] } },
  });
  // Report fans out to TWO independent branches: the Slack post (curated report)
  // and the raw-data store (full observations, for the two-way bot to answer
  // detailed questions). The store runs regardless of Slack dedup, and its data
  // NEVER enters the Slack body — the observations stay private to the instance.
  const idTable = { __rl: true, mode: "id", value: INCIDENT_DATA_TABLE };
  nodes.push({
    id: "store-data", name: "Record incident data", type: "n8n-nodes-base.dataTable", typeVersion: 1.1,
    position: [sx + 1480, 220],
    parameters: { resource: "row", operation: "upsert", dataTableId: idTable,
      filters: { conditions: [{ keyName: "incident_id", condition: "eq",
        keyValue: "={{ $json.incident.incident_id }}" }] },
      /*
       * Carries the usage columns forward (Grok, 2026-09-15). This upserts the SAME row
       * `Record usage` just wrote, keyed by incident_id — a defineBelow upsert that named
       * only incident_id/data would blank `usage`, `models` and `execution_id`, so the
       * durable-token fix would delete itself one node later. They are re-read from the
       * Report item, which carries them through from Conclude.
       */
      columns: { mappingMode: "defineBelow",
        value: { incident_id: "={{ $json.incident.incident_id }}",
          data: "={{ JSON.stringify($json.incident.observations || {}) }}",
          usage: "={{ JSON.stringify($json.usage_by_agent || {}) }}",
          models: "={{ JSON.stringify($json.model_by_agent || {}) }}",
          execution_id: "={{ String($execution.id) }}" },
        matchingColumns: ["incident_id"], schema: [
          { id: "incident_id", displayName: "incident_id", type: "string", canBeUsedToMatch: true, required: false, display: true, defaultMatch: false },
          { id: "data", displayName: "data", type: "string", canBeUsedToMatch: false, required: false, display: true, defaultMatch: false },
          { id: "usage", displayName: "usage", type: "string", canBeUsedToMatch: false, required: false, display: true, defaultMatch: false },
          { id: "models", displayName: "models", type: "string", canBeUsedToMatch: false, required: false, display: true, defaultMatch: false },
          { id: "execution_id", displayName: "execution_id", type: "string", canBeUsedToMatch: false, required: false, display: true, defaultMatch: false },
        ] } },
  });
  // A third independent branch: the SIMULATED Datadog registration (owner asked;
  // Datadog is paid, so it is mocked — never a real call). Report already built
  // the mock record (datadog_record); this only stores it, keyed by incident_id,
  // upsert so a re-run refreshes the one row. Nothing is sent to Datadog.
  const ddTable = { __rl: true, mode: "id", value: DATADOG_TABLE };
  nodes.push({
    id: "store-dd", name: "Record Datadog", type: "n8n-nodes-base.dataTable", typeVersion: 1.1,
    position: [sx + 1480, 420],
    parameters: { resource: "row", operation: "upsert", dataTableId: ddTable,
      filters: { conditions: [{ keyName: "incident_id", condition: "eq",
        keyValue: "={{ $json.incident.incident_id }}" }] },
      columns: { mappingMode: "defineBelow",
        value: { incident_id: "={{ $json.incident.incident_id }}",
          record: "={{ JSON.stringify($json.datadog_record || {}) }}" },
        matchingColumns: ["incident_id"], schema: [
          { id: "incident_id", displayName: "incident_id", type: "string", canBeUsedToMatch: true, required: false, display: true, defaultMatch: false },
          { id: "record", displayName: "record", type: "string", canBeUsedToMatch: false, required: false, display: true, defaultMatch: false },
        ] } },
  });
  // Reported? — the gate before EVERY downstream branch. Subagent audit
  // 2026-09-12: Report also emits a refusal shape ({...j, report_refused}) that
  // still carries incident.incident_id but no slack_blocks / datadog_record, and a
  // fully-refused item carries no incident at all. Ungated, the stores wrote a row
  // for a failed report (`|| {}` masking the absence) or threw on the missing
  // incident. Only a SUCCESSFULLY reported item — one carrying slack_text — passes.
  nodes.push({
    id: "reported", name: "Reported", type: "n8n-nodes-base.if", typeVersion: 2.2,
    position: [sx + 740, -220],
    parameters: { conditions: { options: ifOptions, combinator: "and", conditions: [{
      leftValue: "={{ $json.slack_text }}", rightValue: "",
      operator: { type: "string", operation: "notEmpty" } }] } },
  });
  connections["Report"] = { main: [[{ node: "Reported", type: "main", index: 0 }]] };
  // Reported true -> the three branches; false -> nothing (no post, no stores).
  connections["Reported"] = { main: [[
    { node: "Slack gate", type: "main", index: 0 },
    { node: "Record incident data", type: "main", index: 0 },
    { node: "Record Datadog", type: "main", index: 0 },
  ], []] };

  nodes.push({
    id: "slack-lookup", name: "Slack lookup", type: "n8n-nodes-base.dataTable", typeVersion: 1.1,
    position: [sx + 1480, 0],
    parameters: { resource: "row", operation: "rowNotExists", dataTableId: dtId,
      filters: { conditions: [{ keyName: "incident_id", condition: "eq",
        keyValue: "={{ $json.incident.incident_id }}" }] } },
  });
  // Gate true -> lookup; gate false -> nothing (a refused item never posts).
  connections["Slack gate"] = { main: [[{ node: "Slack lookup", type: "main", index: 0 }], []] };

  nodes.push({
    id: "slack-post", name: "Slack post", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2,
    position: [sx + 2220, 0],
    credentials: { httpHeaderAuth: { id: SLACK_CREDENTIAL.id, name: SLACK_CREDENTIAL.name } },
    parameters: { method: "POST", url: "https://slack.com/api/chat.postMessage",
      authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth",
      sendHeaders: true, headerParameters: { parameters: [{ name: "Content-Type", value: "application/json; charset=utf-8" }] },
      sendBody: true, specifyBody: "json",
      jsonBody: `={{ JSON.stringify({ channel: "${SLACK_CHANNEL}", blocks: ($json.slack_blocks || []), text: ($json.slack_text || ($json.thread || []).join("\\n\\n")) }) }}`,
      /*
       * A Slack outage must not destroy an investigation that was already paid for.
       *
       * Without these the node THROWS on HTTP 500: the execution dies at the Slack
       * branch, and because `Record incident data` / `Record Datadog` sit on parallel
       * branches off Reported, whether they ran at all depends on execution order —
       * four model calls paid for, the result neither posted nor reliably stored
       * (prd-agent-n8n, 2026-09-15; Grok ranked it first). `neverError` keeps a
       * non-2xx as data, `fullResponse` puts Slack's JSON under `body` (which is why
       * `Slack took` below reads `$json.body.ok`), and `onError` lets the run continue
       * so the storing branches finish. Retries are on the node, and only here and on
       * the other Slack calls — NEVER on a model call, where a retry is a second bill.
       */
      options: { response: { response: { neverError: true, fullResponse: true } } } },
    onError: "continueRegularOutput",
    retryOnFail: true, maxTries: 3, waitBetweenTries: 1000,
  });
  connections["Slack lookup"] = { main: [[{ node: "Slack post", type: "main", index: 0 }]] };

  nodes.push({
    id: "slack-took", name: "Slack took", type: "n8n-nodes-base.set", typeVersion: 3.4,
    position: [sx + 2960, 0],
    parameters: { mode: "raw",
      /*
       * Reads `body`, because `Slack post` now sets `fullResponse` (the fix above):
       * the Slack JSON moved from the top level into `$json.body`. The `|| $json`
       * fallback keeps a plain (non-fullResponse) shape working, so this node is not
       * silently coupled to that one option — and `ok === true` is still the test, not
       * the HTTP status: chat.postMessage answers 200 with {"ok":false} when it refuses.
       */
      jsonOutput: `={{ JSON.stringify({ incident_id: $('Report').item.json.incident.incident_id, ts: (() => { const b = ($json && $json.body) || $json; return (b && b.ok === true && typeof b.ts === 'string' && b.ts) ? b.ts : ""; })() }) }}`,
      options: {} },
  });
  connections["Slack post"] = { main: [[{ node: "Slack took", type: "main", index: 0 }]] };

  nodes.push({
    id: "slack-ok", name: "Slack ok", type: "n8n-nodes-base.if", typeVersion: 2.2,
    position: [sx + 3700, 0],
    parameters: { conditions: { options: ifOptions, combinator: "and", conditions: [{
      leftValue: "={{ $json.ts }}", rightValue: "", operator: { type: "string", operation: "notEmpty" } }] } },
  });
  connections["Slack took"] = { main: [[{ node: "Slack ok", type: "main", index: 0 }]] };
  // ts present -> record; empty -> nothing (never write an empty ts).
  connections["Slack ok"] = { main: [[{ node: "Slack record", type: "main", index: 0 }], []] };

  nodes.push({
    id: "slack-record", name: "Slack record", type: "n8n-nodes-base.dataTable", typeVersion: 1.1,
    position: [sx + 4440, 0],
    parameters: { resource: "row", operation: "insert", dataTableId: dtId,
      columns: { mappingMode: "defineBelow",
        value: { incident_id: "={{ $json.incident_id }}", ts: "={{ $json.ts }}" },
        matchingColumns: [], schema: [
          { id: "incident_id", displayName: "incident_id", type: "string", canBeUsedToMatch: true, required: false, display: true, defaultMatch: false },
          { id: "ts", displayName: "ts", type: "string", canBeUsedToMatch: true, required: false, display: true, defaultMatch: false },
        ] } },
  });

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
