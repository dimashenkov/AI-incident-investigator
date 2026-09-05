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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  const report = resolve(ROOT, "out/vitest-report.json");
  if (!existsSync(report)) {
    return unknown("no vitest report; cannot establish that the named tests actually ran", "read DoD");
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

  const missing = [];
  for (const item of list) {
    if (!item.covered) continue;
    for (const name of item.by) if (!passedTitles.has(name)) missing.push(`item ${item.n}: "${name}"`);
  }
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
  const { workflow } = g.generate();
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
  if (m.requiresRemaining !== 0) return fail(`${m.requiresRemaining} require call(s) remain in the artifact`, r.line);
  if (!Array.isArray(m.exports) || m.exports.length === 0) return fail("artifact exports no validators", r.line);
  return pass(`${m.bytes} bytes, ${m.exports.length} validators, 0 requires`, r.line);
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
    try {
      writeFileSync(target, original.replace(m.from, m.to));
      const mutReport = resolve(ROOT, "out/mutation-report.json");
      const { run: r, json } = readFreshReport(mutReport, () =>
        run("npx", ["vitest", "run", "--reporter=json", `--outputFile=${mutReport}`]));
      if (!r.ran) {
        outcome = { kind: "unresolved", detail: `${m.id} (vitest did not run)` };
      } else {
        if (json === null) {
          outcome = { kind: "unresolved", detail: `${m.id} (no readable report)` };
        } else if (namedTestFailed(json, m.mustFail)) {
          outcome = { kind: "caught" };
        } else {
          outcome = { kind: "survived", detail: `${m.id}: "${m.mustFail}" did not fail` };
        }
      }
    } finally {
      writeFileSync(target, original);
    }

    if (outcome?.kind === "survived") survived.push(outcome.detail);
    if (outcome?.kind === "unresolved") unresolvedIds.push(outcome.detail);
  }

  if (survived.length > 0) return fail(`mutation survived: ${survived.join("; ")}`, "mutation run");
  if (unresolvedIds.length > 0) return unknown(`could not test: ${unresolvedIds.join("; ")}`, "mutation run");
  return pass(`${MUTATIONS.length} reintroduced defects, each caught by its named test`, "mutation run");
}

/** Did the test with this name fail in the report? A test that vanished is not a pass. */
export function namedTestFailed(report, name) {
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      if (t.title === name || t.fullName?.endsWith(name)) return t.status === "failed";
    }
  }
  return false;
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
export const LIMITATIONS = [
  // Moved here on 2026-09-05, when provenance closed the other half.
  //
  // An observation can be asked for correctly, arrive from the right cluster in
  // one collection, and still contain a line belonging to another customer —
  // because the provider put it there. Nothing downstream can see that: by then
  // it is indistinguishable from legitimate data, and it carries no incident id
  // to recognise. It is a defect in a provider, and this repository cannot
  // check other people's collection.
  "that a legitimately collected observation contains nothing belonging to anyone else — provenance says it was asked for, not that its contents are clean",
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

  const due = DEBT.filter((d) => chunk >= d.dueFromChunk);
  if (due.length > 0) {
    return unknown(
      `chunk ${chunk}: ${due.length} promised check(s) are due and unwritten — ${due.map((d) => d.claim).join("; ")}`,
      "read PROGRESS.md",
    );
  }
  const soon = DEBT.map((d) => `chunk ${d.dueFromChunk}`).join(", ");
  return pass(`chunk ${chunk}: no promised check is due yet (next: ${soon})`, "read PROGRESS.md");
}

// ── running them ────────────────────────────────────────────────────────────

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
  const exitCode = (failed.length > 0 ? 1 : 0) + (unresolved.length > 0 ? 2 : 0);

  return { results, failed, unresolved, exitCode, limitations: LIMITATIONS, debt: DEBT };
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
  for (const r of gate.results) {
    lines.push(`  ${MARK[r.state]}  ${r.id} — ${r.detail}`);
    if (r.command !== undefined) lines.push(`           $ ${r.command}`);
  }
  lines.push("", "  THIS GATE CANNOT DECIDE THESE — they rest on discipline, and no exit code covers them:");
  for (const n of gate.limitations) lines.push(`    · ${n}`);
  lines.push("", "  PROMISED CHECKS NOT YET WRITTEN — each holds exit 2 from the chunk named:");
  for (const d of gate.debt) lines.push(`    · from chunk ${d.dueFromChunk}: ${d.claim}`);
  lines.push("", `  ${VERDICT[gate.exitCode]}  (exit ${gate.exitCode})`, "");
  return lines.join("\n");
}

// CLI entry. `import.meta.main` is not available on node 20, so compare paths.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const gate = runGate();
  process.stdout.write(format(gate));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ results: gate.results, exitCode: gate.exitCode, limitations: gate.limitations, debt: gate.debt }, null, 2));
  process.exit(gate.exitCode);
}
