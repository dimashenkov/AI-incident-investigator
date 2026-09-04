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

import { buildCore } from "./build-core.mjs";
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
export function buildNodeCode(core) {
  return `// GENERATED — do not edit. Regenerate with: node scripts/generate-workflow.mjs
const module = { exports: {} };
const exports = module.exports;
(function (module, exports) {
${core}
})(module, exports);
const validators = module.exports;

// Every item, not merely the first.
//
// Codex, chunk 1 parts 1-2: reading $input.first() threw on an empty input and
// silently discarded every item after the first, in a node configured to run
// once for ALL items. Dropping items quietly is the same defect as absence
// reading as consent: nothing reports what was never looked at.
//
// No items in means no results out — an empty run is not an error, and it is
// not a pass either. It is simply nothing, and it says so by returning nothing.
const items = $input.all();

return items.map((item, index) => {
  const body = (item.json && item.json.body) || {};
  const target = body.schema || "incident";
  const validator = validators["validate_" + String(target).replace(/-/g, "_")];

  // Three states, never two: a schema nobody has is "unchecked", not "invalid".
  // Collapsing them would report a typo'd schema name as a clean rejection.
  if (typeof validator !== "function") {
    return { json: { index, state: "unchecked", reason: "no such schema: " + target } };
  }

  const ok = validator(body.data);
  if (ok) return { json: { index, state: "valid", schema: target } };
  return { json: { index, state: "invalid", schema: target, errors: (validator.errors || []).map(function (e) {
    return { where: e.instancePath === "" ? "(root)" : e.instancePath, message: e.message || "failed" };
  }) } };
});
`;
}

export function buildWorkflow(core, { name = "AI SRE — incident validation" } = {}) {
  return {
    name,
    nodes: [
      {
        id: "incident-webhook",
        name: "Incident Webhook",
        type: "n8n-nodes-base.webhook",
        typeVersion: 2,
        position: [0, 0],
        parameters: { path: WEBHOOK_PATH, httpMethod: "POST", responseMode: "lastNode" },
      },
      {
        id: "validate-core",
        name: "Validate",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [260, 0],
        parameters: { language: "javaScript", mode: "runOnceForAllItems", jsCode: buildNodeCode(core) },
      },
    ],
    connections: { "Incident Webhook": { main: [[{ node: "Validate", type: "main", index: 0 }]] } },
    settings: { executionOrder: "v1" },
  };
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
export function generate() {
  const core = buildCore().code;
  const workflow = buildWorkflow(core);
  const text = serialise(workflow);
  return { workflow, text, sha256: createHash("sha256").update(text).digest("hex") };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { text, sha256 } = generate();
  mkdirSync(dirname(OUT), { recursive: true });
  const changed = !existsSync(OUT) || readFileSync(OUT, "utf8") !== text;
  writeFileSync(OUT, text);
  process.stdout.write(`workflows/incident.json ${text.length} bytes, sha256 ${sha256.slice(0, 12)}… ${changed ? "(changed)" : "(unchanged)"}\n`);
}
