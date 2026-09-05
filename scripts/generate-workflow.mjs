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

import { buildRuntime, assembleNodeCode, recordNodeCode, concludeNodeCode, AGENT_ORDER } from "./workflow-runtime.mjs";
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
      jsonBody: "={{ JSON.stringify({ model: " + JSON.stringify(MODEL) + ", temperature: 0, "
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
      jsonOutput: `={{ JSON.stringify(Object.assign({}, $('${from}').item.json, { reply: (function () {`
        + ` var t = $json.choices[0].message.content;`
        + ` if (typeof t !== 'string') return null;`
        + ` var f = t.match(/\`\`\`(?:json)?\\s*([\\s\\S]*?)\`\`\`/);`
        + ` if (f) t = f[1];`
        + ` var o; try { o = JSON.parse(t); } catch (e) { return null; }`
        + ` if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;`
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
export const MODEL = "gpt-4o-mini";

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
 * Both come from the environment when it says so, and fall back to the values
 * of the instance this repository deploys to, so that regenerating without a
 * shell full of variables produces the same bytes.
 */
export const OPENAI_CREDENTIAL = {
  id: process.env.N8N_OPENAI_CREDENTIAL_ID ?? "fcCTZNZiEZhLkGHD",
  name: process.env.N8N_OPENAI_CREDENTIAL_NAME ?? "OpenAI account",
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
      parameters: { path: WEBHOOK_PATH, httpMethod: "POST", responseMode: "lastNode" },
    },
    code("assemble", "Assemble", assembleNodeCode(), [220, 0]),
  ];

  const connections = {
    "Incident Webhook": { main: [[{ node: "Assemble", type: "main", index: 0 }]] },
  };

  let previous = "Assemble";
  let x = 440;
  const gates = [];
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

    gates.push(gate);
    previous = record;
    x += 740;
  });

  nodes.push(code("conclude", "Conclude", concludeNodeCode(), [x, 0]));
  connections[previous] = { main: [[{ node: "Conclude", type: "main", index: 0 }]] };

  // Each gate's false branch jumps to the NEXT gate, so several skips in a row
  // still reach the end; the last one goes straight to Conclude.
  gates.forEach((gate, i) => {
    const onward = gates[i + 1] ?? "Conclude";
    connections[gate].main[1] = [{ node: onward, type: "main", index: 0 }];
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
