/**
 * Did the run give the RIGHT answer, or merely an answer?
 *
 * Written on 2026-09-06, after I reported "three of five concluded" as a
 * success and Codex pointed out that one of the three was wrong:
 * cpu-throttling answered INSUFFICIENT_EVIDENCE where its expected.json says
 * CPU_THROTTLING. Concluding and being correct are different things, and
 * nothing in this repository compared the two — so the only thing standing
 * between a wrong answer and a green report was somebody reading both files.
 *
 * Three states, as everywhere: correct, wrong, and could-not-establish. The
 * third is what a refused run is, and it is not the same as a wrong answer.
 *
 * This does NOT grade the reasoning. expected.json says what a run is for; a
 * human reads the thread against it. What this settles is the one comparison a
 * machine can make honestly.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIOS = resolve(ROOT, "scenarios");

export function expectedFor(scenario, root = SCENARIOS) {
  const path = join(root, scenario, "expected.json");
  if (!existsSync(path)) return { state: "unknown", why: `${scenario} has no expected.json` };
  try {
    const e = JSON.parse(readFileSync(path, "utf8"));
    if (typeof e.root_cause_code !== "string") {
      return { state: "unknown", why: `${scenario}/expected.json names no root_cause_code` };
    }
    return { state: "known", code: e.root_cause_code, mustCite: Array.isArray(e.must_cite) ? e.must_cite : [] };
  } catch (err) {
    return { state: "unknown", why: `${scenario}/expected.json is unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Compare one live answer with what the scenario is for.
 *
 * `answer` is the webhook's reply, as recorded. A run that did not conclude is
 * `unestablished`, never `wrong`: it did not give an answer to be wrong about,
 * and folding the two together would make a broken chain look like a bad model.
 */
export function score(scenario, answer, root = SCENARIOS) {
  const want = expectedFor(scenario, root);
  if (want.state !== "known") return { scenario, state: "unestablished", why: want.why };

  if (answer === null || typeof answer !== "object") {
    return { scenario, state: "unestablished", why: "no answer was recorded", expected: want.code };
  }
  if (answer.state !== "concluded") {
    return { scenario, state: "unestablished", expected: want.code,
      why: `the run ended in state ${JSON.stringify(answer.state)}: ${String(answer.reason ?? "no reason given")}` };
  }

  const got = answer.root_cause_code;
  if (got === want.code) {
    // Cited evidence is reported, never scored: expected.json's must_cite says
    // what a human should look for, and a run that reaches the right code by
    // other evidence is not thereby wrong.
    const cited = Array.isArray(answer.evidence) ? answer.evidence.map((e) => e?.source ?? e?.source_ref) : [];
    const missing = want.mustCite.filter((c) => !cited.includes(c));
    return { scenario, state: "correct", code: got, missingCitations: missing };
  }
  return { scenario, state: "wrong", expected: want.code, got: got ?? "(none)" };
}

export function scoreAll(answers, root = SCENARIOS) {
  const scenarios = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  return scenarios.map((s) => score(s, answers[s] ?? null, root));
}

export function format(results) {
  const lines = ["", "WHAT THE RUN ANSWERED", ""];
  for (const r of results) {
    if (r.state === "correct") {
      lines.push(`  CORRECT        ${r.scenario} → ${r.code}` +
        (r.missingCitations.length > 0 ? `  (did not cite ${r.missingCitations.join(", ")})` : ""));
    } else if (r.state === "wrong") {
      lines.push(`  WRONG          ${r.scenario} → ${r.got}, expected ${r.expected}`);
    } else {
      lines.push(`  UNESTABLISHED  ${r.scenario} — ${r.why}`);
    }
  }
  const correct = results.filter((r) => r.state === "correct").length;
  const wrong = results.filter((r) => r.state === "wrong").length;
  const unestablished = results.filter((r) => r.state === "unestablished").length;
  lines.push("", `  ${correct} correct, ${wrong} wrong, ${unestablished} not established, of ${results.length}`);
  lines.push("", "  Concluding and being right are different things. A run that did not conclude is",
    "  not a wrong answer — it gave none.", "");
  return lines.join("\n");
}

function main() {
  const path = process.argv[2];
  if (path === undefined) {
    process.stderr.write("usage: node scripts/score-run.mjs <answers.json>\n" +
      "  where answers.json maps a scenario name to the webhook's reply\n");
    process.exit(2);
  }
  const answers = JSON.parse(readFileSync(path, "utf8"));
  const results = scoreAll(answers);
  process.stdout.write(format(results));
  // Wrong is a failure; not established is not the same failure.
  process.exit((results.some((r) => r.state === "wrong") ? 1 : 0) +
    (results.some((r) => r.state === "unestablished") ? 2 : 0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
