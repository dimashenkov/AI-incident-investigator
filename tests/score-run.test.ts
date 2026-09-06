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
import { score, scoreAll, expectedFor, format } from "../scripts/score-run.mjs";

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
