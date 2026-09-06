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
const concluded = (code: string) => ({ state: "concluded", root_cause_code: code, evidence: [] });

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
    expect(score("cpu-throttling", concluded("CPU_THROTTLING"), SCENARIOS).state).toBe("correct");
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

  it("reports missing citations without failing the answer for them", () => {
    // expected.json's must_cite says what a human should look for. A run that
    // reaches the right code by other evidence is not thereby wrong, and
    // scoring it wrong would be this file inventing a rule nobody agreed.
    const r = score("cpu-throttling", concluded("CPU_THROTTLING"), SCENARIOS);
    expect(r.state).toBe("correct");
    expect(r.missingCitations.length, "the fixture lists citations, so this is not vacuous").toBeGreaterThan(0);
  });

  it("scores every scenario on disk, so one cannot be quietly left out", () => {
    const results = scoreAll({ "container-oom": concluded("CONTAINER_OOM") }, SCENARIOS);
    const names = readdirSync(SCENARIOS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(results).toHaveLength(names.length);
    expect(results.filter((r: { state: string }) => r.state === "correct")).toHaveLength(1);
    expect(results.filter((r: { state: string }) => r.state === "unestablished")).toHaveLength(names.length - 1);
  });

  it("says the difference out loud in the report a human reads", () => {
    const text = format(scoreAll({}, SCENARIOS));
    expect(text).toContain("Concluding and being right are different things");
    expect(text).toContain("not established");
  });
});
