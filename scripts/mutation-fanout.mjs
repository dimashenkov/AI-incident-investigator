/**
 * Run the mutation set across several working copies at once.
 *
 * Why copies and not one tree: a mutation is a deliberately broken file, and a
 * test run that reads a tree somebody else is mutating reports failures that do
 * not exist. That trap is already recorded in this project — four "failures"
 * once came from a mutation in a file nobody's test had touched. So sharing a
 * tree is not an option, and the unit of isolation is a directory.
 *
 * Because each worker owns its own tree, mutations do NOT have to be grouped by
 * file: two workers may mutate the same file safely. The list is split evenly
 * instead, which balances far better than grouping by file would — the largest
 * single file holds 46 of the 305.
 *
 * Three things a copy deliberately does not get:
 *
 *   - `.env`, so a mutation that removes the "environment beats the file" guard
 *     has no file to read. On 2026-09-11 that mutation made the gate POST to
 *     the paid instance three times per run; this is the third floor under it,
 *     and it costs nothing.
 *   - its own `node_modules`, which is symlinked. Nothing mutates it, and 52 MB
 *     per worker is a copy nobody needs.
 *   - the parent's `out/`, because that holds the reports being written.
 *
 * It prints ONE json object on stdout and nothing else, so the caller can stay
 * synchronous: `{ caught, survived, unresolved, workers, seconds }`.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, cpSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus, tmpdir } from "node:os";
import { MUTATIONS } from "./mutations.mjs";
import { filesDeclaring, namedTestFailed } from "./acceptance-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/*
 * The copies live OUTSIDE the repository, under the temporary directory.
 *
 * `cpSync` refuses to copy a directory into a subdirectory of itself, so
 * `out/mut-workers` was rejected for every worker — correctly, and the failure
 * came back as `unresolved` for all 305 rather than as anything passing, which
 * is the one thing that had to hold.
 */
/*
 * A fresh directory per INVOCATION, not a fixed name.
 *
 * Astra, 2026-09-11: every run used `ai-sre-mut-workers/w0`, `w1`, and
 * `prepareCopy` deletes what it finds. Two gates at once — or one gate and
 * another checkout — would replace directories underneath each other's live
 * workers, so a worker could test another tree's files, overwrite its
 * mutation while restoring, or read its report. And because a mutation counts
 * as caught when its named test FAILS, an unrelated filesystem failure could
 * have been recorded as a catch.
 */
const WORKERS_AT = mkdtempSync(join(tmpdir(), "ai-sre-mut-"));

/**
 * How many copies to run at once.
 *
 * Two fewer than the cores, because each worker spawns a vitest which itself
 * wants a thread, and the parent has to stay responsive enough to collect. On
 * this machine: 10 cores, so 8.
 */
export function workerCount(cores = cpus().length, mutations = MUTATIONS.length) {
  const room = Math.max(1, cores - 2);
  // Never more workers than mutations: an empty worker is a tree copied for
  // nothing.
  return Math.max(1, Math.min(room, mutations));
}

/**
 * Split the list so every worker gets a comparable amount of WORK.
 *
 * Round-robin rather than contiguous slices: the mutations are grouped by file
 * in the source, and consecutive ones tend to run the same test file, so
 * contiguous slices would hand one worker every slow whole-suite mutation.
 */
export function shareOut(mutations, workers) {
  const out = Array.from({ length: workers }, () => []);
  mutations.forEach((m, i) => out[i % workers].push(m.id));
  return out;
}

/** The files a copy must not receive, with the reason attached to each. */
export const NOT_COPIED = [
  { name: ".env", why: "a mutation that lets the file beat the environment would read a paid address from it" },
  { name: "node_modules", why: "symlinked instead; nothing mutates it and 52 MB per worker is a copy nobody needs" },
  { name: "out", why: "it holds the reports being written, including the one this fanout is producing" },
  { name: ".git", why: "no worker reads history, and it is the largest thing in the tree" },
];

/** Make one working copy, and say what it is missing. */
export function prepareCopy(at, io = {}) {
  const { copy = cpSync, link = symlinkSync, make = mkdirSync, gone = rmSync, there = existsSync } = io;
  if (there(at)) gone(at, { recursive: true, force: true });
  make(at, { recursive: true });
  const skip = new Set(NOT_COPIED.map((x) => x.name));
  copy(ROOT, at, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(ROOT.length + 1).split("/")[0];
      return rel === "" || !skip.has(rel);
    },
  });
  // vitest needs the packages; nothing mutates them.
  link(join(ROOT, "node_modules"), join(at, "node_modules"), "dir");
  make(join(at, "out"), { recursive: true });
  return { at, missing: NOT_COPIED.map((x) => x.name) };
}

/**
 * Turn what a worker sent back into exactly one outcome per mutation it owned.
 *
 * Exported because the guarantee is behavioural and a test asserting the SOURCE
 * of it establishes nothing — Astra, 2026-09-11, on the first version of these
 * tests, and the criticism was right.
 *
 * Four ways a worker's answer is wrong, and each has to end as `unresolved`
 * rather than as a catch:
 *
 *   - a result for a mutation it was not given
 *   - two results for one mutation
 *   - a result with no id, or an id that is not a string
 *   - nothing at all for something it owned
 *
 * The dangerous one is the second: `[caught a, caught a]` for the share
 * `[a, b]` has the right LENGTH, so a check that compares counts lets it
 * through and `b` is never tested.
 */
export function reconcile(ids, results, worker = 0) {
  const mine = new Set(ids);
  const list = Array.isArray(results) ? results : [];
  const KINDS = ["caught", "survived", "unresolved"];
  /*
   * ONE verdict per mutation, built into a map keyed by the mutation.
   *
   * The first version pushed into a list, so a duplicate produced two
   * `unresolved` entries for one mutation — safe, because nothing counted as
   * caught, but the total then exceeded the share and the gate reported a
   * false alarm instead of the real problem. One id, one answer.
   */
  const verdict = new Map();
  let stray = 0;
  const doubled = new Set();
  for (const r of list) {
    if (r === null || typeof r !== "object" || typeof r.id !== "string" || !mine.has(r.id)) { stray += 1; continue; }
    if (verdict.has(r.id)) { doubled.add(r.id); continue; }
    verdict.set(r.id, KINDS.includes(r.kind) ? r
      : { kind: "unresolved", id: r.id, detail: `${r.id} (worker ${worker} answered with no usable outcome)` });
  }
  // A mutation answered twice is a mutation whose answer cannot be used, and
  // that includes the first copy of it.
  for (const id of doubled) {
    verdict.set(id, { kind: "unresolved", id, detail: `${id} (worker ${worker} reported it more than once)` });
  }
  return ids.map((id) => verdict.get(id) ?? {
    kind: "unresolved", id,
    detail: `${id} (worker ${worker} did not report it${stray > 0 ? `; it sent ${stray} result(s) for mutations it was not given` : ""})`,
  });
}

const CHILD_MARKER = "ACCEPTANCE_GATE_CHILD";

/**
 * Is this copy able to produce a green run at all?
 *
 * A mutation counts as caught when its named test FAILS. So a copy that is
 * broken for some reason of its own — a file that did not copy, a symlink that
 * did not resolve — makes every mutation on it look caught. Astra, 2026-09-11.
 *
 * The full baseline would be one clean run per MUTATION, which doubles the
 * cost. This is one run per COPY: cheap, once, and enough to separate "the
 * test failed because of the mutation" from "this copy cannot run tests". A
 * copy that fails here has its whole share reported unresolved.
 *
 * The file it runs is the smallest real test file in the tree, chosen by size
 * rather than named, so deleting or renaming one file cannot silently turn the
 * check into nothing.
 */
export function copyIsUsable(at, io = {}) {
  const { list = readdirSync, size = (f) => statSync(f).size, spawn = spawnSync } = io;
  let smallest = null;
  try {
    for (const f of list(join(at, "tests"))) {
      if (!f.endsWith(".test.ts")) continue;
      const bytes = size(join(at, "tests", f));
      if (smallest === null || bytes < smallest.bytes) smallest = { f, bytes };
    }
  } catch (e) {
    return { usable: false, why: `the copy has no readable tests directory (${e.message})` };
  }
  if (smallest === null) return { usable: false, why: "the copy contains no test file to try" };
  const r = spawn("npx", ["vitest", "run", "--pool=forks", "--poolOptions.forks.singleFork=true",
    "--poolOptions.forks.maxForks=1", `tests/${smallest.f}`], {
    cwd: at, encoding: "utf8", shell: false, env: { ...process.env, [CHILD_MARKER]: "1" },
  });
  if (r.error !== undefined || r.status === null) {
    return { usable: false, why: `vitest did not run in the copy (${r.error?.message ?? "no exit code"})` };
  }
  if (r.status !== 0) {
    const said = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().replace(/\s+/g, " ").slice(0, 200);
    return { usable: false, why: `tests/${smallest.f} does not pass in an UNMUTATED copy: ${said}` };
  }
  return { usable: true, tried: `tests/${smallest.f}` };
}

/** One mutation, applied and tested inside one copy. Returns the outcome. */
function oneMutation(m, at, fullReport) {
  const target = join(at, m.file);
  if (!existsSync(target)) return { kind: "unresolved", id: m.id, detail: `${m.id} (no such file in the worker copy)` };
  const original = readFileSync(target, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits === 0) return { kind: "unresolved", id: m.id, detail: `${m.id} (anchor text not found)` };
  if (hits > 1) return { kind: "unresolved", id: m.id, detail: `${m.id} (anchor appears ${hits} times; not unique)` };

  /*
   * The in-flight record lives INSIDE the copy. A killed worker therefore
   * leaves a broken file only in a directory that is about to be deleted, and
   * the real tree is never touched — which is strictly safer than the
   * single-tree version this replaces.
   */
  const inFlight = join(at, "out", "mutation-in-flight.json");
  writeFileSync(inFlight, JSON.stringify({ id: m.id, file: m.file, original, mutated: original.replace(m.from, m.to) }));
  try {
    writeFileSync(target, original.replace(m.from, m.to));
    const report = join(at, "out", "mutation-report.json");
    if (existsSync(report)) rmSync(report);
    /*
     * Made RELATIVE to the tree being run.
     *
     * `filesDeclaring` reads a vitest report, and a vitest report stores
     * absolute paths — into the ORIGINAL repository. Handed to a vitest running
     * in a copy, that filter matches nothing: vitest exits 1, writes no report,
     * and every mutation comes back unresolved. Found by carrying vitest's own
     * words into the diagnostic instead of guessing.
     */
    const narrowTo = filesDeclaring(fullReport, m.mustFail)
      .map((f) => (f.startsWith(`${ROOT}/`) ? f.slice(ROOT.length + 1) : f));
    /*
     * ONE thread per worker's vitest, deliberately.
     *
     * Measured on 2026-09-11: eight workers with vitest left to its own
     * threading put the load average past 43 on a ten-core machine, and the
     * run was slower than the sequential one it replaced. The parallelism that
     * helps is at the MUTATION level, where each unit is a whole process; a
     * second layer of it inside each unit only oversubscribes the cores.
     *
     * `--pool=forks` with one fork also removes the worker-thread startup that
     * dominates a single-file run.
     */
    const r = spawnSync("npx", ["vitest", "run", "--reporter=json", "--pool=forks",
      "--poolOptions.forks.singleFork=true", "--poolOptions.forks.maxForks=1",
      `--outputFile=${report}`, ...narrowTo], {
      cwd: at, encoding: "utf8", shell: false, env: { ...process.env, [CHILD_MARKER]: "1" },
    });
    if (r.error !== undefined || r.status === null) {
      return { kind: "unresolved", id: m.id, detail: `${m.id} (vitest did not run)` };
    }
    if (!existsSync(report)) {
      /*
       * What vitest actually said, carried into the answer.
       *
       * The first version said only "no readable report", and eight workers
       * all said it at once — which told me nothing about why. A diagnostic
       * that does not carry the failure makes the next hour guesswork.
       */
      const said = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().replace(/\s+/g, " ").slice(0, 300);
      return { kind: "unresolved", id: m.id,
        detail: `${m.id} (no report at ${report}; vitest exited ${String(r.status)}${said ? `: ${said}` : ""})` };
    }
    let json;
    try { json = JSON.parse(readFileSync(report, "utf8")); }
    catch { return { kind: "unresolved", id: m.id, detail: `${m.id} (no readable report)` }; }
    const verdict = namedTestFailed(json, m.mustFail);
    if (verdict === null) {
      return { kind: "unresolved", id: m.id,
        detail: `${m.id} (the report does not contain "${m.mustFail}"; the run may not have finished)` };
    }
    return verdict ? { kind: "caught", id: m.id }
      : { kind: "survived", id: m.id, detail: `${m.id}: "${m.mustFail}" did not fail` };
  } finally {
    writeFileSync(target, original);
    if (existsSync(inFlight)) rmSync(inFlight);
  }
}

if (process.argv[2] === "--worker" && process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  // One worker: a copy directory and a list of mutation ids on stdin.
  const at = process.argv[3];
  const ids = new Set(JSON.parse(readFileSync(0, "utf8")));
  let fullReport = null;
  try {
    const full = join(ROOT, "out", "vitest-report.json");
    if (existsSync(full)) fullReport = JSON.parse(readFileSync(full, "utf8"));
  } catch { fullReport = null; }
  /*
   * Before any verdict from this copy is believed, the copy has to prove it
   * can run tests. Otherwise "the named test failed" means nothing.
   */
  const fit = copyIsUsable(at);
  const results = [];
  if (!fit.usable) {
    for (const m of MUTATIONS) {
      if (!ids.has(m.id)) continue;
      results.push({ kind: "unresolved", id: m.id, detail: `${m.id} (the worker copy is not usable: ${fit.why})` });
    }
    process.stdout.write(JSON.stringify(results));
    process.exit(0);
  }
  for (const m of MUTATIONS) {
    if (!ids.has(m.id)) continue;
    results.push(oneMutation(m, at, fullReport));
  }
  process.stdout.write(JSON.stringify(results));
  process.exit(0);
}

/*
 * Nothing below runs on import. The first version had no guard, so importing
 * this file to check `workerCount` started 305 mutations — the same class of
 * defect as reading `.env` at import, found the same way: by running it.
 */
const INVOKED_DIRECTLY = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (!INVOKED_DIRECTLY) {
  // Imported for its helpers. Exports only.
} else {
const started = Date.now();
const workers = workerCount();
const shares = shareOut(MUTATIONS, workers);
const self = fileURLToPath(import.meta.url);

const running = shares.map((ids, i) => new Promise((done) => {
  const at = join(WORKERS_AT, `w${i}`);
  let prepared;
  try { prepared = prepareCopy(at); }
  catch (e) {
    // A copy that could not be made is not a set of mutations that passed.
    done({ i, results: ids.map((id) => ({ kind: "unresolved", id, detail: `${id} (worker copy failed: ${e.message})` })) });
    return;
  }
  void prepared;
  const c = spawn(process.execPath, [self, "--worker", at], { cwd: ROOT, env: { ...process.env } });
  let out = "";
  let err = "";
  c.stdout.on("data", (b) => { out += String(b); });
  c.stderr.on("data", (b) => { err += String(b); });
  c.stdin.end(JSON.stringify(ids));
  c.on("close", (status) => {
    let results;
    try { results = JSON.parse(out); if (!Array.isArray(results)) throw new Error("not an array"); }
    catch {
      /*
       * A worker that said nothing readable has established nothing. Its
       * mutations become unresolved, never caught — silence from a parallel
       * worker read as success is how a parallel check reports less work as a
       * clean result.
       */
      results = ids.map((id) => ({ kind: "unresolved", id,
        detail: `${id} (worker ${i} exited ${String(status)} with no readable result${err ? `: ${err.slice(0, 200)}` : ""})` }));
    }
    /*
     * Reconciled by ID, every time — not only when the COUNT disagrees.
     *
     * The first version compared lengths, so a worker returning the right
     * number of results with the wrong ids — two for one mutation and none for
     * another — added up and the missing mutation was counted as checked.
     * Found by reading my own hour-old accounting, which is where this keeps
     * turning up.
     *
     * Anything the worker sent that it was not given is dropped and named:
     * a result for a mutation this worker does not own says the split or the
     * worker is wrong, and neither is a reason to trust the rest of it.
     */
    results = reconcile(ids, results, i);
    done({ i, results });
  });
}));

const all = await Promise.all(running);
const flat = all.flatMap((w) => w.results);
const summary = {
  workers,
  seconds: Math.round((Date.now() - started) / 1000),
  total: MUTATIONS.length,
  caught: flat.filter((r) => r.kind === "caught").length,
  survived: flat.filter((r) => r.kind === "survived").map((r) => r.detail),
  unresolved: flat.filter((r) => r.kind === "unresolved").map((r) => r.detail),
};
try { rmSync(WORKERS_AT, { recursive: true, force: true }); } catch { /* left behind is not a result */ }
process.stdout.write(`${JSON.stringify(summary)}\n`);
}
