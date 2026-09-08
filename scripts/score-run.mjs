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
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
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
    /*
     * Three optional qualifications, added 2026-09-07 for the conflicting
     * evidence scenario. Each is absent by default and absence means NO
     * requirement — never a requirement of zero. `maxConfidence: null` is the
     * whole point: a scenario without a ceiling must behave exactly as it did
     * before these fields existed, and reading a missing field as 0 would fail
     * every clean scenario at once while looking like a stricter check.
     *
     * Each is also type-checked rather than truthiness-checked. `max_confidence: 0`
     * is a real ceiling and must not be discarded as falsy; `also_acceptable: "X"`
     * is a mistake and must not be iterated as a string of characters.
     */
    const alsoAcceptable = Array.isArray(e.also_acceptable)
      ? e.also_acceptable.filter((c) => typeof c === "string") : [];
    const maxConfidence = typeof e.max_confidence === "number" && Number.isFinite(e.max_confidence)
      ? e.max_confidence : null;
    const requiresDissent = e.requires_dissent === true;
    return { state: "known", code: e.root_cause_code, alsoAcceptable, maxConfidence, requiresDissent,
      mustCite: Array.isArray(e.must_cite) ? e.must_cite : [] };
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
  const acceptable = got === want.code || want.alsoAcceptable.includes(got);
  if (!acceptable) {
    return { scenario, state: "wrong", expected: want.code, got: got ?? "(none)" };
  }

  /*
   * The right code, and whether it rests on what the scenario was built around.
   *
   * Grok, 2026-09-06: reporting must_cite without letting it change the verdict
   * is "a field that cannot fail the run is a comment", and report-without-score
   * is exactly how "three of five concluded" came to be called a success one
   * field over. He is right that it was quietly weakened.
   *
   * But scoring a missing citation as WRONG would be this file inventing a rule
   * — the code is right, and expected.json's note says must_cite is what a
   * human should look for. So it is a fourth answer with its own name, which
   * cannot hide inside "correct" and cannot be quoted as a clean result.
   */
  /*
   * The paths live in the agents' findings, not in analysis.evidence.
   *
   * The first version compared must_cite against evidence[].source, which holds
   * the AGENT NAME — "kubernetes", not a path. Nothing could ever match, so
   * every correct answer was reported as resting on other ground, and the new
   * state would have been noise from its first day. Caught by looking at one
   * recorded answer instead of trusting the field name.
   */
  /*
   * The qualifications, checked before the citations because a conclusion held
   * too confidently is wrong about something the citations cannot fix.
   *
   * A refusal is exempt from BOTH qualifications, and for one reason rather than
   * two: they are asked of a conclusion, and a refusal is the absence of one.
   * INSUFFICIENT_EVIDENCE already IS the lowered answer, so a ceiling asks it to
   * doubt its own doubt; and `supports: "against"` is stated relative to a
   * conclusion, so demanding dissent from a run that reached none is asking what
   * the field cannot express. must_cite still applies — refusing does not excuse
   * a run from showing what it looked at — and so does a weaker form of the
   * dissent rule, written below: a refusal must state SOME evidence.
   */
  const unqualified = [];
  const refused = got === "INSUFFICIENT_EVIDENCE";
  if (want.maxConfidence !== null && !refused) {
    const c = answer.incident?.analysis?.confidence;
    /*
     * Written as "not a number, or above the ceiling" rather than "above the
     * ceiling". `null > 0.6` is false in JavaScript, so a missing confidence
     * would have SATISFIED a ceiling it never met — the absence reading as
     * consent, in the one place the whole scenario turns on a number.
     */
    if (typeof c !== "number" || !Number.isFinite(c)) {
      unqualified.push(`it states no confidence, so the ceiling of ${want.maxConfidence} cannot be met`);
    } else if (c > want.maxConfidence) {
      unqualified.push(`confidence ${c} is above the ceiling of ${want.maxConfidence} this scenario requires`);
    }
  }
  /*
   * Dissent, checked as evidence rather than as a flag.
   *
   * Grok, 2026-09-07: the first version counted `supports === "against"` and
   * nothing else, so `{ supports: "against" }` — no source, no fact, no relation
   * to the contradiction the scenario is about — lifted the verdict from
   * correct-but-unqualified to correct. Anyone who knows the field name passes.
   * That is the same defect as a field that cannot fail a run, one level in.
   *
   * Two things are checkable here and a third is not. Checkable: the item is
   * SHAPED like evidence — a source and a fact, both non-empty strings — and it
   * comes from a DIFFERENT source than what supports the conclusion, because a
   * contradiction raised by the same slot that supports the answer is not the
   * conflict this scenario poses. Not checkable, and not claimed: whether the
   * dissent is TRUE. A human reads the thread for that.
   */
  if (want.requiresDissent) {
    const ev = Array.isArray(answer.incident?.analysis?.evidence) ? answer.incident.analysis.evidence : [];
    const shaped = ev.filter((e) => typeof e?.source === "string" && e.source.length > 0
      && typeof e?.fact === "string" && e.fact.length > 0);
    if (refused) {
      /*
       * A refusal has no conclusion, so `against` has nothing to point away
       * from — but it still has to have looked. An empty evidence list on a
       * refusal is indistinguishable from a run that never noticed the
       * contradiction, which Codex reached by calling score() directly on
       * 2026-09-07 and getting `correct` back.
       */
      /*
       * For a refusal, "did it look" is answered by the AGENTS' findings, not
       * by analysis.evidence.
       *
       * Every entry of `evidence` must say whether it supports or contradicts
       * the conclusion, and a refusal reached none — so merge.ts writes an
       * empty list ON PURPOSE, with the reasoning spelled out where it does it.
       * This branch then read that deliberate emptiness as "nothing shows it
       * saw the contradiction", and both answers the scenario declares honest
       * scored unqualified. A subagent measured it on 2026-09-07: no model
       * output could have made conflicting-evidence come back green, so a paid
       * run of the one scenario that can close Definition of Done item 3 was
       * unwinnable before it started.
       *
       * What a refusal must show is that it read something. The findings are
       * where reading is recorded, and must_cite already checks WHICH ones.
       */
      const looked = citedPaths(answer).length > 0 || shaped.length > 0;
      if (!looked) {
        unqualified.push("it refused while citing nothing at all, so nothing shows it looked");
      }
    } else {
      /*
       * A PAIR from different sources, not a property of the against items.
       *
       * Codex, 2026-09-07, reproducing both errors of the first version: it
       * skipped the source comparison entirely when no `for` item existed, so
       * an answer with dissent and no support at all scored correct; and it
       * asked whether EVERY dissent shared a source with the support, so a
       * metrics agent that contributed one supporting fact alongside its
       * contradiction turned a valid answer unqualified. Both come from asking
       * about the items separately. The conflict is a relation: some source
       * says yes and a different source says no, and that is what is checked.
       */
      const against = shaped.filter((e) => e.supports === "against");
      const supporting = shaped.filter((e) => e.supports === "for");
      if (against.length === 0) {
        unqualified.push("no evidence points against the conclusion, so nothing was weighed");
      } else if (supporting.length === 0) {
        unqualified.push("nothing supports the conclusion it reached, so there is no conflict to weigh");
      } else if (!against.some((a) => supporting.some((f) => f.source !== a.source))) {
        unqualified.push("every dissent comes from the same source as the support, which is not the conflict this scenario poses");
      }
    }
  }
  if (unqualified.length > 0) {
    return { scenario, state: "correct-but-unqualified", code: got, why: unqualified };
  }

  const cited = citedPaths(answer);
  const missing = want.mustCite.filter((c) => !cited.some((got) => citationCovers(c, got)));
  if (missing.length > 0) {
    return { scenario, state: "correct-without-its-evidence", code: got, missingCitations: missing };
  }
  return { scenario, state: "correct", code: got, missingCitations: [] };
}

/**
 * Every source_ref any agent reported, which is where a path can actually be.
 *
 * `analysis.evidence` names which AGENT a fact came from; the path is on the
 * finding. Both are needed to trace a conclusion, and only one of them is a
 * citation in the sense must_cite means.
 */
/**
 * Does a citation satisfy a required path?
 *
 * Exactly, or by being MORE specific. `series[0].points[3].value` cites
 * `series[0].points[3]` — it names the same point and says which field of it.
 * The reverse does not hold: `pods[0]` does not cite `pods[0].phase`.
 *
 * Written 2026-09-07, when a subagent showed the prompts and the fixtures had
 * drifted into two spellings of one idea. metrics-agent.md shows
 * `series[0].points[3]` three times as the canonical form; conflicting-evidence
 * demands `series[0].points[3].value` and cpu-throttling demands
 * `series[0].points[3]`. An obedient model could satisfy one scenario and fail
 * the other with the identical, correct answer.
 *
 * Compared SEGMENT by segment rather than as a string prefix, because
 * `series[0].points[30]` starts with `series[0].points[3]` and is a different
 * point entirely.
 */
export function citationCovers(required, got) {
  const split = (p) => String(p).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  const want = split(required);
  const have = split(got);
  if (have.length < want.length) return false;
  return want.every((seg, i) => have[i] === seg);
}

export function citedPaths(answer) {
  const agents = answer?.incident?.analysis?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((a) => (Array.isArray(a?.findings) ? a.findings : []).map((f) => f?.source_ref))
    .filter((r) => typeof r === "string");
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
      lines.push(`  CORRECT        ${r.scenario} → ${r.code}`);
    } else if (r.state === "correct-without-its-evidence") {
      lines.push(`  RIGHT CODE,    ${r.scenario} → ${r.code}`);
      lines.push(`  WRONG GROUND     it never cited ${r.missingCitations.join(", ")}, which is what this scenario was built around`);
    } else if (r.state === "correct-but-unqualified") {
      lines.push(`  RIGHT CODE,    ${r.scenario} → ${r.code}`);
      for (const w of r.why) lines.push(`  UNQUALIFIED      ${w}`);
    } else if (r.state === "wrong") {
      lines.push(`  WRONG          ${r.scenario} → ${r.got}, expected ${r.expected}`);
    } else {
      lines.push(`  UNESTABLISHED  ${r.scenario} — ${r.why}`);
    }
  }
  const correct = results.filter((r) => r.state === "correct").length;
  const ungrounded = results.filter((r) => r.state === "correct-without-its-evidence").length;
  const unqualified = results.filter((r) => r.state === "correct-but-unqualified").length;
  const wrong = results.filter((r) => r.state === "wrong").length;
  const unestablished = results.filter((r) => r.state === "unestablished").length;
  lines.push("", `  ${correct} correct, ${ungrounded} right code on other ground, ` +
    `${unqualified} right code held wrongly, ${wrong} wrong, ` +
    `${unestablished} not established, of ${results.length}`);
  lines.push("", "  Concluding and being right are different things. A run that did not conclude is",
    "  not a wrong answer — it gave none.", "");
  return lines.join("\n");
}

/**
 * Write the scored result into a run record, so a later reader does not have to
 * take somebody's prose for it.
 *
 * The run records held their outcome as a sentence written for a human. A
 * sentence is not something a machine may count, so scripts/readiness.mjs
 * reported every scenario as unestablished — correctly, and uselessly. This is
 * the fix at the source: the scorer writes what it decided, at the moment it
 * decides it, next to the cost of the run that produced it.
 */
export function recordInto(recordPath, results) {
  const rec = JSON.parse(readFileSync(recordPath, "utf8"));
  rec.scored = Object.fromEntries(results.map((r) => [r.scenario, r.state]));
  writeFileSync(recordPath, `${JSON.stringify(rec, null, 2)}\n`);
  return rec.scored;
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

  const at = process.argv.indexOf("--record");
  if (at !== -1) {
    const target = process.argv[at + 1];
    if (target === undefined) {
      process.stderr.write("--record needs the path of a run record in docs/runs/\n");
      process.exit(2);
    }
    recordInto(target, results);
    process.stdout.write(`  recorded ${results.length} scores into ${target}\n\n`);
  }
  // Wrong is a failure; not established is not the same failure.
  // The right code on other ground is not a clean result and does not exit 0.
  process.exit((results.some((r) => r.state === "wrong" || r.state === "correct-without-its-evidence"
    || r.state === "correct-but-unqualified") ? 1 : 0) +
    (results.some((r) => r.state === "unestablished") ? 2 : 0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
