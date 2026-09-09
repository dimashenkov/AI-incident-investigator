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

/**
 * Did this step fail? A reason to stop, or null.
 *
 * Split out because the test that claimed to check it asserted on STRINGS in
 * this file — `release stopped at` and a regex — and both strings sit inside
 * the branch, so deleting the branch left them there and the test green. A
 * subagent measured it on 2026-09-09. A predicate can be called; a substring
 * cannot.
 */
export function stepFailed(r) {
  if (r === null || typeof r !== "object") return "the step produced no result at all";
  if (r.error !== undefined && r.error !== null) return r.error.message ?? String(r.error);
  if (r.status !== 0) return `exit ${r.status}`;
  return null;
}

/** The exit code to leave with when a step failed; a killed step has none. */
export function exitCodeFor(r) {
  return r?.status === null || r?.status === undefined ? 2 : r.status;
}

function step(name, cmd, args) {
  process.stdout.write(`\n── ${name}\n`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  const failed = stepFailed(r);
  if (failed !== null) {
    process.stdout.write(`\nrelease stopped at "${name}" (${failed})\n`);
    process.exit(exitCodeFor(r));
  }
}

/** The check the release is allowed to proceed past, named once. */
export const DRIFT_CHECK_ID = "no-drift-from-baseline";
/** The debt check, named so the exception below is a list rather than a string. */
export const DEBT_CHECK_ID = "promised-checks-due";

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
  /*
   * Exactly two checks may be non-passing, each in exactly one state, and each
   * for a reason that is about something a release CANNOT make worse.
   *
   *   no-drift-from-baseline, fail     — the deployment is behind us. Releasing
   *                                      is the thing that fixes it.
   *   promised-checks-due,   unknown   — promised work is due and unwritten.
   *                                      Releasing neither writes it nor
   *                                      unwrites it.
   *
   * The second was added on 2026-09-07, into a genuine circle. The debt waits
   * on a run recorded with machine-readable scores; that run happened, came
   * back wrong, and so the debt came due while the items stayed uncovered. The
   * items can only be covered by another paid run through the DEPLOYED
   * workflow — which needs a release. Blocking on it makes the debt unclearable
   * by any means.
   *
   * The states are named, not just the ids, and this is why: `unknown` on the
   * drift check means the probe did not run, which is not "the deployment is
   * behind" — Codex, 2026-09-05. `fail` on the debt check would mean promised
   * work is overdue with its dependency met, which is a different claim from
   * "due and unwritten" and is not waved through here.
   */
  const ALLOWED = new Map([[DRIFT_CHECK_ID, "fail"], [DEBT_CHECK_ID, "unknown"]]);
  const blocking = notPassing.filter((r) => ALLOWED.get(r?.id) !== r?.state);
  if (blocking.length > 0) {
    return `the gate stopped on ${blocking.map((r) => `${r.id} (${r.state})`).join(", ")}`;
  }
  /*
   * And each may appear once. A duplicate makes it unclear which result the
   * decision was taken on, and that ambiguity is what let an unknown drift
   * check through before.
   */
  const seen = new Set();
  for (const r of notPassing) {
    if (seen.has(r.id)) return `${r.id} appears more than once in the report, so it is not clear what failed`;
    seen.add(r.id);
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

/**
 * May a release create a new workflow? A reason to stop, or null.
 *
 * Exported so the decision can be tested without an instance. The rule is not
 * "no workflow of this name exists" — it is "we ESTABLISHED that none exists".
 * A listing that could not be read, or that came back in a shape this does not
 * recognise, is not evidence of absence, and a duplicate name plus a shared
 * webhook path is a state nothing in this repository can undo.
 */
export function mayCreateWorkflow(listing, name) {
  if (listing === null || typeof listing !== "object") {
    return "the workflow listing could not be read, so whether one already exists is unestablished";
  }
  if (!Array.isArray(listing.data)) {
    return "the workflow listing was not a list; refusing to create blindly";
  }
  const already = listing.data.filter((w) => w && w.name === name);
  if (already.length > 0) {
    return `a workflow named ${JSON.stringify(name)} already exists (${already.map((w) => w.id).join(", ")})`;
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
  /*
   * BEFORE the spawn. The comment on reportIsFromThisRun said so and the code
   * did not — `startedAt` was taken after spawnSync returned, so the gate's own
   * report was always older than it, every non-zero gate exited 2 with "written
   * before this run started", and the drift-only continuation this whole
   * function exists for became unreachable. A subagent found it hours after I
   * wrote it, by reading the two lines next to each other.
   */
  const startedAt = Date.now();
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

  /*
   * Ask first, because creating is not idempotent and a duplicate cannot be
   * undone from here.
   *
   * With no N8N_WORKFLOW_ID this branch used to POST unconditionally, so a
   * second release on a machine that never set the variable — which is only
   * SUGGESTED below, never required — created a second workflow with the same
   * name and the same fixed webhook path. Step 5 then reports `ambiguous`
   * forever: every later release and every drift check fails for a reason no
   * change to this repository can clear, and the duplicate has to be deleted by
   * hand in the n8n UI. Found by a subagent on 2026-09-07.
   *
   * A listing that cannot be read stops the release rather than guessing. "I
   * could not check whether one already exists" is not "there is none".
   */
  /*
   * Through mayCreateWorkflow, not beside it.
   *
   * The first version of this made the same three decisions inline, so the
   * exported function was tested and called by nothing — a describe block named
   * for the shipped behaviour, exercising an orphan, while the shipped path
   * carried a second copy of the same messages. Found by a subagent the same
   * hour I wrote it.
   */
  const existing = await fetch(`${API}/workflows`, { headers });
  const listing = existing.ok ? await existing.json() : null;
  const stopCreating = existing.ok
    ? mayCreateWorkflow(listing, generated.name)
    : `could not list workflows before creating one: HTTP ${existing.status}`;
  if (stopCreating !== null) {
    process.stdout.write(
      `${stopCreating}.\n`
        + `Set N8N_WORKFLOW_ID in ~/.config/ai-sre/n8n.env to the one you mean, and release again.\n`
        + "Creating a second would share this one's webhook path and make drift ambiguous forever.\n",
    );
    process.exit(2);
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

/**
 * Every step of a release, in the order they must happen.
 *
 * Read by the tests, so an order this file no longer performs is an order the
 * tests can see change.
 */
export const RELEASE_ORDER = [
  "assemble-the-core",
  "generate-the-workflow",
  "acceptance-gate",
  "deploy",
  "verify-the-deployment",
  "re-record-the-baseline",
];

const RUNNERS = {
  "assemble-the-core": () => step("assemble the core", "node", ["scripts/build-core.mjs"]),
  "generate-the-workflow": () => step("generate the workflow", "node", ["scripts/generate-workflow.mjs"]),
  "acceptance-gate": () => gateStep(),
  "deploy": () => deploy(),
  "verify-the-deployment": () => step("verify the deployment", "node", ["scripts/verify-deployment.mjs"]),
  "re-record-the-baseline": () => step("re-record the baseline", "node", ["scripts/record-baseline.mjs"]),
};

/** Which steps are registered, so a name in the order with no runner is visible. */
export const RELEASE_RUNNERS = Object.keys(RUNNERS);

async function main() {
  if (!API || !KEY) {
    process.stdout.write("N8N_API_URL and N8N_API_KEY must be set. Source ~/.config/ai-sre/n8n.env first.\n");
    process.exit(2);
  }

  /*
   * The order is DATA, so a test can read it.
   *
   * It used to be five calls in a row, and the tests asserted on where certain
   * strings appeared in this file — so `gateStep()` could be deleted from the
   * sequence while `acceptance-gate.mjs` still appeared earlier, inside the
   * function's own body, and "runs the gate before deploying anything" stayed
   * green. A subagent measured it on 2026-09-09.
   */
  for (const id of RELEASE_ORDER) {
    const run = RUNNERS[id];
    if (run === undefined) {
      process.stdout.write(`\nrelease stopped: no step is registered for ${id}\n`);
      process.exit(2);
    }
    await run();
  }
  process.stdout.write(`\nreleased: the instance runs what this repository generates, and it was checked after deploying, not before.\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    process.stdout.write(`release failed: ${e && e.message}\n`);
    process.exit(2);
  });
}
