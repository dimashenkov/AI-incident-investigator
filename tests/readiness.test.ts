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
import { definitionOfDone, latestScored, summarise, oneLine, bar, gateResult, scenariosMeasured } from "../scripts/readiness.mjs";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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

  it("does not treat an empty scored object as a run that answered nothing", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-01-01-a.json"), JSON.stringify({ scored: {} }));
      expect(latestScored(join(d, "runs")).scored).toBe(null);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("does not let an unreadable record stop it finding an older good one", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "runs"), { recursive: true });
      writeFileSync(join(d, "runs", "2026-01-01-good.json"), JSON.stringify({ scored: { a: "correct" } }));
      writeFileSync(join(d, "runs", "2026-03-03-broken.json"), "{ not json");
      expect(latestScored(join(d, "runs")).file).toBe("2026-01-01-good.json");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  /*
   * The scorer has its own three states and they must survive the journey into
   * this file. Codex, 2026-09-07: every recorded state other than "correct" was
   * mapped to red, including the scorer's own "unestablished" — so RECORDING
   * that a scenario went unanswered turned it from unknown into failed, which
   * is the exact collapse this file exists to refuse.
   */
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

  it("reads a recorded gate result in both directions", () => {
    const d = tmp();
    try {
      mkdirSync(join(d, "out"), { recursive: true });
      writeFileSync(join(d, "out", "acceptance-gate.json"), JSON.stringify({ exitCode: 0 }));
      expect(gateResult(d)[0].state).toBe("green");
      writeFileSync(join(d, "out", "acceptance-gate.json"), JSON.stringify({ exitCode: 2 }));
      expect(gateResult(d)[0].state).toBe("red");
      writeFileSync(join(d, "out", "acceptance-gate.json"), JSON.stringify({ nothing: true }));
      expect(gateResult(d)[0].state, "a result with no exit code establishes nothing").toBe("unestablished");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
