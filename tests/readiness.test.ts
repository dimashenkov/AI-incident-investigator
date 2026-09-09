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
import { definitionOfDone, latestScored, summarise, oneLine, bar, gateResult, scenariosMeasured, sourceNewerThan } from "../scripts/readiness.mjs";
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
