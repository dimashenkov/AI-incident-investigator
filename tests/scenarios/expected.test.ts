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
import { readRegistry } from "../../src/core/assemble.js";
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
    also_acceptable?: string[]; max_confidence?: number; requires_dissent?: boolean;
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

  /*
   * The precondition, not a census. It was `toBe(5)` until 2026-09-07, when
   * adding two scenarios turned three separate tests red for the same reason:
   * a hard number is a second place the scenario count lives, and it goes
   * stale the moment the first one changes. What this actually needs is that
   * the list is not empty — everything below it iterates and would pass on
   * nothing — and the registry is the one place the count is declared, so
   * agreeing with it is a real check rather than a copy of the answer.
   */
  it("finds every registered scenario, so nothing below passes on an empty set", () => {
    const registry = readRegistry(ROOT)!;
    expect(scenarios.length, "no scenario directories were found").toBeGreaterThan(0);
    expect(scenarios.slice().sort(), "the directories and scenarios/registry.json disagree")
      .toEqual(Object.keys(registry.numbers).sort());
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

  /*
   * Two scenarios may share a cause code only when one of them is a HARDER
   * version of the other — the pair Definition of Done item 3 needs, where the
   * same cause is once clean and once contradicted, and the confidence must
   * differ between them. Without that qualification, a repeated code really is
   * the same test twice, and the second one measures nothing new.
   *
   * Widened from "all distinct" on 2026-09-07, when conflicting-evidence was
   * added deliberately sharing CONTAINER_OOM with container-oom. The rule is
   * not "duplicates are fine now": a duplicate must earn itself by carrying a
   * ceiling or a dissent requirement that its twin does not.
   */
  it("lets two scenarios share a cause only when one of them is the harder case", () => {
    const withCause = scenarios.filter((s) => s !== "insufficient-evidence");
    expect(withCause.length, "nothing to compare; this would pass on an empty set").toBeGreaterThan(1);
    const byCode = new Map<string, string[]>();
    for (const s of withCause) {
      const code = expectedFor(s).root_cause_code as string;
      byCode.set(code, [...(byCode.get(code) ?? []), s]);
    }
    for (const [code, sharing] of byCode) {
      if (sharing.length === 1) continue;
      const qualified = sharing.filter((s) => {
        const e = expectedFor(s);
        return typeof e.max_confidence === "number" || e.requires_dissent === true;
      });
      expect(qualified.length,
        `${sharing.join(" and ")} both expect ${code}; one must carry max_confidence or ` +
        "requires_dissent, or the second is the first test run twice").toBe(sharing.length - 1);
    }
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
