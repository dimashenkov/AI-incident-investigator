/**
 * The eval loop's judgement, kept pure so it is tested without a model or the disk.
 *
 * The owner's goal (2026-09-13): improve the agent. Grok set the honest protocol:
 * gpt-5 refuses temperature 0, so ONE run of a scenario is not a measurement —
 * sampling alone moves the answer. So a scenario is run k times (k>=3), and a
 * failure that repeats is STICKY (real) while a one-of-three is noise. A prompt
 * change is kept only if a sticky failure flips to green AND no stable-green
 * scenario regresses. This file computes stickiness and applies that keep-rule; it
 * takes ALREADY-SCORED states (from score-run.mjs), so it invents no scoring of its
 * own. No imports — same discipline as the other core files.
 */

/** score-run's per-attempt state, reduced to what the loop acts on. */
export type Grade = "pass" | "degraded" | "fail" | "unknown";

/**
 * Reduce a score-run state to a grade.
 *  - pass: "correct" — right code, cited, qualified.
 *  - degraded: right code but a quality gap worth fixing (uncited / unqualified).
 *  - fail: "wrong" — the wrong root cause.
 *  - unknown: not asked / not established — NOT counted as pass or fail.
 */
export function grade(state: string): Grade {
  if (state === "correct") return "pass";
  if (state === "correct-without-its-evidence" || state === "correct-but-unqualified") return "degraded";
  if (state === "wrong") return "fail";
  return "unknown";
}

/** The floor for a verdict. Below it, one sampling fluke reads as sticky, so a
 *  scenario with fewer attempts is "insufficient", not decided (Grok, 2026-09-13). */
export const MIN_K = 3;

export type Verdict = Grade | "mixed" | "insufficient";

export type Stickiness = {
  pass: number; degraded: number; fail: number; unknown: number; total: number;
  /** The grade holding a strict majority; "mixed" if none does; "insufficient" if
   *  fewer than MIN_K attempts were run. */
  majority: Verdict;
  /** True when the majority grade is bad (degraded or fail) — a sticky problem. */
  stickyProblem: boolean;
  /** True when the majority grade is pass — stable green. */
  stableGreen: boolean;
};

/**
 * Classify k attempts of ONE scenario. Fewer than MIN_K attempts → "insufficient"
 * (not decided): one wrong out of one is not a sticky failure, it is an unrun
 * experiment. At MIN_K or more, a strict majority (> half) of one grade is the
 * verdict; anything else is "mixed" — itself a signal that the scenario is not
 * reproducible. unknown attempts count toward the total, so a scenario answered once
 * in three does not masquerade as decided.
 */
export function stickiness(states: string[]): Stickiness {
  const g = states.map(grade);
  const c = { pass: 0, degraded: 0, fail: 0, unknown: 0 };
  for (const x of g) c[x] += 1;
  const total = g.length;
  let majority: Verdict = total < MIN_K ? "insufficient" : "mixed";
  if (total >= MIN_K) {
    for (const k of ["pass", "degraded", "fail", "unknown"] as Grade[]) {
      if (c[k] * 2 > total) { majority = k; break; }
    }
  }
  return {
    ...c, total, majority,
    stickyProblem: majority === "degraded" || majority === "fail",
    stableGreen: majority === "pass",
  };
}

/**
 * Quality rank of a verdict, so "worse" is well-defined. Grok, 2026-09-13: a STICKY
 * PROBLEM is worse than "not established" — a scenario that always fails is worse
 * than one that only sometimes does — so degraded and fail rank BELOW mixed/unknown/
 * insufficient, not above. That makes mixed->fail and mixed->degraded rank drops
 * (regressions), which the first ordering wrongly read as improvements.
 *   pass (4)  >  not-established: mixed/unknown/insufficient (3)  >  degraded (2)  >  fail (1)
 */
function rankOf(v: Verdict): number {
  return { pass: 4, mixed: 3, unknown: 3, insufficient: 3, degraded: 2, fail: 1 }[v] ?? 3;
}

export type KeepVerdict = {
  keep: boolean;
  flipped: string[];        // scenarios that went a sticky problem -> stable green
  regressed: string[];      // scenarios whose verdict got WORSE (incl. green -> mixed)
  unmeasuredGreens: string[]; // prior stable-greens not re-measured after the change
  why: string;
};

/**
 * The keep-rule, written before any edit (Grok, 2026-09-13, hardened after his
 * review). `before` and `after` map scenario -> Stickiness, each from MIN_K attempts
 * on the SAME frozen prompt set. Keep the change ONLY if:
 *   1. at least one sticky problem flipped to stable green, AND
 *   2. no re-measured scenario got worse — and "worse" includes a stable green
 *      falling to mixed/insufficient, and a degraded worsening to fail (rank drop),
 *      not only green->problem, AND
 *   3. every scenario that was stable green before was RE-MEASURED after — an
 *      unmeasured green may have been silently broken, so it blocks the keep.
 * "Different" is never "better": a change that fixes nothing, worsens anything, or
 * leaves a prior green unmeasured is rejected.
 */
export function keepRule(
  before: Record<string, Stickiness>,
  after: Record<string, Stickiness>,
): KeepVerdict {
  const flipped: string[] = [];
  const regressed: string[] = [];
  const unmeasuredGreens: string[] = [];
  for (const scenario of Object.keys(before)) {
    const b = before[scenario]!;
    const a = after[scenario];
    if (a === undefined) {
      if (b.stableGreen) unmeasuredGreens.push(scenario); // a green we can no longer vouch for
      continue;
    }
    if (b.stickyProblem && a.stableGreen) flipped.push(scenario);
    if (rankOf(a.majority) < rankOf(b.majority)) regressed.push(scenario);
  }
  const keep = flipped.length > 0 && regressed.length === 0 && unmeasuredGreens.length === 0;
  let why;
  if (keep) why = `keep: fixed ${flipped.join(", ")}, regressed nothing, every prior green re-measured`;
  else if (regressed.length > 0) why = `reject: regressed ${regressed.join(", ")}${flipped.length ? ` (even though it fixed ${flipped.join(", ")})` : ""}`;
  else if (unmeasuredGreens.length > 0) why = `reject: prior green(s) not re-measured, cannot vouch: ${unmeasuredGreens.join(", ")}`;
  else why = "reject: fixed no sticky problem — different, not better";
  return { keep, flipped, regressed, unmeasuredGreens, why };
}
