/**
 * The parallel mutation runner.
 *
 * Measured on one tree, the same 305 mutations: 540 seconds sequentially, 68
 * across eight worker copies, with the same 305 caught. The tests here are for
 * the ways parallelism can report LESS work as a clean result, which is the
 * only hazard it adds.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs, the same file node runs.
import { workerCount, shareOut, reconcile, copyIsUsable, NOT_COPIED, prepareCopy } from "../scripts/mutation-fanout.mjs";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("how the work is divided", () => {
  it("leaves room for the parent and for each worker's own test process", () => {
    expect(workerCount(10, 305)).toBe(8);
    expect(workerCount(4, 305)).toBe(2);
    // One core must still produce one worker rather than zero.
    expect(workerCount(1, 305)).toBe(1);
    expect(workerCount(2, 305)).toBe(1);
  });

  it("never makes more workers than there is work", () => {
    // A worker with nothing to do is a tree copied for nothing.
    expect(workerCount(10, 3)).toBe(3);
    expect(workerCount(10, 1)).toBe(1);
  });

  it("shares round-robin, not in blocks", () => {
    /*
     * The mutations are grouped by file in the source and consecutive ones
     * tend to run the same test file. Contiguous slices would hand one worker
     * every slow whole-suite mutation and leave the rest idle.
     */
    const ten = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}` }));
    expect(shareOut(ten, 3)).toEqual([["m0", "m3", "m6", "m9"], ["m1", "m4", "m7"], ["m2", "m5", "m8"]]);
  });

  it("gives every mutation to exactly one worker", () => {
    const many = Array.from({ length: 305 }, (_, i) => ({ id: `m${i}` }));
    const shares = shareOut(many, 8);
    const all = shares.flat();
    expect(all.length, "none dropped").toBe(305);
    expect(new Set(all).size, "none duplicated").toBe(305);
  });
});

describe("what a worker copy deliberately does not get", () => {
  it("withholds the .env file, and says why", () => {
    /*
     * A mutation that lets the file beat the environment turned the gate into
     * three paid executions per run on 2026-09-11. A copy without that file is
     * the third floor under it, and it costs nothing.
     */
    const env = NOT_COPIED.find((x: { name: string }) => x.name === ".env");
    expect(env, "the .env file must be on the withheld list").toBeDefined();
    expect(env.why).toContain("paid address");
  });

  it("withholds node_modules, out and .git, each for a stated reason", () => {
    const names = NOT_COPIED.map((x: { name: string }) => x.name);
    expect(names).toEqual([".env", "node_modules", "out", ".git"]);
    for (const entry of NOT_COPIED) {
      expect(entry.why, `${entry.name} is on the list with no reason`).toBeTruthy();
    }
  });

  it("copies the tree somewhere outside the repository", () => {
    /*
     * `cpSync` refuses to copy a directory into a subdirectory of itself, so
     * the first version — `out/mut-workers` — failed for all eight workers.
     * It failed as `unresolved` for every mutation rather than as anything
     * passing, which is the one thing that had to hold, but the copies belong
     * outside the tree.
     */
    const src: string = readFileSync(resolve(ROOT, "scripts/mutation-fanout.mjs"), "utf8");
    expect(src).toContain("mkdtempSync(join(tmpdir()");
    expect(src, "not inside out/, which cpSync refuses").not.toContain('join(ROOT, "out", "mut-workers")');
  });

  it("is a function, so importing this file copies nothing", () => {
    // Importing a module must not start 305 mutations. The first version had
    // no entry guard and did exactly that.
    expect(typeof prepareCopy).toBe("function");
    const src: string = readFileSync(resolve(ROOT, "scripts/mutation-fanout.mjs"), "utf8");
    expect(src).toContain("const INVOKED_DIRECTLY = process.argv[1] !== undefined");
  });
});

describe("a parallel answer is accepted only when it is complete", () => {
  it("requires every mutation to be accounted for", () => {
    /*
     * The hazard parallelism adds, in one line: a worker that dies quietly
     * takes its mutations with it, and a summary that only counts what came
     * back reads as a clean run over a smaller set.
     */
    const src: string = readFileSync(resolve(ROOT, "scripts/acceptance-gate.mjs"), "utf8");
    expect(src).toContain("if (caught + survived.length + unresolved.length !== total) {");
    expect(src).toContain("neither caught nor refused");
  });

  it("falls back to the sequential path rather than deciding, when the fanout cannot answer", () => {
    const src: string = readFileSync(resolve(ROOT, "scripts/acceptance-gate.mjs"), "utf8");
    const fn = src.slice(src.indexOf("function runFanout()"), src.indexOf("function checkMutations()"));
    // Four ways it gives up, and every one returns null — which means "use the
    // slower path", never "it passed".
    expect(fn.split("return null;").length - 1).toBeGreaterThanOrEqual(4);
    expect(fn, "it may say pass only after accounting for everything").toContain("return pass(");
  });

  it("turns a worker that said nothing readable into unresolved, never caught", () => {
    const src: string = readFileSync(resolve(ROOT, "scripts/mutation-fanout.mjs"), "utf8");
    expect(src).toContain('kind: "unresolved"');
    const onClose = src.slice(src.indexOf('c.on("close"'), src.indexOf("done({ i, results });"));
    expect(onClose, "a silent worker is not a worker that caught things").toContain("with no readable result");
    expect(onClose).not.toContain('kind: "caught"');
  });

  it("names the mutation AND the worker that never reported it", () => {
    // The message carries the worker number, because eight of them saying the
    // same sentence tells nobody which copy to look at.
    const missing = reconcile(["a"], [], 5)[0];
    expect(missing.kind).toBe("unresolved");
    expect(missing.detail).toBe("a (worker 5 did not report it)");
  });
});

describe("what a worker sends back, put through the real validator", () => {
  /*
   * Astra, 2026-09-11, on the first version of these tests: source-string
   * assertions do not establish this guarantee. The criticism was right, so
   * the reconciliation is exported and the cases go through it.
   *
   * Every case below must end with nothing counted as caught, because a
   * worker whose answer cannot be trusted for one mutation cannot be trusted
   * for the others either.
   */
  const kinds = (ids: string[], res: unknown) =>
    reconcile(ids, res, 3).map((x: { kind: string; id: string }) => `${x.kind}:${x.id}`).join(",");

  it("refuses two results for one mutation, including the first copy", () => {
    /*
     * The dangerous shape: `[caught a, caught a]` for the share `[a, b]` has
     * the right LENGTH, so a check comparing counts lets it through and `b` is
     * never tested at all.
     */
    expect(kinds(["a", "b"], [{ kind: "caught", id: "a" }, { kind: "caught", id: "a" }]))
      .toBe("unresolved:a,unresolved:b");
  });

  it("drops results for mutations the worker was not given", () => {
    expect(kinds(["a", "b"], [{ kind: "caught", id: "x" }, { kind: "caught", id: "y" }]))
      .toBe("unresolved:a,unresolved:b");
    const said = reconcile(["a"], [{ kind: "caught", id: "x" }], 3)[0];
    expect(said.detail, "and it says how many strays there were")
      .toContain("1 result(s) for mutations it was not given");
  });

  it("gives exactly one verdict per mutation in the share, whatever came back", () => {
    // The gate's accounting compares totals, so an extra entry is a false
    // alarm and a missing one is a false clean. Neither is acceptable.
    expect(reconcile(["a", "b", "c"], [{ kind: "caught", id: "a" }], 3)).toHaveLength(3);
    expect(reconcile(["a", "b"], [{ kind: "caught", id: "a" }, { kind: "caught", id: "a" }], 3)).toHaveLength(2);
    expect(reconcile([], [{ kind: "caught", id: "a" }], 3)).toHaveLength(0);
  });

  it("refuses an outcome with no id, or a kind it does not know", () => {
    expect(kinds(["a"], [{ kind: "caught" }])).toBe("unresolved:a");
    expect(kinds(["a"], [{ kind: "caught", id: 7 }])).toBe("unresolved:a");
    expect(kinds(["a"], [{ kind: "fine", id: "a" }])).toBe("unresolved:a");
    expect(kinds(["a"], [null])).toBe("unresolved:a");
  });

  it("refuses anything that is not a list of results", () => {
    expect(kinds(["a"], "nonsense")).toBe("unresolved:a");
    expect(kinds(["a"], null)).toBe("unresolved:a");
    expect(kinds(["a"], { kind: "caught", id: "a" })).toBe("unresolved:a");
  });

  it("keeps a clean answer clean, or it would refuse everything and prove nothing", () => {
    expect(kinds(["a", "b"], [{ kind: "caught", id: "a" }, { kind: "survived", id: "b" }]))
      .toBe("caught:a,survived:b");
  });

  it("gives every worker its own directory, so two runs cannot delete each other's", () => {
    /*
     * Astra, 2026-09-11: every invocation used `ai-sre-mut-workers/w0`, `w1`,
     * and `prepareCopy` deletes what it finds. Two gates at once — or one gate
     * and another checkout — replaced directories underneath each other's live
     * workers. And since a mutation counts as caught when its named test
     * FAILS, an unrelated filesystem failure could have been recorded as a
     * catch.
     */
    const src: string = readFileSync(resolve(ROOT, "scripts/mutation-fanout.mjs"), "utf8");
    expect(src).toContain('mkdtempSync(join(tmpdir(), "ai-sre-mut-"))');
    expect(src, "not a fixed name any second run would collide with")
      .not.toContain('join(tmpdir(), "ai-sre-mut-workers")');
  });
});

describe("a copy has to prove it can run tests before its verdicts count", () => {
  /*
   * A mutation counts as caught when its named test FAILS. So a copy broken
   * for a reason of its own — a file that did not copy, a symlink that did not
   * resolve — makes every mutation on it look caught. Astra, 2026-09-11.
   *
   * The full baseline is one clean run per MUTATION, which doubles the cost.
   * This is one run per COPY, which separates "the test failed because of the
   * mutation" from "this copy cannot run tests" for the price of eight runs.
   */
  it("refuses a copy with no tests directory, rather than trusting it", () => {
    const answer = copyIsUsable("/definitely/not/a/tree", { list: () => { throw new Error("ENOENT"); } });
    expect(answer.usable).toBe(false);
    expect(answer.why).toContain("no readable tests directory");
  });

  it("refuses a copy that holds no test file at all", () => {
    // Not "nothing to check, so it is fine" — an empty set is the one thing
    // that must never read as a pass.
    const answer = copyIsUsable("/tree", { list: () => ["README.md", "helpers.ts"] });
    expect(answer.usable).toBe(false);
    expect(answer.why).toContain("no test file to try");
  });

  it("picks the smallest test file rather than a named one", () => {
    /*
     * By size, so deleting or renaming one file cannot silently turn this
     * check into nothing.
     */
    const tried: string[] = [];
    copyIsUsable("/tree", {
      list: () => ["big.test.ts", "small.test.ts", "notes.md"],
      size: (f: string) => (f.endsWith("small.test.ts") ? 10 : 9999),
      spawn: (_c: string, args: string[]) => { tried.push(args[args.length - 1] ?? "nothing"); return { status: 0 }; },
    });
    expect(tried).toEqual(["tests/small.test.ts"]);
  });

  it("refuses a copy where an UNMUTATED test does not pass, and quotes it", () => {
    const answer = copyIsUsable("/tree", {
      list: () => ["a.test.ts"],
      size: () => 10,
      spawn: () => ({ status: 1, stdout: "Cannot find module 'vitest'", stderr: "" }),
    });
    expect(answer.usable).toBe(false);
    expect(answer.why).toContain("does not pass in an UNMUTATED copy");
    expect(answer.why, "and it carries what the run said").toContain("Cannot find module");
  });

  it("refuses a copy where the test runner never produced an exit code", () => {
    const answer = copyIsUsable("/tree", {
      list: () => ["a.test.ts"], size: () => 10, spawn: () => ({ status: null }),
    });
    expect(answer.usable).toBe(false);
    expect(answer.why).toContain("did not run in the copy");
  });

  it("accepts a copy that runs a test cleanly, or it would refuse everything", () => {
    const answer = copyIsUsable("/tree", {
      list: () => ["a.test.ts"], size: () => 10, spawn: () => ({ status: 0 }),
    });
    expect(answer.usable).toBe(true);
    expect(answer.tried).toBe("tests/a.test.ts");
  });

  it("reports the whole share unresolved when its copy is unusable", () => {
    /*
     * Behaviour, through the real worker process, because the first version of
     * this asserted the SOURCE — and a mutation that flips the condition while
     * leaving the message in place survived the gate saying so.
     *
     * The copy is broken by removing its tests, then the worker is asked for a
     * mutation. The reason it gives back is what distinguishes the two paths:
     * with the check in place it says the COPY is not usable; without it the
     * worker goes on and reports a missing report instead.
     */
    const at = join(mkdtempSync(join(tmpdir(), "unusable-")), "w");
    prepareCopy(at);
    rmSync(join(at, "tests"), { recursive: true, force: true });
    const r = spawnSync(process.execPath, [resolve(ROOT, "scripts/mutation-fanout.mjs"), "--worker", at], {
      input: JSON.stringify(["the-claim-stops-being-exclusive"]), encoding: "utf8",
    });
    const back = JSON.parse(r.stdout);
    expect(back).toHaveLength(1);
    expect(back[0].kind, "nothing from an unusable copy is a catch").toBe("unresolved");
    expect(back[0].detail).toContain("the worker copy is not usable");
    expect(back[0].detail).toContain("no readable tests directory");
  });
});
