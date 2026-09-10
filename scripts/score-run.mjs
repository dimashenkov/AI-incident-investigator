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

/**
 * The scenario a key names, with any attempt marker removed.
 *
 * A repeated measurement needs each attempt recorded separately — three
 * attempts written under one scenario name keep only the last, and the one
 * discarded is as likely as any to be the interesting one. The protocol said to
 * write `image-pull-failure#1`, `#2`, `#3` and I wrote that in the document and
 * not in the code: `scoreAll` enumerated directories and read `answers[s]`, so
 * every attempt key was silently ignored, and `score()` called with one
 * answered "has no expected.json". Codex found it on 2026-09-08, before the run
 * it would have wasted.
 *
 * `#` because no scenario directory can contain it, so the split cannot be
 * ambiguous.
 */
export function scenarioOf(key) {
  const at = String(key).indexOf("#");
  return at === -1 ? String(key) : String(key).slice(0, at);
}

/** The attempt a key names, or null when it names the scenario itself. */
export function attemptOf(key) {
  const at = String(key).indexOf("#");
  return at === -1 ? null : String(key).slice(at + 1);
}

export function expectedFor(scenario, root = SCENARIOS) {
  const path = join(root, scenarioOf(scenario), "expected.json");
  if (!existsSync(path)) return { state: "unknown", why: `${scenarioOf(scenario)} has no expected.json` };
  try {
    const e = JSON.parse(readFileSync(path, "utf8"));
    if (typeof e.root_cause_code !== "string") {
      return { state: "unknown", why: `${scenarioOf(scenario)}/expected.json names no root_cause_code` };
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
    // The comparable scenario, when this one's honesty is a COMPARISON rather
    // than a threshold. Absent means no comparison is asked for.
    const lessConfidentThan = typeof e.must_be_less_confident_than === "string"
      && e.must_be_less_confident_than.length > 0 ? e.must_be_less_confident_than : null;
    return { state: "known", code: e.root_cause_code, alsoAcceptable, maxConfidence, requiresDissent,
      lessConfidentThan,
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
/**
 * The ceiling a refusal may not exceed, read from the schema rather than restated.
 *
 * The schema says a refusal's confidence is at most 0.5; the scenario says the
 * answer's confidence is at most 0.6. Both are ceilings on the same number for
 * the same run, and they disagreed — so a hand-built refusal at 0.55 scored
 * `correct` here while the chain could never have produced that document. A
 * subagent found it on 2026-09-09.
 *
 * Reading it rather than copying it is what stops the two from drifting again.
 * If the schema stops saying it, that is `null` and only the scenario's ceiling
 * applies — an absent rule is not a rule of zero.
 */
export function refusalCeiling(schemaPath = new URL("../schemas/incident.schema.json", import.meta.url).pathname) {
  let doc;
  try { doc = JSON.parse(readFileSync(schemaPath, "utf8")); } catch { return null; }
  const found = [];
  const walk = (node) => {
    if (node === null || typeof node !== "object") return;
    if (!Array.isArray(node)) {
      const props = node.properties;
      if (props !== null && typeof props === "object") {
        const rc = props.root_cause_code;
        const conf = props.confidence;
        if (rc !== null && typeof rc === "object" && rc.const === "INSUFFICIENT_EVIDENCE"
          && conf !== null && typeof conf === "object" && typeof conf.maximum === "number") {
          found.push(conf.maximum);
        }
      }
    }
    for (const v of Array.isArray(node) ? node : Object.values(node)) walk(v);
  };
  walk(doc);
  return found.length === 0 ? null : Math.min(...found);
}

/**
 * A refusal that is held as firmly as a conclusion, reported rather than passed.
 *
 * Split out when the ceiling stopped being a single number: the scenario has
 * one and the schema has one, and both are about this same value.
 */
function scoreRefusalCeiling(answer, ceiling, unqualified) {
  const c = answer.incident?.analysis?.confidence;
  /*
   * A number that is not a number does not slip past the ceiling.
   *
   * The first version asked `typeof c === "number" && isFinite && c > max`, so
   * `"0.95"` as a string and Infinity walked through in silence — the same
   * `null > 0.6` shape this file already refuses on the other branch, written
   * again on the branch added a day later. Grok found it on 2026-09-08.
   *
   * Absent is still fine: a refusal that states no confidence is honest, and
   * that is the whole reason this is separate from the other branch.
   */
  if (c !== undefined && c !== null && (typeof c !== "number" || !Number.isFinite(c))) {
    unqualified.push(`it refused and stated a confidence of ${JSON.stringify(c)}, `
      + "which is not a number, so whether it is under the ceiling cannot be established");
  } else if (typeof c === "number" && Number.isFinite(c) && c > ceiling) {
    unqualified.push(`it refused and then stated confidence ${c}, above the ceiling of `
      + `${ceiling} — a refusal held that firmly is not a refusal`);
  }
}

export function score(scenario, answer, root = SCENARIOS) {
  const want = expectedFor(scenario, root);
  if (want.state !== "known") return { scenario, state: "unestablished", why: want.why };

  /*
   * Nobody asked, and nobody answering is not the same as answering nothing.
   *
   * Codex, 2026-09-08, reproducing the staged purchase: part 2 scores an
   * answers file that holds no readiness keys, so `scoreAll` writes a bare
   * `readiness-probe-failure: unestablished` — and `--add` merges it beside the
   * three correct attempts part 1 recorded, because the bare key carried no
   * verdict to protect. Six correct measurements read back as two unanswered
   * scenarios. The two cases were one word, so nothing downstream could tell
   * them apart: `unasked` is "this part did not ask", `unestablished` is "it
   * was asked and established nothing". Both are unknown, and only one of them
   * may be overwritten by anything at all.
   */
  if (answer === null || typeof answer !== "object") {
    return { scenario, state: "unasked", why: "no answer was recorded", expected: want.code };
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
  /*
   * A refusal is exempt from the ceiling — but not from stating a number that
   * contradicts it.
   *
   * The exemption was written because INSUFFICIENT_EVIDENCE already IS the
   * lowered answer, so demanding a low number asks it to doubt its own doubt.
   * That reasoning holds for a refusal that states no confidence, or states a
   * low one. It does not hold for a refusal at 0.95: a subagent scored exactly
   * that `correct` on 2026-09-08, before the run that would have paid for it —
   * and Definition of Done item 3 would have read as closed by a run in which
   * the confidence went UP. Item 3's claim is "confidence reduction under
   * conflicting evidence".
   *
   * So the ceiling is waived, and a HIGH number is still refused. The bound is
   * deliberately loose: a refusal may say anything up to the scenario's own
   * ceiling, which is the most a refusal could honestly claim.
   */
  if (refused) {
    /*
     * The stricter of the two ceilings, because both are about this number.
     */
    const fromSchema = refusalCeiling();
    const ceiling = want.maxConfidence === null ? fromSchema
      : fromSchema === null ? want.maxConfidence
        : Math.min(want.maxConfidence, fromSchema);
    if (ceiling !== null) scoreRefusalCeiling(answer, ceiling, unqualified);
  }
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
    /*
     * The source must be an agent that actually answered.
     *
     * Grok, 2026-09-08, on the half of this that was never changed: two
     * invented rows with two different `source` strings, one `for` and one
     * `against`, satisfy the pair. The shape was checked and the anchoring was
     * not — so "a different source disagreed" could be written by someone who
     * had not asked any source. What is checkable is that the name belongs to
     * an agent this incident recorded a result from; whether the dissent is
     * TRUE is still for a human, and is still not claimed.
     */
    const answered = new Set((Array.isArray(answer.incident?.analysis?.agents)
      ? answer.incident.analysis.agents : []).map((a) => a?.agent).filter((n) => typeof n === "string"));
    const shaped = ev.filter((e) => typeof e?.source === "string" && e.source.length > 0
      && typeof e?.fact === "string" && e.fact.length > 0
      && answered.has(e.source));
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

  /*
   * A citation only counts if it RESOLVES in the observation.
   *
   * `citationCovers` accepts a path at least as specific as the required one,
   * which is right for `series[0].points[3].value` covering
   * `series[0].points[3]` — and wrong for `series[0].points[3].value.nope`,
   * which is more specific and points at nothing. Grok scored exactly that
   * `correct` on 2026-09-08. The chain refuses an unresolvable ref from a
   * specialist, so this is unreachable through the deployed path today; the
   * scorer is also read by hand-built answer files, and this does not rely on a
   * guarantee made somewhere else.
   *
   * The bound is the DEPTH the required path names plus what the scenario asked
   * for: nothing deeper is needed to satisfy it, so nothing deeper is accepted.
   */
  /*
   * Nothing to resolve against is its own answer, and it is not success.
   *
   * The first version skipped resolution when the answer carried no
   * observations and then let the citation strings stand on their own. Codex
   * reproduced the consequence on 2026-09-08: an answer holding the expected
   * code and the two required path strings, with no observations and no facts,
   * scored `correct`. "I could not look" had been folded into "clean" — the
   * defect this repository names everywhere else.
   *
   * So it is the third state. A run whose citations cannot be resolved is
   * unestablished, with the reason said out loud, and it moves no counter that
   * a green result moves. A scenario that requires no citation is unaffected:
   * there is nothing to resolve, so nothing is claimed.
   */
  if (want.mustCite.length > 0 && !hasObservations(answer)) {
    return { scenario, state: "unestablished", expected: want.code,
      why: "it answered without carrying any observation, so no citation of it could be resolved" };
  }
  const cited = citedRefs(answer).filter((c) => resolvesForAgent(answer, c)).map((c) => c.ref);
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
/**
 * Does a citation point at something the incident actually holds?
 *
 * `citationCovers` accepts a path at least as specific as the required one —
 * right for `series[0].points[3].value` covering `series[0].points[3]`, and
 * wrong for `series[0].points[3].value.nope`, which is more specific and points
 * at nothing. Grok scored exactly that `correct` on 2026-09-08.
 *
 * Depth cannot separate the two: one leaf deeper than the requirement is
 * legitimate in the first case and invented in the second. What separates them
 * is whether the path RESOLVES, and the answer carries the incident, so the
 * scorer can look rather than reason about it.
 *
 * A citation is checked against the slot of the agent that reported it.
 *
 * The first version searched every slot, with a comment saying the scorer is
 * not told which agent reported the path. It is told: `citedPaths` walks
 * `analysis.agents`, and threw the name away one line later. Codex reproduced
 * the cost on 2026-09-08 — a readiness finding attributed to `kubernetes`, an
 * empty kubernetes slot, and both required paths sitting in `logs`, scored
 * `correct`. One agent was credited with what another one saw, which is the
 * same defect `recordAgentResult` refuses in the chain.
 *
 * An agent that is not one of the three collection slots — the synthesiser
 * that writes the root cause — is checked against every slot, because it is
 * reading all of them and has no slot of its own.
 */
/** The three slots an agent can be asked to read; anything else reads all of them. */
export const SCORE_SLOTS = ["kubernetes", "logs", "metrics"];

/** Is there any observation at all to resolve a citation against? */
export function hasObservations(answer) {
  const obs = answer?.incident?.observations;
  if (typeof obs !== "object" || obs === null) return false;
  return Object.values(obs).some((slot) => typeof slot === "object" && slot !== null);
}

export function resolvesInSomeSlot(answer, path) {
  const obs = answer?.incident?.observations;
  if (typeof obs !== "object" || obs === null) return false;
  return Object.values(obs).some((slot) => resolvesIn(slot, path));
}

/** Does the path resolve inside ONE slot? Own properties only, so `toString` is not a citation. */
export function resolvesIn(slot, path) {
  if (typeof slot !== "object" || slot === null) return false;
  let cur = slot;
  for (const seg of segments(path)) {
    if (cur === null || typeof cur !== "object"
      || !Object.prototype.hasOwnProperty.call(cur, seg)) return false;
    cur = cur[seg];
  }
  return true;
}

/** A path as segments, with `[0]` folded into the path so indexes compare. */
export function segments(p) {
  return String(p).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
}

export function citationCovers(required, got) {
  const split = segments;
  const want = split(required);
  const have = split(got);
  if (have.length < want.length) return false;
  return want.every((seg, i) => have[i] === seg);
}

export function citedPaths(answer) {
  return citedRefs(answer).map((c) => c.ref);
}

/** Every citation with the agent that reported it, which is what decides the slot. */
export function citedRefs(answer) {
  const agents = answer?.incident?.analysis?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((a) => (Array.isArray(a?.findings) ? a.findings : [])
    .map((f) => ({ agent: typeof a?.agent === "string" ? a.agent : null, ref: f?.source_ref })))
    .filter((c) => typeof c.ref === "string");
}

/**
 * Does this citation resolve where its own agent could have seen it?
 *
 * A named collection agent is held to its own slot. Anything else — the
 * synthesiser, or an agent whose name is missing — is held to the weaker rule
 * of resolving somewhere, which is still stronger than not resolving at all.
 */
export function resolvesForAgent(answer, cited) {
  const slot = answer?.incident?.observations?.[cited.agent];
  if (SCORE_SLOTS.includes(cited.agent)) {
    return resolvesIn(slot, cited.ref);
  }
  return resolvesInSomeSlot(answer, cited.ref);
}

/**
 * Every answer scored, including attempts.
 *
 * The scenarios on disk decide what MUST be answered — an absent one is
 * unestablished, which is the whole reason this enumerates directories rather
 * than keys. Attempt keys are then scored on top, so `image-pull-failure#2`
 * appears beside `image-pull-failure` instead of vanishing.
 */
export function scoreAll(answers, root = SCENARIOS) {
  const keys = Object.keys(answers ?? {});
  /*
   * `gathering` travels with the verdict, and is not part of it.
   *
   * The printer for the fourth axis was added before this line existed, so it
   * had nothing to print: half a fix that looked whole. Attached here, at the
   * one place every scored attempt passes through.
   */
  const extra = keys
    .filter((k) => attemptOf(k) !== null)
    .sort()
    .map((k) => ({ ...score(k, answers[k], root), gathering: gathering(answers[k]) }));
  /*
   * A scenario answered ONLY under numbered attempts was still answered.
   *
   * The first version always emitted the bare row, so eight successful `#1`
   * answers printed "8 correct, 8 not established, of 16" and the CLI exited 2
   * — a clean run reported as half unestablished, and readiness read the
   * synthetic row as a fourth attempt nobody had made. Codex measured it on
   * 2026-09-08.
   *
   * A bare answer that IS present is still scored beside its attempts: two
   * answers are two measurements, and only the absent one is synthetic.
   */
  const attempted = new Set(keys.filter((k) => attemptOf(k) !== null).map((k) => scenarioOf(k)));
  const scenarios = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  const bare = scenarios
    .filter((s) => Object.prototype.hasOwnProperty.call(answers ?? {}, s) || !attempted.has(s))
    .map((s) => score(s, answers?.[s] ?? null, root));
  return compareConfidences([...bare, ...extra], answers ?? {}, root);
}

/**
 * The comparison Definition-of-Done item 3 actually asks for.
 *
 * A scenario may declare `must_be_less_confident_than: "<other scenario>"`.
 * The ceiling alone does not establish a reduction: 55% here and 55% on the
 * comparable case satisfies `max_confidence` and is not a lowering of anything.
 * Grok showed on 2026-09-07 that this comparison lived only in the protocol's
 * prose, so the run could have come back green under an outcome the protocol
 * says does not close the item.
 *
 * A missing comparable answer makes the result UNQUALIFIED rather than correct:
 * a comparison nobody could make has not been made, and reporting it as clean
 * is the flattering reading.
 */
export function compareConfidences(results, answers, root = SCENARIOS) {
  const confidenceOf = (name) => {
    const a = answers?.[name];
    const c = a?.incident?.analysis?.confidence;
    return typeof c === "number" && Number.isFinite(c) ? c : null;
  };

  return results.map((r) => {
    if (r.state !== "correct") return r;
    const want = expectedFor(scenarioOf(r.scenario), root);
    const other = want.state === "known" ? want.lessConfidentThan : null;
    if (other === null || other === undefined) return r;

    const mine = confidenceOf(r.scenario);
    const theirs = confidenceOf(other);
    /*
     * A refusal has no confidence to compare, and it is an accepted answer for
     * exactly this scenario — so the comparison does not apply to it.
     */
    if (r.code === "INSUFFICIENT_EVIDENCE") return r;

    if (mine === null || theirs === null) {
      return { ...r, state: "correct-but-unqualified",
        why: [`the confidence here cannot be compared with ${other}: `
          + `${mine === null ? "this run states none" : `${other} was not answered in this run`}`] };
    }
    if (!(mine < theirs)) {
      return { ...r, state: "correct-but-unqualified",
        why: [`confidence ${mine} is not lower than ${other}'s ${theirs}; `
          + "the same number on a contradicted case and a clean one is not a reduction"] };
    }
    return r;
  });
}

/**
 * The slots that did NOT come back collected, from a recorded answer.
 *
 * The fourth axis of docs/measurement-contract.md. A right code reached from
 * two slices, because the third was never gathered, is a different result from
 * a right code reached from three — and the verdict line does not say which.
 * It is reported beside the verdict, never folded into it: this does not change
 * whether an answer is correct, it says what the answer was reached from.
 */
export function gathering(answer) {
  const c = answer?.incident?.collection;
  if (c === null || typeof c !== "object" || Array.isArray(c)) return [];
  const out = [];
  for (const [slot, raw] of Object.entries(c)) {
    if (raw === null || typeof raw !== "object") continue;
    const state = raw.state;
    if (state === "collected") continue;
    out.push(state === "failed"
      ? `${slot} failed: ${typeof raw.reason === "string" ? raw.reason : "no reason recorded"}`
      : `${slot} ${state === "nothing" ? "held nothing" : `was ${String(state)}`}`);
  }
  return out;
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
    } else if (r.state === "unasked") {
      // Printed apart because the record keeps them apart: nobody asking is not
      // the same failure as asking and settling nothing.
      lines.push(`  NOT ASKED      ${r.scenario} — ${r.why}`);
    } else {
      lines.push(`  UNESTABLISHED  ${r.scenario} — ${r.why}`);
    }
  }
  const correct = results.filter((r) => r.state === "correct").length;
  const ungrounded = results.filter((r) => r.state === "correct-without-its-evidence").length;
  const unqualified = results.filter((r) => r.state === "correct-but-unqualified").length;
  const wrong = results.filter((r) => r.state === "wrong").length;
  const unestablished = results.filter((r) => r.state === "unestablished" || r.state === "unasked").length;
  lines.push("", `  ${correct} correct, ${ungrounded} right code on other ground, ` +
    `${unqualified} right code held wrongly, ${wrong} wrong, ` +
    `${unestablished} not established, of ${results.length}`);
  const partial = results.filter((r) => Array.isArray(r.gathering) && r.gathering.length > 0);
  if (partial.length > 0) {
    lines.push("", "  WHAT THE ANSWERS WERE REACHED FROM — not a verdict, and not folded into one:");
    for (const r of partial) lines.push(`    ${r.scenario}: ${r.gathering.join("; ")}`);
  }
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
export function recordInto(recordPath, results, { replace = false, add = false } = {}) {
  const rec = JSON.parse(readFileSync(recordPath, "utf8"));

  /*
   * Two refusals, both measured by a subagent on 2026-09-07.
   *
   * A verdict already written is not overwritten by accident. Running the
   * scorer against a different answers file replaced a real result with one
   * derived from `{}` — every scenario `unestablished`, exit 2, no warning, and
   * the record then contradicted its own prose. `replace: true` is how a caller
   * says it meant to.
   *
   * And a full map of `unestablished` is not a measurement. `scoreAll`
   * enumerates every scenario directory whatever the answers hold, so an empty
   * answers file produces eight keys rather than an obviously truncated map —
   * and `someRunWasScored` in the gate accepts any non-empty `scored`, so those
   * eight would flip promised checks from waiting to due on the strength of a
   * run that established nothing.
   */
  const established = results.filter((r) => r.state !== "unestablished" && r.state !== "unasked");
  if (established.length === 0) {
    throw new Error(`refusing to record scores into ${recordPath}: every scenario came back `
      + "unestablished, which is a run that answered nothing rather than a measurement");
  }

  const before = rec.scored;
  const hasVerdict = before !== null && typeof before === "object" && !Array.isArray(before)
    && Object.keys(before).length > 0;

  /*
   * A run bought in parts arrives in parts, and one record has to hold them.
   *
   * Grok, 2026-09-08: `latestScored` returns a SINGLE record, so a second file
   * sends the scenarios of the first part back to unestablished — but writing
   * the second part over the first with `--replace` orphans it just as
   * completely, and waiting until the end means hand-entering what the last
   * section of the protocol forbids. So there is a third door, and it is narrow
   * on purpose: `--add` may fill a key that says nothing yet, and may rewrite a
   * key with the SAME verdict, and may not turn one established verdict into a
   * different one. Changing a verdict that was already established is what
   * `--replace` is for, and it still asks the caller to say why.
   */
  if (hasVerdict && add && !replace) {
    /*
     * How much a value says, so a later part cannot say less over it.
     *
     * `unasked` says nothing at all, `unestablished` says it was asked and
     * settled nothing, and anything else is a verdict. A part may raise what a
     * key says and may repeat it; it may not lower it, and two different
     * verdicts for one key are a conflict rather than an update.
     */
    const SAYS = { unasked: 0, unestablished: 1 };
    const says = (v) => (typeof v === "string" ? (SAYS[v] ?? 2) : -1);
    const conflicts = results.filter((r) =>
      says(before[r.scenario]) === 2 && says(r.state) === 2 && before[r.scenario] !== r.state);
    if (conflicts.length > 0) {
      throw new Error(`${recordPath} already scores ${conflicts.map((c) => c.scenario).join(", ")} `
        + "differently. Pass --replace to change a verdict, and say why the first one was wrong");
    }
    const arriving = results.filter((r) => says(r.state) >= says(before[r.scenario]));
    rec.scored = { ...before, ...Object.fromEntries(arriving.map((r) => [r.scenario, r.state])) };
    writeFileSync(recordPath, `${JSON.stringify(rec, null, 2)}\n`);
    return rec.scored;
  }

  if (hasVerdict && !replace) {
    throw new Error(`${recordPath} already carries scores. Pass --replace to overwrite them, `
      + "and say in the record why the first ones were wrong");
  }

  rec.scored = Object.fromEntries(results.map((r) => [r.scenario, r.state]));
  writeFileSync(recordPath, `${JSON.stringify(rec, null, 2)}\n`);
  return rec.scored;
}

/**
 * The four exit codes, as a function rather than as an expression inside main.
 *
 * Nothing spawned this script, so the only thing that read the exit code was a
 * person. A subagent measured the consequence on 2026-09-09: dropping
 * `correct-but-unqualified` from the failure side left every test green while a
 * paid run whose right code was held above the ceiling exited 0 — reported as
 * clean by the number CI reads.
 *
 * `0` clean, `1` something is wrong, `2` something could not be established,
 * `3` both. The same four the gate uses, and for the same reason: a person
 * reads the report, a machine reads only this.
 */
export function exitCodeFor(results) {
  const failed = results.some((r) => r.state === "wrong" || r.state === "correct-without-its-evidence"
    || r.state === "correct-but-unqualified");
  const unknown = results.some((r) => r.state === "unestablished" || r.state === "unasked");
  return (failed ? 1 : 0) + (unknown ? 2 : 0);
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
    try {
      recordInto(target, results, { replace: process.argv.includes("--replace"),
        add: process.argv.includes("--add") });
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    }
    process.stdout.write(`  recorded ${results.length} scores into ${target}\n\n`);
  }
  // Wrong is a failure; not established is not the same failure.
  // The right code on other ground is not a clean result and does not exit 0.
  process.exit(exitCodeFor(results));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
