/**
 * Re-record the deployment baseline from the live instance.
 *
 * Run this ONLY when the deployment is deliberately changed. It uploads the
 * generated workflow, exports it back, records what the instance added along
 * with the sha256 of the code THE DEPLOYMENT returned, and deletes the upload.
 *
 * The digest is never computed from the generated file. That distinction is the
 * whole point: a baseline that borrows the generated code cannot notice a
 * deployment running something else, which is precisely the failure this
 * baseline exists to catch.
 *
 * It needs the network and the API key, so it is not part of the gate. A check
 * that fails when the network is down fails for reasons that have nothing to do
 * with the code, and gets ignored.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = resolve(ROOT, "tests/fixtures/deployed-export.json");

const API = process.env.N8N_API_URL;
const KEY = process.env.N8N_API_KEY;

/** Replace each code payload with the digest of what came back from the instance. */
export function recordFrom(exported, { note }) {
  const out = { ...exported };
  delete out.shared;
  out.nodes = (out.nodes ?? []).map((n) => {
    const js = n?.parameters?.jsCode;
    if (typeof js !== "string") return n;
    return {
      ...n,
      parameters: {
        ...n.parameters,
        jsCode: { __sha256: createHash("sha256").update(js, "utf8").digest("hex"), __bytes: Buffer.byteLength(js, "utf8") },
      },
    };
  });
  out._fixture_note = note;
  return out;
}

async function main() {
  if (!API || !KEY) {
    process.stderr.write("N8N_API_URL and N8N_API_KEY must be set. Source ~/.config/ai-sre/n8n.env first.\n");
    process.exit(2);
  }
  const headers = { "X-N8N-API-KEY": KEY, "Content-Type": "application/json" };
  const body = readFileSync(resolve(ROOT, "workflows/incident.json"), "utf8");

  const created = await (await fetch(`${API}/workflows`, { method: "POST", headers, body })).json();
  if (!created.id) {
    process.stderr.write(`upload failed: ${JSON.stringify(created).slice(0, 200)}\n`);
    process.exit(2);
  }

  try {
    const exported = await (await fetch(`${API}/workflows/${created.id}`, { headers })).json();
    const fixture = recordFrom(exported, {
      note:
        "A real export from n8n Cloud, with each large code payload replaced by the sha256 of what the " +
        "DEPLOYMENT returned — not by the generated code. Re-record with scripts/record-baseline.mjs " +
        "whenever the deployment is deliberately changed.",
    });
    writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + "\n");
    process.stdout.write(`baseline recorded from workflow ${created.id}\n`);
  } finally {
    // The upload is removed whatever happened above: a probe that leaves debris
    // in a live instance is worse than one that fails.
    const res = await fetch(`${API}/workflows/${created.id}`, { method: "DELETE", headers });
    process.stdout.write(`cleanup: HTTP ${res.status}\n`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    process.stderr.write(`${e && e.message}\n`);
    process.exit(2);
  });
}
