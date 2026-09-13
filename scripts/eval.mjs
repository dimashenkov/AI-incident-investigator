/**
 * The "read" step of the eval loop: score every recorded run, group the failures by
 * where they hurt, and — when given two prompt versions — apply the keep-rule.
 *
 * It reads the DURABLE records (docs/answers/*.json, git-tracked), NOT live n8n
 * executions (which are pruned). It invents no scoring: it calls score-run's
 * `score`, then eval.ts's `grade` / `stickiness` / `keepRule`. It SPENDS NOTHING —
 * it reads files. Producing more attempts (to raise k) is the paid step, and it is
 * not here.
 *
 *   node scripts/eval.mjs                 # the read: every scenario, stickiness
 *   node scripts/eval.mjs --before <hashA> --after <hashB>   # keep-rule across two
 *                                                              # prompt versions
 *
 * Grade/stickiness/keepRule live in src/core/eval.ts (pure, tested). This file is
 * only the glue: read, group, print.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { score, scenarioOf } from "./score-run.mjs";
// eval.ts is TypeScript; node's type-stripping runs it, and .ts imports resolve.
import { stickiness, keepRule } from "../src/core/eval.ts";

/** A short id for a WHOLE prompt-version set (all agents), so a comparison is
 *  between two frozen sets — not "any agent's hash matches", which mixes versions
 *  when only one agent changed (Grok, 2026-09-13). No provenance -> null. */
function setIdOf(promptVersions) {
  if (promptVersions === null || typeof promptVersions !== "object") return null;
  const stable = JSON.stringify(Object.keys(promptVersions).sort().map((k) => [k, promptVersions[k]]));
  return createHash("sha256").update(stable).digest("hex").slice(0, 12);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANSWERS = join(ROOT, "docs", "answers");

/** Every recorded answer, as { key -> answer } merged across all answer files. A
 *  key already seen is collected as another attempt under a synthetic sub-key, so
 *  two files that both hold `oom#1` do not silently overwrite one run with another. */
function readAllAnswers(dir = ANSWERS) {
  const byKey = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    let doc;
    try { doc = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) continue;
    for (const [key, answer] of Object.entries(doc)) {
      if (!/#\d+$/.test(key) && !answer?.state) continue; // skip non-run entries
      let k = `${key}@${f}`;
      byKey[k] = answer;
    }
  }
  return byKey;
}

/** The attempts whose WHOLE prompt-version set matches `setId` — a comparison is
 *  between two frozen sets, so a run counts only if every agent's prompt matches.
 *  Returns { stick: scenario->Stickiness, n: matched attempt count }. */
function statesForSet(byKey, setId) {
  const out = {};
  let n = 0;
  for (const [key, answer] of Object.entries(byKey)) {
    const pv = answer && typeof answer === "object" ? answer.prompt_versions : undefined;
    if (setIdOf(pv) !== setId) continue;
    n += 1;
    const scenario = scenarioOf(key.split("@")[0]);
    (out[scenario] ??= []).push(score(scenario, answer).state);
  }
  const stick = {};
  for (const [s, states] of Object.entries(out)) stick[s] = stickiness(states);
  return { stick, n };
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  const before = flag("--before");
  const after = flag("--after");

  const byKey = readAllAnswers();

  if (before && after) {
    const b = statesForSet(byKey, before);
    const a = statesForSet(byKey, after);
    process.stdout.write(`keep-rule: prompt set ${before} -> ${after}\n`);
    // A comparison with no attributed runs on either side cannot decide anything —
    // say THAT, not "fixed no sticky problem" (Grok, 2026-09-13).
    if (b.n === 0 || a.n === 0) {
      process.stdout.write(`  reject: no attributed runs (${before}: ${b.n} run(s), ${after}: ${a.n} run(s)).\n`);
      process.stdout.write("  Runs carry prompt_versions only since 2026-09-13; produce k>=3 attempts per set first (that spends).\n");
      process.exit(1);
    }
    const v = keepRule(b.stick, a.stick);
    process.stdout.write(`  ${v.why}\n`);
    process.stdout.write(`  flipped:          ${v.flipped.join(", ") || "(none)"}\n`);
    process.stdout.write(`  regressed:        ${v.regressed.join(", ") || "(none)"}\n`);
    process.stdout.write(`  unmeasured green: ${v.unmeasuredGreens.join(", ") || "(none)"}\n`);
    process.exit(v.keep ? 0 : 1);
  }

  // Group by prompt-version SET first — stickiness is only honest within one frozen
  // set. Mixing versions/eras into one number is what Grok warned against.
  const bySet = {};
  for (const [key, answer] of Object.entries(byKey)) {
    const pv = answer && typeof answer === "object" ? answer.prompt_versions : undefined;
    const setId = setIdOf(pv) ?? "(no provenance)";
    const scenario = scenarioOf(key.split("@")[0]);
    ((bySet[setId] ??= {})[scenario] ??= []).push(score(scenario, answer));
  }

  process.stdout.write("EVAL READ — recorded runs, scored, by prompt-version set then stickiness\n");
  for (const [setId, scenarios] of Object.entries(bySet)) {
    const note = setId === "(no provenance)"
      ? "  — pre-provenance runs; stickiness here MIXES versions, not a valid comparison"
      : "";
    process.stdout.write(`\nprompt set ${setId}${note}\n`);
    const rows = Object.entries(scenarios)
      .map(([scenario, results]) => ({ scenario, s: stickiness(results.map((r) => r.state)), results }))
      .sort((a, b) => rank(a.s.majority) - rank(b.s.majority));
    for (const { scenario, s, results } of rows) {
      const mark = s.stableGreen ? "✓" : s.stickyProblem ? "✗" : s.majority === "insufficient" ? "·" : "~";
      const counts = `${s.pass}✓ ${s.degraded}~ ${s.fail}✗ ${s.unknown}?`;
      const wrong = results.find((r) => r.state === "wrong");
      const detail = wrong ? `  got ${wrong.got} want ${wrong.expected}` : "";
      process.stdout.write(`  ${mark} ${scenario.padEnd(28)} ${String(s.majority).padEnd(12)} [${counts} of ${s.total}]${detail}\n`);
    }
    const problems = rows.filter((r) => r.s.stickyProblem).length;
    const thin = rows.filter((r) => r.s.majority === "insufficient").length;
    process.stdout.write(`  ${rows.length} scenarios · ${problems} sticky problem(s) · ${thin} below k=3.\n`);
  }
  process.stdout.write("\nTo compare a prompt change: --before <setId> --after <setId> (needs k>=3 attributed runs per set).\n");
}

function rank(majority) {
  return { fail: 0, degraded: 1, mixed: 2, unknown: 3, pass: 4 }[majority] ?? 5;
}

main();
