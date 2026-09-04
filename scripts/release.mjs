/**
 * The release procedure. This is the thing that makes the live check mandatory.
 *
 * Codex, chunk 2 debt: "the live check is not part of any release/deployment
 * workflow. It exists only as an optional package script; nothing invokes it.
 * Therefore a deployment can drift indefinitely while every mandatory check
 * exits 0." A script nobody runs leaves the hole it was written to close.
 *
 * So releasing is a chain, and any broken link stops it:
 *
 *   1. assemble the core          — no dependency may survive
 *   2. generate the workflow      — from the schemas, in memory
 *   3. the gate                   — everything the repository can decide alone
 *   4. deploy                     — create, or update the configured id
 *   5. verify the deployment      — export it back and compare
 *   6. re-record the baseline     — from what the deployment returned
 *
 * Step 5 is the point. Steps 1 to 3 establish that the repository is coherent;
 * only step 5 establishes that the instance is running it. A release that
 * skipped it would prove the same nothing the gate proves.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = process.env.N8N_API_URL;
const KEY = process.env.N8N_API_KEY;
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID;

function step(name, cmd, args) {
  process.stdout.write(`\n── ${name}\n`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (r.error !== undefined || r.status !== 0) {
    process.stdout.write(`\nrelease stopped at "${name}" (${r.error ? r.error.message : `exit ${r.status}`})\n`);
    process.exit(r.status === null || r.status === undefined ? 2 : r.status);
  }
}

async function deploy() {
  process.stdout.write(`\n── deploy\n`);
  const headers = { "X-N8N-API-KEY": KEY, "Content-Type": "application/json" };
  const generated = JSON.parse(readFileSync(resolve(ROOT, "workflows/incident.json"), "utf8"));
  const body = JSON.stringify({
    name: generated.name,
    nodes: generated.nodes,
    connections: generated.connections,
    settings: generated.settings,
  });

  if (WORKFLOW_ID) {
    const res = await fetch(`${API}/workflows/${WORKFLOW_ID}`, { method: "PUT", headers, body });
    if (!res.ok) {
      process.stdout.write(`updating ${WORKFLOW_ID} returned HTTP ${res.status}\n`);
      process.exit(2);
    }
    process.stdout.write(`updated ${WORKFLOW_ID}\n`);
    return;
  }

  const res = await fetch(`${API}/workflows`, { method: "POST", headers, body });
  const created = await res.json();
  if (!created.id) {
    process.stdout.write(`create failed: ${JSON.stringify(created).slice(0, 200)}\n`);
    process.exit(2);
  }
  process.stdout.write(
    `created ${created.id}\n` +
      `Set N8N_WORKFLOW_ID=${created.id} in ~/.config/ai-sre/n8n.env so later releases update this one\n` +
      `and so drift is matched by id rather than by a name the UI can change.\n`,
  );
}

async function main() {
  if (!API || !KEY) {
    process.stdout.write("N8N_API_URL and N8N_API_KEY must be set. Source ~/.config/ai-sre/n8n.env first.\n");
    process.exit(2);
  }

  step("assemble the core", "node", ["scripts/build-core.mjs"]);
  step("generate the workflow", "node", ["scripts/generate-workflow.mjs"]);
  step("acceptance gate", "node", ["scripts/acceptance-gate.mjs"]);
  await deploy();
  step("verify the deployment", "node", ["scripts/verify-deployment.mjs"]);
  step("re-record the baseline", "node", ["scripts/record-baseline.mjs"]);
  process.stdout.write(`\nreleased: the instance runs what this repository generates, and it was checked after deploying, not before.\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    process.stdout.write(`release failed: ${e && e.message}\n`);
    process.exit(2);
  });
}
