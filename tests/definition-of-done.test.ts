/**
 * The ten items Codex listed on the plan as uncovered by the described tests.
 *
 * They were recorded verbatim in PROGRESS.md and have sat there since, with a
 * DEBT entry due from chunk 5 saying each one must have a test behind it. This
 * file is that check.
 *
 * It works by naming, for each item, the tests that cover it, and requiring
 * those tests to exist by their declared name. That is weaker than proving the
 * test is adequate — nothing here can do that — but it is much stronger than a
 * list in a document, because renaming or deleting a test breaks it, and an
 * item nobody covered cannot be quietly counted as done.
 *
 * Items that CANNOT be covered without calling a model say so, by name, and are
 * listed as outstanding rather than described as passing.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = new URL("./", import.meta.url).pathname;

function collectTests(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return collectTests(full);
    return e.name.endsWith(".test.ts") ? [full] : [];
  });
}

const SUITE = collectTests(TEST_DIR).map((f) => readFileSync(f, "utf8")).join("\n");
const DECLARED = new Set([...SUITE.matchAll(/\bit\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]));

// @ts-expect-error — plain .mjs, read by the gate as well as by these tests.
import { DEFINITION_OF_DONE as RAW } from "../scripts/definition-of-done.mjs";
// @ts-expect-error - plain .mjs script, no types
import { LIMITATIONS } from "../scripts/acceptance-gate.mjs";

type Item = { n: number; claim: string } & (
  | { covered: true; by: string[] }
  // `outOfScope` is optional because an uncovered item is one of two things: a
  // dependency still coming, or a decision the owner made. Written as optional
  // rather than as a fourth variant so that forgetting it reads as "still
  // waiting" — the state that keeps being reported, not the one that goes quiet.
  | { covered: false; needs: string; why: string; outOfScope?: string }
);
const DEFINITION_OF_DONE = RAW as Item[];

describe("the ten Definition-of-Done items", () => {
  it("holds exactly the ten that were recorded, no more and no fewer", () => {
    expect(DEFINITION_OF_DONE.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("names, for every covered item, tests that actually exist", () => {
    // This is what makes the list more than prose: renaming or deleting a test
    // breaks it here, and an item nobody covered cannot be counted as done.
    for (const item of DEFINITION_OF_DONE) {
      if (!item.covered) continue;
      expect(item.by.length, `item ${item.n} claims coverage but names no test`).toBeGreaterThan(0);
      for (const name of item.by) {
        expect(DECLARED.has(name), `item ${item.n} names a test that does not exist: "${name}"`).toBe(true);
      }
    }
  });

  it("says what each uncovered item is waiting for, rather than leaving it blank", () => {
    for (const item of DEFINITION_OF_DONE) {
      if (item.covered) continue;
      expect(item.needs, `item ${item.n} is uncovered with no stated dependency`).toBeTruthy();
      expect(item.why.length, `item ${item.n} does not say why it cannot be covered yet`).toBeGreaterThan(60);
    }
  });

  it("keeps a decision out of scope apart from a dependency still coming", () => {
    // Three states, not two. The owner decided on 2026-09-05 that there will be
    // one provider, so items 6 and 8 are not waiting for anything — and calling
    // them "waiting" would be a promise nobody intends to keep, while the
    // report reads as though work is on its way.
    const decided = DEFINITION_OF_DONE.filter((i) => !i.covered && i.outOfScope !== undefined) as Array<Extract<Item, { covered: false }>>;
    expect(decided.map((i) => i.n), "the decision moved, or an item lost it").toEqual([6, 8]);
    for (const item of decided) {
      expect(item.outOfScope!.length, `item ${item.n} says it is out of scope without saying who decided or when`)
        .toBeGreaterThan(60);
      expect(item.outOfScope, `item ${item.n} does not date the decision`).toContain("2026-09-05");
    }
  });

  it("prints every out-of-scope item as a gate limitation, so a decision is not a quiet deletion", () => {
    // The gate builds these from the decisions rather than a retyped list, and
    // this is what holds that. An item decided out of scope and then invisible
    // is exactly a claim shrinking without anyone seeing it shrink.
    const decided = DEFINITION_OF_DONE.filter((i) => !i.covered && i.outOfScope !== undefined) as Array<Extract<Item, { covered: false }>>;
    expect(decided.length, "this test is vacuous if nothing is out of scope").toBeGreaterThan(0);
    for (const item of decided) {
      const printed = (LIMITATIONS as string[]).some((l) => l.includes(`Definition of Done item ${item.n}`) && l.includes(item.outOfScope!));
      expect(printed, `item ${item.n} is out of scope and the gate never prints it`).toBe(true);
    }
  });

  it("reports five of ten covered, and names the five that are not", () => {
    // The number is asserted so that quietly reclassifying an item as covered
    // fails here rather than improving a statistic nobody checks. It went from
    // seven to six when Codex pointed out that item 2 was claiming more than
    // its tests establish.
    const covered = DEFINITION_OF_DONE.filter((i) => i.covered).map((i) => i.n);
    const outstanding = DEFINITION_OF_DONE.filter((i) => !i.covered).map((i) => i.n);
    expect(covered).toEqual([1, 4, 5, 7, 9]);
    expect(outstanding).toEqual([2, 3, 6, 8, 10]);
    // Of the five, three are still waiting and two were decided. Asserted apart
    // so that moving an item between the two fails here.
    const waiting = DEFINITION_OF_DONE.filter((i) => !i.covered && i.outOfScope === undefined).map((i) => i.n);
    expect(waiting, "all three remaining dependencies are one and the same: a model call").toEqual([2, 3, 10]);
  });

  it("names only dependencies that provably do not exist yet", () => {
    // Codex, chunk 2: requiring the strings to be distinct let "we felt lazy"
    // through, and would have let through a dependency that already exists.
    // Each allowed dependency is checked against the repository instead.
    const ABSENT: Record<string, () => boolean> = {
      "a provider whose answers can be checked, not only requested": () =>
        // One fixture-backed provider that reads files it is handed. Nothing
        // can verify what it returns is what was asked for.
        readdirSync(new URL("../src/providers/", import.meta.url).pathname).filter((f) => f.endsWith(".ts")).length < 3,
      "trusted provenance at the ingestion boundary": () =>
        // One fixture-backed provider that reads files. Nothing carries a
        // collection-request identity, so there is nothing to check against.
        !readFileSync(new URL("../src/providers/fixtures.ts", import.meta.url).pathname, "utf8").includes("collection_request"),
      "a model call": () =>
        // No model key anywhere the project reads. If one appears, this stops
        // being a reason and the items waiting on it become ordinary work.
        process.env.OPENAI_API_KEY === undefined && process.env.ANTHROPIC_API_KEY === undefined,
      "a second provider implementation": () =>
        // One provider file exists; substitutability claimed from a single
        // implementation is a claim about something that is not there.
        readdirSync(new URL("../src/providers/", import.meta.url).pathname).filter((f) => f.endsWith(".ts")).length < 3,
      "a model call through the deployed workflow": () =>
        process.env.OPENAI_API_KEY === undefined && process.env.ANTHROPIC_API_KEY === undefined,
    };

    for (const item of DEFINITION_OF_DONE) {
      if (item.covered) continue;
      const check = ABSENT[item.needs];
      expect(check, `item ${item.n} waits on "${item.needs}", which is not a recognised dependency`).toBeDefined();
      expect(check!(), `item ${item.n} waits on "${item.needs}", but that now exists — the item is ordinary work`).toBe(true);
    }
  });
});
