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

/** One scored attempt, reduced to the fields diagnosis reads. score-run.mjs returns
 *  more; diagnose ignores the rest. */
export type ScoredAttempt = {
  state: string;
  expected?: string;
  got?: string;
  code?: string;
  why?: string | string[];  // score() returns a string for most states, a string[] for correct-but-unqualified
  missingCitations?: string[];
};

export type Diagnosis = {
  /** wrong-code confusions: which `got` stood in for `want`, and how often. */
  codeConfusion: Array<{ got: string; want: string; count: number }>;
  /** required citations that were missing, unioned across attempts, with counts. */
  missedCitations: Array<{ path: string; count: number }>;
  /** how many attempts landed on each soft-fail axis. */
  uncited: number;      // correct code, a required citation missing
  unqualified: number;  // correct code, confidence over the ceiling / unqualified refusal
  unresolved: number;   // could not be established (no answer, unresolvable citation)
  /** reasons per axis, each carrying ONLY its own (Grok, 2026-09-13: a shared list
   *  read positionally attributes one axis's reason to another). Deduped by value. */
  unqualifiedReasons: string[];
  unresolvedReasons: string[];
  /** both axes' reasons, for a caller that wants them together. */
  reasons: string[];
  /** ready-to-print diagnosis lines; empty when nothing is wrong. */
  lines: string[];
};

/**
 * Turn the k scored attempts of ONE scenario into a diagnosis of WHERE it fails —
 * the "read" the eval loop was missing (Grok, 2026-09-13): stickiness says a
 * scenario is a problem, diagnose says on which axis, so the next prompt edit has a
 * target instead of a guess.
 *
 * This is DETAIL, never a verdict. It deliberately does not re-tally a majority or
 * decide keep/reject — splitting k attempts across four axes would make every
 * scenario "insufficient" (Grok's warning). stickiness owns the verdict; diagnose
 * only describes the failures under it, and returns empty `lines` when every attempt
 * passed clean.
 */
export function diagnose(results: ScoredAttempt[]): Diagnosis {
  const confusion = new Map<string, number>();       // "got→want" -> count
  const citations = new Map<string, number>();        // path -> count
  let uncited = 0, unqualified = 0, unresolved = 0;
  const unqualifiedReasons: string[] = [];
  const unresolvedReasons: string[] = [];
  // score() returns `why` as a STRING for unasked/unestablished but as a STRING[]
  // for correct-but-unqualified (Grok, 2026-09-13). Normalise to a list, and dedup
  // by VALUE (a Set keyed on an array would never match two equal arrays), into the
  // axis's OWN list so no reason is attributed to the wrong axis.
  const addReasons = (list: string[], why?: string | string[]) => {
    const items = Array.isArray(why) ? why : why == null ? [] : [why];
    for (const w of items) if (w && !list.includes(w)) list.push(w);
  };

  for (const r of results) {
    if (r.state === "wrong") {
      const key = `${r.got ?? "(none)"}→${r.expected ?? "(unknown)"}`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
    } else if (r.state === "correct-without-its-evidence") {
      uncited += 1;
    } else if (r.state === "correct-but-unqualified") {
      unqualified += 1;
      addReasons(unqualifiedReasons, r.why);
    } else if (r.state === "unestablished" || r.state === "unasked") {
      unresolved += 1;
      addReasons(unresolvedReasons, r.why);
    }
    for (const c of r.missingCitations ?? []) citations.set(c, (citations.get(c) ?? 0) + 1);
  }

  const codeConfusion = [...confusion.entries()]
    .map(([k, count]) => { const [got, want] = k.split("→"); return { got: got!, want: want!, count }; })
    .sort((a, b) => b.count - a.count);
  const missedCitations = [...citations.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count);

  const lines: string[] = [];
  for (const c of codeConfusion) lines.push(`wrong ×${c.count}: got ${c.got}, want ${c.want}`);
  if (missedCitations.length > 0) {
    lines.push(`uncited: ${missedCitations.map((m) => `${m.path} (×${m.count})`).join(", ")}`);
  }
  // Each axis prints ITS OWN reason, not a positional guess into a shared list.
  if (unqualified > 0) lines.push(`unqualified ×${unqualified}${unqualifiedReasons.length ? `: ${unqualifiedReasons[0]}` : ""}`);
  if (unresolved > 0) lines.push(`unresolved ×${unresolved}${unresolvedReasons.length ? `: ${unresolvedReasons[0]}` : ""}`);
  const reasons = [...unqualifiedReasons, ...unresolvedReasons];
  return { codeConfusion, missedCitations, uncited, unqualified, unresolved, unqualifiedReasons, unresolvedReasons, reasons, lines };
}

export type AgentMiss = {
  agent: string;                                   // owning slot, or "(unattributed)"
  paths: Array<{ path: string; count: number }>;   // missed required paths, most-missed first
  total: number;                                   // total misses attributed to this agent
};

/**
 * Attribute missed required citations to the SPECIALIST that should have supplied
 * them — Grok's brick #2, 2026-09-13. `missedCitations` is diagnose()'s aggregated
 * {path,count} list for one scenario; `owningAgent` maps a required path to the slot
 * that owns it (from the fixtures, injected so this stays pure and testable). Groups
 * the misses by owning agent so the operator knows WHICH prompt to edit — the logs
 * agent's misses point at prompts/logs-agent.md, not "the agent". A path no slot
 * claims falls to "(unattributed)" and is shown, not hidden (the fixture oracle can
 * be incomplete, and silence would read as "attributed").
 */
export function attributeMisses(
  missedCitations: Array<{ path: string; count: number }>,
  owningAgent: (path: string) => string | null,
): AgentMiss[] {
  const byAgent = new Map<string, Map<string, number>>();
  for (const { path, count } of missedCitations) {
    const agent = owningAgent(path) ?? "(unattributed)";
    const paths = byAgent.get(agent) ?? new Map<string, number>();
    paths.set(path, (paths.get(path) ?? 0) + count);
    byAgent.set(agent, paths);
  }
  return [...byAgent.entries()]
    .map(([agent, paths]) => ({
      agent,
      paths: [...paths.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count),
      total: [...paths.values()].reduce((s, c) => s + c, 0),
    }))
    .sort((a, b) => b.total - a.total);
}

export type AgentRollup = { agent: string; misses: number; scenarios: number };

/**
 * Roll up one PROMPT-VERSION SET's per-scenario attributions into a ranked
 * "which specialist to edit" list. Grok, 2026-09-13: this must NEVER cross sets —
 * stickiness deliberately keeps versions apart, and summing an old era's misses with
 * a new one's points at a dead prompt. So it takes ONE set's attributions
 * ({scenario -> AgentMiss[]}) and nothing else; the caller invokes it per set.
 * `scenarios` counts DISTINCT scenarios an agent missed in, `misses` the total.
 */
export function rollupMisses(attributionsByScenario: Record<string, AgentMiss[]>): AgentRollup[] {
  const acc = new Map<string, { misses: number; scenarios: Set<string> }>();
  for (const [scenario, attrs] of Object.entries(attributionsByScenario)) {
    for (const a of attrs) {
      const e = acc.get(a.agent) ?? { misses: 0, scenarios: new Set<string>() };
      e.misses += a.total;
      e.scenarios.add(scenario);
      acc.set(a.agent, e);
    }
  }
  return [...acc.entries()]
    .map(([agent, e]) => ({ agent, misses: e.misses, scenarios: e.scenarios.size }))
    .sort((a, b) => b.misses - a.misses);
}

export type KeepPlan = {
  greensToRemeasure: string[];  // MANDATORY: every stable green, or the keep-rule blocks
  stickyToFlip: string[];       // TARGETS: the sticky problems; an edit must flip >=1
  minRuns: number;              // the floor: every green + ONE sticky target, at k
  fullRuns: number;             // re-measuring every green AND every sticky, at k
  canImprove: boolean;          // false when no sticky problem exists — nothing to flip
  why: string;
};

/**
 * What the keep-rule will DEMAND of the next paid run, printed BEFORE the edit so the
 * price is known first (Grok's brick #5, 2026-09-13; corrected after his review). It
 * is NOT a discounted subset AND it does not overstate: keepRule requires EVERY prior
 * green re-measured (an unmeasured green blocks the keep) plus AT LEAST ONE sticky
 * problem flipped — not every sticky re-measured. So the mandatory floor is
 * `greens + 1 sticky target` at k; re-measuring all sticky (fullRuns) shows more but
 * is not required to keep. When there is NO sticky problem, no edit can be kept
 * against this set — there is nothing to flip — said plainly, not papered over: the
 * honest next step is to surface a real failure first (extend the baseline).
 */
export function keepPlan(before: Record<string, Stickiness>, k: number = MIN_K): KeepPlan {
  const greensToRemeasure = Object.entries(before).filter(([, s]) => s.stableGreen).map(([n]) => n).sort();
  const stickyToFlip = Object.entries(before).filter(([, s]) => s.stickyProblem).map(([n]) => n).sort();
  const canImprove = stickyToFlip.length > 0;
  const minRuns = (greensToRemeasure.length + (canImprove ? 1 : 0)) * k;
  const fullRuns = (greensToRemeasure.length + stickyToFlip.length) * k;
  const why = canImprove
    ? `to KEEP an edit: re-measure EVERY green {${greensToRemeasure.join(", ") || "(none)"}} (mandatory) AND flip ≥1 of {${stickyToFlip.join(", ")}} with no regression — minimum k=${k} of ${greensToRemeasure.length} green(s) + 1 sticky target = ${minRuns} runs; re-measuring all ${stickyToFlip.length} sticky = ${fullRuns} runs`
    : `no sticky problem in this set — nothing to flip, so NO edit can be kept here (the keep-rule needs a fixed failure). Re-measuring the ${greensToRemeasure.length} green(s) alone cannot keep a change; surface a real failure first (extend the baseline)`;
  return { greensToRemeasure, stickyToFlip, minRuns, fullRuns, canImprove, why };
}
