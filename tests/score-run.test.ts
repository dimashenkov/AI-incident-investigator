/**
 * Concluding and being right are different things.
 *
 * On 2026-09-06 I reported "three of five concluded" as a success. One of the
 * three answered INSUFFICIENT_EVIDENCE where its expected.json says
 * CPU_THROTTLING — a wrong answer counted as a win, because nothing compared
 * the two and the only thing between them was somebody reading both files.
 */
import { describe, it, expect } from "vitest";
import { SLOTS } from "../src/providers/fixtures.js";
import { MERGE_SLOTS } from "../src/core/merge.js";
// @ts-expect-error — plain .mjs, the same file node runs.
import { AGENT_ORDER } from "../scripts/workflow-runtime.mjs";
import { readdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error - plain .mjs script, no types
import { SCORE_SLOTS, score, scoreAll, expectedFor, format, citationCovers, recordInto, scenarioOf, attemptOf, compareConfidences, resolvesInSomeSlot, refusalCeiling, exitCodeFor } from "../scripts/score-run.mjs";

const SCENARIOS = new URL("../scenarios/", import.meta.url).pathname;
/**
 * A concluded answer, with the paths its agents reported.
 *
 * The paths live on the agents' findings. The first version of the scorer read
 * analysis.evidence[].source, which holds the agent NAME — so nothing could
 * ever match must_cite and the citation verdict was noise. Caught by looking at
 * a recorded answer instead of trusting a field name.
 */
const SLOT_OF: Record<string, string> = {
  pods: "kubernetes", events: "kubernetes", deployment: "kubernetes",
  lines: "logs", series: "metrics",
};

/** A path as segments, `[0]` folded in, the same reading the scorer uses. */
const segs = (p: string) => p.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);

/**
 * Build an observation that actually holds these paths.
 *
 * A fixture that cites a path its incident does not carry is the run the
 * scorer must refuse — so the honest fixture has to carry them, or every test
 * here would be measuring the refusal instead of the thing it names.
 */
const materialise = (refs: string[]) => {
  const obs: Record<string, any> = {};
  for (const ref of refs) {
    const path = segs(ref);
    const slot = SLOT_OF[path[0]!] ?? "logs";
    obs[slot] ??= {};
    let cur: any = obs[slot];
    for (let i = 0; i < path.length; i++) {
      const here = path[i]!;
      const key: any = /^\d+$/.test(here) ? Number(here) : here;
      if (i === path.length - 1) { cur[key] ??= "seen"; break; }
      const nextIsIndex = /^\d+$/.test(path[i + 1]!);
      cur[key] ??= nextIsIndex ? [] : {};
      cur = cur[key];
    }
  }
  return obs;
};

/** Which agent could honestly have cited each path — its own slot, never another's. */
const agentsFor = (cited: string[]) => {
  const by = new Map<string, string[]>();
  for (const r of cited) {
    const slot = SLOT_OF[segs(r)[0]!] ?? "logs";
    by.set(slot, [...(by.get(slot) ?? []), r]);
  }
  if (by.size === 0) return [{ agent: "kubernetes", findings: [] as unknown[] }];
  return [...by.entries()].map(([agent, refs]) =>
    ({ agent, findings: refs.map((r) => ({ fact: "f", source_ref: r })) }));
};

const concluded = (code: string, cited: string[] = []) => ({
  state: "concluded",
  root_cause_code: code,
  incident: {
    observations: { kubernetes: {}, logs: {}, metrics: {}, ...materialise(cited) },
    analysis: { agents: agentsFor(cited) },
  },
});

const mustCiteOf = (scenario: string): string[] => expectedFor(scenario, SCENARIOS).mustCite;

/**
 * The same answer, plus the two things a conflicting scenario is scored on:
 * how sure it says it is, and whether anything in its evidence argues back.
 */
const qualified = (code: string, cited: string[], confidence: unknown, against: number) => {
  const a = concluded(code, cited) as Record<string, any>;
  a.incident.analysis.confidence = confidence;
  a.incident.analysis.evidence = [
    { source: "kubernetes", fact: "the container was OOMKilled", supports: "for" },
    ...Array.from({ length: against }, () => ({
      source: "metrics", fact: "memory never approached the limit", supports: "against",
    })),
  ];
  // Evidence names an agent, and an agent that never answered cannot have
  // dissented — so a fixture that wants the pair weighed has to have asked both.
  for (const name of ["kubernetes", "metrics"]) {
    if (!a.incident.analysis.agents.some((g: any) => g.agent === name)) {
      a.incident.analysis.agents.push({ agent: name, findings: [] });
    }
  }
  return a;
};

/** An answer whose evidence list is exactly what is passed, warts and all. */
const withEvidence = (code: string, cited: string[], confidence: unknown, evidence: unknown[]) => {
  const a = concluded(code, cited) as Record<string, any>;
  a.incident.analysis.confidence = confidence;
  a.incident.analysis.evidence = evidence;
  return a;
};

describe("scoring a run against what the scenario is for", () => {
  it("knows what every scenario on disk expects", () => {
    // A scenario with no expected answer cannot be scored, and a run over it
    // would look green for having no opinion about it.
    const names = readdirSync(SCENARIOS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(names.length, "no scenarios; this test would pass on nothing").toBeGreaterThan(0);
    for (const n of names) {
      const e = expectedFor(n, SCENARIOS);
      expect(e.state, `${n}: ${e.why ?? ""}`).toBe("known");
      expect(e.code).toMatch(/^[A-Z_]+$/);
    }
  });

  it("calls the right code correct and the wrong code wrong", () => {
    expect(score("cpu-throttling", concluded("CPU_THROTTLING", mustCiteOf("cpu-throttling")), SCENARIOS).state).toBe("correct");
    const bad = score("cpu-throttling", concluded("INSUFFICIENT_EVIDENCE"), SCENARIOS);
    expect(bad.state).toBe("wrong");
    expect(bad.expected).toBe("CPU_THROTTLING");
    expect(bad.got).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("keeps a run that gave no answer apart from one that gave a wrong answer", () => {
    /*
     * The distinction the whole file exists for. A refused run is a broken
     * chain; a wrong code is a bad diagnosis. Folding them together makes a
     * routing bug look like a model that cannot think.
     */
    for (const answer of [
      { state: "refused", reason: "the incident carries 0 root cause results" },
      { state: "recorded" },
      null,
      undefined,
    ]) {
      const r = score("container-oom", answer, SCENARIOS);
      // A chain that ran and did not conclude is unestablished; nothing on
      // disk at all is `unasked`, which the record has to keep apart so a
      // later part cannot write it over an earlier part's verdict.
      const expectState = answer === null || answer === undefined ? "unasked" : "unestablished";
      expect(r.state, `${JSON.stringify(answer)} was scored as an answer`).toBe(expectState);
      expect(r.got, "a run that established nothing must carry no answer to compare").toBeUndefined();
    }
  });

  it("keeps the right code on other ground apart from the right code on its own", () => {
    /*
     * Grok, 2026-09-06: reporting must_cite without letting it change the
     * verdict makes it "a field that cannot fail the run", which is a comment.
     * Scoring it WRONG would invent a rule — the code is right. So it is a
     * fourth answer with its own name, which cannot hide inside "correct".
     */
    const needed = mustCiteOf("cpu-throttling");
    expect(needed.length, "the fixture lists citations, so this is not vacuous").toBeGreaterThan(0);

    const grounded = score("cpu-throttling", concluded("CPU_THROTTLING", needed), SCENARIOS);
    expect(grounded.state).toBe("correct");
    expect(grounded.missingCitations).toEqual([]);

    const ungrounded = score("cpu-throttling", concluded("CPU_THROTTLING", []), SCENARIOS);
    expect(ungrounded.state).toBe("correct-without-its-evidence");
    expect(ungrounded.missingCitations).toEqual(needed);
  });

  it("reads the citations from the agents' findings, not from the evidence list", () => {
    // analysis.evidence names which AGENT a fact came from; the path is on the
    // finding. Comparing must_cite against the agent name matches nothing, and
    // the verdict becomes noise that always says the same thing.
    const needed = mustCiteOf("cpu-throttling");
    const held = { observations: materialise(needed), analysis: { agents: [] } };
    const wrongPlace = { state: "concluded", root_cause_code: "CPU_THROTTLING",
      incident: held,
      evidence: needed.map((r) => ({ source: r, fact: "f", supports: "for" })) };
    expect(score("cpu-throttling", wrongPlace, SCENARIOS).state,
      "citations in the evidence list are not the agents' source_refs").toBe("correct-without-its-evidence");

    // And the paths must come from the incident's agents, not from an analysis
    // hung anywhere else on the answer. Without this the two readings agree on
    // every input the other cases use, and the difference is untested.
    const outsideTheIncident = { state: "concluded", root_cause_code: "CPU_THROTTLING",
      analysis: { agents: [{ findings: needed.map((r) => ({ fact: "f", source_ref: r })) }] },
      incident: { observations: materialise(needed), analysis: { agents: [] } } };
    expect(score("cpu-throttling", outsideTheIncident, SCENARIOS).state,
      "findings outside the incident are not the incident's citations").toBe("correct-without-its-evidence");
  });

  it("scores every scenario on disk, so one cannot be quietly left out", () => {
    const results = scoreAll({ "container-oom": concluded("CONTAINER_OOM") }, SCENARIOS);
    const names = readdirSync(SCENARIOS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(results).toHaveLength(names.length);
    expect(results.filter((r: { state: string }) => r.state.startsWith("correct"))).toHaveLength(1);
    expect(results.filter((r: { state: string }) => r.state === "unasked")).toHaveLength(names.length - 1);
  });

  it("says the difference out loud in the report a human reads", () => {
    const text = format(scoreAll({}, SCENARIOS));
    expect(text).toContain("Concluding and being right are different things");
    expect(text).toContain("not established");
  });
});

/*
 * Definition of Done item 3 says confidence falls when findings conflict. Until
 * 2026-09-07 nothing could measure that: expected.json held only a code, and a
 * field that cannot fail the run is a comment. These are the tests for the
 * three qualifications that give it teeth — and for the two ways they could
 * quietly grant a pass instead.
 */
describe("a scenario whose evidence conflicts is scored on more than its code", () => {
  const S = "conflicting-evidence";
  const cite = mustCiteOf(S);

  it("takes either honest answer and refuses a third", () => {
    // Naming the observed cause with the number lowered, or refusing outright.
    expect(score(S, qualified("CONTAINER_OOM", cite, 0.5, 1), SCENARIOS).state).toBe("correct");
    // A refusal is exempt from both qualifications, for one reason: they are
    // asked of a conclusion, and a refusal is the absence of one. It still has
    // to cite what it looked at.
    // 0 rather than 0.9: since 2026-09-08 a refusal may not be stated above the
    // scenario's own ceiling, because a refusal held that firmly is not one.
    expect(score(S, qualified("INSUFFICIENT_EVIDENCE", cite, 0, 0), SCENARIOS).state).toBe("correct");
    expect(score(S, qualified("INSUFFICIENT_EVIDENCE", [], 0, 0), SCENARIOS).state)
      .toBe("correct-without-its-evidence");
    expect(score(S, qualified("CPU_THROTTLING", cite, 0.2, 1), SCENARIOS).state).toBe("wrong");
  });

  it("refuses the right code held too confidently, and says so in its own state", () => {
    const r = score(S, qualified("CONTAINER_OOM", cite, 0.9, 1), SCENARIOS);
    expect(r.state, "0.9 on contradicted evidence must not read as correct").toBe("correct-but-unqualified");
    expect(r.why.join(" ")).toMatch(/above the ceiling/);
  });

  it("refuses a conclusion that never mentions what argues with it", () => {
    const r = score(S, qualified("CONTAINER_OOM", cite, 0.4, 0), SCENARIOS);
    expect(r.state).toBe("correct-but-unqualified");
    expect(r.why.join(" ")).toMatch(/nothing was weighed/);
  });

  /*
   * The defect this whole file exists to catch, in the one place it would have
   * been invisible: `null > 0.6` is false in JavaScript, so an answer that
   * states no confidence at all would have SATISFIED the ceiling. A missing
   * number reading as a met requirement is the absence being taken for consent.
   */
  it("does not let a missing confidence satisfy the ceiling", () => {
    for (const c of [null, undefined, "0.4", Number.NaN]) {
      const r = score(S, qualified("CONTAINER_OOM", cite, c, 1), SCENARIOS);
      expect(r.state, `confidence ${JSON.stringify(c)} must not pass as met`).toBe("correct-but-unqualified");
      expect(r.why.join(" ")).toMatch(/states no confidence/);
    }
  });

  /*
   * The other direction: the qualifications must not leak onto scenarios that
   * never asked for them, or every clean run turns red for lacking a ceiling
   * it was never given. Absence means no requirement, not a requirement of zero.
   */
  it("leaves a scenario without these fields exactly as it was", () => {
    const clean = mustCiteOf("container-oom");
    expect(expectedFor("container-oom", SCENARIOS).maxConfidence,
      "container-oom must carry no ceiling, or it is not the comparable case").toBe(null);
    expect(score("container-oom", qualified("CONTAINER_OOM", clean, 0.95, 0), SCENARIOS).state).toBe("correct");
    expect(score("container-oom", concluded("CONTAINER_OOM", clean), SCENARIOS).state).toBe("correct");
  });

  /*
   * Grok, 2026-09-07: the first version counted supports === "against" and
   * nothing else, so a bare flag with no source and no fact lifted the verdict
   * to correct. Anyone who knows the field name walks past the check — the same
   * defect as a field that cannot fail a run, one level in.
   */
  it("refuses a dissent that is a flag rather than evidence", () => {
    const bare = score(S, withEvidence("CONTAINER_OOM", cite, 0.4, [{ supports: "against" }]), SCENARIOS);
    expect(bare.state, "a bare flag must not satisfy the dissent requirement").toBe("correct-but-unqualified");
    expect(bare.why.join(" ")).toMatch(/nothing was weighed/);

    const empty = score(S, withEvidence("CONTAINER_OOM", cite, 0.4,
      [{ source: "", fact: "", supports: "against" }]), SCENARIOS);
    expect(empty.state, "empty strings are not evidence either").toBe("correct-but-unqualified");
  });

  /*
   * And a contradiction raised by the slot that already supports the answer is
   * not the conflict this scenario poses: the whole scenario is kubernetes and
   * metrics disagreeing with each other.
   */
  it("refuses a dissent that comes from the same source as the support", () => {
    const r = score(S, withEvidence("CONTAINER_OOM", cite, 0.4, [
      { source: "kubernetes", fact: "the container was OOMKilled", supports: "for" },
      { source: "kubernetes", fact: "but it might have been something else", supports: "against" },
    ]), SCENARIOS);
    expect(r.state).toBe("correct-but-unqualified");
    expect(r.why.join(" ")).toMatch(/same source as the support/);
  });

  /*
   * Codex reached this by calling score() directly on 2026-09-07: a refusal with
   * an empty evidence list scored `correct`, so the scenario could not tell a
   * reasoned refusal from one that never noticed the contradiction. A refusal is
   * exempt from pointing AGAINST a conclusion it never reached — not from having
   * looked at anything.
   */
  it("refuses a refusal that cites nothing at all", () => {
    /*
     * A refusal writes an EMPTY analysis.evidence on purpose — every entry must
     * point for or against a conclusion, and a refusal reached none. Judging it
     * on that emptiness made both answers this scenario declares honest score
     * unqualified, so a paid run of the one scenario that can close Definition
     * of Done item 3 was unwinnable before it started. Measured 2026-09-07.
     *
     * What it must show is that it READ something, and reading is recorded in
     * the agents' findings.
     */
    const blind = withEvidence("INSUFFICIENT_EVIDENCE", [], 0, []);
    expect(score(S, blind, SCENARIOS).state,
      "a refusal that cites nothing has not looked").toBe("correct-but-unqualified");
    expect(score(S, blind, SCENARIOS).why.join(" ")).toMatch(/citing nothing/);

    // The honest refusal: it cited what it read, and reached no conclusion, so
    // analysis.evidence is empty exactly as merge.ts intends.
    const honest = withEvidence("INSUFFICIENT_EVIDENCE", cite, 0, []);
    expect(score(S, honest, SCENARIOS).state,
      "the answer the scenario declares acceptable must be reachable").toBe("correct");
  });

  /*
   * Codex, 2026-09-07, reproducing it: the first version skipped the source
   * comparison entirely when no supporting evidence existed, so an answer that
   * argued only AGAINST the conclusion it had just reached scored correct.
   */
  it("refuses a dissent with nothing supporting the conclusion", () => {
    const r = score(S, withEvidence("CONTAINER_OOM", cite, 0.4,
      [{ source: "metrics", fact: "memory never approached the limit", supports: "against" }]), SCENARIOS);
    expect(r.state, "arguing against your own conclusion and never for it is not weighing").toBe("correct-but-unqualified");
    expect(r.why.join(" ")).toMatch(/nothing supports the conclusion/);
  });

  /*
   * And the same defect from the other side: asking whether EVERY dissent
   * shared a source with the support turned a genuine cross-source conflict
   * unqualified as soon as the dissenting agent also contributed one
   * supporting fact. The conflict is a relation between a pair, not a property
   * of each item.
   */
  it("accepts a cross-source conflict even when the dissenting agent also supports", () => {
    const r = score(S, withEvidence("CONTAINER_OOM", cite, 0.4, [
      { source: "kubernetes", fact: "the container was OOMKilled", supports: "for" },
      { source: "metrics", fact: "the container did run at all", supports: "for" },
      { source: "metrics", fact: "memory never approached the limit", supports: "against" },
    ]), SCENARIOS);
    expect(r.state, "one extra supporting fact must not invalidate a real contradiction").toBe("correct");
  });

  it("refuses a refusal that is held as firmly as a conclusion", () => {
    /*
     * The exemption said: a refusal already IS the lowered answer, so demanding
     * a low number asks it to doubt its own doubt. True for a refusal that
     * states nothing, or something small. Not true at 0.95 — a subagent scored
     * exactly that `correct` on 2026-09-08, before the run that would have paid
     * for it, and Definition of Done item 3 would have read as CLOSED by a run
     * in which the confidence went up. Item 3's claim is "confidence reduction
     * under conflicting evidence".
     */
    const refusal = (confidence: unknown) =>
      withEvidence("INSUFFICIENT_EVIDENCE", cite, confidence, []);

    const firm = score(S, refusal(0.95), SCENARIOS);
    expect(firm.state, "a refusal at 95% is not a refusal").toBe("correct-but-unqualified");
    expect(firm.why.join(" ")).toMatch(/above the ceiling/);

    /*
     * The ceiling for a REFUSAL is the stricter of two, and they are not equal.
     *
     * The scenario says 0.6 and the schema says a refusal may not exceed 0.5 —
     * two carriers of one rule about one number, and this test asserted the
     * looser one, so a hand-built refusal at 0.6 scored `correct` although the
     * chain could never have produced that document. A subagent found it on
     * 2026-09-09.
     */
    expect(refusalCeiling(), "read from the schema, not restated here").toBe(0.5);
    for (const c of [0, 0.3, 0.5, null, undefined]) {
      expect(score(S, refusal(c), SCENARIOS).state, `a refusal at ${JSON.stringify(c)} is honest`)
        .toBe("correct");
    }
    const overSchema = score(S, refusal(0.6), SCENARIOS);
    expect(overSchema.state, "0.6 is under the scenario's ceiling and over the schema's")
      .toBe("correct-but-unqualified");
    expect(overSchema.why.join(" ")).toMatch(/above the ceiling of 0\.5/);
  });

  it("gives each combination of states its own exit code", () => {
    /*
     * The exit code was an expression inside main, and nothing spawned main —
     * so the only reader was a person. A subagent measured it on 2026-09-09:
     * dropping `correct-but-unqualified` from the failure side left the whole
     * suite green while a run whose right code was held above the ceiling
     * exited 0, which is the number a machine reads.
     */
    const r = (...states: string[]) => exitCodeFor(states.map((state) => ({ state })));
    expect(r("correct"), "everything answered and right").toBe(0);
    expect(r("correct", "wrong"), "a wrong answer is a failure").toBe(1);
    expect(r("correct", "correct-without-its-evidence"), "right code on other ground is not clean").toBe(1);
    expect(r("correct", "correct-but-unqualified"), "right code held wrongly is not clean").toBe(1);
    expect(r("correct", "unestablished"), "asked and settled nothing is unknown").toBe(2);
    expect(r("correct", "unasked"), "nobody asked is unknown").toBe(2);
    expect(r("wrong", "unasked"), "a failure beside an unknown is both").toBe(3);
    expect(r(), "nothing scored at all is not a clean run").toBe(0);
  });

  it("counts the new state separately in the report and does not exit clean", () => {
    const text = format([score(S, qualified("CONTAINER_OOM", cite, 0.9, 1), SCENARIOS)]);
    expect(text).toMatch(/UNQUALIFIED/);
    expect(text).toMatch(/right code held wrongly/);
  });
});

/*
 * The prompts and the fixtures had drifted into two spellings of one idea:
 * metrics-agent.md shows `series[0].points[3]` while conflicting-evidence
 * demands `series[0].points[3].value`, and cpu-throttling demands the point.
 * An obedient model could satisfy one scenario and fail the other with the
 * identical, correct answer. Found by a subagent on 2026-09-07.
 */
describe("a citation counts when it is at least as specific as the one required", () => {
  it("counts a citation that is more specific than the one required", () => {
    expect(citationCovers("series[0].points[3]", "series[0].points[3].value"),
      "naming the field of a point names the point").toBe(true);
    expect(citationCovers("lines[2]", "lines[2].message")).toBe(true);
    expect(citationCovers("deployment.image", "deployment.image")).toBe(true);
  });

  it("does not count a citation that is less specific, or a different index", () => {
    expect(citationCovers("pods[0].phase", "pods[0]"),
      "naming the pod does not name its phase").toBe(false);
    /*
     * Compared segment by segment, not as a string: `series[0].points[30]`
     * starts with `series[0].points[3]` and is a different point entirely.
     */
    expect(citationCovers("series[0].points[3]", "series[0].points[30]"),
      "point 30 is not point 3").toBe(false);
    expect(citationCovers("events[0].message", "events[1].message")).toBe(false);
  });
});

/*
 * Two ways a run record could be quietly falsified, both measured by a subagent
 * on 2026-09-07 by running the scorer twice with different inputs.
 */
describe("a recorded verdict is not overwritten by accident", () => {
  const record = () => {
    const d = mkdtempSync(join(tmpdir(), "rec-"));
    const f = join(d, "run.json");
    writeFileSync(f, JSON.stringify({ note: "the run that concluded container-oom correctly" }));
    return { d, f };
  };
  const ok = [{ scenario: "container-oom", state: "correct" }];

  it("refuses to replace scores that are already there", () => {
    const { d, f } = record();
    try {
      expect(recordInto(f, ok)).toEqual({ "container-oom": "correct" });
      expect(() => recordInto(f, [{ scenario: "container-oom", state: "wrong" }]),
        "a second run must not silently rewrite the first's verdict").toThrow(/already carries scores/);
      // Saying so explicitly is allowed; the point is that it must be said.
      expect(recordInto(f, [{ scenario: "container-oom", state: "wrong" }], { replace: true }))
        .toEqual({ "container-oom": "wrong" });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("refuses to record a run in which nothing was established", () => {
    /*
     * scoreAll enumerates every scenario directory whatever the answers hold,
     * so an empty answers file produces a FULL map of `unestablished` rather
     * than an obviously truncated one — and the gate's someRunWasScored accepts
     * any non-empty scored map, so those keys would flip promised checks from
     * waiting to due on the strength of a run that answered nothing.
     */
    const { d, f } = record();
    try {
      const nothing = ["container-oom", "cpu-throttling"].map((s) => ({ scenario: s, state: "unestablished" }));
      expect(() => recordInto(f, nothing)).toThrow(/answered nothing/);
      // A run where SOMETHING was established records, unestablished keys and all.
      expect(recordInto(f, [...nothing, { scenario: "image-pull-failure", state: "correct" }]))
        .toHaveProperty("image-pull-failure", "correct");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

/*
 * A repeated measurement needs each attempt recorded separately: three attempts
 * written under one scenario name keep only the last, and the discarded one is
 * as likely as any to be the interesting one — on 2026-09-07 it was exactly the
 * attempt that cited the path the whole re-measurement was about.
 *
 * The protocol said to write `image-pull-failure#1`. I wrote that in the
 * document and not in the code: scoreAll enumerated directories and read
 * answers[s], so every attempt key was silently ignored, and score() called
 * with one answered "has no expected.json". Codex found it on 2026-09-08,
 * before the run it would have wasted.
 */
describe("an attempt is scored as itself, not lost under its scenario", () => {
  const cite = mustCiteOf("image-pull-failure");
  const answer = (code: string) => concluded(code, cite);

  it("splits a key into the scenario and the attempt", () => {
    expect(scenarioOf("image-pull-failure#2")).toBe("image-pull-failure");
    expect(attemptOf("image-pull-failure#2")).toBe("2");
    // A bare name is the scenario itself, not attempt "".
    expect(scenarioOf("image-pull-failure")).toBe("image-pull-failure");
    expect(attemptOf("image-pull-failure")).toBeNull();
  });

  it("scores an attempt key against its scenario's expectation", () => {
    const r = score("image-pull-failure#1", answer("IMAGE_PULL_FAILURE"), SCENARIOS);
    expect(r.state, "an attempt must be scorable at all").toBe("correct");
    expect(r.scenario, "and it must keep its own name in the result").toBe("image-pull-failure#1");
  });

  it("keeps every attempt as its own row rather than the last one winning", () => {
    const rows = scoreAll({
      "image-pull-failure": answer("IMAGE_PULL_FAILURE"),
      "image-pull-failure#2": answer("IMAGE_PULL_FAILURE"),
      "image-pull-failure#3": answer("CONTAINER_OOM"),
    }, SCENARIOS).filter((r: { scenario: string }) => r.scenario.startsWith("image-pull-failure"));

    expect(rows.map((r: { scenario: string }) => r.scenario))
      .toEqual(["image-pull-failure", "image-pull-failure#2", "image-pull-failure#3"]);
    expect(rows.map((r: { state: string }) => r.state), "the wrong attempt must survive into the record")
      .toEqual(["correct", "correct", "wrong"]);
  });

  it("still reports a scenario nobody answered, attempts or not", () => {
    // The directories decide what MUST be answered. That is why scoreAll walks
    // them rather than the keys it was handed.
    const rows = scoreAll({ "image-pull-failure#1": answer("IMAGE_PULL_FAILURE") }, SCENARIOS);
    const bare = rows.find((r: { scenario: string }) => r.scenario === "container-oom");
    expect(bare!.state, "an unanswered scenario is reported as not asked, not absent").toBe("unasked");
  });
});

/*
 * Two ways a run could be recorded BETTER than it was, both measured by Grok on
 * 2026-09-08, before the run they would have flattered.
 */
describe("a citation counts only when it points at something the incident holds", () => {
  const withObservations = (refs: string[]) => ({
    state: "concluded", root_cause_code: "CONTAINER_OOM",
    incident: {
      observations: { kubernetes: { pods: [{ containers: [{ last_state: { terminated: { reason: "OOMKilled" } } }] }] },
        logs: null, metrics: { series: [{ points: [{}, {}, {}, { value: 155 }] }] } },
      analysis: { confidence: 0.5,
        evidence: [{ source: "kubernetes", fact: "a", supports: "for" },
                   { source: "metrics", fact: "b", supports: "against" }],
        // Each ref is attributed to the agent whose slot could hold it. A
        // fixture that credits kubernetes with a metrics path is the defect
        // this file measures elsewhere, not the honest answer it needs here.
        agents: agentsFor(refs) },
    },
  });

  it("refuses a path invented one level below a real one", () => {
    /*
     * citationCovers accepts a path at least as specific as the requirement —
     * right for the leaf of a point, wrong for a leaf invented under the leaf.
     * Depth cannot separate them: one deeper is legitimate in the first case
     * and invented in the second. Resolution can, and the answer carries the
     * incident, so the scorer looks instead of reasoning.
     */
    const real = score("conflicting-evidence", withObservations([
      "pods[0].containers[0].last_state.terminated.reason", "series[0].points[3].value"]), SCENARIOS);
    expect(real.state, "the honest answer must still be correct").toBe("correct");

    const invented = score("conflicting-evidence", withObservations([
      "pods[0].containers[0].last_state.terminated.reason.nope", "series[0].points[3].value.nope"]), SCENARIOS);
    expect(invented.state, "a path pointing at nothing is not a citation")
      .toBe("correct-without-its-evidence");
  });

  it("resolves a path against every slot, which is the weaker rule for an agent with no slot", () => {
    const a = withObservations([]);
    expect(resolvesInSomeSlot(a, "pods[0].containers[0].last_state.terminated.reason")).toBe(true);
    expect(resolvesInSomeSlot(a, "series[0].points[3].value")).toBe(true);
    expect(resolvesInSomeSlot(a, "series[0].points[9].value"), "point 9 is not there").toBe(false);
    expect(resolvesInSomeSlot({ incident: {} }, "anything"),
      "an incident with no observations resolves nothing").toBe(false);
    expect(resolvesInSomeSlot(a, "toString"), "a property every object has is not a citation").toBe(false);
  });

  it("refuses a refusal whose confidence is not a number", () => {
    const S = "conflicting-evidence";
    const cite = mustCiteOf(S);
    const withEvidence = (code: string, cited: string[], confidence: unknown, evidence: unknown[]) => {
      const a = concluded(code, cited) as Record<string, any>;
      a.incident.analysis.confidence = confidence;
      a.incident.analysis.evidence = evidence;
      return a;
    };
    /*
     * The ceiling branch asked `typeof c === "number" && isFinite && c > max`,
     * so "0.95" as a string and Infinity walked through in silence — the same
     * `null > 0.6` shape this file already refuses on the other branch, written
     * again on the branch added a day later.
     */
    const refusal = (confidence: unknown) =>
      withEvidence("INSUFFICIENT_EVIDENCE", cite, confidence, []);
    for (const bad of ["0.95", Number.POSITIVE_INFINITY, Number.NaN, "low"]) {
      const r = score(S, refusal(bad), SCENARIOS);
      expect(r.state, `${JSON.stringify(bad)} must not pass as under the ceiling`)
        .toBe("correct-but-unqualified");
      expect(r.why.join(" ")).toMatch(/not a number|above the ceiling/);
    }
    // Absent is still honest — that is why this branch is separate from the other.
    expect(score(S, refusal(undefined), SCENARIOS).state).toBe("correct");
  });
});

/*
 * Five ways a run could have been recorded better than it was, all found on
 * 2026-09-08 by Codex and Grok · 2 independently, BEFORE the run they would
 * have flattered. Each test names one and fails without its fix.
 */
describe("what the scorer refuses to call an answer", () => {
  const cite = (agent: string, refs: string[]) =>
    ({ agent, findings: refs.map((r) => ({ fact: "f", source_ref: r })) });

  it("does not report a scenario unestablished when its attempts answered it", () => {
    /*
     * Eight successful `#1` answers printed "8 correct, 8 not established, of
     * 16", because the bare row was emitted whether or not anything answered
     * under it. The CLI exited 2 on a clean run, and readiness read the
     * synthetic row as a fourth attempt nobody had made.
     */
    const answers: Record<string, unknown> = {};
    const names = readdirSync(SCENARIOS, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
    for (const n of names) {
      const want = expectedFor(n, SCENARIOS);
      answers[`${n}#1`] = qualified(want.code, mustCiteOf(n), 0.5, 1);
    }
    const rows = scoreAll(answers, SCENARIOS);
    expect(rows, "one row per attempt, and no synthetic row beside it").toHaveLength(names.length);
    expect(rows.filter((r: { state: string }) => r.state === "unestablished"),
      "a scenario answered under an attempt key was answered").toHaveLength(0);
  });

  it("still reports the bare scenario when a bare answer was recorded beside its attempts", () => {
    // Two answers are two measurements. Only the ABSENT bare row is synthetic.
    const rows = scoreAll({
      "container-oom": qualified("CONTAINER_OOM", mustCiteOf("container-oom"), 0.5, 1),
      "container-oom#2": qualified("CONTAINER_OOM", mustCiteOf("container-oom"), 0.5, 1),
    }, SCENARIOS).filter((r: { scenario: string }) => r.scenario.startsWith("container-oom"));
    expect(rows.map((r: { scenario: string }) => r.scenario)).toEqual(["container-oom", "container-oom#2"]);
  });

  it("refuses a citation that resolves only in another agent's slot", () => {
    /*
     * Codex reproduced this: a readiness finding attributed to kubernetes, an
     * empty kubernetes slot, and both required paths sitting in logs, scored
     * correct. One agent credited with what another one saw — the same thing
     * recordAgentResult refuses inside the chain.
     */
    const needed = mustCiteOf("readiness-probe-failure");
    const obs = materialise(needed);
    const honest = { state: "concluded", root_cause_code: "READINESS_PROBE_FAILURE",
      incident: { observations: obs, analysis: { agents: agentsFor(needed) } } };
    expect(score("readiness-probe-failure", honest, SCENARIOS).state,
      "the honest attribution must still be correct").toBe("correct");

    /*
     * Both required paths sit in ONE foreign slot, and the agent's own slot is
     * empty. The first version of this fixture emptied kubernetes and left the
     * kubernetes path nowhere at all — so the citation failed to resolve
     * anywhere, and the test passed even with the slot rule turned off. The
     * mutation run caught it; nothing else would have.
     */
    const elsewhere = Object.assign({}, ...Object.values(obs));
    const misattributed = { state: "concluded", root_cause_code: "READINESS_PROBE_FAILURE",
      incident: { observations: { kubernetes: {}, logs: elsewhere },
        analysis: { agents: [cite("kubernetes", needed)] } } };
    expect(resolvesInSomeSlot(misattributed, needed[0]!),
      "the paths must resolve SOMEWHERE, or this measures the wrong refusal").toBe(true);
    expect(score("readiness-probe-failure", misattributed, SCENARIOS).state,
      "a path its own agent could not have seen is not that agent's citation")
      .toBe("correct-without-its-evidence");
  });

  it("calls an answer carrying no observation unestablished, not correct", () => {
    /*
     * A fabricated answer holding the expected code and the two required path
     * strings, with no observations and no facts, scored correct: "I could not
     * look" folded into "clean".
     */
    const needed = mustCiteOf("container-oom");
    const nothingToCheck = { state: "concluded", root_cause_code: "CONTAINER_OOM",
      incident: { analysis: { agents: [cite("kubernetes", needed)] } } };
    const r = score("container-oom", nothingToCheck, SCENARIOS);
    expect(r.state).toBe("unestablished");
    expect(r.why).toMatch(/no citation of it could be resolved/);
  });

  it("does not accept dissent from a source that never answered", () => {
    /*
     * Grok · 2: two invented rows with two different `source` strings, one for
     * and one against, satisfied the pair. The shape was checked; the anchoring
     * was not, so "a different source disagreed" could be written by someone
     * who had asked no source at all.
     */
    const needed = mustCiteOf("conflicting-evidence");
    const base = () => ({ state: "concluded", root_cause_code: "CONTAINER_OOM",
      incident: { observations: materialise(needed),
        analysis: { confidence: 0.5, agents: agentsFor(needed),
          evidence: [{ source: "kubernetes", fact: "a", supports: "for" },
                     { source: "metrics", fact: "b", supports: "against" }] } } });
    expect(score("conflicting-evidence", base(), SCENARIOS).state,
      "both sources answered, so the pair stands").toBe("correct");

    const invented = base();
    invented.incident.analysis.evidence = [
      { source: "datadog", fact: "a", supports: "for" },
      { source: "pagerduty", fact: "b", supports: "against" }];
    const r = score("conflicting-evidence", invented, SCENARIOS);
    expect(r.state, "a source that never answered cannot have dissented").toBe("correct-but-unqualified");
    expect(r.why.join(" ")).toMatch(/nothing was weighed|no conflict/);
  });
});

describe("a run bought in parts is recorded in one record", () => {
  const rec = () => {
    const d = mkdtempSync(join(tmpdir(), "rec-"));
    const f = join(d, "2026-09-08-a.json");
    writeFileSync(f, JSON.stringify({ when: "2026-09-08", scored: null }));
    return { d, f };
  };

  it("fills keys the record does not answer yet, and leaves the rest standing", () => {
    /*
     * Grok, 2026-09-08: latestScored returns a SINGLE record, so a second file
     * sends part one back to unestablished — and --replace over the same file
     * orphans it just as completely. This is the third door.
     */
    const { d, f } = rec();
    try {
      recordInto(f, [{ scenario: "alpha", state: "correct" },
                     { scenario: "beta", state: "unestablished" }]);
      recordInto(f, [{ scenario: "alpha", state: "unestablished" },
                     { scenario: "beta", state: "wrong" }], { add: true });
      const after = JSON.parse(readFileSync(f, "utf8")).scored;
      expect(after.alpha, "an established verdict is not undone by a later part").toBe("correct");
      expect(after.beta, "and a key that said nothing yet is filled").toBe("wrong");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("carries six correct attempts through three parts without losing one", () => {
    /*
     * Codex reproduced this on 2026-09-08, against the staged purchase itself:
     * part 2 scores an answers file with no readiness keys, so a bare
     * `readiness-probe-failure` row arrives — and merged beside the three
     * correct attempts part 1 recorded, it turned six correct measurements into
     * two unanswered scenarios, each reported as "4 attempts, worst kept".
     *
     * This walks the parts through the real scorer and the real reader, which
     * is the only place the defect showed.
     */
    const { d, f } = rec();
    try {
      const part = (scenario: string, n: number) => {
        const answers: Record<string, unknown> = {};
        for (let i = 1; i <= n; i++) {
          answers[`${scenario}#${i}`] =
            qualified(expectedFor(scenario, SCENARIOS).code, mustCiteOf(scenario), 0.5, 1);
        }
        recordInto(f, scoreAll(answers, SCENARIOS), { add: true });
      };
      part("readiness-probe-failure", 3);
      part("image-pull-failure", 3);

      const scored = JSON.parse(readFileSync(f, "utf8")).scored;
      for (const s of ["readiness-probe-failure", "image-pull-failure"]) {
        for (let i = 1; i <= 3; i++) {
          expect(scored[`${s}#${i}`], `${s}#${i} must survive the other part`).toBe("correct");
        }
        expect(scored[s], "and the bare key must still say only that nobody asked it").toBe("unasked");
      }
      expect(scored["container-oom"], "a scenario no part bought says nobody asked").toBe("unasked");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("refuses to turn one established verdict into a different one without --replace", () => {
    const { d, f } = rec();
    try {
      recordInto(f, [{ scenario: "alpha", state: "correct" }]);
      expect(() => recordInto(f, [{ scenario: "alpha", state: "wrong" }], { add: true }))
        .toThrow(/scores alpha differently/);
      expect(JSON.parse(readFileSync(f, "utf8")).scored.alpha).toBe("correct");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

/*
 * Definition-of-Done item 3 says confidence FALLS when findings conflict. That
 * is a comparison, and it lived only in the protocol's prose until 2026-09-07:
 * `max_confidence` alone is satisfied by 55% on the contradicted scenario and
 * 55% on the clean one, which is not a reduction of anything. Grok found it
 * while attacking the protocol, before the run was bought.
 */
describe("a scenario whose honesty is a comparison is scored against its pair", () => {
  const answer = (code: string, confidence: number | null) => ({
    state: "concluded", root_cause_code: code,
    incident: { analysis: { confidence, evidence: [
      { source: "kubernetes", fact: "OOMKilled", supports: "for" },
      { source: "metrics", fact: "memory never approached the limit", supports: "against" },
    ], agents: [{ agent: "kubernetes", findings: mustCiteOf("conflicting-evidence").map((r) => ({ fact: "f", source_ref: r })) }] } },
  });
  const correctPair = (mine: number | null, theirs: number | null) => compareConfidences(
    [{ scenario: "conflicting-evidence", state: "correct", code: "CONTAINER_OOM", missingCitations: [] }],
    { "conflicting-evidence": answer("CONTAINER_OOM", mine), "container-oom": answer("CONTAINER_OOM", theirs) },
    SCENARIOS,
  )[0]!;

  it("refuses the same confidence on the contradicted case and the clean one", () => {
    const r = correctPair(0.55, 0.55);
    expect(r.state, "equal numbers are not a reduction").toBe("correct-but-unqualified");
    expect(r.why.join(" ")).toMatch(/not lower than/);
  });

  it("refuses a HIGHER confidence on the contradicted case", () => {
    expect(correctPair(0.8, 0.4).state).toBe("correct-but-unqualified");
  });

  it("accepts a genuinely lower confidence, or this refuses everything", () => {
    expect(correctPair(0.4, 0.8).state).toBe("correct");
  });

  it("refuses when the comparable scenario was not answered in this run", () => {
    /*
     * A comparison nobody could make has not been made. Reporting it clean is
     * the flattering reading, and it is the one a run that bought only half the
     * scenarios would have produced.
     */
    const r = compareConfidences(
      [{ scenario: "conflicting-evidence", state: "correct", code: "CONTAINER_OOM", missingCitations: [] }],
      { "conflicting-evidence": answer("CONTAINER_OOM", 0.4) },
      SCENARIOS,
    )[0]!;
    expect(r.state).toBe("correct-but-unqualified");
    expect(r.why.join(" ")).toMatch(/was not answered in this run/);
  });

  it("leaves a refusal alone, since it has no confidence to compare", () => {
    const r = compareConfidences(
      [{ scenario: "conflicting-evidence", state: "correct", code: "INSUFFICIENT_EVIDENCE", missingCitations: [] }],
      { "conflicting-evidence": answer("INSUFFICIENT_EVIDENCE", 0) },
      SCENARIOS,
    )[0]!;
    expect(r.state, "refusing IS the accepted answer here").toBe("correct");
  });

  it("leaves alone a scenario that declares no comparison", () => {
    const r = compareConfidences(
      [{ scenario: "container-oom", state: "correct", code: "CONTAINER_OOM", missingCitations: [] }],
      { "container-oom": answer("CONTAINER_OOM", 0.9) },
      SCENARIOS,
    )[0]!;
    expect(r.state).toBe("correct");
  });
});

describe("the list of slots exists four times", () => {
  /*
   * `SLOTS` (src/providers/fixtures.ts), `MERGE_SLOTS` (src/core/merge.ts),
   * `SCORE_SLOTS` (scripts/score-run.mjs) and `AGENT_ORDER`
   * (scripts/workflow-runtime.mjs) all name the same collection agents, and the
   * files cannot import from each other: two of them are transpiled into the
   * n8n Code node, where imports do not exist. TypeScript catches a wrong NAME
   * in the two typed copies and nothing catches a MISSING one, and SCORE_SLOTS
   * is plain JavaScript with no protection at all — so a fourth collection
   * agent added everywhere but there falls through `resolvesInSomeSlot`, and a
   * citation attributed to it that happens to resolve in another agent's slot
   * scores `correct`. That is the defect `resolvesForAgent` says it closed.
   * A subagent found it on 2026-09-09. The copies stay; this notices divergence.
   */
  it("names the same collection agents in all four places", () => {
    expect([...SCORE_SLOTS], "score-run against the fixtures").toEqual([...SLOTS]);
    expect([...MERGE_SLOTS], "merge against the fixtures").toEqual([...SLOTS]);
  });

  it("orders the agents as the collectors plus the one that reads them all", () => {
    expect([...AGENT_ORDER], "the runtime asks every collector, then root-cause")
      .toEqual([...SLOTS, "root-cause"]);
  });
});
