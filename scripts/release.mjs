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
 *
 * The one check step 3 is not allowed to stop the chain with.
 *
 * Found on 2026-09-05 by walking into it: the gate refuses when the generated
 * workflow differs from the recorded deployment baseline, and that is exactly
 * what is true of every change worth releasing. The gate blocked the release,
 * and the release was the only thing that could clear the gate — so any change
 * to the core deadlocked, and the way out would have been to stop running the
 * chain, which is the hole this file exists to close.
 *
 * So the drift check, and ONLY that check by name, may fail here. Nothing is
 * relaxed: step 5 exports the deployment back and compares it, which is the
 * stronger question. What is refused is answering it BEFORE deploying.
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

/** The check the release is allowed to proceed past, named once. */
export const DRIFT_CHECK_ID = "no-drift-from-baseline";

/**
 * Decide whether a failed gate still lets the release continue.
 *
 * Returns a reason to stop, or null to proceed. Separated from running it so
 * the decision can be tested without a gate run, and written to require what is
 * needed rather than forbid what is not: it proceeds only when it can see the
 * report AND every non-passing entry in it is the drift check.
 */
export function releaseMayProceed(report) {
  if (report === null || report === undefined) {
    return "the gate failed and its report could not be read, so there is no way to tell what failed";
  }
  const results = report.results;
  if (!Array.isArray(results) || results.length === 0) {
    return "the gate report carries no results, which is not the same as a clean gate";
  }
  const notPassing = results.filter((r) => r?.state !== "pass");
  if (notPassing.length === 0) {
    return "the gate exited non-zero while every check passed; that disagreement is itself a defect";
  }
  const other = notPassing.filter((r) => r?.id !== DRIFT_CHECK_ID);
  if (other.length > 0) {
    return `the gate stopped on ${other.map((r) => `${r.id} (${r.state})`).join(", ")}`;
  }
  /*
   * Codex, 2026-09-05: matching the id alone let the drift check through in the
   * `unknown` state — the one state this project says must never read as a
   * pass. "The deployment is behind us" is a thing the gate ESTABLISHED; "the
   * drift probe did not run" is not, and a release is exactly the moment that
   * difference matters. Duplicates got through for the same reason.
   */
  if (notPassing.length !== 1) {
    return `the drift check appears ${notPassing.length} times in the report, so it is not clear what failed`;
  }
  if (notPassing[0]?.state !== "fail") {
    return `${DRIFT_CHECK_ID} is ${String(notPassing[0]?.state)}, not fail; a check that could not be established has not said the deployment is merely behind`;
  }
  return null;
}

/**
 * Did the gate actually finish? A reason to stop, or null to carry on reading.
 *
 * A gate that was KILLED did not produce the report on disk. `spawnSync` on a
 * killed child gives `error: undefined` and `status: null`, so the caller's
 * success test did not return and the read below picked up whatever
 * out/acceptance-gate.json held from an earlier run. If that leftover showed
 * only drift failing, the chain DEPLOYED while announcing "the gate failed on
 * no-drift-from-baseline only" — a statement about a run that never finished.
 * This project has had the gate killed by a ten-minute limit twice, so the
 * trigger is not hypothetical. Found by a subagent on 2026-09-07.
 *
 * A signal kill is not a verdict. Neither is a spawn that never started.
 */
/**
 * Was this report written by the gate run we just waited for? A reason to stop,
 * or null.
 *
 * `startedAt` is taken before the gate is spawned, so a report stamped earlier
 * belongs to some other execution. A report with no stamp predates the stamping
 * and cannot be dated at all, which is not the same as being current.
 */
export function reportIsFromThisRun(report, startedAt) {
  if (report === null || typeof report !== "object") {
    return "the gate wrote no readable report, so there is nothing to judge it by";
  }
  if (typeof report.finishedAt !== "number") {
    return "the gate report carries no time, so it cannot be tied to the run that just finished";
  }
  if (report.finishedAt < startedAt) {
    return "the gate report on disk was written before this run started, so it is a different run's";
  }
  return null;
}

export function gateFinished(r) {
  if (r === null || typeof r !== "object") return "the gate result could not be read at all";
  if (r.error !== undefined && r.error !== null) {
    return `the gate could not be started: ${r.error?.message ?? String(r.error)}`;
  }
  if (typeof r.status !== "number") {
    return `the gate did not finish${r.signal ? ` (killed by ${r.signal})` : ""}, `
      + "so any report on disk is from a different run";
  }
  return null;
}

function gateStep() {
  process.stdout.write(`\n── acceptance gate\n`);
  const r = spawnSync("node", ["scripts/acceptance-gate.mjs"], { cwd: ROOT, stdio: "inherit" });
  if (r.error === undefined && r.status === 0) return;

  const finished = gateFinished(r);
  if (finished !== null) {
    process.stdout.write(`\nrelease stopped at "acceptance gate": ${finished}\n`);
    process.exit(2);
  }

  /*
   * And the report has to be from THIS run.
   *
   * `gateFinished` rejects a killed gate and a gate that never started. It does
   * not reject a gate that THREW: `restoreInterruptedMutation`, `format` and
   * the final `writeFileSync` all sit outside runGate's per-check try, so an
   * exception there exits non-zero having written no report — and the read
   * below picks up whatever was left on disk. If that leftover showed only
   * drift failing, the chain deployed while announcing "the gate failed on
   * no-drift-from-baseline only". The artifact has carried `finishedAt` since
   * this morning for exactly this, and nothing read it. Found by a subagent on
   * 2026-09-07.
   */
  const startedAt = Date.now();
  let report = null;
  try {
    report = JSON.parse(readFileSync(resolve(ROOT, "out/acceptance-gate.json"), "utf8"));
  } catch {
    report = null;
  }
  const fresh = reportIsFromThisRun(report, startedAt);
  if (fresh !== null) {
    process.stdout.write(`\nrelease stopped at "acceptance gate": ${fresh}\n`);
    process.exit(2);
  }

  const stop = releaseMayProceed(report);
  if (stop !== null) {
    process.stdout.write(`\nrelease stopped at "acceptance gate": ${stop}\n`);
    process.exit(r.status === null || r.status === undefined ? 2 : r.status);
  }
  process.stdout.write(
    `\nthe gate failed on ${DRIFT_CHECK_ID} only. That is what a release is for: the deployment is behind ` +
    `the repository. Continuing, and step 5 will compare the deployment after it has been updated.\n`,
  );
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
  gateStep();
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
