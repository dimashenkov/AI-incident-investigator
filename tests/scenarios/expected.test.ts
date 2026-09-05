/**
 * The expected.json files are claims. Something has to read them.
 *
 * Codex, chunk 2: "Nothing reads or validates them. Consequently an invalid
 * cause code, misspelled evidence path, or contradictory expectation passes
 * every gate — the CPU omission demonstrates this already."
 *
 * It did. The cpu-throttling scenario expected CPU_THROTTLING, which the schema
 * did not permit, so the correct answer to that scenario could never have been
 * recorded. A file stating what a run should conclude, that nothing checks, is
 * the defect this project keeps finding, in fixture form.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { listScenarios, readScenario } from "../../src/providers/fixtures.js";
import commonSchema from "../../schemas/common.schema.json" with { type: "json" };

const ROOT = new URL("../../scenarios/", import.meta.url).pathname;

/**
 * What a scenario may expect: a named cause from the shared list, or the
 * verdict that the evidence does not support one. Read from the carrier rather
 * than from the incident schema, which now composes the two.
 */
const CAUSE_CODES: string[] = [...commonSchema.$defs.causeCode.enum, "INSUFFICIENT_EVIDENCE"];

const expectedFor = (scenario: string) =>
  JSON.parse(readFileSync(`${ROOT}${scenario}/expected.json`, "utf8")) as {
    root_cause_code: string; note?: string; must_cite?: string[];
  };

/** Follow a dotted/bracketed path like `pods[0].containers[0].limits.memory`. */
function resolvePath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

describe("every scenario's expected answer is one the system can give", () => {
  const scenarios = listScenarios(ROOT);

  it("finds all five, so nothing below passes on an empty set", () => {
    expect(scenarios.length).toBe(5);
  });

  it("names a cause code the incident schema permits", () => {
    // The exact defect: cpu-throttling expected a code the schema refused, so
    // its correct diagnosis would have failed validation.
    for (const s of scenarios) {
      const e = expectedFor(s);
      expect(CAUSE_CODES, `${s} expects ${e.root_cause_code}, which the schema does not permit`).toContain(e.root_cause_code);
    }
  });

  it("says what the scenario is for, in prose a human can check the run against", () => {
    for (const s of scenarios) {
      expect(expectedFor(s).note, `${s} has no note`).toBeTruthy();
      expect(expectedFor(s).note!.length, `${s} note is too short to say anything`).toBeGreaterThan(40);
    }
  });

  it("points must_cite at paths that actually exist in the observations", () => {
    // A misspelled evidence path would make an expectation unsatisfiable while
    // looking exactly like a satisfiable one.
    for (const s of scenarios) {
      const e = expectedFor(s);
      if (e.must_cite === undefined) continue;
      const obs = readScenario(s, ROOT);
      for (const path of e.must_cite) {
        const found = (["kubernetes", "logs", "metrics"] as const)
          .map((slot) => (obs[slot].state === "collected" ? resolvePath((obs[slot] as { data: unknown }).data, path) : undefined))
          .some((v) => v !== undefined);
        expect(found, `${s}: must_cite path ${path} resolves to nothing in any observation`).toBe(true);
      }
    }
  });

  it("does not expect a real cause from the scenario built to have none", () => {
    // insufficient-evidence exists so that naming a cause is the wrong answer.
    // An expectation contradicting that would make the scenario pointless.
    expect(expectedFor("insufficient-evidence").root_cause_code).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("expects a real cause from every scenario that has one", () => {
    for (const s of scenarios.filter((x) => x !== "insufficient-evidence")) {
      expect(expectedFor(s).root_cause_code, `${s} should name a cause`).not.toBe("INSUFFICIENT_EVIDENCE");
    }
  });

  it("gives each scenario with a cause a distinct one, so no two are the same test", () => {
    const codes = scenarios.filter((s) => s !== "insufficient-evidence").map((s) => expectedFor(s).root_cause_code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("the scenario registry is append-only and complete", () => {
  const registry = JSON.parse(readFileSync(`${ROOT}registry.json`, "utf8")) as {
    next_free: number; numbers: Record<string, number>;
  };

  it("gives every scenario on disk a number", () => {
    // A scenario without a number cannot be assembled at all, and finding that
    // out at run time is worse than finding it here.
    for (const s of listScenarios(ROOT)) {
      expect(registry.numbers, `${s} has no number in the registry`).toHaveProperty(s);
    }
  });

  it("never gives two scenarios the same number", () => {
    const numbers = Object.values(registry.numbers);
    expect(new Set(numbers).size, "two scenarios share a number").toBe(numbers.length);
  });

  it("keeps next_free ahead of every number issued", () => {
    // If next_free ever pointed at a used number, the next scenario added would
    // silently take an existing incident's id.
    for (const [name, n] of Object.entries(registry.numbers)) {
      expect(n, `${name} has a number at or beyond next_free`).toBeLessThan(registry.next_free);
    }
  });

  it("issues numbers the id format can carry", () => {
    for (const [name, n] of Object.entries(registry.numbers)) {
      expect(Number.isInteger(n) && n >= 1 && n <= 98, `${name} number ${n} is out of range`).toBe(true);
    }
  });
});
