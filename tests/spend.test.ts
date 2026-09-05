/**
 * What the prototype cost, and the two ways that number lies.
 *
 * The owner asked to know the total at the end. A total is easy to produce and
 * easy to get wrong in exactly two directions: by folding in money nobody paid,
 * and by quietly dropping a run it could not price. Both are tested here.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error - plain .mjs script, no types
import { costOfRun, readRuns, report, oneLine, PRICES } from "../scripts/spend.mjs";

const RUNS = new URL("../docs/runs/", import.meta.url).pathname;

describe("the spend counter reads artifacts, not memory", () => {
  it("prices a recorded run from its tokens and the model's recorded price", () => {
    const r = costOfRun({ model: "gpt-4o-mini-2024-07-18", totals: { input_tokens: 1_000_000, output_tokens: 0 } });
    expect(r.state).toBe("measured");
    expect(r.usd).toBeCloseTo(PRICES["gpt-4o-mini-2024-07-18"].input, 10);
  });

  it("says it could not establish a cost rather than counting it as zero", () => {
    // The defect this repository keeps finding: an unknown folded into the
    // clean answer. A run whose model has no recorded price is not a free run.
    for (const run of [
      { model: "some-model-nobody-priced", totals: { input_tokens: 10, output_tokens: 10 } },
      { model: "gpt-4o-mini-2024-07-18", totals: { input_tokens: "lots", output_tokens: 10 } },
      { model: "gpt-4o-mini-2024-07-18" },
      {},
    ]) {
      const r = costOfRun(run);
      expect(r.state, `${JSON.stringify(run)} was priced when it should not have been`).toBe("unknown");
      expect(r.why.length, "an unknown must say what is missing").toBeGreaterThan(10);
      expect(r.usd, "an unknown must not carry a number anyone could add up").toBeUndefined();
    }
  });

  it("reads every run on disk, so a new one cannot be silently uncounted", () => {
    const onDisk = readdirSync(RUNS).filter((f) => f.endsWith(".json")).sort();
    expect(onDisk.length, "this test is vacuous with no runs recorded").toBeGreaterThan(0);
    const { runs, unreadable } = readRuns(RUNS);
    expect(runs.map((r: { name: string }) => r.name)).toEqual(onDisk);
    expect(unreadable, "a run that cannot be parsed is not a run that cost nothing").toEqual([]);
  });

  it("prices every run that is actually on disk today", () => {
    // If a run is added with a model nobody has priced, this fails and the
    // price gets recorded — rather than the total quietly becoming a floor.
    const { runs } = readRuns(RUNS);
    for (const { name, run } of runs) {
      const r = costOfRun(run);
      expect(r.state, `${name}: ${r.why ?? ""}`).toBe("measured");
    }
  });

  it("keeps subscription tools out of the money total, in the report a reader sees", () => {
    /*
     * Owner, 2026-09-05: "we do not call Codex with an API here, so it is not
     * spending. It is on a subscription." The same is true of Grok, whose
     * per-call total_cost_usd looks exactly like an invoice and is not one.
     *
     * Codex, the same day: this used to grep the SOURCE, so it passed on the
     * comment explaining the line — the report lines could have been deleted
     * while the phrases survived in the header. It reads the output now.
     */
    for (const key of Object.keys(PRICES) as string[]) {
      for (const tool of ["codex", "grok"]) {
        expect(key.includes(tool), `${key} prices ${tool} as if it were metered`).toBe(false);
      }
    }
    const { text } = report();
    expect(text, "the report must say why the subscription tools are excluded").toContain("flat monthly fee");
    expect(text, "and must say what a per-call number on a subscription actually is").toContain("weight, not an invoice");
  });

  it("names in the report what it cannot count at all", () => {
    // Not "the largest cost" — that is unmeasured, and asserting it would be
    // the same defect the counter exists to prevent. What is certain is that
    // the counter cannot see it, and the report has to say so.
    const { text } = report();
    expect(text).toContain("Not counted anywhere");
    expect(text).toContain("session");
  });

  it("qualifies the total in the same report where an unreadable run is counted", () => {
    /*
     * Codex, 2026-09-05: unreadable files were added to the unknown count AFTER
     * the "this total is a floor" line had been decided. So a directory whose
     * only problem was an unparseable file exited 2 while the report printed an
     * unqualified total — the number a human reads disagreeing with the number
     * CI reads, which is the whole failure this exit code exists to prevent.
     */
    const dir = mkdtempSync(join(tmpdir(), "spend-"));
    writeFileSync(join(dir, "good.json"), JSON.stringify({
      when: "2026-01-01", model: "gpt-4o-mini-2024-07-18",
      totals: { input_tokens: 1000, output_tokens: 100 },
    }));
    writeFileSync(join(dir, "broken.json"), "{ not json");
    const r = report(dir);
    expect(r.unknown, "the unreadable file must reach the count").toBeGreaterThan(0);
    expect(r.text, "and the total printed beside it must say it is a floor").toContain("is a floor");
    expect(r.text).toContain("UNREADABLE");
  });

  it("refuses a token count that is not a whole non-negative number", () => {
    // Codex, 2026-09-05: Number() turned null, "", false and -100 into finite
    // numbers, so a negative count was subtracted from the total in silence.
    for (const bad of [-100, null, "", false, 1.5, "1000", undefined, NaN]) {
      const r = costOfRun({ model: "gpt-4o-mini-2024-07-18", totals: { input_tokens: bad, output_tokens: 10 } });
      expect(r.state, `${JSON.stringify(bad)} was accepted as a token count`).toBe("unknown");
      expect(r.usd).toBeUndefined();
    }
    // And the shape that is fine stays fine, or this test refuses everything.
    expect(costOfRun({ model: "gpt-4o-mini-2024-07-18", totals: { input_tokens: 0, output_tokens: 0 } }).state)
      .toBe("measured");
  });

  it("carries the qualification with the one figure, not only in the breakdown", () => {
    /*
     * Owner, 2026-09-05: one figure in every report, the breakdown only on
     * request. That makes the one line the only place the number is usually
     * read — so it is the one place that must admit when it is a floor. A
     * qualification that lives only in the detail is a qualification nobody
     * sees.
     */
    const dir = mkdtempSync(join(tmpdir(), "spend-"));
    writeFileSync(join(dir, "good.json"), JSON.stringify({
      when: "2026-01-01", model: "gpt-4o-mini-2024-07-18",
      totals: { input_tokens: 1000, output_tokens: 100 },
    }));
    expect(oneLine(dir), "a clean total must not call itself a floor").not.toContain("floor");
    expect(oneLine(dir)).toContain("$0.0002");

    writeFileSync(join(dir, "unpriced.json"), JSON.stringify({
      when: "2026-01-01", model: "a-model-nobody-priced",
      totals: { input_tokens: 1000, output_tokens: 100 },
    }));
    const line = oneLine(dir);
    expect(line, "the one line must say the figure is a floor").toContain("floor");
    expect(line, "and say how many runs it could not price").toContain("1 run(s)");
    expect(line, "and point at where the detail is").toContain("npm run spend");
  });
});
