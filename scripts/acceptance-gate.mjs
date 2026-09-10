/**
 * The acceptance gate.
 *
 * Codex, verdict 4 on the plan: "The cycle's closing condition is circular…
 * A reviewer's silence is not proof." A chunk was closed because I said the
 * tests passed and nobody objected. Silence is not a check.
 *
 * The tests answer "does the code work". This file answers a different
 * question — "was the promised thing built" — and the tests cannot answer it,
 * because a test that was never written does not fail. It is simply absent,
 * and everything looks green.
 *
 * Two rules hold this file honest, and both exist because the recurring defect
 * in this project is fixing an unchecked claim with a new unchecked claim:
 *
 *  1. A check either RAN or it did not. `unknown` is a real outcome with its
 *     own exit code, never folded into pass and never folded into fail.
 *  2. Anything this gate cannot mechanically verify is printed, every run,
 *     under NOT VERIFIED. Listing it is not checking it, and the output says so.
 */
import { spawnSync } from "node:child_process";

import { MUTATIONS } from "./mutations.mjs";
import { remainingRequires } from "./requires.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "out/acceptance-gate.json");

/** @typedef {{ state: "pass"|"fail"|"unknown", detail: string, command?: string }} Outcome */

const pass = (detail, command) => ({ state: "pass", detail, command });
const fail = (detail, command) => ({ state: "fail", detail, command });
/** Could not establish. Not clean, not broken — a third thing, and it is reported as one. */
const unknown = (detail, command) => ({ state: "unknown", detail, command });

/**
 * Set on every process this gate spawns. A nested gate seeing it knows it is
 * already inside a gate run and refuses to spawn the suite again.
 */
export const CHILD_MARKER = "ACCEPTANCE_GATE_CHILD";

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, [CHILD_MARKER]: "1" },
  });
  return {
    line: [cmd, ...args].join(" "),
    // `status === null` means the process never produced an exit code (killed,
    // or never spawned). That is not a failure of the thing being checked.
    ran: r.error === undefined && r.status !== null,
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error ? String(r.error.message) : null,
  };
}

// ── the checks ──────────────────────────────────────────────────────────────

/**
 * The suite must pass AND must have collected tests. A suite that collects
 * nothing exits 0 — "all zero of my tests passed" reads exactly like success.
 */
/**
 * The judgement, separated from the spawning so it can be tested against a
 * report we hand it. Exported for exactly that reason.
 *
 * `json` is null when no report was produced; that is `unknown`, not `fail` —
 * we did not learn that the tests are broken, we learned nothing.
 */
export function interpretVitestReport(json, status, line) {
  if (json === null || json === undefined) {
    return unknown(`vitest exited ${status} but wrote no readable report; cannot count tests`, line);
  }

  const total = Number(json.numTotalTests);
  const passed = Number(json.numPassedTests);
  const failed = Number(json.numFailedTests);
  if (!Number.isFinite(total) || !Number.isFinite(passed) || !Number.isFinite(failed)) {
    return unknown("vitest report has no test counts", line);
  }
  // An empty suite exits 0. "All zero of my tests passed" must never read as clean.
  if (total === 0) return fail("the suite collected 0 tests; an empty suite exits 0", line);
  if (failed > 0 || passed !== total) return fail(`${passed}/${total} passed, ${failed} failed`, line);
  if (status !== 0) return fail(`${passed}/${total} passed but vitest exited ${status}`, line);
  return pass(`${passed}/${total} tests passed`, line);
}

/**
 * Delete the report, run the suite, read what it actually wrote.
 *
 * Codex, chunk 0 round 8: checkTests() deleted its report first and
 * checkMutations() did not. If vitest started but died before writing, the
 * mutation check read a report from an earlier run and declared the mutation
 * caught on evidence from a different execution. A stale file is not a result.
 *
 * Both callers go through here now, so the deletion cannot be present in one
 * place and missing in the other.
 */
export function readFreshReport(reportPath, runSuite, fs = { rm: rmSync, exists: existsSync, read: readFileSync }) {
  fs.rm(reportPath, { force: true });
  const r = runSuite();
  if (!fs.exists(reportPath)) return { run: r, json: null };
  try {
    return { run: r, json: JSON.parse(fs.read(reportPath, "utf8")) };
  } catch {
    return { run: r, json: null };
  }
}

function checkTests() {
  /*
   * Measured on 2026-09-04: a test called runGate() with the real checks, this
   * check spawned vitest, vitest ran that test again, and the run never
   * returned. It does not fail — it hangs, which from outside is
   * indistinguishable from a slow suite.
   *
   * Codex, chunk 0 round 2: keying on VITEST alone was wrong twice over. A test
   * could delete process.env.VITEST and recurse anyway, and `VITEST=0 npm run
   * gate` from an ordinary shell silently skipped the test check. So the marker
   * is ours, it is set only on the child we spawn ourselves, and it cannot be
   * arrived at by accident or by editing someone else's variable.
   */
  if (process.env[CHILD_MARKER] !== undefined) {
    return unknown(`refusing to spawn vitest from a run this gate already started (${CHILD_MARKER} is set)`, "guard");
  }

  const report = resolve(ROOT, "out/vitest-report.json");
  const { run: r, json } = readFreshReport(report, () =>
    run("npx", ["vitest", "run", "--reporter=json", `--outputFile=${report}`]));

  if (!r.ran) return unknown(`vitest did not run: ${r.error ?? "no exit code"}`, r.line);
  return interpretVitestReport(json, r.status, r.line);
}

function checkTypecheck() {
  const r = run("npx", ["tsc", "--noEmit"]);
  if (!r.ran) return unknown(`tsc did not run: ${r.error ?? "no exit code"}`, r.line);
  if (r.status !== 0) {
    const first = (r.stdout + r.stderr).split("\n").filter((l) => l.includes("error TS"))[0] ?? "";
    return fail(`tsc exited ${r.status}${first ? `: ${first.trim()}` : ""}`, r.line);
  }
  return pass("0 type errors", r.line);
}

/**
 * Every `node <path>` in package.json scripts must point at a file that exists.
 * This is the check that would have caught `npm run gate` pointing at a script
 * nobody had written — a declared capability that silently was not there.
 */
function checkDeclaredScriptsExist() {
  const pkgPath = resolve(ROOT, "package.json");
  if (!existsSync(pkgPath)) return unknown("no package.json", "read package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (e) {
    return unknown(`package.json unreadable: ${e instanceof Error ? e.message : String(e)}`, "read package.json");
  }

  return interpretScripts(
    pkg.scripts ?? {},
    (rel) => existsSync(resolve(ROOT, rel)),
    (bin) => existsSync(resolve(ROOT, "node_modules/.bin", bin)),
  );
}

/**
 * Exported so a test can hand it a scripts block and a fake filesystem.
 * `fileExists` is injected because the interesting case — a script pointing at
 * a file that is not there — must be reproducible without deleting real files.
 */
export function interpretScripts(scripts, fileExists, binExists = () => false) {
  const missing = [];
  let checked = 0;
  for (const [name, body] of Object.entries(scripts)) {
    const text = String(body).trim();

    // A compound command is more than one command, and checking the first one
    // and calling the script verified is the partial-category defect again.
    // Found 2026-09-04: `node gate.mjs && node missing.mjs` reported "all
    // scripts point at files that exist" after looking at exactly one of them.
    // The separator list is deliberately generous — anything that could chain
    // makes the line unexamined rather than half-examined.
    if (/[&|;\n]|\$\(|`/.test(text)) continue;

    // Shape one: `node PATH` — the path must exist on disk.
    const asFile = text.match(/^node\s+([^\s]+)/);
    if (asFile !== null) {
      checked += 1;
      if (!fileExists(asFile[1])) missing.push(`${name} -> ${asFile[1]}`);
      continue;
    }

    // Shape two: `bin args…` — the binary must be installed. Without this the
    // check reported "unexamined" for `vitest run` and `tsc --noEmit`, which is
    // honest but leaves the two commands the project actually relies on unchecked.
    const asBin = text.match(/^([a-z0-9@._-]+)(\s|$)/i);
    if (asBin !== null) {
      checked += 1;
      if (!binExists(asBin[1])) missing.push(`${name} -> ${asBin[1]} (not in node_modules/.bin)`);
      continue;
    }

    // Anything else is not silently counted as fine — it is unexamined, and said so.
  }

  if (missing.length > 0) return fail(`declared but missing: ${missing.join(", ")}`, "read package.json");

  // Codex, chunk 0 round 2: returning pass because one script was readable said
  // nothing about the rest. A check reports on what it examined, and what it
  // could not read stays "could not establish" — never rounded up to clean.
  const total = Object.keys(scripts).length;
  const unexamined = total - checked;
  if (unexamined > 0) {
    return unknown(`${checked} node script(s) verified; ${unexamined} script(s) are not a bare 'node PATH' and were left unexamined`, "read package.json");
  }
  if (checked === 0) return unknown("package.json declares no scripts at all", "read package.json");
  return pass(`all ${checked} declared script(s) point at files that exist`, "read package.json");
}

/**
 * What a secret looks like by name, paired with the .gitignore line that is
 * meant to keep it out of the repository in the first place.
 *
 * Two carriers for one idea is this project's recurring defect, and here the
 * two cannot simply be merged: .gitignore is read by git and this list is read
 * by the gate, and they answer different questions — "keep it out" versus
 * "is one sitting here anyway". So they stay separate and a test requires each
 * pattern here to have its counterpart there. Drift becomes a failing test
 * rather than a hole nobody notices.
 */
export const SECRET_SHAPED = [
  { re: /(^|\/)\.env($|\.(?!example))/, catches: [".env", "config/.env.local"], ignoreLines: [".env", ".env.local"] },
  { re: /\.pem$/, catches: ["server.pem"], ignoreLines: ["*.pem"] },
  { re: /\.key$/, catches: ["tls.key"], ignoreLines: ["*.key"] },
  // Codex, chunk 0 round 9: these two names shared one entry that declared a
  // single ignore line, so deleting the id_rsa line from .gitignore left the
  // suite green and the key exposed. An entry now lists every name it catches
  // and every line that must keep them out, and the test walks both lists.
  { re: /(^|\/)id_(rsa|ed25519)$/, catches: ["id_rsa", "keys/id_ed25519"], ignoreLines: ["id_rsa", "id_ed25519"] },
  { re: /credentials.*\.json$/, catches: ["n8n-credentials.json"], ignoreLines: ["*credentials*.json"] },
];

/**
 * Parse `git status --porcelain=v1 -z` into paths.
 *
 * Codex, chunk 0 round 2: slicing three characters off every NUL-delimited
 * field is wrong. A rename emits TWO fields — "R  new\0old" — and only the
 * first carries the "XY " prefix. Slicing the second turned a path named
 * ".env" into "v", so the one file the check exists to catch became invisible.
 */
export function parsePorcelainZ(out) {
  const fields = out.split("\0");
  const paths = [];
  for (let i = 0; i < fields.length; i += 1) {
    const rec = fields[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    paths.push(rec.slice(3));
    // A rename or copy consumes the next field whole: it is the original path,
    // with no status prefix of its own.
    if (xy.includes("R") || xy.includes("C")) {
      i += 1;
      const origin = fields[i];
      if (origin !== undefined && origin.length > 0) paths.push(origin);
    }
  }
  return paths;
}

export function findSecretShaped(paths) {
  return paths.filter((f) => SECRET_SHAPED.some(({ re }) => re.test(f)));
}

/**
 * Nothing secret is tracked, AND nothing secret is sitting untracked next to
 * the commit that is about to happen.
 *
 * Codex, chunk 0 round 2: looking only at `git ls-files` reads the index. The
 * gate runs *before* a commit, and the usual next move is `git add -A`, which
 * sweeps in exactly the untracked file the index does not yet know about. A
 * check that inspects only what is already tracked is blind to the one moment
 * it exists for.
 *
 * Untracked-and-gitignored is not reported: .gitignore is what keeps it out,
 * and `git status` already respects it.
 */
function checkNoSecretsNearTheCommit() {
  const tracked = run("git", ["ls-files", "-z"]);
  if (!tracked.ran) return unknown(`git did not run: ${tracked.error ?? "no exit code"}`, tracked.line);
  if (tracked.status !== 0) return unknown(`git ls-files exited ${tracked.status}; not a repo?`, tracked.line);

  // --untracked-files=all, because the default collapses an untracked directory
  // to "keys/" and a secret inside it never appears. Measured 2026-09-04: with
  // the default, `?? keys/` hid `keys/id_ed25519` completely.
  const status = run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ran || status.status !== 0) {
    // We know about the index but not about the working tree. That is half an
    // answer, and half an answer is not a pass.
    return unknown(`git ls-files worked but git status did not (${status.error ?? `exit ${status.status}`}); working tree unexamined`, status.line);
  }

  const trackedFiles = tracked.stdout.split("\0").filter((f) => f.length > 0);
  const worktreeFiles = parsePorcelainZ(status.stdout);

  const all = [...new Set([...trackedFiles, ...worktreeFiles])];
  if (all.length === 0) return unknown("git reports no files at all; nothing to inspect", tracked.line);

  const hits = findSecretShaped(all);
  if (hits.length > 0) return fail(`secret-shaped files present: ${hits.join(", ")}`, tracked.line);
  return pass(`${trackedFiles.length} tracked + ${worktreeFiles.length} changed/untracked, none secret-shaped by name`, tracked.line);
}

export const CHECKS = [
  // Assembly comes first. Codex, chunk 1 parts 1-2: with the build last, the
  // gate could validate an old workflow and then refresh the artifact, and
  // report both as clean. Generation now builds in memory so the chain cannot
  // break that way, but the order still says what depends on what.
  { id: "core-builds-clean", describe: "the deployable artifact assembles with no dependency left behind", run: checkCoreBuild },
  { id: "tests", describe: "the declared test suite passes and is not empty", run: checkTests },
  { id: "typecheck", describe: "tsc --noEmit is clean", run: checkTypecheck },
  { id: "declared-scripts-exist", describe: "every declared node script points at a real file", run: checkDeclaredScriptsExist },
  { id: "no-secrets-near-commit", describe: "no secret-shaped file is tracked or waiting untracked", run: checkNoSecretsNearTheCommit },
  { id: "promised-checks-due", describe: "every mechanically decidable check that has come due is written", run: checkDebt },
  { id: "mutations-still-caught", describe: "reintroducing a fixed defect still fails the test written for it", run: checkMutations },
  { id: "no-drift-from-baseline", describe: "the generated workflow still matches the recorded deployment", run: checkDrift },
  { id: "definition-of-done", describe: "every Definition-of-Done item is covered or says what it waits for", run: checkDefinitionOfDone },
];

/**
 * Read how much of the Definition of Done is actually covered.
 *
 * The list lived in PROGRESS.md as prose for a whole chunk. Prose cannot say
 * whether an item is still covered after a test is renamed, and a document
 * claiming ten items are handled while three wait on things that do not exist
 * is the kind of statement this gate exists to refuse.
 */
const DOD_PROBE = `
import("./scripts/definition-of-done.mjs").then((m) => {
  console.log(JSON.stringify(m.DEFINITION_OF_DONE));
}).catch((e) => { console.log("probe failed: " + (e && e.message)); process.exit(1); });
`;

/**
 * Every reason an item's coverage claim is not established.
 *
 * Exported so it can be tested with hand-built input: an item claiming coverage
 * must NAME what covers it, and `for (const name of item.by)` over an empty
 * array iterates zero times, contributes nothing, and lets the item be counted
 * as covered. `covered: true, by: []` passed this gate while
 * scripts/readiness.mjs called the same item unestablished — two carriers of
 * one rule, only one guarded. Found by a subagent on 2026-09-07 running both
 * against the same input.
 */
/**
 * When this gate run started. Set once, at the top of the process.
 *
 * A report older than this belongs to some other execution, and "the named
 * tests ran and passed" is a claim about a run that did not happen here.
 */
export const RUN_STARTED_AT = Date.now();

/** Is the report on disk from this run, rather than one left behind? */
export function reportIsFromThisRun(path, startedAt = RUN_STARTED_AT, statOf = statSync) {
  try {
    return statOf(path).mtimeMs >= startedAt;
  } catch {
    // Unreadable is not "from this run"; it is not established either way, and
    // the caller turns that into unknown rather than into a pass.
    return false;
  }
}

export function coverageGaps(list, passedTitles) {
  const missing = [];
  for (const item of list) {
    if (!item.covered) continue;
    if (!Array.isArray(item.by) || item.by.length === 0) {
      missing.push(`item ${item.n}: claims coverage and names no test`);
      continue;
    }
    for (const name of item.by) if (!passedTitles.has(name)) missing.push(`item ${item.n}: "${name}"`);
  }
  return missing;
}

function checkDefinitionOfDone() {
  const file = resolve(ROOT, "scripts/definition-of-done.mjs");
  if (!existsSync(file)) return unknown("scripts/definition-of-done.mjs is missing; coverage of the ten is unestablished", "read DoD");

  const r = run("node", ["-e", DOD_PROBE]);
  if (!r.ran) return unknown(`could not read the Definition-of-Done list: ${r.error ?? "no exit code"}`, r.line);
  const out = (r.stdout + r.stderr).trim();

  let list;
  try {
    list = JSON.parse(out);
  } catch {
    return unknown(`the Definition-of-Done probe said: ${out.slice(0, 200)}`, r.line);
  }
  if (!Array.isArray(list) || list.length !== 10) {
    return unknown(`the list holds ${Array.isArray(list) ? list.length : "no"} items, not the ten that were recorded`, "read DoD");
  }

  /*
   * Every named test must have RUN AND PASSED, not merely appear in a file.
   *
   * Codex, chunk 2: "Coverage is established with a regex over source text. A
   * comment or inert string containing it(\"claimed name\" satisfies it… This
   * proves only that matching text exists, not that the test executes."
   *
   * The gate already has the vitest report from its own run, so it can ask the
   * stronger question: did this test execute, and did it pass.
   */
  /*
   * The report must come from THIS run.
   *
   * `checkTests` returns early when the gate is already inside a vitest child,
   * before `readFreshReport` deletes the old file — so this check read a report
   * written minutes earlier by a different execution and printed
   * "5 of 10 covered by tests that ran and passed" while vitest had not run at
   * all. A subagent reproduced it on 2026-09-07 by calling the two checks in
   * order. Exactly the defect `readFreshReport` was written for: it says "both
   * callers go through here now", and there was a third reader.
   *
   * The gate stamps the run it is in, and a report that predates the stamp is
   * not this run's report.
   */
  const report = resolve(ROOT, "out/vitest-report.json");
  if (!existsSync(report)) {
    return unknown("no vitest report; cannot establish that the named tests actually ran", "read DoD");
  }
  if (!reportIsFromThisRun(report)) {
    return unknown("the vitest report on disk predates this gate run, so coverage cannot be established from it",
      "read DoD");
  }
  let passedTitles;
  try {
    const json = JSON.parse(readFileSync(report, "utf8"));
    passedTitles = new Set(
      (json.testResults ?? []).flatMap((f) => (f.assertionResults ?? []).filter((t) => t.status === "passed").map((t) => t.title)),
    );
  } catch (e) {
    return unknown(`vitest report unreadable: ${e instanceof Error ? e.message : String(e)}`, "read DoD");
  }
  if (passedTitles.size === 0) return unknown("the vitest report lists no passing tests; coverage cannot be established from it", "read DoD");

  const missing = coverageGaps(list, passedTitles);
  if (missing.length > 0) {
    return fail(`named as covering a Definition-of-Done item but did not run and pass: ${missing.slice(0, 3).join("; ")}`, "read DoD");
  }

  const covered = list.filter((i) => i.covered).length;
  const outstanding = list.length - covered;
  if (outstanding === 0) return pass("all ten covered by tests that ran and passed", "read DoD");
  return pass(`${covered} of ${list.length} covered by tests that ran and passed; ${outstanding} wait on dependencies that do not exist yet`, "read DoD");
}

/**
 * Compare the generated workflow against the recorded deployment baseline.
 *
 * This is the local half of drift detection. It costs nothing and needs no
 * network: the baseline is a real export, recorded once, and re-exported only
 * when the deployment is deliberately changed. The live half — export the
 * running instance and compare again — belongs to release, not to every check,
 * because a gate that needs the network fails for reasons that have nothing to
 * do with the code.
 *
 * A missing baseline is `unknown`, never `pass`: nothing to compare against is
 * not agreement.
 */
function checkDrift() {
  const fixture = resolve(ROOT, "tests/fixtures/deployed-export.json");
  if (!existsSync(fixture)) {
    return unknown("no recorded deployment baseline; nothing to compare the generated workflow against", "read baseline");
  }

  // Asserting the baseline merely EXISTS would be a check that establishes
  // nothing — the defect this whole project keeps finding. It runs the
  // comparison.
  const r = run("node", ["-e", DRIFT_PROBE]);
  if (!r.ran) return unknown(`drift probe did not run: ${r.error ?? "no exit code"}`, r.line);
  const out = (r.stdout + r.stderr).trim();
  if (r.status === 0 && out.startsWith("same")) return pass("generated workflow matches the recorded deployment baseline", "drift probe");
  if (out.startsWith("drifted")) return fail(out.slice(0, 300), "drift probe");
  return unknown(out.length > 0 ? out.slice(0, 300) : `drift probe exited ${r.status} silently`, "drift probe");
}

/** Run in a child so a throwing generator cannot take the whole gate down. */
const DRIFT_PROBE = `
import("./scripts/generate-workflow.mjs").then(async (g) => {
  const d = await import("./scripts/drift.mjs");
  const fs = await import("node:fs");
  const { workflow } = await g.generate();
  const raw = JSON.parse(fs.readFileSync("tests/fixtures/deployed-export.json", "utf8"));
  delete raw._fixture_note;
  const r = d.compareWorkflows(workflow, raw);
  if (r.state === "same") { console.log("same"); process.exit(0); }
  if (r.state === "drifted") { console.log("drifted: " + r.differences.slice(0, 3).map((x) => x.path).join(", ")); process.exit(1); }
  console.log("unchecked: " + r.reason); process.exit(2);
}).catch((e) => { console.log("probe failed: " + (e && e.message)); process.exit(2); });
`;

/**
 * The artifact the n8n Code node would run must actually assemble.
 *
 * A build that fails only when someone happens to run it by hand is a build
 * nobody runs. The three conditions it enforces — exact substitution counts,
 * zero remaining requires, unchanged format semantics — are the ones measured
 * to fail silently otherwise.
 */
/**
 * What the ARTIFACT says against what the manifest claims about it.
 *
 * Split out so it can be tested: the check around it runs the builder in a
 * child process and reads two files, and the thing worth pinning is this
 * comparison. Returns null when they agree, or the sentence to fail with.
 *
 * The manifest used to carry the literal 0 and the gate read it back, so the
 * one line claiming "no dependency left behind" rested on a constant the
 * builder had written about itself.
 */
export function artifactDisagreesWithManifest(left, claimed) {
  const found = Array.isArray(left) ? left : [];
  if (found.length > 0) {
    return `the artifact still calls require: ${[...new Set(found)].join(", ")} `
      + `(the manifest claims ${claimed})`;
  }
  if (claimed !== 0) {
    return `the manifest claims ${claimed} require call(s) while the artifact has none — `
      + "one of the two counted something the other did not";
  }
  return null;
}

function checkCoreBuild() {
  const script = resolve(ROOT, "scripts/build-core.mjs");
  if (!existsSync(script)) return unknown("scripts/build-core.mjs is missing", "build core");

  const r = run("node", [script]);
  if (!r.ran) return unknown(`build did not run: ${r.error ?? "no exit code"}`, r.line);
  if (r.status !== 0) {
    const first = (r.stdout + r.stderr).split("\n").find((l) => l.includes("Error")) ?? `exit ${r.status}`;
    return fail(first.trim(), r.line);
  }

  const manifestPath = resolve(ROOT, "out/core.manifest.json");
  if (!existsSync(manifestPath)) return unknown("build exited 0 but wrote no manifest", r.line);
  let m;
  try {
    m = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return unknown(`manifest unreadable: ${e instanceof Error ? e.message : String(e)}`, r.line);
  }
  /*
   * The manifest is the builder's word about its own output. This recounts from
   * the ARTIFACT, so weakening the builder's detector no longer buys a passing
   * gate line: the two must agree, and this one reads the bytes that ship.
   */
  let left;
  try {
    left = remainingRequires(readFileSync(resolve(ROOT, "out/core.js"), "utf8"));
  } catch (e) {
    return unknown(`artifact unreadable: ${e instanceof Error ? e.message : String(e)}`, r.line);
  }
  const disagreement = artifactDisagreesWithManifest(left, m.requiresRemaining);
  if (disagreement !== null) return fail(disagreement, r.line);
  if (!Array.isArray(m.exports) || m.exports.length === 0) return fail("artifact exports no validators", r.line);
  return pass(`${m.bytes} bytes, ${m.exports.length} validators, ${left.length} requires counted in the artifact`, r.line);
}

/**
 * Reintroduce each known defect, run the suite, require the named test to fail.
 *
 * The file is always restored by reversing the edit, never by asking git to
 * discard it: git restore would also throw away anything else uncommitted in
 * that file, including work in progress that has nothing to do with this check.
 */
function checkMutations() {
  if (process.env[CHILD_MARKER] !== undefined) {
    return unknown(`refusing to run mutations from inside a gate run (${CHILD_MARKER} is set)`, "guard");
  }
  if (MUTATIONS.length === 0) return unknown("no mutations are recorded; nothing was proven", "mutations");

  const survived = [];
  const unresolvedIds = [];
  /*
   * The report from this gate's own full suite run, used only to decide WHICH
   * FILE to run per mutation. If it cannot be read, `fullReport` stays null and
   * `filesDeclaring` returns nothing, so every mutation runs the whole suite —
   * slower, and never weaker.
   */
  let fullReport = null;
  try {
    const full = resolve(ROOT, "out/vitest-report.json");
    if (existsSync(full)) fullReport = JSON.parse(readFileSync(full, "utf8"));
  } catch {
    fullReport = null;
  }

  for (const m of MUTATIONS) {
    const target = resolve(ROOT, m.file);
    if (!existsSync(target)) {
      unresolvedIds.push(`${m.id} (no such file)`);
      continue;
    }
    const original = readFileSync(target, "utf8");
    const hits = original.split(m.from).length - 1;
    if (hits === 0) {
      // The code moved. That is not proof the test still bites; it is proof we
      // no longer know, and the mutation needs rewriting.
      unresolvedIds.push(`${m.id} (anchor text not found)`);
      continue;
    }
    if (hits > 1) {
      // Measured 2026-09-04: an ambiguous anchor replaced a quotation of itself
      // instead of the code, the suite stayed green, and the mutation was
      // reported as surviving. Ambiguity is "could not establish", not a result.
      unresolvedIds.push(`${m.id} (anchor appears ${hits} times; not unique)`);
      continue;
    }

    let outcome = null;
    /*
     * The mutated file is recorded before it is written, and the record is
     * removed after it is restored.
     *
     * Measured on 2026-09-05: the `finally` below restores the file on any
     * error, and does nothing at all when the process is killed. A run was
     * interrupted and the prompt file stayed mutated — saying "a hypothesis
     * code is whatever seems right", the exact defect that had already wasted a
     * paid run — until the next test run happened to notice.
     *
     * Nothing was deployed with it, and that was luck rather than design: the
     * interrupted run came after the release. Had it come before, the mutation
     * would have been generated into the workflow and uploaded, and the only
     * thing that would have caught it is a human reading a prompt.
     *
     * So the guarantee cannot live only in a finally block. It lives in a file
     * that outlives the process, and restoreInterruptedMutation below reads it.
     */
    writeFileSync(IN_FLIGHT, JSON.stringify({ id: m.id, file: m.file, original, mutated: original.replace(m.from, m.to) }));
    try {
      writeFileSync(target, original.replace(m.from, m.to));
      const mutReport = resolve(ROOT, "out/mutation-report.json");
      /*
       * Only the file that declares the named test.
       *
       * `narrowTo` comes from the full report this gate produced at the start,
       * so it is this tree's own answer, not a guess. When it is empty — a
       * generated title, a report that did not list it — the whole suite runs,
       * because "I could not narrow it" must not become "I checked less".
       */
      const narrowTo = filesDeclaring(fullReport, m.mustFail);
      const args = ["vitest", "run", "--reporter=json", `--outputFile=${mutReport}`, ...narrowTo];
      const { run: r, json } = readFreshReport(mutReport, () => run("npx", args));
      if (!r.ran) {
        outcome = { kind: "unresolved", detail: `${m.id} (vitest did not run)` };
      } else {
        if (json === null) {
          outcome = { kind: "unresolved", detail: `${m.id} (no readable report)` };
        } else {
          const verdict = namedTestFailed(json, m.mustFail);
          if (verdict === null) {
            // Not "it passed" — the report does not contain that test at all,
            // which is what a run that did not finish looks like.
            outcome = { kind: "unresolved",
              detail: `${m.id} (the report does not contain "${m.mustFail}"; the run may not have finished)` };
          } else if (verdict) {
            outcome = { kind: "caught" };
          } else {
            outcome = { kind: "survived", detail: `${m.id}: "${m.mustFail}" did not fail` };
          }
        }
      }
    } finally {
      writeFileSync(target, original);
      if (existsSync(IN_FLIGHT)) rmSync(IN_FLIGHT);
    }

    if (outcome?.kind === "survived") survived.push(outcome.detail);
    if (outcome?.kind === "unresolved") unresolvedIds.push(outcome.detail);
  }

  if (survived.length > 0) return fail(`mutation survived: ${survived.join("; ")}`, "mutation run");
  if (unresolvedIds.length > 0) return unknown(`could not test: ${unresolvedIds.join("; ")}`, "mutation run");
  return pass(`${MUTATIONS.length} reintroduced defects, each caught by its named test`, "mutation run");
}

/** Did the test with this name fail in the report? A test that vanished is not a pass. */
/**
 * Which test FILE holds a given test title, read from a vitest JSON report.
 *
 * The mutation check asks one question — did the named test fail — and answered
 * it by running all 735 tests, 265 times. The file that holds the title is
 * enough, and the report the gate already produced knows which file that is.
 *
 * Returns an array, not a string: two files may declare the same title, and
 * running both is the answer that does not have to choose. An empty array means
 * the title was not in the report, and the caller then runs everything rather
 * than assume.
 */
export function filesDeclaring(report, name) {
  const out = [];
  for (const file of report?.testResults ?? []) {
    const holds = (file.assertionResults ?? []).some((t) => t?.fullName === name || t?.title === name);
    if (holds && typeof file.name === "string" && !out.includes(file.name)) out.push(file.name);
  }
  return out;
}

export function namedTestFailed(report, name) {
  /*
   * Three states, in the checker that exists to enforce them.
   *
   * This returned `false` both for "the test ran and passed" and for "the test
   * is not in this report at all" — and on 2026-09-05 the second happened: a
   * partial report from a run that did not finish reported a mutation as
   * SURVIVING. The one message that must never be produced by not looking.
   *
   * `null` means the named test was not found. The caller reports that as
   * unresolved, which is what it is.
   */
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      /*
       * Exact, not a suffix.
       *
       * This matched `fullName.endsWith(name)`, so a title that ENDS with
       * another test's title answered for it — and which of the two the loop
       * reached first depended on the order vitest happened to sort the files
       * in. A mutation was therefore reported caught or survived by the file
       * ordering rather than by the code. A subagent found it on 2026-09-09,
       * with the pair: "refuses a coverage claim that names no test" is a
       * suffix of "the readiness counter refuses a coverage claim that names no
       * test".
       *
       * The meta-test beside the list already requires titles to be unique by
       * exact comparison; this is the runner agreeing with the guard.
       */
      if (t.title === name || t.fullName === name) return t.status === "failed";
    }
  }
  return null;
}



/**
 * Two lists, because round 1 and round 2 of the review pulled in opposite
 * directions and both were right about their half.
 *
 * Round 1: a disclaimer that cannot affect the verdict is decoration.
 * Round 2: "a gate that can never accept will be bypassed, special-cased, or
 * quietly emptied. That is operationally worse than a conspicuous disclaimer."
 *
 * The way out is not to pick a side but to stop mixing two different things:
 *
 *   LIMITATIONS — this program cannot decide them, ever. Whether a human ran a
 *     review, whether an objection was copied verbatim. Printed every run,
 *     never gating: a check that can never be satisfied teaches people to
 *     ignore the number.
 *
 *   DEBT — mechanically decidable, simply not written yet. Each says which
 *     chunk it comes due in. Before that chunk it is a promise; from that chunk
 *     on it holds exit 2 in place until someone writes the check.
 *
 * The test of which list a line belongs in: could a program decide it with the
 * files on disk? If yes it is debt, and debt has a due date.
 */
/** What the generated workflow weighs right now, for the limitation below. */
function workflowSizeMB() {
  try {
    return `${(statSync(resolve(ROOT, "workflows/incident.json")).size / 1e6).toFixed(2)} MB`;
  } catch {
    return "a size this run could not read";
  }
}

export const LIMITATIONS = [
  // Moved here on 2026-09-05, when provenance closed the other half.
  //
  // An observation can be asked for correctly, arrive from the right cluster in
  // one collection, and still contain a line belonging to another customer —
  // because the provider put it there. Nothing downstream can see that: by then
  // it is indistinguishable from legitimate data, and it carries no incident id
  // to recognise. It is a defect in a provider, and this repository cannot
  // check other people's collection.
  /*
   * Narrowed on 2026-09-07. It said the contents "cannot" be checked, and for
   * the kubernetes slot that is "have not": observations.schema.json REQUIRES
   * pods[].namespace and deployment.namespace, and the incident carries the
   * namespace it asked about, so the comparison is sitting right there. Logs
   * and metrics genuinely carry no such field. An overclaim of impossibility is
   * how a closable gap stays open.
   */
  "that a legitimately collected observation contains nothing belonging to anyone else. Provenance says it was asked for, not that its contents are clean. For logs and metrics there is no field to compare; for kubernetes there is one — pods[].namespace — and it is NOT yet compared, which is a gap rather than an impossibility",
  // Moved here from DEBT on 2026-09-05. Codex: "the DEBT trigger is not
  // checkable — it describes an external permission condition while enforcement
  // is an unrelated dueFromChunk. Nothing detects the second pusher arriving."
  //
  // He is right, and a debt whose due date nobody will notice is a debt that
  // quietly never comes due. It belongs among the things this gate cannot
  // decide, printed every run, until repository-visible ownership metadata
  // exists to check it against.
  "that deployment goes through a chain nobody can skip — true while one person deploys by hand, unchecked and unenforced the moment a second can push",
  // Codex, 2026-09-05: "deterministicCollectionId is unsafe as provenance
  // evidence. It is public and predictable, and reruns reuse it, so an old or
  // forged response for the same incident and scenario passes."
  //
  // He is right about what it is, and it stays deterministic on purpose: the
  // generated workflow has to be byte-identical between runs or drift detection
  // becomes noise. So the id proves that an answer belongs to THIS collection,
  // not that the collection is fresh — and today every observation is a file
  // this process reads itself, so there is nobody to forge one. The day an
  // observation arrives from outside this process, the id has to be minted
  // unpredictably and the reproducible artifact has to get its stability from
  // somewhere else.
  "that a collection id could not have been guessed — it is derived from the incident and the scenario so the generated workflow stays byte-identical between runs",
  // Codex, 2026-09-05: "the first pressure point is n8n's workflow JSON
  // transport, storage and editor serialisation, and the existing spike
  // established only 126 KB."
  //
  // Half of that is now measured and half is not, and the two must not be said
  // in one breath. The API accepted 2.25 MB: the release chain uploaded it,
  // exported it back and compared digests, on 2026-09-05. Whether the EDITOR
  // opens it, and what it does to a 350 KB Code node, nothing here has tried —
  // and nothing here can, because it is a browser.
  /*
   * The size is READ, not remembered. 2.25 MB was measured on 2026-09-05
   * against a 15-node workflow; the file now has 19 nodes and weighs more, and
   * a limitation printed on every run carrying a stale number is the defect
   * this list exists to state honestly.
   */
  `that the n8n editor can open a workflow this size — the API stores and returns ${workflowSizeMB()}, `
    + "measured on each gate run; the editor is untried",
  // Codex, 2026-09-05, after the first live run: "the schema allows 0 to 1, and
  // concludeIncident copies the model's number without checking the prompt's
  // bands, the agreement count, directness, contradictions, or the 0.95
  // ceiling. The displayed confidence is an unestablished model assertion."
  //
  // He is right, and the fix is not a second number computed here — that would
  // be this repository's own recurring defect: answering a claim nothing checks
  // with another claim nothing checks. A confidence derived from counting
  // agreeing findings would look enforced and would measure the counting.
  //
  // So it is said instead: the number is what the model said, and a reader who
  // takes it for a measurement is taking it for something it is not.
  "that a confidence figure means anything beyond what the model asserted — the prompt asks for bands and nothing enforces them",
  // Codex, 2026-09-06, listing what local and live can still differ in after
  // the harness was made to walk the real connections: n8n's item-linking
  // semantics for $().item, which a name map does not reproduce; node and
  // expression versions against `new Function`; multiple webhook items or
  // concurrent executions, where the harness models one item synchronously.
  //
  // The harness executes the strings that ship, which is far more than it did.
  // It is still not n8n, and the day those differ, only a live run says so.
  "that the local harness runs the workflow the way n8n does — it executes the same strings, in one line, one item at a time",
  // Codex, 2026-09-06, on the citations a scenario is built around: "this
  // remains prompt-only compliance. A schema-valid answer can omit the required
  // configuration citation, so stochastic omission survives."
  //
  // True, and deliberately not closed here. must_cite says what a human should
  // look for; a validator refusing an answer for missing one would turn a note
  // into a rule nobody agreed, and scripts/score-run.mjs already reports the
  // omission as its own verdict rather than hiding it inside "correct".
  /*
   * Widened on 2026-09-10, after a rubric meant to fix it was designed,
   * attacked twice and rejected. A required citation names ONE canonical path,
   * and an answer reading the same value from somewhere else is recorded as a
   * miss. `must_support` — a proposition with an entity and a set of accepted
   * paths — was written out in docs/must-support.md and not built: it would add
   * identity resolution and semantic parsers while measuring citation, not
   * reasoning. And the case that motivated it did not survive: the log line
   * says "heap usage 468Mi of 512Mi limit" and does NOT say those 512Mi are the
   * container's configured limit.
   */
  "that an agent cites what a scenario was built around — the prompt asks, nothing enforces, and the scorer reports the miss rather than refusing the answer",
  /*
   * Rewritten the same day it was written, and the test came from Grok:
   *
   *   Name the observation that would make you delete the sentence. If it is
   *   "kubernetes cited limits.memory", you parked a bug. If it is "must_cite
   *   now matches properties, not paths", you stated an instrument bound. A
   *   true bound still prints when this miss goes away.
   *
   * The first version would have stopped printing the moment one agent emitted
   * one field: a parked bug wearing the word limitation. Worse, it promised the
   * misses were reviewed by hand while another limitation says nothing records
   * a review — measurement replaced by a caption.
   *
   * What is left is the bound that survives any answer: a required citation is
   * matched by PATH against every specialist finding, so it says nothing about
   * whether the conclusion used it. Measured on 2026-09-10: for container-oom
   * the hypothesis was supported by terminated.reason alone, and limits.memory
   * was never emitted by anybody.
   */
  "that a required citation was USED by the conclusion — it is matched by path against "
    + "ANY agent's finding, the synthesiser's included, and presence is not use",
  /*
   * `src/core/review.ts` builds and reads a human review log, and its own
   * header calls itself "the only signal in the project that can tell a right
   * answer from a well-formed one". Nothing writes one: the module has no
   * caller outside its test, no script produces a log, and `docs/` holds none.
   * A subagent found it on 2026-09-10. Said out loud, because a reader takes
   * the file's existence as evidence the prototype HAS human ground truth — it
   * has a library for it and no path to it.
   */
  "that anyone has recorded a human verdict — src/core/review.ts can build and "
    + "read a review log, and nothing in the project writes one",
  "that every diff went through external review before commit",
  "that each review objection was recorded verbatim rather than paraphrased",
  "that memory was written after each step",
];

export const DEBT = [



  {
    // Deliberately carries no count, and neither does this comment.
    //
    // It used to name a number. The list moved and the sentence did not, which
    // is the second-carrier defect inside the file whose job is refusing claims
    // larger than their evidence. Rewriting it to explain the old number kept
    // the number, so the explanation went too.
    //
    // scripts/definition-of-done.mjs holds the state; the `definition-of-done`
    // check reports it from there.
    claim: "the Definition-of-Done items still uncovered — see the definition-of-done check for which, and what each waits on",
    dueFromChunk: 5,
    /*
     * Due, and misfiled, and the second is why it stayed due.
     *
     * DEBT is for what this repository can decide and has not written yet.
     * LIMITATIONS is for what it can never decide. The three items still
     * uncovered are neither: they wait on a model call, which is not
     * deterministic and so cannot be "written", but is not impossible either —
     * it becomes possible the moment a run is recorded.
     *
     * So the condition is the artifact, not a chunk number. A chunk number was
     * the wrong shape of promise: it came due while the thing it waited for had
     * never existed, and the only ways out were to move the number or to widen
     * an exception. Both are the defect this file exists to refuse.
     *
     * `unlessArtifact` is a path. While it does not exist the debt is not yet
     * due whatever the chunk says; once it does, the chunk number applies again
     * and the items must be covered.
     */
    /*
     * A CONDITION, not a filename. Until 2026-09-07 this named
     * "docs/runs/deployed-chain.json" — a path that appears exactly once in the
     * whole repository, on this line, and that nothing has ever written. So the
     * debt waited forever on the absence of a file nobody produces, while six
     * records of live runs through the deployed workflow sat in the same
     * directory. A subagent found it by grepping for the filename.
     *
     * A promise that waits on a sentinel nobody writes is not a promise. What
     * it actually waits for is a recorded run whose results a machine can read,
     * which is what `score-run.mjs --record` writes and what
     * scripts/readiness.mjs counts. The same signal, asked in one place.
     */
    unlessScoredRun: true,
    /*
     * Rewritten 2026-09-07. The old sentence was wrong in both halves and it is
     * the line the gate prints on every run:
     *
     *   "the three uncovered items" — there are FIVE uncovered, and the same
     *   gate run prints "5 of 10 covered" two lines away;
     *   "no recorded run has made yet" — six chain records say in their own
     *   notes that they ran end to end through the deployed workflow. The real
     *   condition is that no record carries machine-readable scores.
     *
     * Worse, two of the uncovered items wait on code nobody has written, not on
     * a model call — readiness.mjs says so out loud — so they were excused by a
     * reason that does not apply to them. The comment directly above this entry
     * says a number here is the second-carrier defect. The number was here.
     */
    why: "the uncovered Definition-of-Done items whose evidence is a model's answer wait on a run "
      + "recorded with machine-readable scores; the definition-of-done check names which, and not "
      + "every uncovered item waits on this",
  },
];

/**
 * Which chunk are we in? Read from PROGRESS.md, never remembered — the same
 * rule the round number follows. A number this file carried as a constant would
 * be one more claim nothing checks.
 */
export function readCurrentChunk(text) {
  /*
   * Measured 2026-09-04: reading "the first numeric cell of any table row"
   * returned 6 for a file whose highest chunk is 0. PROGRESS.md holds several
   * tables, and a numbered list of review objections looks exactly like a
   * chunk column to a parser that is not told which table to read.
   *
   * So the table is identified by its header, and only its rows are read. A
   * file with no such header returns null, which the caller reports as
   * "could not establish" — never as chunk 0.
   */
  const lines = text.split("\n");
  const header = lines.findIndex((l) => l.startsWith("|") && /\|\s*Chunk\s*\|/i.test(l));
  if (header === -1) return null;

  const chunks = [];
  // +2 skips the header and the |---|---| separator beneath it.
  for (let i = header + 2; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || !line.startsWith("|")) break;
    const cell = line.split("|")[1]?.trim();
    if (cell !== undefined && /^\d+$/.test(cell)) chunks.push(Number(cell));
  }
  if (chunks.length === 0) return null;
  return Math.max(...chunks);
}

/**
 * Has any run been recorded in a form a machine can read?
 *
 * Exported for the test: a run record states its outcome in prose for a human,
 * and prose is not evidence anything may count. `score-run.mjs --record` writes
 * a `scored` object at the moment it scores, and that object is the signal —
 * the same one scripts/readiness.mjs uses, so the two cannot disagree about
 * whether this project has ever measured itself.
 *
 * An empty `scored` is NOT a scored run: absence of results is not a result.
 */
export function someRunWasScored(runsDir) {
  if (!existsSync(runsDir)) return false;
  let names;
  try {
    names = readdirSync(runsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
  for (const n of names) {
    try {
      const rec = JSON.parse(readFileSync(resolve(runsDir, n), "utf8"));
      const scored = rec?.scored;
      /*
       * A run was SCORED only if something in it was established.
       *
       * Keys alone were enough here, and the scorer writes a key for every
       * scenario whatever happened — `unasked` for one no part bought,
       * `unestablished` for one that answered nothing. So a record of nothing
       * but those two flipped the promised checks from waiting to due on the
       * strength of a run that established nothing. `recordInto` refuses to
       * WRITE such a record, but this reader must not depend on a guarantee
       * made in another file: a record edited by hand reaches it too.
       */
      if (scored !== null && typeof scored === "object" && !Array.isArray(scored)
        && Object.values(scored).some((v) => v !== "unasked" && v !== "unestablished")) return true;
    } catch { /* unreadable is not evidence of a scored run */ }
  }
  return false;
}

/**
 * Which promises are due and which are waiting, decided from data.
 *
 * Split out because the only test over this reported the STATE of the check —
 * one of pass, fail, unknown — which every branch satisfies, so the whole
 * point of DEBT could be deleted and nothing noticed. A subagent measured it on
 * 2026-09-09: `const due = []` reports PASS while a promise is overdue.
 *
 * A debt with no `dueFromChunk` is due from the FIRST chunk rather than never.
 * `chunk >= undefined` is false, so the only required field was the one nothing
 * required — absence reading as "not yet", which is this project's oldest bug.
 */
/*
 * The chunk a debt falls due from, and the ONE place that decides it.
 *
 * A missing field means "due now", deliberately. The default lived inside the
 * filter, and two printers read `d.dueFromChunk` raw — so an entry without the
 * field was enforced as due and reported as "chunk undefined". A subagent found
 * it on 2026-09-09.
 */
export function dueFrom(d) {
  return typeof d?.dueFromChunk === "number" ? d.dueFromChunk : 0;
}

export function splitDebt(debts, chunk, { artifactExists, scored }) {
  const list = Array.isArray(debts) ? debts : [];
  const waiting = list.filter((d) =>
    (typeof d.unlessArtifact === "string" && !artifactExists(d.unlessArtifact))
    || (d.unlessScoredRun === true && !scored));
  const due = list.filter((d) => {
    if (waiting.includes(d)) return false;
    return chunk >= dueFrom(d);
  });
  return { due, waiting };
}

function checkDebt() {
  const progress = resolve(ROOT, "PROGRESS.md");
  if (!existsSync(progress)) {
    return unknown("PROGRESS.md is missing; cannot tell which chunk is due", "read PROGRESS.md");
  }

  let chunk;
  try {
    chunk = readCurrentChunk(readFileSync(progress, "utf8"));
  } catch (e) {
    return unknown(`PROGRESS.md unreadable: ${e instanceof Error ? e.message : String(e)}`, "read PROGRESS.md");
  }
  if (chunk === null) {
    return unknown("PROGRESS.md names no chunk number; cannot tell what is due", "read PROGRESS.md");
  }

  // A debt whose stated dependency has not happened yet is not overdue; it is
  // waiting, and saying so is different from saying nobody wrote it.
  const scored = someRunWasScored(resolve(ROOT, "docs/runs"));
  const { due, waiting } = splitDebt(DEBT, chunk, {
    artifactExists: (rel) => existsSync(resolve(ROOT, rel)),
    scored,
  });
  if (due.length > 0) {
    return unknown(
      `chunk ${chunk}: ${due.length} promised check(s) are due and unwritten — ${due.map((d) => d.claim).join("; ")}`,
      "read PROGRESS.md",
    );
  }
  if (waiting.length > 0) {
    return pass(
      `chunk ${chunk}: ${waiting.length} promised check(s) wait on something that has not happened — ` +
      /*
       * Name what it waits FOR, whichever kind of condition it is. The message
       * formatted `d.unlessArtifact` unconditionally and printed "(undefined)"
       * for a debt that waits on a scored run — and this line is the only thing
       * a reader is told about why the promise is not due.
       */
      waiting.map((d) => `${d.why} (${typeof d.unlessArtifact === "string"
        ? d.unlessArtifact : "waiting for a run whose results were recorded machine-readably"})`).join("; "),
      "read PROGRESS.md",
    );
  }
  const soon = DEBT.map((d) => `chunk ${dueFrom(d)}`).join(", ");
  return pass(`chunk ${chunk}: no promised check is due yet (next: ${soon})`, "read PROGRESS.md");
}

// ── running them ────────────────────────────────────────────────────────────

/** Where an in-flight mutation is recorded, so a killed run leaves a trace. */
const IN_FLIGHT = resolve(ROOT, "out/mutation-in-flight.json");

/**
 * Put back a file a killed mutation run left broken.
 *
 * Returns what it did, so the caller can say it out loud. Silence here would be
 * the worst possible shape: the repository quietly repaired, and nobody told
 * that a deployment may have gone out with the mutation in it.
 */
export function restoreInterruptedMutation(path = IN_FLIGHT, root = ROOT) {
  if (!existsSync(path)) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { state: "unreadable", detail: e instanceof Error ? e.message : String(e) };
  }
  if (typeof record?.file !== "string" || typeof record?.original !== "string" || typeof record?.mutated !== "string") {
    return { state: "unreadable", detail: "the record names no file, or holds no original or mutated text" };
  }

  /*
   * Codex, 2026-09-05, High: this used to overwrite whenever the file differed
   * from the recorded original. Two ways that destroys work — someone edits the
   * file after the kill and loses those edits, and a stale or forged record
   * names any writable path at all.
   *
   * So: the path must be inside the repository, and the file must still hold
   * EXACTLY the mutated text. Anything else is a file this record no longer
   * describes, and the honest answer is to say so and touch nothing.
   */
  /*
   * The path is resolved through symlinks before it is judged.
   *
   * Codex, 2026-09-05: comparing the resolved STRING is not the same as
   * comparing the real file. A symlink inside the repository points wherever it
   * likes, and readFileSync and writeFileSync follow it — so a record naming a
   * link would have passed the check and restored a file outside.
   *
   * realpathSync throws when nothing is there, and that is the right answer
   * too: a record naming a file that does not exist describes nothing.
   */
  const named = resolve(root, record.file);
  let target;
  let realRoot;
  try {
    target = realpathSync(named);
    realRoot = realpathSync(root);
  } catch (e) {
    return { state: "refused", id: record.id, file: record.file,
      detail: `cannot resolve ${record.file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (target !== realRoot && !target.startsWith(realRoot + sep)) {
    return { state: "refused", id: record.id, file: record.file,
      detail: `the record names ${record.file}, which resolves to ${target}, outside this repository` };
  }
  const now = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (now === record.original) {
    rmSync(path);
    return { state: "already-clean", id: record.id, file: record.file };
  }
  if (now !== record.mutated) {
    return { state: "refused", id: record.id, file: record.file,
      detail: `${record.file} no longer holds the text this record describes; it was edited after the interruption. ` +
        "Nothing was changed — put it back by hand, then delete " + path };
  }
  writeFileSync(target, record.original);
  rmSync(path);
  return { state: "restored", id: record.id, file: record.file };
}

export function runGate(checks = CHECKS) {
  const results = checks.map((c) => {
    let outcome;
    try {
      outcome = c.run();
    } catch (e) {
      // A check that threw did not establish anything. It is not a failure of
      // the subject; it is a failure to look.
      outcome = unknown(`check threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Codex, chunk 0 round 2: nothing validated the state. A check returning
    // {state: "timeout"} counted as neither fail nor unknown, and the arithmetic
    // produced 0 — "everything passed", from an outcome nobody recognised.
    if (outcome === null || outcome === undefined || !["pass", "fail", "unknown"].includes(outcome.state)) {
      outcome = unknown(`check returned an unrecognised state: ${JSON.stringify(outcome?.state ?? outcome)}`);
    }
    return { id: c.id, describe: c.describe, ...outcome };
  });

  const failed = results.filter((r) => r.state === "fail");
  const unresolved = results.filter((r) => r.state === "unknown");

  /*
   * Four codes, because three collapsed two different situations into one.
   *
   * Codex, chunk 0 round 2: exit 1 used to mean both "something failed" and
   * "something failed and other things were never established". A human reads
   * the full report and sees the difference; CI branches on the number alone,
   * and so read a partial assessment as a completed one.
   *
   *   0  everything was checked and everything passed
   *   1  something failed, and everything else WAS established
   *   2  nothing failed, but something could not be established
   *   3  something failed AND something could not be established
   */
  /*
   * A gate that checked NOTHING is not a gate that passed.
   *
   * `runGate([])` printed `PASS (exit 0)` with no check lines above it — the
   * empty-suite defect, in the arithmetic of the file that refuses it for
   * vitest eleven hundred lines up ("the suite collected 0 tests; an empty
   * suite exits 0") and that scripts/readiness.mjs guards for its own bar. One
   * rule, three carriers, and this was the unguarded one. Found by a subagent
   * on 2026-09-07 by simply calling it.
   *
   * It is `unknown`, not `fail`: nothing was established, and nothing failed.
   */
  const nothingChecked = results.length === 0;
  const exitCode = (failed.length > 0 ? 1 : 0)
    + (unresolved.length > 0 || nothingChecked ? 2 : 0);

  /*
   * And an interrupted mutation that could not be put back travels into the
   * exit code, instead of being printed and dropped. `refused` and `unreadable`
   * both mean the same thing: this gate does not know whether a source file
   * still holds a planted defect. That is the definition of exit 2, and it was
   * the one place the answer was thrown away — while scripts/readiness.mjs read
   * the recorded exitCode and reported the gate green.
   */
  return { results, failed, unresolved, exitCode, nothingChecked,
    limitations: LIMITATIONS, debt: DEBT };
}

/**
 * Fold an interrupted-mutation outcome into the gate's exit code.
 *
 * Separate from runGate because the repair happens at the command entry — the
 * gate's own test must not erase a mutation that a killed run left applied.
 */
export function withRepair(gate, repaired) {
  if (repaired === null || repaired === undefined) return gate;
  const unresolvedRepair = repaired.state === "refused" || repaired.state === "unreadable";
  if (!unresolvedRepair) return { ...gate, repaired };
  return { ...gate, repaired, exitCode: gate.exitCode | 2 };
}

const VERDICT = {
  0: "PASS",
  1: "FAIL",
  2: "COULD NOT ESTABLISH — passed on what was checked, and that is not the same as clean",
  3: "FAIL, AND INCOMPLETE — something failed and something else was never established",
};
const MARK = { pass: "PASS   ", fail: "FAIL   ", unknown: "UNKNOWN" };

export function format(gate) {
  const lines = ["", "ACCEPTANCE GATE", ""];
  // First, and loudly. A killed mutation run leaves a deliberately broken file
  // on disk, and whatever is generated from the tree afterwards carries it.
  if (gate.repaired !== null && gate.repaired !== undefined) {
    if (gate.repaired.state === "restored") {
      lines.push(`  REPAIRED  a killed mutation run had left ${gate.repaired.file} broken (${gate.repaired.id}).`);
      lines.push("            It is put back. Anything generated from the tree since then carried it —", "");
      lines.push("            check whether a deployment happened in between.", "");
    } else if (gate.repaired.state === "already-clean") {
      lines.push(`  NOTE      a mutation run was interrupted (${gate.repaired.id}) but ${gate.repaired.file} was already correct.`, "");
    } else if (gate.repaired.state === "refused") {
      lines.push(`  REFUSED   an interrupted mutation was recorded, and nothing was changed: ${gate.repaired.detail}`, "");
    } else {
      lines.push(`  NOTE      an interrupted mutation was recorded and could not be read: ${gate.repaired.detail}`, "");
    }
  }
  for (const r of gate.results) {
    lines.push(`  ${MARK[r.state]}  ${r.id} — ${r.detail}`);
    if (r.command !== undefined) lines.push(`           $ ${r.command}`);
  }
  lines.push("", "  THIS GATE CANNOT DECIDE THESE — they rest on discipline, and no exit code covers them:");
  for (const n of gate.limitations) lines.push(`    · ${n}`);
  lines.push("", "  PROMISED CHECKS NOT YET WRITTEN — each holds exit 2 from the chunk named:");
  for (const d of gate.debt) lines.push(`    · from chunk ${dueFrom(d)}: ${d.claim}`);
  lines.push("", `  ${VERDICT[gate.exitCode]}  (exit ${gate.exitCode})`, "");
  return lines.join("\n");
}

// CLI entry. `import.meta.main` is not available on node 20, so compare paths.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  /*
   * The repair belongs to the command, not to runGate.
   *
   * Put inside runGate for ten minutes on 2026-09-05 and it ate itself: the
   * mutation runner spawns the whole suite, the suite contains a test that
   * calls runGate, and that call restored the very file being mutated. Thirty
   * eight mutations "survived" at once. A repair that runs wherever the
   * function is called is a repair that fires in the middle of the thing it is
   * meant to protect.
   */
  /*
   * The repair is taken FIRST, and that is not a style choice.
   *
   * Passing the repair as the SECOND argument beside a call to the gate reads
   * as "repair alongside the gate", but JavaScript evaluates arguments left to
   * right — so
   * `runGate()` ran first, its mutation check rewrote and then deleted
   * `out/mutation-in-flight.json` 232 times, and the repair that followed found
   * nothing. The whole "a killed run left a file broken, the next run puts it
   * back and says so" guarantee was dead, silently, from the commit that folded
   * two statements into one expression. A subagent found it on 2026-09-09; no
   * test covered the ORDER, only the two halves.
   */
  const repaired = restoreInterruptedMutation();
  const gate = withRepair(runGate(), repaired);
  process.stdout.write(format(gate));
  mkdirSync(dirname(OUT), { recursive: true });
  /*
   * `repaired` is written out too. scripts/readiness.mjs reads this file and
   * reported the gate green off `exitCode` alone, so an interrupted mutation
   * nobody could put back was invisible to every later reader.
   */
  writeFileSync(OUT, JSON.stringify({ results: gate.results, exitCode: gate.exitCode,
    /*
     * When this ran. scripts/readiness.mjs reported "the acceptance gate
     * passed", present tense, from a file with no date — so a green gate could
     * outlive every edit made after it. The same staleness this file refuses
     * for the vitest report, one reader over.
     */
    finishedAt: Date.now(),
    repaired: gate.repaired ?? null, nothingChecked: gate.nothingChecked === true,
    limitations: gate.limitations, debt: gate.debt }, null, 2));
  process.exit(gate.exitCode);
}
