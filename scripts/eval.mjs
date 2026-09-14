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
import { score, scenarioOf, owningSlot, compareConfidences } from "./score-run.mjs";
// eval.ts is TypeScript; node's type-stripping runs it, and .ts imports resolve.
import { stickiness, keepRule, diagnose, attributeMisses, rollupMisses, keepPlan } from "../src/core/eval.ts";

/** Which prompt file an owning slot points at — so the rollup names WHAT to edit,
 *  not just which agent. An unattributed miss names no file. */
const SLOT_PROMPT = {
  kubernetes: "prompts/kubernetes-agent.md",
  logs: "prompts/logs-agent.md",
  metrics: "prompts/metrics-agent.md",
};

/** A short id for a WHOLE prompt-version set (all agents), so a comparison is
 *  between two frozen sets — not "any agent's hash matches", which mixes versions
 *  when only one agent changed (Grok, 2026-09-13). No provenance -> null. */
function setIdOf(promptVersions) {
  if (promptVersions === null || typeof promptVersions !== "object") return null;
  const stable = JSON.stringify(Object.keys(promptVersions).sort().map((k) => [k, promptVersions[k]]));
  return createHash("sha256").update(stable).digest("hex").slice(0, 12);
}

/** The model tag appended to a set's bucket id. A stickiness bucket must hold runs
 *  from ONE configuration; a `grok-*` fallback (proven, exec 415) is a DIFFERENT
 *  configuration from the primary `gpt-*` family and must not share a bucket with it
 *  (Grok, 2026-09-14: a model swap otherwise reads as a prompt effect).
 *
 *  It tags by the NON-primary models PRESENT, not by the full agent->model map: the
 *  recorded `model_by_agent` is unevenly populated (some runs list four agents, some
 *  one), so keying on the whole map would split the all-gpt-5 baseline `2c121d3550c3`
 *  into three buckets on data-quality noise and break its k=3 stickiness. Keying on
 *  "which non-gpt model appears" leaves every gpt-5 run — however many agents it
 *  recorded — in the primary bucket (empty tag), and isolates only a real fallback. */
function fallbackTag(modelByAgent) {
  if (modelByAgent === null || typeof modelByAgent !== "object") return "";
  const nonPrimary = [...new Set(
    Object.values(modelByAgent).filter((m) => typeof m === "string" && !m.startsWith("gpt-")),
  )].sort();
  return nonPrimary.length ? "·" + nonPrimary.join("+") : "";
}

/** The stickiness bucket for an answer: its frozen prompt set, plus a fallback tag so a
 *  `grok-*` run is separated from the primary `gpt-*` baseline. The primary bucket keeps
 *  the bare prompt-set id (empty tag), so the documented `2c121d3550c3` still resolves and
 *  `--before <id> --after <id>` compares clean gpt-5 runs only. No provenance -> null. */
function bucketOf(answer) {
  const pv = answer && typeof answer === "object" ? answer.prompt_versions : undefined;
  const base = setIdOf(pv);
  if (base === null) return null;
  return base + fallbackTag(answer && typeof answer === "object" ? answer.model_by_agent : undefined);
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

/** This bucket's members grouped BY SOURCE FILE, each file's answers keyed by their original
 *  scenario/attempt key. A file is one recorded execution, so `conflicting-evidence#N` and
 *  `container-oom#N` in it are the same run and the DoD-3 comparison pairs them file-scoped
 *  — never across files, which is exactly why readAllAnswers keeps the `@file` suffix. An
 *  earlier version stripped `@file` to key the whole bucket by attempt; that collapsed the
 *  eight bare `conflicting-evidence` answers spread across the no-provenance files into one
 *  (last write wins) and paired a stale comparable (Grok, 2026-09-14). Keys are unique within
 *  one file, so grouping by file and keeping the original key loses nothing. */
function filesForBucket(byKey, bucketId) {
  const files = {};
  for (const [key, answer] of Object.entries(byKey)) {
    if ((bucketOf(answer) ?? "(no provenance)") !== bucketId) continue;
    // The FIRST "@" is the separator: readAllAnswers builds `${origKey}@${file}` and an
    // origKey (scenario or scenario#N) never contains "@", so a filename that does contain
    // one still ends up wholly in `file` — lastIndexOf would have split it wrong (Grok, 2026-09-14).
    const at = key.indexOf("@");
    const origKey = at === -1 ? key : key.slice(0, at);
    const file = at === -1 ? "" : key.slice(at + 1);
    (files[file] ??= {})[origKey] = answer;
  }
  return files;
}

/** Score a bucket: each file scored as ONE run through compareConfidences, the corrected
 *  results aggregated and grouped by scenario. Bare `score()` returns `conflicting-evidence`
 *  "correct" without the `container-oom` reduction (DoD-3), so the keep-rule and the read
 *  both graded it in isolation — a prompt that fails the reduction could be kept green
 *  (Grok, 2026-09-14). Returns scenario -> scored results[] (compareConfidences-corrected). */
function scoredByScenario(files) {
  const out = {};
  for (const answersMap of Object.values(files)) {
    const results = compareConfidences(
      Object.keys(answersMap).sort().map((k) => score(k, answersMap[k])),
      answersMap,
    );
    for (const r of results) (out[scenarioOf(r.scenario)] ??= []).push(r);
  }
  return out;
}

/** The runs whose bucket (frozen prompt set + model configuration) matches `bucketId` — a
 *  comparison is between two frozen buckets, so a run counts only if every agent's prompt AND
 *  the model configuration match. Returns { stick: scenario->Stickiness, n: attempt count }. */
function statesForSet(byKey, bucketId) {
  const files = filesForBucket(byKey, bucketId);
  const byScenario = scoredByScenario(files);
  const stick = {};
  for (const [s, results] of Object.entries(byScenario)) stick[s] = stickiness(results.map((r) => r.state));
  const n = Object.values(files).reduce((a, m) => a + Object.keys(m).length, 0);
  return { stick, n };
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  const before = flag("--before");
  const after = flag("--after");
  const plan = argv.includes("--plan");

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

  // Group by BUCKET first (frozen prompt set + model configuration) — stickiness is only
  // honest within one frozen configuration. Mixing versions/eras, or a gpt-5 baseline with
  // a grok fallback, into one number is what Grok warned against. Each bucket is scored
  // through compareConfidences, so conflicting-evidence carries its DoD-3 reduction here too
  // — not only in the keep-rule path (the second carrier of the same defect).
  const bySet = {};
  for (const setId of new Set(Object.values(byKey).map((a) => bucketOf(a) ?? "(no provenance)"))) {
    bySet[setId] = scoredByScenario(filesForBucket(byKey, setId));
  }

  // --plan: BEFORE an edit, print what the keep-rule will demand of the next paid
  // run — the actual requirement, not a discounted subset (Grok's brick #5). Only
  // for versioned sets; a mixed (no-provenance) set cannot be a valid "before".
  if (plan) {
    process.stdout.write("EVAL PLAN — what a keepable edit will cost, per prompt-version set\n");
    let any = false;
    for (const [setId, scenarios] of Object.entries(bySet)) {
      if (setId === "(no provenance)") continue;
      any = true;
      const stick = {};
      for (const [scenario, results] of Object.entries(scenarios)) stick[scenario] = stickiness(results.map((r) => r.state));
      const p = keepPlan(stick);
      process.stdout.write(`\nprompt set ${setId}\n`);
      process.stdout.write(`  ${p.why}\n`);
      if (p.canImprove) {
        process.stdout.write(`  mandatory greens: ${p.greensToRemeasure.join(", ") || "(none)"}\n`);
        process.stdout.write(`  flip ≥1 of:       ${p.stickyToFlip.join(", ")}\n`);
        process.stdout.write(`  minimum ${p.minRuns} runs · all-sticky ${p.fullRuns} runs (k=3)\n`);
      }
    }
    if (!any) process.stdout.write("\nNo versioned set yet — produce a k>=3 baseline under one frozen prompt set first (that spends).\n");
    return;
  }

  process.stdout.write("EVAL READ — recorded runs, scored, by prompt-version set then stickiness\n");
  for (const [setId, scenarios] of Object.entries(bySet)) {
    const mixed = setId === "(no provenance)";
    const note = mixed
      ? "  — pre-provenance runs; stickiness here MIXES versions, not a valid comparison"
      : "";
    process.stdout.write(`\nprompt set ${setId}${note}\n`);
    const rows = Object.entries(scenarios)
      .map(([scenario, results]) => ({ scenario, s: stickiness(results.map((r) => r.state)), results }))
      .sort((a, b) => rank(a.s.majority) - rank(b.s.majority));
    // Attributions for THIS set only — the rollup below must never cross sets, or an
    // old era's misses would outweigh a new one's and point at a dead prompt (Grok,
    // 2026-09-13). So the tally is rebuilt per set, not accumulated across them.
    const attributionsByScenario = {};
    for (const { scenario, s, results } of rows) {
      const mark = s.stableGreen ? "✓" : s.stickyProblem ? "✗" : s.majority === "insufficient" ? "·" : "~";
      const counts = `${s.pass}✓ ${s.degraded}~ ${s.fail}✗ ${s.unknown}?`;
      process.stdout.write(`  ${mark} ${scenario.padEnd(28)} ${String(s.majority).padEnd(12)} [${counts} of ${s.total}]\n`);
      // Diagnosis is DETAIL under a non-green scenario — the axis of failure, so the
      // next prompt edit has a target. It never changes the verdict above (Grok,
      // 2026-09-13). A stable green with a clean sweep prints nothing extra.
      if (!s.stableGreen) {
        const d = diagnose(results);
        for (const line of d.lines) process.stdout.write(`      ↳ ${line}\n`);
        const attr = attributeMisses(d.missedCitations, (p) => owningSlot(scenario, p));
        for (const a of attr) {
          process.stdout.write(`      ↳ agent ${a.agent}: ${a.paths.map((p) => `${p.path} (×${p.count})`).join(", ")}\n`);
        }
        if (attr.length > 0) attributionsByScenario[scenario] = attr;
      }
    }
    const problems = rows.filter((r) => r.s.stickyProblem).length;
    const thin = rows.filter((r) => r.s.majority === "insufficient").length;
    process.stdout.write(`  ${rows.length} scenarios · ${problems} sticky problem(s) · ${thin} below k=3.\n`);

    // WHERE TO EDIT — this set's specialists ranked by missed citations, each with the
    // prompt file to open. A mixed (no-provenance) set is labelled NOT actionable:
    // its ranking blends eras, so it cannot say which live prompt to edit.
    const ranked = rollupMisses(attributionsByScenario);
    if (ranked.length > 0) {
      const caveat = mixed ? "  — MIXED ERAS, not a valid edit target (needs a versioned set)" : "";
      process.stdout.write(`  WHERE TO EDIT (this set)${caveat}\n`);
      for (const { agent, misses, scenarios: n } of ranked) {
        const file = SLOT_PROMPT[agent] ?? "(no prompt — path owned by no slot; check the fixture/must_cite)";
        process.stdout.write(`    ${agent.padEnd(16)} ${misses} miss(es) across ${n} scenario(s) → ${file}\n`);
      }
    }
  }
  process.stdout.write("\nTo compare a prompt change: --before <setId> --after <setId> (needs k>=3 attributed runs per set).\n");
}

function rank(majority) {
  return { fail: 0, degraded: 1, mixed: 2, unknown: 3, pass: 4 }[majority] ?? 5;
}

// The helpers are exported so the keep-rule and read paths can be tested with synthetic
// answers — without this, eval.mjs was CLI-only and the grading glue had no coverage, which
// is how the "green without the confidence comparison" defect (Grok, 2026-09-14) survived.
export { setIdOf, fallbackTag, bucketOf, filesForBucket, scoredByScenario, statesForSet };

// Run main() only when invoked directly, not when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
