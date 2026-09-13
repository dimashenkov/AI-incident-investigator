/**
 * The eval loop's judgement. The point (owner + Grok, 2026-09-13): "better" must be
 * distinguished from "different" when the model is non-deterministic. So a failure
 * only counts if it is STICKY across k attempts, and a prompt change is kept only if
 * a sticky problem flips to green with no stable-green regression.
 */
import { describe, it, expect } from "vitest";
import { grade, stickiness, keepRule, diagnose } from "../src/core/eval.js";

describe("grade", () => {
  it("maps score states to pass / degraded / fail / unknown", () => {
    expect(grade("correct")).toBe("pass");
    expect(grade("correct-without-its-evidence")).toBe("degraded");
    expect(grade("correct-but-unqualified")).toBe("degraded");
    expect(grade("wrong")).toBe("fail");
    expect(grade("unasked")).toBe("unknown");
    expect(grade("unestablished")).toBe("unknown");
  });
});

describe("stickiness", () => {
  it("calls three wrong a sticky problem, not noise", () => {
    const s = stickiness(["wrong", "wrong", "wrong"]);
    expect(s.majority).toBe("fail");
    expect(s.stickyProblem).toBe(true);
    expect(s.stableGreen).toBe(false);
  });

  it("calls one-of-three noise — a strict majority is needed", () => {
    const s = stickiness(["correct", "correct", "wrong"]);
    expect(s.majority).toBe("pass");
    expect(s.stableGreen).toBe(true);
    expect(s.stickyProblem).toBe(false);
  });

  it("calls a split 'mixed' — not reproducible, not decided", () => {
    const s = stickiness(["correct", "wrong", "unasked"]);
    expect(s.majority).toBe("mixed");
    expect(s.stickyProblem).toBe(false);
    expect(s.stableGreen).toBe(false);
  });

  it("counts unknown toward the total, so a once-answered scenario is not 'decided'", () => {
    const s = stickiness(["correct", "unasked", "unasked"]);
    expect(s.majority).toBe("unknown");   // 2/3 unknown wins, not the single pass
    expect(s.stableGreen).toBe(false);
  });

  it("calls fewer than k=3 attempts 'insufficient' — one wrong is not sticky", () => {
    // Grok, 2026-09-13: without a floor, a single wrong run reads as a sticky
    // failure. It is an unrun experiment, not a measurement.
    const one = stickiness(["wrong"]);
    expect(one.majority).toBe("insufficient");
    expect(one.stickyProblem, "one run is never a sticky problem").toBe(false);
    expect(one.stableGreen).toBe(false);
    const two = stickiness(["correct", "correct"]);
    expect(two.majority).toBe("insufficient");
    expect(two.stableGreen, "two greens are still below the floor").toBe(false);
  });
});

const sticky = (states: string[]) => stickiness(states);

describe("keepRule", () => {
  it("keeps a change that flips a sticky failure to green and regresses nothing", () => {
    const before = { oom: sticky(["wrong", "wrong", "wrong"]), dns: sticky(["correct", "correct", "correct"]) };
    const after = { oom: sticky(["correct", "correct", "correct"]), dns: sticky(["correct", "correct", "correct"]) };
    const v = keepRule(before, after);
    expect(v.keep).toBe(true);
    expect(v.flipped).toContain("oom");
    expect(v.regressed).toEqual([]);
  });

  it("REJECTS a change that fixes one but regresses a stable-green scenario", () => {
    const before = { oom: sticky(["wrong", "wrong", "wrong"]), dns: sticky(["correct", "correct", "correct"]) };
    const after = { oom: sticky(["correct", "correct", "correct"]), dns: sticky(["wrong", "wrong", "wrong"]) };
    const v = keepRule(before, after);
    expect(v.keep, "a regression sinks the change even if it fixed something").toBe(false);
    expect(v.regressed).toContain("dns");
  });

  it("REJECTS a change that fixes nothing — different is not better", () => {
    const before = { oom: sticky(["wrong", "wrong", "wrong"]) };
    const after = { oom: sticky(["wrong", "correct", "wrong"]) };  // still majority-fail
    const v = keepRule(before, after);
    expect(v.keep).toBe(false);
    expect(v.flipped).toEqual([]);
  });

  it("treats a MIXED scenario becoming a sticky FAIL as a regression (Grok's re-review case)", () => {
    // The rank bug: fail once ranked ABOVE mixed, so mixed->fail read as a rise and
    // the change shipped. A sticky failure is worse than 'not established'.
    const before = { oom: sticky(["wrong", "wrong", "wrong"]), dns: sticky(["correct", "wrong", "unasked"]) };
    const after = { oom: sticky(["correct", "correct", "correct"]), dns: sticky(["wrong", "wrong", "wrong"]) };
    const v = keepRule(before, after);
    expect(v.keep, "making a mixed scenario a sticky failure must block the keep").toBe(false);
    expect(v.regressed).toContain("dns");
  });

  it("treats a stable green falling to MIXED as a regression (lost stability)", () => {
    // Grok hole: green->mixed was not a regression before. Losing a reproducible
    // green IS worse, even if it did not become an outright failure.
    const before = { oom: sticky(["wrong", "wrong", "wrong"]), dns: sticky(["correct", "correct", "correct"]) };
    const after = { oom: sticky(["correct", "correct", "correct"]), dns: sticky(["correct", "wrong", "unasked"]) };
    const v = keepRule(before, after);
    expect(v.keep).toBe(false);
    expect(v.regressed).toContain("dns");
  });

  it("treats degraded worsening to fail as a regression", () => {
    const before = { a: sticky(["wrong", "wrong", "wrong"]),
      b: sticky(["correct-without-its-evidence", "correct-without-its-evidence", "correct-without-its-evidence"]) };
    const after = { a: sticky(["correct", "correct", "correct"]), b: sticky(["wrong", "wrong", "wrong"]) };
    const v = keepRule(before, after);
    expect(v.keep, "degraded->fail is worse and blocks the keep").toBe(false);
    expect(v.regressed).toContain("b");
  });

  it("REJECTS keeping when a prior stable green was not re-measured", () => {
    // Measuring only the failure you fixed, and skipping the greens, can silently
    // break one — so an unmeasured prior green blocks the keep.
    const before = { oom: sticky(["wrong", "wrong", "wrong"]), dns: sticky(["correct", "correct", "correct"]) };
    const after = { oom: sticky(["correct", "correct", "correct"]) };  // dns not re-run
    const v = keepRule(before, after);
    expect(v.keep).toBe(false);
    expect(v.unmeasuredGreens).toContain("dns");
  });
});

describe("diagnose — WHERE a scenario fails, as detail under the verdict (Grok 2026-09-13)", () => {
  it("aggregates wrong-code confusion with counts, most frequent first", () => {
    const d = diagnose([
      { state: "wrong", got: "APPLICATION_STARTUP_FAILURE", expected: "DEPLOYMENT_REGRESSION" },
      { state: "wrong", got: "APPLICATION_STARTUP_FAILURE", expected: "DEPLOYMENT_REGRESSION" },
      { state: "wrong", got: "CONFIG_ERROR", expected: "DEPLOYMENT_REGRESSION" },
    ]);
    expect(d.codeConfusion[0]).toEqual({ got: "APPLICATION_STARTUP_FAILURE", want: "DEPLOYMENT_REGRESSION", count: 2 });
    expect(d.lines[0]).toContain("got APPLICATION_STARTUP_FAILURE, want DEPLOYMENT_REGRESSION");
  });

  it("unions missed citations across attempts with per-path counts", () => {
    const d = diagnose([
      { state: "correct-without-its-evidence", code: "OOM", missingCitations: ["metrics.series[0].points[3]"] },
      { state: "correct-without-its-evidence", code: "OOM", missingCitations: ["metrics.series[0].points[3]", "logs.lines[2]"] },
      { state: "correct", code: "OOM", missingCitations: [] },
    ]);
    expect(d.uncited).toBe(2);
    expect(d.missedCitations[0]).toEqual({ path: "metrics.series[0].points[3]", count: 2 });
    expect(d.lines.some((l) => l.includes("metrics.series[0].points[3] (×2)"))).toBe(true);
  });

  it("reports the unqualified axis with its reason", () => {
    const d = diagnose([
      { state: "correct-but-unqualified", code: "OOM", why: "confidence 0.8 exceeds the 0.6 ceiling", missingCitations: [] },
      { state: "correct", code: "OOM", missingCitations: [] },
      { state: "correct", code: "OOM", missingCitations: [] },
    ]);
    expect(d.unqualified).toBe(1);
    expect(d.lines.some((l) => l.startsWith("unqualified") && l.includes("0.6 ceiling"))).toBe(true);
  });

  it("reads `why` as the string[] score() actually returns for correct-but-unqualified (Grok re-review)", () => {
    // The live object is a LIST, not a string: score() returns why: [...] for this
    // state. A string-only reader would stringify "[object]" or dedup a Set by
    // reference. diagnose must surface the actual reason text.
    const d = diagnose([
      { state: "correct-but-unqualified", code: "OOM", why: ["confidence 0.8 exceeds the 0.6 ceiling"], missingCitations: [] },
      { state: "correct-but-unqualified", code: "OOM", why: ["confidence 0.8 exceeds the 0.6 ceiling"], missingCitations: [] },
      { state: "correct", code: "OOM", missingCitations: [] },
    ]);
    expect(d.unqualifiedReasons).toEqual(["confidence 0.8 exceeds the 0.6 ceiling"]); // deduped by value, not reference
    expect(d.lines.some((l) => l.startsWith("unqualified") && l.includes("0.6 ceiling"))).toBe(true);
  });

  it("gives each axis its OWN reason — an unasked reason never rides the unqualified line (Grok's swap case)", () => {
    // The shared-reasons bug: reasons[0] was the first-by-attempt-order, so an
    // unasked scenario's "no answer" text printed on the unqualified line and the
    // real unqualified reason moved to unresolved. Each axis must carry its own.
    const d = diagnose([
      { state: "unasked", expected: "OOM", why: "no answer was recorded" },
      { state: "correct-but-unqualified", code: "OOM", why: ["confidence 0.8 exceeds the 0.6 ceiling"], missingCitations: [] },
      { state: "correct", code: "OOM", missingCitations: [] },
    ]);
    const unq = d.lines.find((l) => l.startsWith("unqualified"))!;
    const unr = d.lines.find((l) => l.startsWith("unresolved"))!;
    expect(unq, "unqualified line carries the ceiling reason").toContain("0.6 ceiling");
    expect(unq, "not the unasked reason").not.toContain("no answer");
    expect(unr, "unresolved line carries the unasked reason").toContain("no answer was recorded");
    expect(unr).not.toContain("0.6 ceiling");
  });

  it("is DETAIL only — a clean sweep yields no lines, so it never speaks over a green verdict", () => {
    const d = diagnose([
      { state: "correct", code: "OOM", missingCitations: [] },
      { state: "correct", code: "OOM", missingCitations: [] },
      { state: "correct", code: "OOM", missingCitations: [] },
    ]);
    expect(d.lines).toEqual([]);
    expect(d.codeConfusion).toEqual([]);
    expect(d.missedCitations).toEqual([]);
  });

  it("does not invent a reason where none was recorded", () => {
    const d = diagnose([{ state: "unasked", expected: "OOM", why: "no answer was recorded" }]);
    expect(d.unresolved).toBe(1);
    expect(d.lines[0]).toContain("no answer was recorded");
  });
});
