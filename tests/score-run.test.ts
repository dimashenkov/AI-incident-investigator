/**
 * Concluding and being right are different things.
 *
 * On 2026-09-06 I reported "three of five concluded" as a success. One of the
 * three answered INSUFFICIENT_EVIDENCE where its expected.json says
 * CPU_THROTTLING — a wrong answer counted as a win, because nothing compared
 * the two and the only thing between them was somebody reading both files.
 */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
// @ts-expect-error - plain .mjs script, no types
import { score, scoreAll, expectedFor, format, citationCovers } from "../scripts/score-run.mjs";

const SCENARIOS = new URL("../scenarios/", import.meta.url).pathname;
/**
 * A concluded answer, with the paths its agents reported.
 *
 * The paths live on the agents' findings. The first version of the scorer read
 * analysis.evidence[].source, which holds the agent NAME — so nothing could
 * ever match must_cite and the citation verdict was noise. Caught by looking at
 * a recorded answer instead of trusting a field name.
 */
const concluded = (code: string, cited: string[] = []) => ({
  state: "concluded",
  root_cause_code: code,
  incident: { analysis: { agents: [{ agent: "kubernetes", findings: cited.map((r) => ({ fact: "f", source_ref: r })) }] } },
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
      expect(r.state, `${JSON.stringify(answer)} was scored as an answer`).toBe("unestablished");
      expect(r.got, "an unestablished run must carry no answer to compare").toBeUndefined();
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
    const wrongPlace = { state: "concluded", root_cause_code: "CPU_THROTTLING",
      evidence: needed.map((r) => ({ source: r, fact: "f", supports: "for" })) };
    expect(score("cpu-throttling", wrongPlace, SCENARIOS).state,
      "citations in the evidence list are not the agents' source_refs").toBe("correct-without-its-evidence");

    // And the paths must come from the incident's agents, not from an analysis
    // hung anywhere else on the answer. Without this the two readings agree on
    // every input the other cases use, and the difference is untested.
    const outsideTheIncident = { state: "concluded", root_cause_code: "CPU_THROTTLING",
      analysis: { agents: [{ findings: needed.map((r) => ({ fact: "f", source_ref: r })) }] },
      incident: { analysis: { agents: [] } } };
    expect(score("cpu-throttling", outsideTheIncident, SCENARIOS).state,
      "findings outside the incident are not the incident's citations").toBe("correct-without-its-evidence");
  });

  it("scores every scenario on disk, so one cannot be quietly left out", () => {
    const results = scoreAll({ "container-oom": concluded("CONTAINER_OOM") }, SCENARIOS);
    const names = readdirSync(SCENARIOS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(results).toHaveLength(names.length);
    expect(results.filter((r: { state: string }) => r.state.startsWith("correct"))).toHaveLength(1);
    expect(results.filter((r: { state: string }) => r.state === "unestablished")).toHaveLength(names.length - 1);
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
    expect(score(S, qualified("INSUFFICIENT_EVIDENCE", cite, 0.9, 0), SCENARIOS).state).toBe("correct");
    expect(score(S, qualified("INSUFFICIENT_EVIDENCE", [], 0.9, 0), SCENARIOS).state)
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
