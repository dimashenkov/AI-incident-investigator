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
/**
 * A baseline is only a baseline if it describes a workflow.
 *
 * `nodes: (out.nodes ?? [])` used to accept anything, so `{message:
 * "unauthorized"}` became a baseline with zero nodes and every later drift
 * comparison was measured against it. The callers check before calling; this
 * refuses anyway, because a helper that trusts its callers is a helper that is
 * wrong the day one of them stops checking.
 */
export function recordFrom(exported, { note }) {
  const out = { ...exported };
  delete out.shared;
  if (!Array.isArray(out.nodes) || out.nodes.length === 0) {
    throw new Error("refusing to record a baseline from an export with no nodes: "
      + JSON.stringify(exported).slice(0, 200));
  }
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

/**
 * Which workflow the baseline is taken from.
 *
 * Codex, chunk 2 debt: this always created a separate temporary workflow,
 * exported that, and deleted it — so a release that claimed to "re-record from
 * the deployment it just verified" recorded something else entirely, and the
 * ordering test could not have noticed.
 *
 * With an id configured, the baseline comes from THAT deployment. Without one,
 * a temporary copy is still the only option, and the result says so rather than
 * letting the weaker source pass for the stronger.
 */
export function chooseSource(env) {
  const id = env.N8N_WORKFLOW_ID;
  if (id !== undefined && id !== null && id !== "") return { mode: "existing", id };
  return {
    mode: "temporary",
    why: "N8N_WORKFLOW_ID is not set, so the baseline is taken from a temporary upload rather than from the deployment itself",
  };
}

async function main() {
  if (!API || !KEY) {
    process.stderr.write("N8N_API_URL and N8N_API_KEY must be set. Source ~/.config/ai-sre/n8n.env first.\n");
    process.exit(2);
  }
  const headers = { "X-N8N-API-KEY": KEY, "Content-Type": "application/json" };
  const source = chooseSource(process.env);

  if (source.mode === "existing") {
    const res = await fetch(`${API}/workflows/${source.id}`, { headers });
    if (!res.ok) {
      process.stderr.write(`could not export ${source.id}: HTTP ${res.status}\n`);
      process.exit(2);
    }
    const exported = await res.json();
    writeFileSync(
      FIXTURE,
      JSON.stringify(
        recordFrom(exported, {
          note:
            "A real export from the DEPLOYED workflow, with each large code payload replaced by the sha256 of " +
            "what the deployment returned. Re-record with scripts/record-baseline.mjs after a deliberate change.",
        }),
        null,
        2,
      ) + "\n",
    );
    process.stdout.write(`baseline recorded from the deployed workflow ${source.id}\n`);
    return;
  }

  process.stdout.write(`${source.why}\n`);
  const body = readFileSync(resolve(ROOT, "workflows/incident.json"), "utf8");
  const created = await (await fetch(`${API}/workflows`, { method: "POST", headers, body })).json();
  if (!created.id) {
    process.stderr.write(`upload failed: ${JSON.stringify(created).slice(0, 200)}\n`);
    process.exit(2);
  }

  try {
    /*
     * Checked, like the `existing` branch eight lines up.
     *
     * This was `await (await fetch(...)).json()` with no look at res.ok, and
     * `recordFrom` fills in `nodes: (out.nodes ?? [])` — so an error body was
     * written OVER the drift baseline, the artifact every later comparison is
     * measured against, and the script printed "baseline recorded". The
     * `finally` then deleted the upload, leaving nothing to re-export. Found by
     * a subagent on 2026-09-07, and it is the path the FIRST release takes,
     * before N8N_WORKFLOW_ID exists.
     */
    const exportRes = await fetch(`${API}/workflows/${created.id}`, { headers });
    if (!exportRes.ok) {
      process.stderr.write(`could not export the temporary workflow ${created.id}: HTTP ${exportRes.status}\n`);
      process.exit(2);
    }
    const exported = await exportRes.json();
    if (!Array.isArray(exported.nodes) || exported.nodes.length === 0) {
      process.stderr.write(`the export carried no nodes; refusing to write a baseline from it: `
        + `${JSON.stringify(exported).slice(0, 200)}\n`);
      process.exit(2);
    }
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
