/**
 * A readiness percentage is the easiest number in this repository to fake.
 *
 * Asked for by the owner on 2026-09-07. It lies in two directions and both are
 * flattering: counting what cannot be established as failure makes a project
 * that has simply not been asked look broken, and dropping it from the
 * denominator makes one that cannot answer at all look finished. So the tests
 * below are mostly about the third state, not the first two.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error - plain .mjs script, no types
import { definitionOfDone, latestScored, summarise, oneLine, bar, gateResult, scenariosMeasured, sourceNewerThan, latestScoredPerScenario, orderedRecords, naturalOlderToNewer } from "../scripts/readiness.mjs";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = () => mkdtempSync(join(tmpdir(), "readiness-"));

describe("a readiness figure that admits what it does not know", () => {
  it("does not count an unestablished check as green", () => {
    const s = summarise([
      { id: "a", state: "green" }, { id: "b", state: "unestablished", waits: "a paid run" },
      { id: "c", state: "unestablished", waits: "something else" }, { id: "d", state: "red" },
    ]);
    expect(s.percent, "1 green of 4 is 25%, not 33% and not 50%").toBe(25);
    expect(s.unestablished).toBe(2);
    expect(s.red).toBe(1);
  });

  /*
   * The rounding direction is a decision, not an accident: 99% must not appear
   * while two checks are still open, because the figure is read by someone
   * deciding whether the thing is finished.
   */
  it("rounds down, so the figure never reads higher than the checks support", () => {
    const checks = Array.from({ length: 3 }, (_, i) => ({ id: `x${i}`, state: i < 2 ? "green" : "red" }));
    expect(summarise(checks).percent, "2 of 3 is 66%, never 67%").toBe(66);
  });

  /*
   * The qualification travels with the figure. On the day this was written the
   * one-liner said all thirteen unestablished checks "cannot be answered
   * without a paid run" — two of them waited on code nobody had written, so the
   * sentence overstated what money would buy.
   */
  it("says separately how much waits on money and how much on work", () => {
    const line = oneLine(summarise([
      { id: "a", state: "green" },
      { id: "b", state: "unestablished", waits: "a paid run" },
      { id: "c", state: "unestablished", waits: "something else" },
    ]));
    expect(line).toMatch(/1 wait on a paid run/);
    expect(line).toMatch(/1 on work not yet done/);
  });

  it("says nothing about money when nothing waits on it", () => {
    const line = oneLine(summarise([{ id: "a", state: "green" }, { id: "b", state: "red" }]));
    expect(line).not.toMatch(/paid run/);
    expect(line).toMatch(/readiness 50%/);
  });

  /*
   * The bar is drawn in three characters because the project has three states.
   * A two-character bar has to draw unestablished as empty, and empty reads as
   * "not done yet" when the truth is "not asked yet" — the same collapse this
   * project refuses everywhere else, drawn instead of written.
   */
  it("draws unestablished as its own character, not as empty", () => {
    const b = bar(summarise([
      { id: "a", state: "green" }, { id: "b", state: "unestablished", waits: "a paid run" },
      { id: "c", state: "unestablished", waits: "a paid run" }, { id: "d", state: "red" },
    ]), 28);
    expect(b.length, "the bar must be exactly the width asked for").toBe(28);
    expect(b).toMatch(/^█+▒+░+$/);
    expect([...b].filter((c) => c === "█").length, "1 of 4 green is 7 of 28 cells").toBe(7);
    expect([...b].filter((c) => c === "▒").length, "2 of 4 unestablished is 14 cells").toBe(14);
  });

  /*
   * The remainder from flooring must never be handed to green: a bar that pads
   * with green reports work nobody did. It goes to whatever is genuinely open.
   */
  it("never pads the bar with green", () => {
    const s = summarise([
      { id: "a", state: "green" }, { id: "b", state: "green" },
      { id: "c", state: "unestablished", waits: "a paid run" },
    ]);
    const b = bar(s, 28);
    expect(b.length).toBe(28);
    expect([...b].filter((c) => c === "█").length, "2 of 3 is 18 cells, not 19").toBe(18);
    expect([...b].filter((c) => c === "▒").length, "the remainder goes to what is open").toBe(10);
  });

  /*
   * Codex, 2026-09-07: bar(summarise([]), 5) came back "█████". With nothing
   * counted there is no unestablished and no red, so the rounding remainder
   * fell through to green — a project nobody has measured drawing a full bar,
   * which is the worst single output this file can produce.
   */
  it("draws nothing as unestablished, not as finished", () => {
    expect(bar(summarise([]), 5), "an unmeasured project is unknown, not done").toBe("▒▒▒▒▒");
    expect(summarise([]).percent).toBe(0);
  });

  it("fills the bar when everything is green and nothing is open", () => {
    const b = bar(summarise([{ id: "a", state: "green" }, { id: "b", state: "green" }, { id: "c", state: "green" }]), 28);
    expect(b).toBe("█".repeat(28));
  });

  it("puts the bar in the one line that goes in every report", () => {
    expect(oneLine(summarise([{ id: "a", state: "green" }]))).toMatch(/^█+ readiness 100%/);
  });

  /*
   * An item that CLAIMS coverage and whose named test did not run and pass is
   * red, not green — the same question the acceptance gate asks, asked the same
   * way so the two cannot disagree about the same repository.
   */
  it("the readiness counter refuses a coverage claim whose named test did not pass", () => {
    const list = [{ n: 1, claim: "c", covered: true, by: ["a test that ran"] },
                  { n: 2, claim: "d", covered: true, by: ["a test that did not"] }];
    const checks = definitionOfDone("/nowhere", list, new Set(["a test that ran"]));
    expect(checks.map((c: any) => c.state)).toEqual(["green", "red"]);
  });

  it("calls coverage unestablished when there is no test report at all", () => {
    const list = [{ n: 1, claim: "c", covered: true, by: ["anything"] }];
    expect(definitionOfDone("/nowhere", list, null)[0].state,
      "no report is not the same as a failing test").toBe("unestablished");
  });

  it("the readiness counter refuses a coverage claim that names no test", () => {
    const list = [{ n: 1, claim: "c", covered: true, by: [] }];
    expect(definitionOfDone("/nowhere", list, new Set(["x"]))[0].state).toBe("unestablished");
  });

  /*
   * The reason every scenario reads unestablished today: the run records say
   * what happened in prose written for a human, and prose is not something a
   * machine may count. A record without `scored` must be SKIPPED, not read as a
   * run in which nothing was answered — absence is not an empty result.
   */
  it("skips a run record that carries no machine-readable scores", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-01-01-a.json"), JSON.stringify({ outcome: "it went fine, honestly" }));
      const r = latestScored(join(d, "runs"));
      expect(r.scored, "prose must not be counted as a score").toBe(null);
      expect(r.why).toMatch(/no run record carries machine-readable scores/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("takes the newest record that has scores, not the newest record", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-01-01-old.json"), JSON.stringify({ scored: { a: "correct" } }));
      writeFileSync(join(d, "runs", "2026-02-02-new.json"), JSON.stringify({ outcome: "no scores here" }));
      const r = latestScored(join(d, "runs"));
      expect(r.file).toBe("2026-01-01-old.json");
      expect(r.scored).toEqual({ a: "correct" });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  /*
   * The date is data; the filename is a habit. A subagent found on 2026-09-07
   * that an undated record — `final-run.json`, or the sentinel a debt used to
   * wait for — sorts above every `2026-…` in ASCII and became "the newest", so
   * a superseded run's greens could outlive the regression after it.
   */
  it("takes the newest by the date inside the record, not by filename", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "zzz-oldest.json"),
        JSON.stringify({ when: "2026-01-01", scored: { a: "wrong" } }));
      writeFileSync(join(d, "runs", "aaa-newest.json"),
        JSON.stringify({ when: "2026-06-06", scored: { a: "correct" } }));
      const r = latestScored(join(d, "runs"));
      expect(r.file, "the later date wins, whatever the files are called").toBe("aaa-newest.json");
      expect(r.scored).toEqual({ a: "correct" });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("never lets an undated record outrank a dated one", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-01-01-real.json"),
        JSON.stringify({ when: "2026-01-01", scored: { a: "correct" } }));
      writeFileSync(join(d, "runs", "final-run.json"), JSON.stringify({ scored: { a: "wrong" } }));
      expect(latestScored(join(d, "runs")).file,
        "a record with no date may predate everything; it must not lead").toBe("2026-01-01-real.json");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  /*
   * The model-blind second carrier (Grok, 2026-09-14). latestScoredPerScenario took the
   * newest record per scenario by DATE alone. A grok fallback run — proven live, exec 415 —
   * that is later scored and recorded would then override the gpt-5 baseline: a newer grok
   * `wrong` drags a scenario red off the fallback, or a grok `correct` masks a gpt-5
   * regression. A fallback is a different configuration, not a re-measurement of the primary.
   *
   * These set model_by_agent BY HAND, so they prove the demotion LOGIC, not the live path:
   * the recording path does not yet stamp the model into a docs/runs scored record, so on real
   * data the guard is latent (a live grok record is unmarked -> primary). That half is a
   * recorded limitation in docs/backlog.md, not a claim of "fixed" (Grok, 2026-09-14).
   */
  it("does not let a newer grok-fallback verdict supersede a gpt-5 one for the same scenario", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-01-01-gpt5.json"),
        JSON.stringify({ when: "2026-01-01", model_by_agent: { "root-cause": "gpt-5-2025-08-07" }, scored: { alpha: "correct" } }));
      writeFileSync(join(d, "runs", "2026-06-06-grok.json"),
        JSON.stringify({ when: "2026-06-06", model_by_agent: { "root-cause": "grok-4.3" }, scored: { alpha: "wrong" } }));
      const r = latestScoredPerScenario(join(d, "runs"));
      expect(r.scored.alpha, "the primary gpt-5 verdict stands; the newer grok one is demoted").toBe("correct");
      expect(r.from.alpha).toBe("2026-01-01-gpt5.json");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("still uses a grok verdict when NO primary record established the scenario", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-06-06-grok.json"),
        JSON.stringify({ when: "2026-06-06", model_by_agent: { "root-cause": "grok-4.3" }, scored: { beta: "correct" } }));
      const r = latestScoredPerScenario(join(d, "runs"));
      expect(r.scored.beta, "a fallback verdict beats none when nothing primary answered").toBe("correct");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("treats a record naming no model as primary — the gpt-5 era wrote no marker", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-01-01-unmarked.json"),
        JSON.stringify({ when: "2026-01-01", scored: { gamma: "correct" } }));
      writeFileSync(join(d, "runs", "2026-06-06-grok.json"),
        JSON.stringify({ when: "2026-06-06", model_by_agent: { "root-cause": "grok-4.3" }, scored: { gamma: "wrong" } }));
      expect(latestScoredPerScenario(join(d, "runs")).scored.gamma,
        "an unmarked (pre-marker) record is primary and is not superseded by a grok one").toBe("correct");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("does not treat an empty scored object as a run that answered nothing", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-01-01-a.json"), JSON.stringify({ scored: {} }));
      expect(latestScored(join(d, "runs")).scored).toBe(null);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  /*
   * Reversed on 2026-09-07, and the reversal is the point.
   *
   * This used to assert that an unreadable record does not stop the search — so
   * a truncated NEWEST record was skipped in silence and readiness answered
   * from an older run, reporting green for a scenario the newest run had scored
   * `wrong`. A subagent measured it. "One bad file must not blind the count"
   * sounds right and is the flattering direction: it answers from a record that
   * has been superseded by one nobody can read.
   *
   * Stopping is not blindness. It is the third state, said out loud.
   */
  it("stops at an unreadable record rather than answering from an older one", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-01-01-good.json"),
        JSON.stringify({ when: "2026-01-01", scored: { a: "correct" } }));
      writeFileSync(join(d, "runs", "2026-03-03-broken.json"), "{ not json");
      const r = latestScored(join(d, "runs"));
      expect(r.scored, "a superseded record must not answer for the newest one").toBe(null);
      expect(r.unreadable).toBe("2026-03-03-broken.json");
      expect(r.why).toMatch(/could not be read/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("breaks a tie between records of the same day by name, not by directory order", () => {
    /*
     * Every real record carries a date with no time, so ties are the normal
     * case — and the comparator returned 0, leaving the winner to readdirSync.
     * A subagent scored two records of one day differently on 2026-09-07 and
     * the SECOND run of the day beat the sixth.
     */
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-06-06-second.json"),
        JSON.stringify({ when: "2026-06-06", scored: { a: "wrong" } }));
      writeFileSync(join(d, "runs", "2026-06-06-sixth.json"),
        JSON.stringify({ when: "2026-06-06", scored: { a: "correct" } }));
      const r = latestScored(join(d, "runs"));
      expect(r.file, "the later name wins, and it wins every time").toBe("2026-06-06-sixth.json");
      expect(r.scored).toEqual({ a: "correct" });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  /*
   * The scorer has its own three states and they must survive the journey into
   * this file. Codex, 2026-09-07: every recorded state other than "correct" was
   * mapped to red, including the scorer's own "unestablished" — so RECORDING
   * that a scenario went unanswered turned it from unknown into failed, which
   * is the exact collapse this file exists to refuse.
   */
  it("lets the worst attempt decide, so two of three is not a fix", () => {
    /*
     * The point of repeating a measurement is to separate a fix from luck. Two
     * correct and one wrong is not a fix, and a figure that reported it as one
     * would be the flattery this file exists to refuse. This reader saw only
     * the bare scenario key, so attempts were invisible to it — the same defect
     * Codex found in the scorer on 2026-09-08, one reader over.
     */
    const d = tmp();
    try {
      for (const n of ["alpha", "beta"]) mkdirSync(join(d, "scenarios", n), { recursive: true });
      mkdirSync(join(d, "docs", "runs"), { recursive: true });
      writeFileSync(join(d, "docs", "runs", "2026-09-08-a.json"), JSON.stringify({
        when: "2026-09-08",
        scored: { alpha: "correct", "alpha#2": "correct", "alpha#3": "wrong",
                  beta: "correct", "beta#2": "correct" },
      }));
      const byId = new Map<string, { state: string; why: string }>(
        scenariosMeasured(d).map((c: any) => [c.id as string, c as { state: string; why: string }]));
      expect(byId.get("scenario-alpha")!.state, "one wrong attempt is not a passing scenario").toBe("red");
      expect(byId.get("scenario-alpha")!.why, "and the report must say how many there were")
        .toMatch(/3 attempts, worst kept/);
      expect(byId.get("scenario-beta")!.state, "every attempt correct is correct").toBe("green");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("walks past a record that carries no verdicts to one that does", () => {
    /*
     * The runner writes a record the moment a paid call arrives, with `scored`
     * still null — the scorer fills it later. That record is newer than every
     * earlier one, so if it were taken as the answer it would silently replace
     * a run that DID score, and the reason printed would be "no run record
     * scores this scenario", which is false while an older file does.
     *
     * Grok raised it on 2026-09-08 from a partial reading of this file; the
     * skip was already here and nothing pinned it. This pins it.
     */
    const d = tmp();
    try {
      mkdirSync(join(d, "scenarios", "alpha"), { recursive: true });
      mkdirSync(join(d, "docs", "runs"), { recursive: true });
      writeFileSync(join(d, "docs", "runs", "2026-09-07-old.json"), JSON.stringify({
        when: "2026-09-07", scored: { alpha: "correct" },
      }));
      writeFileSync(join(d, "docs", "runs", "2026-09-08-new.json"), JSON.stringify({
        when: "2026-09-08", totals: { input_tokens: null, output_tokens: null }, scored: null,
      }));
      /*
       * And the harder shape: a record with KEYS, none of which is a verdict.
       * The scorer writes one key per scenario whatever happened, so this is
       * what a staged part looks like the moment it is scored. Counting keys
       * alone let it outrank an older record that really had answers — Codex,
       * 2026-09-08, after the same predicate had been strengthened in the gate
       * and not here.
       */
      writeFileSync(join(d, "docs", "runs", "2026-09-08-zz-newer.json"), JSON.stringify({
        when: "2026-09-08", scored: { alpha: "unasked", beta: "unestablished" },
      }));
      const l = latestScored(join(d, "docs", "runs"));
      expect(l.file, "the newer record says nothing, so it is not the answer").toBe("2026-09-07-old.json");
      expect(l.scored).toEqual({ alpha: "correct" });
      const c = scenariosMeasured(d).find((x: any) => x.id === "scenario-alpha");
      expect(c!.state, "and the verdict that exists is still read").toBe("green");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("does not let a record whose date is not a date outrank a dated one", () => {
    /*
     * `when` was any non-empty string, and records are ordered by comparing it
     * as TEXT — so "unknown" sorted ahead of every real date, claimed the
     * scenario, and a wrong attempt from the newest run was replaced by an
     * older correct one. Readiness went green. Codex, 2026-09-09.
     */
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "new.json"),
        JSON.stringify({ when: "2026-09-09", scored: { "alpha#1": "wrong" } }));
      writeFileSync(join(d, "runs", "old.json"),
        JSON.stringify({ when: "unknown", scored: { "alpha#2": "correct" } }));
      expect(latestScoredPerScenario(join(d, "runs")).scored,
        "a record that gives no usable date is undated, and undated never wins")
        .toEqual({ "alpha#1": "wrong" });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("does not count a placeholder from one file as an attempt made in another", () => {
    /*
     * A newer record said `alpha: unasked`; an older one had actually tried
     * twice and established nothing. Merged key by key, the reader said "not
     * established in new.json (3 attempts)" — counting the placeholder, and
     * naming the file that holds only it. Codex, 2026-09-09.
     */
    const d = tmp();
    try {
      mkdirSync(join(d, "scenarios", "alpha"), { recursive: true });
      mkdirSync(join(d, "docs", "runs"), { recursive: true });
      writeFileSync(join(d, "docs", "runs", "2026-09-09-new.json"),
        JSON.stringify({ when: "2026-09-09", scored: { alpha: "unasked" } }));
      writeFileSync(join(d, "docs", "runs", "2026-01-01-old.json"), JSON.stringify({
        when: "2026-01-01",
        scored: { "alpha#1": "unestablished", "alpha#2": "unestablished" } }));
      const c = scenariosMeasured(d).find((x: any) => x.id === "scenario-alpha");
      expect(c!.state).toBe("unestablished");
      expect(c!.why, "one file's placeholder is not three attempts").not.toMatch(/3 attempts/);
      expect(c!.why, "and the file named is the one the row came from").toContain("2026-09-09-new.json");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("names the file of a winning record whose only verdict is a later attempt", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "scenarios", "alpha"), { recursive: true });
      mkdirSync(join(d, "docs", "runs"), { recursive: true });
      writeFileSync(join(d, "docs", "runs", "2026-09-09-new.json"),
        JSON.stringify({ when: "2026-09-09", scored: { "alpha#2": "correct" } }));
      const c = scenariosMeasured(d).find((x: any) => x.id === "scenario-alpha");
      expect(c!.why, "any attempt of the scenario names the file, not only the bare key or #1")
        .toContain("2026-09-09-new.json");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("lets a newer measurement replace the whole scenario, not one attempt key", () => {
    /*
     * An older record scored `alpha#1` correct and `alpha#2` wrong. The newer
     * one repeated only `alpha#1`. Merging key by key kept the older `#2`, so
     * the worst-of rule reported the scenario WRONG from an attempt the newest
     * measurement never made — and named the newer file as its source.
     * Codex reproduced it on 2026-09-09.
     */
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-01-01-a.json"),
        JSON.stringify({ when: "2026-01-01", scored: { "alpha#1": "correct", "alpha#2": "wrong" } }));
      writeFileSync(join(d, "runs", "2026-06-01-b.json"),
        JSON.stringify({ when: "2026-06-01", scored: { "alpha#1": "correct" } }));
      const r = latestScoredPerScenario(join(d, "runs"));
      expect(r.scored, "the newest record that established anything takes the scenario whole")
        .toEqual({ "alpha#1": "correct" });
      expect(r.from!["alpha#1"], "and the verdict is attributed to the file it came from")
        .toBe("2026-06-01-b.json");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("keeps every attempt of the record that claims the scenario", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-01-01-a.json"),
        JSON.stringify({ when: "2026-01-01", scored: { "alpha#1": "correct" } }));
      writeFileSync(join(d, "runs", "2026-06-01-b.json"),
        JSON.stringify({ when: "2026-06-01", scored: { "alpha#1": "correct", "alpha#2": "wrong" } }));
      expect(latestScoredPerScenario(join(d, "runs")).scored,
        "a repeat that answered twice is two attempts, and the worst of them still counts")
        .toEqual({ "alpha#1": "correct", "alpha#2": "wrong" });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("does not let a bare unestablished row outvote answered attempts of the same scenario", () => {
    /*
     * A run bought in parts writes the bare key `alpha` from the part that did
     * not ask, and `alpha#1` from the part that did. The fallback merge matched
     * on the EXACT key, so the bare `unestablished` row survived beside the
     * answered attempt and the scenario reported unestablished, citing the
     * older file. Codex reproduced it on 2026-09-09.
     */
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-01-01-a.json"),
        JSON.stringify({ when: "2026-01-01", scored: { alpha: "unestablished" } }));
      writeFileSync(join(d, "runs", "2026-06-01-b.json"),
        JSON.stringify({ when: "2026-06-01", scored: { "alpha#1": "correct" } }));
      const scored = latestScoredPerScenario(join(d, "runs")).scored;
      expect(scored, "an attempt that answered is not unanswered by a part that did not ask")
        .toEqual({ "alpha#1": "correct" });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("carries the record parsed while unreadability was decided, not a second read", () => {
    /*
     * The records were read and parsed TWICE: once to find the date and catch
     * an unreadable file, once again — outside any catch — to hand them back.
     * A record that changed between the two made readiness throw instead of
     * answering unestablished.
     */
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-02-02-a.json"),
        JSON.stringify({ when: "2026-02-02", scored: { alpha: "correct" }, note: "kept" }));
      const r = orderedRecords(join(d, "runs"));
      expect(r.records.length).toBe(1);
      expect(r.records[0].rec, "the parsed object travels with the file it came from")
        .toEqual({ when: "2026-02-02", scored: { alpha: "correct" }, note: "kept" });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("does not let a row saying nobody asked outvote the attempts that answered", () => {
    /*
     * A run bought in parts writes one record, so a scenario answered under
     * three attempt keys also carries a bare row from the parts that bought
     * something else. Counting that row turned six correct measurements into
     * two unanswered scenarios — Codex, 2026-09-08, against the staged purchase.
     */
    const d = tmp();
    try {
      for (const n of ["alpha", "beta"]) mkdirSync(join(d, "scenarios", n), { recursive: true });
      mkdirSync(join(d, "docs", "runs"), { recursive: true });
      writeFileSync(join(d, "docs", "runs", "2026-09-08-a.json"), JSON.stringify({
        when: "2026-09-08",
        scored: { alpha: "unasked", "alpha#1": "correct", "alpha#2": "correct", "alpha#3": "correct",
                  beta: "unasked" },
      }));
      const byId = new Map<string, { state: string; why: string }>(
        scenariosMeasured(d).map((c: any) => [c.id as string, c as { state: string; why: string }]));
      expect(byId.get("scenario-alpha")!.state, "three correct attempts are a correct scenario").toBe("green");
      expect(byId.get("scenario-alpha")!.why, "and only the attempts are counted")
        .toMatch(/3 attempts/);
      expect(byId.get("scenario-beta")!.state,
        "but a scenario where nobody asked at all is still unknown").toBe("unestablished");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("names the worst attempt by rank, not by the order they arrived", () => {
    /*
     * Codex, 2026-09-08: the first version took whichever failing state came
     * first, so a scenario that was both correct-without-its-evidence and
     * correct-but-unqualified reported a different reason depending on the
     * order the keys sat in. Both are red either way — the figure did not move,
     * the REASON moved, and a reason that changes with the order is not a
     * reading of anything.
     */
    const d = tmp();
    try {
      for (const n of ["alpha", "beta"]) mkdirSync(join(d, "scenarios", n), { recursive: true });
      mkdirSync(join(d, "docs", "runs"), { recursive: true });
      writeFileSync(join(d, "docs", "runs", "2026-09-08-a.json"), JSON.stringify({
        when: "2026-09-08",
        scored: { "alpha#1": "correct-without-its-evidence", "alpha#2": "correct-but-unqualified",
                  "beta#1": "correct-but-unqualified", "beta#2": "correct-without-its-evidence" },
      }));
      const byId = new Map<string, { state: string; why: string }>(
        scenariosMeasured(d).map((c: any) => [c.id as string, c as { state: string; why: string }]));
      const a = byId.get("scenario-alpha")!;
      const b = byId.get("scenario-beta")!;
      expect(a.state).toBe("red");
      expect(b.state).toBe("red");
      expect(b.why.replace("beta", "alpha"), "the same two states must read the same either way")
        .toBe(a.why);
      expect(a.why, "and the one that is worse is the one that is named")
        .toMatch(/^correct-without-its-evidence/);
      expect(a.why, "the other is still said, so nothing is dropped")
        .toMatch(/also correct-but-unqualified/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("keeps the scorer's own unestablished state instead of calling it a failure", () => {
    const d = tmp();
    try {
      for (const n of ["alpha", "beta", "gamma"]) mkdirSync(join(d, "scenarios", n), { recursive: true });
      mkdirSync(join(d, "docs", "runs"), { recursive: true });
      writeFileSync(join(d, "docs", "runs", "2026-01-01-a.json"), JSON.stringify({
        scored: { alpha: "correct", beta: "wrong", gamma: "unestablished" },
      }));
      const byId = new Map<string, { state: string }>(
        scenariosMeasured(d).map((c: any) => [c.id as string, c as { state: string }]));
      expect(byId.get("scenario-alpha")!.state).toBe("green");
      expect(byId.get("scenario-beta")!.state, "a wrong answer is established and red").toBe("red");
      expect(byId.get("scenario-gamma")!.state,
        "a run that did not answer establishes nothing, and recording that must not create a failure")
        .toBe("unestablished");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  /*
   * out/ is gitignored, so in a fresh clone the gate has not run. That is
   * unestablished — never green, and never red either: "I could not look" is
   * not "it failed".
   */
  it("calls the gate unestablished when no gate result exists here", () => {
    const d = tmp();
    try {
      expect(gateResult(d)[0].state).toBe("unestablished");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  /*
   * A gate result older than the tree is not a statement about this tree.
   *
   * This file reported "the acceptance gate passed", present tense, from an
   * artifact with no date — so a subagent on 2026-09-07 could read the mtimes
   * side by side and find five mutations and a whole uncommitted diff
   * postdating the green being reported. The same staleness the gate itself
   * refuses for its vitest report, one reader over.
   */
  it("refuses a gate result that predates the tree it is asked about", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "out"), { recursive: true });
      mkdirSync(join(d, "src"), { recursive: true });
      writeFileSync(join(d, "src", "thing.ts"), "export const a = 1;");
      const edited = statSync(join(d, "src", "thing.ts")).mtimeMs;

      writeFileSync(join(d, "out", "acceptance-gate.json"),
        JSON.stringify({ exitCode: 0, finishedAt: edited - 5000 }));
      const stale = gateResult(d)[0];
      expect(stale.state, "a green from before the edit is not about this tree").toBe("unestablished");
      expect(stale.why).toMatch(/src\/thing\.ts/);

      writeFileSync(join(d, "out", "acceptance-gate.json"),
        JSON.stringify({ exitCode: 0, finishedAt: edited + 5000 }));
      expect(gateResult(d)[0].state, "and a green from after it is").toBe("green");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("refuses a gate result that carries no time at all", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "out"), { recursive: true });
      writeFileSync(join(d, "out", "acceptance-gate.json"), JSON.stringify({ exitCode: 0 }));
      const r = gateResult(d)[0];
      expect(r.state, "undateable is not green").toBe("unestablished");
      expect(r.why).toMatch(/carries no time/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("names the file that outran the gate, rather than only saying stale", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "scripts"), { recursive: true });
      writeFileSync(join(d, "scripts", "later.mjs"), "// x");
      const at = statSync(join(d, "scripts", "later.mjs")).mtimeMs;
      expect(sourceNewerThan(d, at - 1000)).toBe("scripts/later.mjs");
      expect(sourceNewerThan(d, at + 1000), "nothing newer, so nothing to name").toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("keeps the gate's four exit codes apart instead of folding them into two", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "out"), { recursive: true });
      // Dated into the future, so the freshness check above is satisfied and
      // this test is about the exit code and nothing else.
      const fresh = Date.now() + 60_000;
      writeFileSync(join(d, "out", "acceptance-gate.json"), JSON.stringify({ exitCode: 0, finishedAt: fresh }));
      expect(gateResult(d)[0].state).toBe("green");
      /*
       * The gate has FOUR exit codes and this test used to pin two of them
       * together: `exitCode: 2` was asserted to be red, which is the collapse
       * the whole file exists to refuse, enshrined by the test that should have
       * caught it. A subagent found it on 2026-09-09.
       */
      writeFileSync(join(d, "out", "acceptance-gate.json"), JSON.stringify({ exitCode: 1, finishedAt: fresh }));
      expect(gateResult(d)[0].state, "something failed is red").toBe("red");
      writeFileSync(join(d, "out", "acceptance-gate.json"), JSON.stringify({ exitCode: 2, finishedAt: fresh }));
      expect(gateResult(d)[0].state, "could not establish is not failed").toBe("unestablished");
      writeFileSync(join(d, "out", "acceptance-gate.json"), JSON.stringify({ exitCode: 3, finishedAt: fresh }));
      expect(gateResult(d)[0].state, "a real failure beside an unknown is still red").toBe("red");
      writeFileSync(join(d, "out", "acceptance-gate.json"), JSON.stringify({ nothing: true, finishedAt: fresh }));
      expect(gateResult(d)[0].state, "a result with no exit code establishes nothing").toBe("unestablished");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

/*
 * The run is bought in PARTS, so no single record holds every scenario.
 *
 * Measured on 2026-09-07 minutes after it happened: part 1 established
 * readiness-probe-failure correct three times, readiness went 31% to 36%, part
 * 2 was bought next, and the figure fell straight back to 31% — because part
 * 2's record says nothing about readiness-probe-failure and the counter read
 * only the newest record. A later run that did not ASK a question does not
 * unanswer it.
 */
describe("a verdict survives a later run that did not ask the question", () => {
  const twoParts = () => {
    const d = tmp();
    mkdirSync(join(d, "runs"), { recursive: true });
    writeFileSync(join(d, "runs", "2026-09-07-part1.json"), JSON.stringify({
      when: "2026-09-07", scored: { "readiness-probe-failure#1": "correct", "image-pull-failure": "unasked" },
    }));
    writeFileSync(join(d, "runs", "2026-09-07-part2.json"), JSON.stringify({
      when: "2026-09-07", scored: { "image-pull-failure#1": "wrong", "readiness-probe-failure": "unasked" },
    }));
    return d;
  };

  it("keeps what an earlier part established", () => {
    const d = twoParts();
    try {
      const r = latestScoredPerScenario(join(d, "runs"));
      expect(r.scored, "the earlier part's verdict was lost").toHaveProperty(
        "readiness-probe-failure#1", "correct");
      expect(r.scored).toHaveProperty("image-pull-failure#1", "wrong");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("does not let unasked or unestablished overwrite a real verdict", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-01-01-a.json"),
        JSON.stringify({ when: "2026-01-01", scored: { alpha: "correct" } }));
      writeFileSync(join(d, "runs", "2026-06-06-b.json"),
        JSON.stringify({ when: "2026-06-06", scored: { alpha: "unasked" } }));
      expect(latestScoredPerScenario(join(d, "runs")).scored,
        "a question nobody asked says nothing about the answer").toHaveProperty("alpha", "correct");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("lets a newer REAL verdict replace an older one, because that is a re-measurement", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-01-01-a.json"),
        JSON.stringify({ when: "2026-01-01", scored: { alpha: "correct" } }));
      writeFileSync(join(d, "runs", "2026-06-06-b.json"),
        JSON.stringify({ when: "2026-06-06", scored: { alpha: "wrong" } }));
      expect(latestScoredPerScenario(join(d, "runs")).scored).toHaveProperty("alpha", "wrong");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("names the record each verdict came from, not one file for all of them", () => {
    const d = twoParts();
    try {
      const checks = scenariosMeasured(d);
      void checks;
      const r = latestScoredPerScenario(join(d, "runs"));
      expect(r.from!["readiness-probe-failure#1"]).toBe("2026-09-07-part1.json");
      expect(r.from!["image-pull-failure#1"]).toBe("2026-09-07-part2.json");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("the newest run of a day wins by its NUMBER, not its name", () => {
  /*
   * The same-day tie-break compared filenames as strings, so
   * `...run-9.json` sorted after `...run-10.json` (because "1" < "9") and the
   * ninth run was taken as newer than the tenth. It held only while run numbers
   * had one digit. Measured on 2026-09-11: node-not-ready#3 was scored correct
   * in run-10 and readiness kept reporting run-9's older wrong-ground verdict.
   */
  it("orders run-9 before run-10 as older, the way a human counts", () => {
    expect(naturalOlderToNewer("x-run-9.json", "x-run-10.json")).toBeLessThan(0);
    expect(naturalOlderToNewer("x-run-10.json", "x-run-9.json")).toBeGreaterThan(0);
    expect(naturalOlderToNewer("x-part2.json", "x-part10.json")).toBeLessThan(0);
    expect(naturalOlderToNewer("x-run-6.json", "x-run-6.json")).toBe(0);
  });

  it("lets run-10's verdict supersede run-9's for the same scenario", () => {
    const d = mkdtempSync(join(tmpdir(), "ready-"));
    const runs = join(d, "runs"); mkdirSync(runs, { recursive: true });
    // Same date, run-9 older wrong-ground, run-10 newer correct. String order
    // would pick run-9; number order must pick run-10.
    writeFileSync(join(runs, "2026-09-11-webhook-run-9.json"), JSON.stringify({
      when: "2026-09-11", scored: { "alpha#2": "correct-without-its-evidence" } }));
    writeFileSync(join(runs, "2026-09-11-webhook-run-10.json"), JSON.stringify({
      when: "2026-09-11", scored: { "alpha#3": "correct" } }));
    const r = latestScoredPerScenario(runs);
    // Keyed by the attempt key, and the newest attempt (run-10's alpha#3) is
    // the one kept; run-9's alpha#2 is superseded, not carried beside it.
    expect(r.scored["alpha#3"], "the tenth run is the newest, and it scored correct").toBe("correct");
    expect(r.scored["alpha#2"], "the ninth run's attempt does not survive").toBeUndefined();
    expect(r.from["alpha#3"]).toContain("run-10");
  });
});
