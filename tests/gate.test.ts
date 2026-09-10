/**
 * Tests for the gate itself.
 *
 * The gate exists because a claim nobody checks reads as true. A gate nobody
 * checks is the same defect one level up, so every test here is written
 * against a specific way this gate could lie:
 *
 *   · fold "could not establish" into "clean"
 *   · call an empty test suite a pass, because an empty suite exits 0
 *   · call a missing file fine, because nothing looked for it
 *   · die on a check that throws, and report nothing at all
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync, symlinkSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Does a .gitignore line cover this filename?
 *
 * A first attempt checked prefix and suffix only, and reported that
 * "*credentials*.json" does not cover "n8n-credentials.json" — a star in the
 * middle was invisible to it. Translating the glob is barely longer and does
 * not quietly answer a narrower question than the one asked.
 */
function globMatches(line: string, name: string): boolean {
  const escaped = line.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(name);
}

/** Every *.test.ts under a directory, at any depth. */
function collectTests(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return collectTests(full);
    return e.name.endsWith(".test.ts") ? [full] : [];
  });
}
// Plain .mjs — the same file node runs in production, so there are no types.
// @ts-expect-error
import { filesDeclaring, artifactDisagreesWithManifest, dueFrom, runGate, format, restoreInterruptedMutation, CHECKS, CHILD_MARKER, LIMITATIONS, DEBT, SECRET_SHAPED, readFreshReport, interpretVitestReport, interpretScripts, findSecretShaped, parsePorcelainZ, readCurrentChunk, namedTestFailed, coverageGaps, someRunWasScored, withRepair, reportIsFromThisRun, splitDebt} from "../scripts/acceptance-gate.mjs";
// @ts-expect-error
import { MUTATIONS } from "../scripts/mutations.mjs";

const check = (id: string, outcome: unknown) => ({ id, describe: id, run: () => outcome });
const PASS = { state: "pass", detail: "fine" };
const FAIL = { state: "fail", detail: "broken" };
const UNKNOWN = { state: "unknown", detail: "could not look" };

describe("three states, never two", () => {
  it("exits 0 only when every check actually passed", () => {
    expect(runGate([check("a", PASS), check("b", PASS)]).exitCode).toBe(0);
  });

  it("exits 2, not 0, when a check could not establish anything", () => {
    // The dangerous collapse: "I could not check" reported as "clean".
    const gate = runGate([check("a", PASS), check("b", UNKNOWN)]);
    expect(gate.exitCode).toBe(2);
    expect(gate.unresolved.map((r: { id: string }) => r.id)).toEqual(["b"]);
  });

  it("exits 1 when something concretely failed", () => {
    expect(runGate([check("a", FAIL)]).exitCode).toBe(1);
  });

  it("exits 3 when something failed AND something else was never established", () => {
    // Codex, chunk 0 round 2: exit 1 used to cover both "it failed" and "it
    // failed and the rest was never looked at". A human sees the difference in
    // the report; CI sees only the number, and read a partial verdict as final.
    const gate = runGate([check("a", FAIL), check("b", UNKNOWN)]);
    expect(gate.exitCode).toBe(3);
    expect(gate.failed).toHaveLength(1);
    expect(gate.unresolved).toHaveLength(1);
  });

  it("keeps 1 and 2 meaning exactly one thing each", () => {
    // Guards the arithmetic: 1 must never appear while an unknown is present.
    expect(runGate([check("a", FAIL), check("b", PASS)]).exitCode).toBe(1);
    expect(runGate([check("a", UNKNOWN), check("b", PASS)]).exitCode).toBe(2);
  });

  it("turns a check that throws into unknown, not into a pass and not into a crash", () => {
    const exploding = { id: "boom", describe: "boom", run: () => { throw new Error("no such file"); } };
    const gate = runGate([check("a", PASS), exploding]);
    expect(gate.exitCode).toBe(2);
    expect(gate.unresolved[0].detail).toContain("no such file");
  });
});

describe("reading the vitest report", () => {
  const OK = { numTotalTests: 27, numPassedTests: 27, numFailedTests: 0 };

  it("passes a suite that ran and was green", () => {
    expect(interpretVitestReport(OK, 0, "$").state).toBe("pass");
  });

  it("refuses a suite that collected zero tests", () => {
    // An empty suite exits 0. Without this the gate reports a green run for a
    // project whose tests were all deleted or never matched the glob.
    const r = interpretVitestReport({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0 }, 0, "$");
    expect(r.state).toBe("fail");
  });

  it("reports unknown, not pass, when no report was written", () => {
    expect(interpretVitestReport(null, 0, "$").state).toBe("unknown");
  });

  it("reports unknown when the report carries no counts", () => {
    expect(interpretVitestReport({ ok: true }, 0, "$").state).toBe("unknown");
  });

  it("fails when counts are green but the runner exited nonzero", () => {
    // Green counts plus a nonzero exit means something the counts do not cover
    // went wrong — an unhandled error, a failing setup file.
    expect(interpretVitestReport(OK, 1, "$").state).toBe("fail");
  });

  it("fails when passed and total disagree even with zero failures", () => {
    const r = interpretVitestReport({ numTotalTests: 27, numPassedTests: 20, numFailedTests: 0 }, 0, "$");
    expect(r.state).toBe("fail");
  });
});

describe("declared scripts must point at real files", () => {
  const exists = (paths: string[]) => (p: string) => paths.includes(p);

  it("fails when a declared script points at a file that is not there", () => {
    // This is the defect that was live on 2026-09-04: package.json declared
    // `gate` -> scripts/acceptance-gate.mjs and no such file existed.
    const r = interpretScripts({ gate: "node scripts/acceptance-gate.mjs" }, exists([]));
    expect(r.state).toBe("fail");
    expect(r.detail).toContain("scripts/acceptance-gate.mjs");
  });

  it("passes when it is there", () => {
    const r = interpretScripts({ gate: "node scripts/acceptance-gate.mjs" }, exists(["scripts/acceptance-gate.mjs"]));
    expect(r.state).toBe("pass");
  });

  it("fails when a script names a binary that is not installed", () => {
    // `vitest run` and `tsc --noEmit` are the two commands this project actually
    // relies on. Leaving them "unexamined" was honest but useless.
    const r = interpretScripts({ test: "vitest run" }, exists([]), () => false);
    expect(r.state).toBe("fail");
    expect(r.detail).toContain("node_modules/.bin");
  });

  it("passes when the binary is installed", () => {
    const r = interpretScripts({ test: "vitest run" }, exists([]), (b: string) => b === "vitest");
    expect(r.state).toBe("pass");
  });

  it("reports unknown for a script shape it genuinely cannot read", () => {
    // Nothing was examined. Saying "pass" here would be a clean bill of health
    // issued by a check that looked at nothing.
    const r = interpretScripts({ ci: "vitest run && tsc --noEmit" }, exists([]), () => true);
    expect(r.state).toBe("unknown");
    expect(r.detail).toContain("1 script(s)");
  });

  it("reports unknown when one script is readable but another is not", () => {
    // Codex, chunk 0 round 2: this used to pass. One verified script said
    // nothing about the one nobody could read, and pass claimed it did.
    const r = interpretScripts(
      { gate: "node scripts/acceptance-gate.mjs", ci: "a && b" },
      exists(["scripts/acceptance-gate.mjs"]),
      () => true,
    );
    expect(r.state).toBe("unknown");
    expect(r.detail).toContain("1 script(s)");
  });

  it("still fails on a missing file even when other scripts are unreadable", () => {
    const r = interpretScripts(
      { test: "vitest run", gate: "node scripts/missing.mjs" },
      exists([]),
    );
    expect(r.state).toBe("fail");
  });
});

describe("what the gate cannot decide, and what it merely has not written", () => {
  it("keeps the two lists apart, because they fail for different reasons", () => {
    // Round 1: a disclaimer that cannot change the verdict is decoration.
    // Round 2: a gate that can never accept gets bypassed or quietly emptied.
    // Both are right about their half; the split is what makes both true at once.
    expect(LIMITATIONS.length).toBeGreaterThan(0);
    expect(DEBT.length).toBeGreaterThan(0);
    expect(DEBT.every((d: { dueFromChunk: number }) => Number.isInteger(d.dueFromChunk))).toBe(true);
  });

  it("does not let a limitation hold the exit code hostage", () => {
    const ids = CHECKS.map((c: { id: string }) => c.id);
    expect(ids).not.toContain("unverified-claims");
    expect(ids).toContain("promised-checks-due");
  });

  it("prints both lists, so neither disappears from the report", () => {
    const text = format(runGate([check("a", PASS)]));
    expect(text).toContain("CANNOT DECIDE");
    expect(text).toContain("PROMISED CHECKS NOT YET WRITTEN");
    expect(text).toContain(LIMITATIONS[0]);
    expect(text).toContain(DEBT[0].claim);
  });

  it("refuses to spawn the suite from a run this gate already started", () => {
    // Measured 2026-09-04: without a guard the suite never returned — it hangs
    // rather than fails, which from outside looks like slow tests.
    // Codex round 2: keying on VITEST was bypassable (a test can delete it) and
    // overbroad (VITEST=0 in a shell silently skipped the check). This marker is
    // the gate's own and is set only on children the gate spawns itself.
    const tests = CHECKS.find((c: { id: string }) => c.id === "tests");
    const before = process.env[CHILD_MARKER];
    process.env[CHILD_MARKER] = "1";
    try {
      const r = tests.run();
      expect(r.state).toBe("unknown");
      expect(r.detail).toContain("already started");
    } finally {
      if (before === undefined) delete process.env[CHILD_MARKER];
      else process.env[CHILD_MARKER] = before;
    }
  });
});

describe("reading which chunk is current", () => {
  const TABLE = ["| Chunk | Кръг | Какво |", "|---|---|---|", "| план | 1 | нещо |", "| 0 | 2 | нещо |", ""].join("\n");

  it("reads the highest chunk from the rounds table", () => {
    expect(readCurrentChunk(TABLE)).toBe(0);
  });

  it("ignores numbers in other tables in the same file", () => {
    // Measured 2026-09-04: reading any numeric first cell returned 6 for a file
    // whose highest chunk is 0 — a numbered objections table looks identical to
    // a parser that was never told which table to read.
    expect(readCurrentChunk(TABLE + "\n| # | Възражение |\n|---|---|\n| 6 | нещо |\n")).toBe(0);
  });

  it("returns null, not 0, when there is no rounds table", () => {
    // null becomes "could not establish". Defaulting to 0 would quietly declare
    // that nothing is due yet — absence read as permission.
    expect(readCurrentChunk("| # | x |\n|---|---|\n| 3 | y |")).toBe(null);
  });
});

describe("an outcome nobody recognises is not a pass", () => {
  it("turns an unrecognised state into unknown, not into a silent 0", () => {
    // Codex, chunk 0 round 2: nothing validated the state. {state: "timeout"}
    // was neither fail nor unknown, the arithmetic produced 0, and the gate
    // announced "everything passed" from an outcome it did not understand.
    const gate = runGate([{ id: "weird", describe: "weird", run: () => ({ state: "timeout", detail: "?" }) }]);
    expect(gate.exitCode).toBe(2);
    expect(gate.unresolved[0].detail).toContain("unrecognised state");
  });

  it("treats a check returning nothing at all the same way", () => {
    expect(runGate([{ id: "void", describe: "void", run: () => undefined }]).exitCode).toBe(2);
  });
});

describe("parsing git status porcelain -z", () => {
  it("keeps a renamed file's original path intact", () => {
    // Codex, chunk 0 round 2: slicing three characters off every field turned
    // the second path of a rename — ".env" — into "v". The one file the check
    // exists to catch became invisible simply by being renamed.
    expect(parsePorcelainZ("R  safe.txt\0.env\0")).toEqual(["safe.txt", ".env"]);
  });

  it("reads ordinary records and untracked files", () => {
    expect(parsePorcelainZ("?? keys/id_ed25519\0 M src/a.ts\0")).toEqual(["keys/id_ed25519", "src/a.ts"]);
  });

  it("survives a trailing empty field without inventing a path", () => {
    expect(parsePorcelainZ("?? a.txt\0")).toEqual(["a.txt"]);
  });
});

describe("the report a machine does not read", () => {
  it("prints every unknown, so losing them from format() cannot pass silently", () => {
    // Codex, chunk 0 round 2: the old test inspected gate.unresolved only. If
    // format() stopped printing unknowns, the report would go quiet about them
    // and every test would still be green.
    const text = format(runGate([check("visible-fail", FAIL), check("silent-unknown", UNKNOWN)]));
    expect(text).toContain("silent-unknown");
    expect(text).toContain("UNKNOWN");
    expect(text).toContain("exit 3");
  });

  it("names the verdict in words, not only as a number", () => {
    expect(format(runGate([check("a", UNKNOWN)]))).toContain("COULD NOT ESTABLISH");
  });
});

describe("secret-shaped files, tracked or not", () => {
  it("spots the ones that must never reach a commit", () => {
    const hits = findSecretShaped([
      "src/index.ts", ".env", "config/prod.pem", "keys/id_ed25519", "n8n-credentials.json",
    ]);
    expect(hits).toEqual([".env", "config/prod.pem", "keys/id_ed25519", "n8n-credentials.json"]);
  });

  /*
   * Every entry, not the four this test happened to name.
   *
   * A subagent replayed the whole describe block against each four-element
   * sublist on 2026-09-07: deleting `/\.key$/` left the ENTIRE suite green,
   * because `.key` was the one shape absent from the hardcoded list above and
   * no mutation touched SECRET_SHAPED membership. A scanner entry nobody
   * exercises is an entry that can be removed while the report stays clean.
   */
  it("exercises every entry it declares, not only the ones this file lists", () => {
    expect(SECRET_SHAPED.length, "no entries; this would pass on an empty set").toBeGreaterThan(0);
    for (const entry of SECRET_SHAPED) {
      expect(entry.catches.length, `${entry.re} names nothing it catches`).toBeGreaterThan(0);
      for (const name of entry.catches) {
        expect(findSecretShaped([name]), `${name} is declared caught by ${entry.re} and was not`)
          .toEqual([name]);
      }
    }
  });

  /*
   * A list that does NOT come from SECRET_SHAPED, which is the whole point.
   *
   * The test above walks the entries and asks each to catch what it declares —
   * so deleting an entry outright removes the rule AND the claim together, and
   * consistency survives. A subagent measured that on 2026-09-07: dropping
   * `/\.key$/` left every assertion in this file green with `tls.key` sitting
   * untracked beside a commit.
   *
   * What that needs is a second, independent statement of what must be caught.
   * Every name here is a real secret shape this project has handled: an n8n API
   * key, a TLS key, a service-account JSON, an SSH key, the env file.
   */
  it("catches every shape this project has actually had to keep out", () => {
    const mustBeCaught = [
      ".env", "config/.env.local", "tls.key", "server.pem",
      "id_rsa", "keys/id_ed25519", "n8n-credentials.json",
    ];
    for (const name of mustBeCaught) {
      expect(findSecretShaped([name]), `${name} must be caught by some entry`).toEqual([name]);
    }
    // And something that is not a secret must still pass, or this catches all.
    expect(findSecretShaped(["src/index.ts", ".env.example"])).toEqual([]);
  });

  it("leaves .env.example alone, since it is the file that documents the real one", () => {
    expect(findSecretShaped([".env.example"])).toEqual([]);
  });

  it("keeps the gate's idea of a secret and .gitignore's from drifting apart", () => {
    // Two carriers for one idea, found while hunting for the defect class this
    // project keeps repeating. They cannot be merged — git reads one, the gate
    // reads the other, and they answer different questions — so the test makes
    // the drift fail instead of leaving a hole nobody looks at.
    const ignore = readFileSync(new URL("../.gitignore", import.meta.url).pathname, "utf8")
      .split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
    expect(SECRET_SHAPED.length).toBeGreaterThan(0);
    for (const { ignoreLines } of SECRET_SHAPED) {
      expect(ignoreLines.length, "an entry that names no ignore line vouches for nothing").toBeGreaterThan(0);
      for (const line of ignoreLines) {
        expect(ignore, `.gitignore has no line for ${line}, which the gate treats as secret-shaped`).toContain(line);
      }
    }
  });

  it("catches nothing it has not declared, which is the direction that matters", () => {
    // A subagent review on 2026-09-04: the test below proves declared ⊆ caught.
    // The round-9 defect needed caught ⊆ declared — widen the regex to
    // id_(rsa|dsa|ed25519) without touching the lists and every test stays
    // green while no .gitignore line covers id_dsa.
    //
    // A regex cannot be enumerated, so this reads the literal alternatives out
    // of its source: every name a pattern can spell must be a name it declares.
    /*
     * Rewritten 2026-09-07. The old reader was `/\(([^()?][^()]*)\)/g`, and a
     * subagent measured what it misses: `[^()?]` excludes every `(?:` group,
     * and `[^()]*` cannot see an alternation with no parentheses at all. Three
     * of the four ways to widen a pattern were invisible —
     * `id_(?:rsa|dsa|ed25519)`, `\.pem$|\.p12$` and `\.p[ek][my]$` each left
     * the suite green while catching a name no .gitignore line covers.
     *
     * So this reads alternatives out of EVERY group, capturing or not, plus the
     * top level, and refuses a character class inside a literal segment
     * outright — a class cannot be enumerated into names, and a check that
     * silently skips what it cannot read is the thing being guarded against.
     */
    const alternativesOf = (source: string): string[] => {
      const out: string[] = [];
      /*
       * Every parenthesised group, capturing `(` and non-capturing `(?:` alike.
       * A lookaround — `(?!`, `(?=`, `(?<!`, `(?<=` — is skipped on purpose: it
       * can only NARROW what a pattern matches, so it cannot introduce a name
       * the entry has not declared. Skipping what widens would be the defect;
       * skipping what narrows is the point.
       */
      for (const m of source.matchAll(/\((?:\?:)?([^()]*)\)/g)) {
        if (m[1]!.startsWith("?")) continue;
        out.push(...m[1]!.split("|"));
      }
      /*
       * And the top level, with groups removed so their bars are not counted
       * twice. Removal is ITERATIVE: one pass over `(^|\/)\.env($|\.(?!example))`
       * strips the inner lookaround and leaves a stray `(`, which then reads as
       * part of a name. My own first draft of this fix had that bug.
       */
      let flat = source;
      for (let i = 0; i < 10; i += 1) {
        const next = flat.replace(/\((?:\?:)?[^()]*\)/g, "");
        if (next === flat) break;
        flat = next;
      }
      if (flat.includes("|")) out.push(...flat.split("|"));
      return out;
    };

    for (const { re, catches } of SECRET_SHAPED) {
      /*
       * Checked before the alternatives and independently of them, because a
       * character class produces NO alternatives — so `\.p[ek][my]$` widened
       * the pattern to `server.pky` while the loop below ran zero times and the
       * suite stayed green. An assertion that only runs when there is something
       * to iterate cannot notice the case with nothing to iterate.
       */
      expect(re.source.replace(/\\\[|\\\]/g, ""),
        `${re} uses a character class, which cannot be enumerated into the names it declares`)
        .not.toMatch(/[[\]]/);

      const alternations = alternativesOf(re.source);
      expect(alternations.length,
        `${re} yields no alternatives to check; if that is right it has none, but say so here`)
        .toBeGreaterThanOrEqual(0);
      for (const alt of alternations) {
        const literal = alt.replace(/\\/g, "");
        if (literal === "" || literal === "^" || literal === "/") continue;
        expect(literal, `${re} uses a character class this test cannot enumerate into names`)
          .not.toMatch(/[[\]]/);
        // Anchors and quantifiers are structure, not name — strip them to compare.
        const bare = literal.replace(/[$^*+?]/g, "");
        if (bare === "") continue;
        const declared = catches.some((c: string) => c.includes(bare));
        expect(declared, `${re} can match "${bare}" but no declared name contains it`).toBe(true);
      }
    }
  });

  it("names every filename each entry catches, so none is covered without being declared", () => {
    // Codex, chunk 0 round 9: one regex matched id_rsa and id_ed25519 while
    // declaring only one ignore line. Deleting the other line left this suite
    // green and recreated the exposure the pairing exists to prevent. Every
    // name an entry catches is now written down and checked.
    for (const { re, catches } of SECRET_SHAPED) {
      expect(catches.length, `${re} declares no filenames it catches`).toBeGreaterThan(0);
      for (const name of catches) {
        // Codex, chunk 0 round 10: this asked findSecretShaped(), which succeeds
        // when ANY entry matches. A name could be filed under the wrong entry,
        // inherit that entry's unrelated ignore lines, and all three pairing
        // tests would still pass. The question is whether THIS pattern catches
        // it, so this pattern is what gets asked.
        expect(re.test(name), `${re} declares it catches ${name} but does not`).toBe(true);
      }
    }
    // And the whole set still catches them, which is the other half of the claim.
    const everyName = SECRET_SHAPED.flatMap(({ catches }: { catches: string[] }) => catches);
    expect(findSecretShaped(everyName)).toEqual(everyName);
  });

  it("covers every declared filename with a declared ignore line", () => {
    // The two lists must describe the same set: a name caught by the gate but
    // kept out by nothing, or a line with no name behind it, is drift again.
    for (const { catches, ignoreLines } of SECRET_SHAPED) {
      for (const name of catches) {
        const base = name.split("/").pop()!;
        const covered = ignoreLines.some((l: string) => globMatches(l, base));
        expect(covered, `${name} is caught by the gate but no declared ignore line covers it`).toBe(true);
      }
    }
  });
});

describe("the mutation machinery, which is what makes 'every fix has a test' checkable", () => {
  const report = (title: string, status: string) => ({
    testResults: [{ assertionResults: [{ title, fullName: `some suite ${title}`, status }] }],
  });

  it("sees a named test that failed", () => {
    expect(namedTestFailed(report("refuses X", "failed"), "refuses X")).toBe(true);
  });

  it("does not treat a passing test as proof the mutation was caught", () => {
    expect(namedTestFailed(report("refuses X", "passed"), "refuses X")).toBe(false);
  });

  it("does not treat a test that vanished as caught, nor as one that passed", () => {
    /*
     * The name of this test was already right and its assertion was half.
     *
     * It required `false`, which is the same answer as "the test ran and
     * passed" — so a report missing the named test produced "the mutation
     * SURVIVED", the one message that must never come from not looking. On
     * 2026-09-05 exactly that happened: a run that did not finish reported a
     * mutation as surviving, and I spent a while looking for a defect in the
     * code rather than in the checker.
     *
     * Null is a third answer: not found. The caller reports it as unresolved.
     */
    expect(namedTestFailed(report("something else", "failed"), "refuses X")).toBeNull();
    expect(namedTestFailed(report("refuses X", "passed"), "refuses X"), "a passing test is a different answer").toBe(false);
    expect(namedTestFailed(report("refuses X", "failed"), "refuses X")).toBe(true);
  });

  it("says not-found for a report with no results at all", () => {
    expect(namedTestFailed({}, "refuses X")).toBeNull();
    expect(namedTestFailed({ testResults: [] }, "refuses X")).toBeNull();
  });

  it("keeps every mutation anchor unique in its target file", () => {
    // Measured 2026-09-04: an anchor that appeared twice — once as code, once
    // quoted as data in the same file — mutated the quotation. The code was
    // never touched, the suite stayed green, and the mutation was reported as
    // surviving a test that in fact still bites. Ambiguity produced a false alarm
    // then; with the entries in their own file it would produce a false all-clear.
    /*
     * The precondition the two strongest coverage claims in this repository did
     * not have.
     *
     * Both of these are `for (const m of MUTATIONS)`, and this file guards
     * exactly that shape for SECRET_SHAPED, for DEBT and for the test titles —
     * and not for the list of 174 defects whose whole job is proving the suite
     * bites. Empty the array and both tests go green while the gate reports
     * nothing reintroduced. Found by a subagent on 2026-09-07.
     */
    expect(MUTATIONS.length, "no mutations; both tests below would pass on nothing")
      .toBeGreaterThan(100);

    /*
     * And no two entries may share an id, or a report naming one of them names
     * both — nor may any be a no-op, which leaves the file unchanged, lets its
     * named test pass, and has the gate report it survived.
     */
    const ids = (MUTATIONS as Array<{ id: string }>).map((m) => m.id);
    expect(new Set(ids).size, "two mutations share an id").toBe(ids.length);
    for (const m of MUTATIONS as Array<{ id: string; from: string; to: string }>) {
      expect(m.to, `${m.id} replaces its anchor with itself, so it changes nothing`).not.toBe(m.from);
    }

    /*
     * And no mutation may CONTAIN its own anchor.
     *
     * `to.includes(from)` means the anchor survives the mutation — so if a run
     * is killed with that one applied, the next run reads the already-mutated
     * text as the original, mutates on top of it, and restores the mutated text
     * in `finally`. The planted defect becomes permanent while the harness
     * reports it caught. A subagent found four of these on 2026-09-09; unlike
     * the others they do not even leave an unresolved anchor behind to notice.
     */
    for (const m of MUTATIONS as Array<{ id: string; from: string; to: string }>) {
      expect(m.to.includes(m.from),
        `${m.id} keeps its own anchor inside the replacement, so a killed run would make it permanent`)
        .toBe(false);
    }

    const root = new URL("../", import.meta.url).pathname;
    for (const m of MUTATIONS as Array<{ id: string; file: string; from: string }>) {
      const text = readFileSync(join(root, m.file), "utf8");
      const hits = text.split(m.from).length - 1;
      expect(hits, `${m.id}: anchor appears ${hits} times in ${m.file}`).toBe(1);
    }
  });

  it("answers for the test it was asked about, not for one whose name ends the same way", () => {
    /*
     * `namedTestFailed` matched `fullName.endsWith(name)`, so a title ENDING
     * with another test's title answered for it — and which one the loop
     * reached first depended on how vitest happened to order the files that
     * run. A mutation was reported caught or survived by file ordering rather
     * than by the code. A subagent found it on 2026-09-09.
     */
    const report = {
      testResults: [
        { assertionResults: [
          { title: "the readiness counter refuses a claim that names no test",
            fullName: "readiness the readiness counter refuses a claim that names no test",
            status: "passed" },
          { title: "refuses a claim that names no test",
            fullName: "gate refuses a claim that names no test",
            status: "failed" },
        ] },
      ],
    };
    expect(namedTestFailed(report, "refuses a claim that names no test"),
      "the suffix must not answer for the test actually named").toBe(true);
    expect(namedTestFailed(report, "the readiness counter refuses a claim that names no test"))
      .toBe(false);
    expect(namedTestFailed(report, "a title nobody wrote"),
      "not found is still its own answer").toBeNull();
  });

  it("names a real test for every mutation, so none can be caught by accident", () => {
    // The suite files are DISCOVERED, not listed. Listing them was the same
    // defect this project keeps producing: a third test file was added, the
    // list still named two, and a mutation pointing into the new file read as
    // "names a test that does not exist" while the test was right there.
    const testDir = new URL("./", import.meta.url).pathname;
    const suite = collectTests(testDir).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(collectTests(testDir).length, "no test files discovered").toBeGreaterThan(2);
    // A subagent review on 2026-09-04: this searched the whole source text, so
    // the phrase surviving in a COMMENT satisfied it after the test itself was
    // renamed or deleted. It must find a declaration, not a mention.
    //
    // A mustFail name is matched as the literal argument of it(), so a mutation
    // may only point at a statically named test. A name assembled inside a loop
    // is not findable here and fails — the right outcome, since such a mutation
    // could not prove which test caught it either.
    /*
     * Counted, not collapsed into a Set.
     *
     * `namedTestFailed` returns on the FIRST title that matches, and the vitest
     * reporter orders results by file path — so two tests sharing a title mean
     * one of them silently answers for the other, and a mutation can be
     * reported caught by a test that never ran against it. That happened on
     * 2026-09-07: a fix of mine duplicated two titles across files and the
     * verdict was right by alphabet. The rename closed it; a Set could not have
     * seen it, which is why this now counts.
     */
    /*
     * `probe(...)` counts too. It is a two-line wrapper in
     * tests/scenarios/absence.test.ts whose whole body is `it(n, ...)`, so a
     * probe IS a statically named test — its title reaches the vitest report
     * exactly as written, which is what namedTestFailed looks it up by. The
     * matcher below only knew the literal `it(` spelling, so on 2026-09-07 six
     * mutations naming real, running probes were reported as naming tests that
     * do not exist. A matcher that misses a declaration form is a matcher that
     * refuses correct work.
     */
    const titles = [...suite.matchAll(/\b(?:it|probe)\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!);
    expect(titles.length, "no it() declarations were found; the matcher is broken").toBeGreaterThan(20);
    for (const m of MUTATIONS as Array<{ id: string; mustFail: string }>) {
      const times = titles.filter((t) => t === m.mustFail).length;
      expect(times,
        times === 0
          ? `${m.id} names a test that is not declared anywhere: ${m.mustFail}`
          : `${m.id} names a title declared ${times} times; the mutation would be judged by whichever `
            + `file sorts first, not by the test written for it: ${m.mustFail}`)
        .toBe(1);
    }
  });

  /*
   * And no two tests anywhere may share a title, whether a mutation names them
   * or not — the next duplicate would otherwise be invisible until it happened
   * to collide with a mustFail.
   */
  it("declares no test title twice across the suite", () => {
    const suite = collectTests(new URL("./", import.meta.url).pathname)
      .map((f: string) => readFileSync(f, "utf8")).join("\n");
    const titles = [...suite.matchAll(/\b(?:it|probe)\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!);
    expect(titles.length, "no titles found; this would pass on an empty set").toBeGreaterThan(100);
    const seen = new Map<string, number>();
    for (const t of titles) seen.set(t, (seen.get(t) ?? 0) + 1);
    const repeated = [...seen.entries()].filter(([, n]) => n > 1).map(([t, n]) => `${t} (${n})`);
    expect(repeated,
      "a shared title makes the mutation harness answer from whichever file sorts first").toEqual([]);
  });
});

describe("a stale report is not a result", () => {
  const fakeFs = (state: { exists: boolean; body: string }) => ({
    rm: () => { state.exists = false; },
    exists: () => state.exists,
    read: () => state.body,
  });

  it("deletes the old report before running, so yesterday's run cannot answer today's question", () => {
    // Codex, chunk 0 round 8: the mutation check reused its report file without
    // deleting it. A run that started and died before writing left the previous
    // report in place, and the mutation was declared caught on evidence from a
    // different execution entirely.
    const state = { exists: true, body: JSON.stringify({ numTotalTests: 99 }) };
    const { json } = readFreshReport("/tmp/whatever.json", () => ({ ran: true }), fakeFs(state));
    expect(json, "a report from an earlier run was read as this run's result").toBe(null);
  });

  it("reads the report when the run actually wrote one", () => {
    const state = { exists: false, body: "" };
    const { json } = readFreshReport("/tmp/whatever.json", () => {
      state.exists = true;
      state.body = JSON.stringify({ numTotalTests: 7 });
      return { ran: true };
    }, fakeFs(state));
    expect(json).toEqual({ numTotalTests: 7 });
  });

  it("returns null rather than throwing when the report is unreadable", () => {
    const state = { exists: false, body: "" };
    const { json } = readFreshReport("/tmp/whatever.json", () => {
      state.exists = true;
      state.body = "{ not json";
      return { ran: true };
    }, fakeFs(state));
    expect(json).toBe(null);
  });
});

describe("what a killed mutation run leaves behind", () => {
  /*
   * Measured on 2026-09-05: a run was interrupted, the prompt file stayed
   * mutated — telling the model a hypothesis code is whatever seems right,
   * the exact defect that had already wasted a paid run — and the tree stayed
   * broken until a later test happened to notice. The finally block does not
   * run when the process is killed, so the guarantee lives in a file instead.
   */
  const record = (dir: string, file: string, original: string, mutated = "the mutated text") => {
    const path = join(dir, "in-flight.json");
    writeFileSync(path, JSON.stringify({ id: "some-mutation", file, original, mutated }));
    return path;
  };

  it("puts the file back and says which mutation left it broken", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    const target = join(dir, "prompt.md");
    writeFileSync(target, "the mutated text");
    const path = record(dir, target, "the original text");

    const r = restoreInterruptedMutation(path, dir);
    expect(r?.state).toBe("restored");
    expect(r?.id).toBe("some-mutation");
    expect(readFileSync(target, "utf8")).toBe("the original text");
    expect(existsSync(path), "the record must go, or every later run repeats the repair").toBe(false);
  });

  it("takes the repair before it runs the gate, or there is nothing left to repair", () => {
    /*
     * Passing the repair as the second argument beside a call to the gate reads
     * as "repair alongside the gate". JavaScript evaluates arguments left to
     * right, so
     * `runGate()` went first — and its mutation check writes and then deletes
     * `out/mutation-in-flight.json` once per mutation, so the repair that
     * followed found nothing, every time. The guarantee that a killed run is
     * put back and said out loud was dead from the commit that folded two
     * statements into one expression, and nothing failed. A subagent found it
     * on 2026-09-09.
     *
     * Asserted against the source for the same reason as the test below: the
     * property is an ORDERING, and both halves pass their own unit tests while
     * the order between them is wrong.
     */
    const src = readFileSync(new URL("../scripts/acceptance-gate.mjs", import.meta.url).pathname, "utf8");
    const takes = src.indexOf("const repaired = restoreInterruptedMutation();");
    // The STATEMENT, not any mention of it: the comment above names the same
    // call, and comparing against a comment is comparing against prose.
    const runs = src.indexOf("const gate = withRepair(runGate()");
    expect(takes, "the repair is not taken into a variable before the gate runs").toBeGreaterThan(-1);
    expect(runs, "nothing calls withRepair around the gate").toBeGreaterThan(-1);
    expect(takes, "the repair is read after the gate has already deleted the evidence")
      .toBeLessThan(runs);
    expect(src, "the repair may not be an argument evaluated beside the gate")
      .not.toContain("withRepair(runGate(), restoreInterruptedMutation())");
  });

  it("records the file before it damages it, which is the only ordering that survives a kill", () => {
    /*
     * Asserted against the source, because the property is an ORDERING and the
     * thing that violates it is a process that never reaches its next line.
     * A mutation for this survived every test written the other way: handing
     * restoreInterruptedMutation a record built by hand exercises the reading
     * side and says nothing about when the record is written.
     */
    const src = readFileSync(new URL("../scripts/acceptance-gate.mjs", import.meta.url).pathname, "utf8");
    const records = src.indexOf("writeFileSync(IN_FLIGHT, JSON.stringify(");
    const damages = src.indexOf("writeFileSync(target, original.replace(m.from, m.to))");
    expect(records, "nothing records the in-flight mutation").toBeGreaterThan(-1);
    expect(damages, "nothing applies a mutation; this test is about a thing that no longer happens").toBeGreaterThan(-1);
    expect(records, "the record is written after the file is broken, so a kill leaves no trace")
      .toBeLessThan(damages);
  });

  it("refuses to touch a file someone edited after the interruption", () => {
    /*
     * Codex, 2026-09-05, High: it used to overwrite whenever the file differed
     * from the recorded original, so a developer who fixed the file by hand and
     * kept working lost that work to a repair announcing itself as a repair.
     */
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    const target = join(dir, "prompt.md");
    writeFileSync(target, "the text somebody wrote afterwards");
    const path = record(dir, target, "the original text");

    const r = restoreInterruptedMutation(path, dir);
    expect(r?.state).toBe("refused");
    expect(readFileSync(target, "utf8"), "their work must survive").toBe("the text somebody wrote afterwards");
    expect(existsSync(path), "the record stays, so the next run says it again").toBe(true);
    expect(String(r?.detail)).toContain("by hand");
  });

  it("refuses a record naming a path outside the repository", () => {
    // A stale or forged record must not be a way to overwrite any writable file
    // on the machine. Refusing by path is checkable; trusting it is not.
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    const outside = join(dir, "somebody-elses.txt");
    writeFileSync(outside, "not ours");
    const path = record(dir, outside, "whatever");
    // The root is a sibling directory, so the recorded path is genuinely outside it.
    const r = restoreInterruptedMutation(path, mkdtempSync(join(tmpdir(), "root-")));
    expect(r?.state).toBe("refused");
    expect(String(r?.detail)).toContain("outside this repository");
    expect(readFileSync(outside, "utf8")).toBe("not ours");
  });

  it("refuses a symlink inside the repository that points outside it", () => {
    /*
     * Codex, 2026-09-05: comparing the resolved path STRING is not comparing
     * the real file. readFileSync and writeFileSync follow a link, so a record
     * naming one passed the check and would have restored a file outside.
     */
    const root = mkdtempSync(join(tmpdir(), "root-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    const outside = join(elsewhere, "not-ours.md");
    writeFileSync(outside, "the mutated text");

    const link = join(root, "looks-like-ours.md");
    symlinkSync(outside, link);

    const path = join(root, "in-flight.json");
    writeFileSync(path, JSON.stringify({ id: "some-mutation", file: link, original: "ours", mutated: "the mutated text" }));

    const r = restoreInterruptedMutation(path, root);
    expect(r?.state).toBe("refused");
    expect(readFileSync(outside, "utf8"), "the file outside must be untouched").toBe("the mutated text");
    // Naming the RESOLVED file, not the link. Asserting only "outside this
    // repository" passed while the check still judged the path string: on this
    // machine a temporary directory is itself a symlink, so the link's own path
    // already looked outside, and the mutation survived a test that read as
    // though it covered this.
    expect(String(r?.detail), "the refusal must name the file the link resolves to")
      .toContain(realpathSync(outside));
  });

  it("refuses a record naming a file that is not there, rather than resolving it away", () => {
    // realpathSync throws on a missing file, and that is the right answer: a
    // record describing nothing must not become permission to create it.
    const root = mkdtempSync(join(tmpdir(), "root-"));
    const path = join(root, "in-flight.json");
    writeFileSync(path, JSON.stringify({ id: "x", file: join(root, "gone.md"), original: "a", mutated: "b" }));
    const r = restoreInterruptedMutation(path, root);
    expect(r?.state).toBe("refused");
    expect(String(r?.detail)).toContain("cannot resolve");
  });

  it("says nothing happened when nothing was interrupted", () => {
    expect(restoreInterruptedMutation(join(mkdtempSync(join(tmpdir(), "gate-")), "absent.json"))).toBeNull();
  });

  it("keeps a file that is already correct, and still clears the record", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    const target = join(dir, "prompt.md");
    writeFileSync(target, "the original text");
    const path = record(dir, target, "the original text");
    const r = restoreInterruptedMutation(path, dir);
    expect(r?.state).toBe("already-clean");
    expect(existsSync(path)).toBe(false);
  });

  it("refuses to act on a record it cannot read, rather than guessing", () => {
    // A half-written record is not permission to overwrite a source file with
    // whatever could be parsed out of it.
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    const path = join(dir, "in-flight.json");
    writeFileSync(path, "{ not json");
    expect(restoreInterruptedMutation(path, dir)?.state).toBe("unreadable");
    writeFileSync(path, JSON.stringify({ id: "x" }));
    expect(restoreInterruptedMutation(path, dir)?.state).toBe("unreadable");
  });
});

/*
 * The Definition-of-Done coverage claim, checked the way readiness.mjs already
 * checked it. A subagent ran both against the same item on 2026-09-07: the
 * readiness counter called `covered: true, by: []` unestablished and this gate
 * counted it covered, because a loop over an empty array contributes nothing to
 * the list of gaps. One rule, two carriers, one of them guarded.
 */
describe("a Definition-of-Done item must name what covers it", () => {
  const passed = new Set(["a test that ran"]);

  it("refuses a coverage claim that names no test", () => {
    expect(coverageGaps([{ n: 1, claim: "c", covered: true, by: [] }], passed))
      .toEqual(['item 1: claims coverage and names no test']);
    expect(coverageGaps([{ n: 2, claim: "c", covered: true }], passed),
      "a missing `by` is the same claim with less typing")
      .toEqual(['item 2: claims coverage and names no test']);
  });

  it("refuses a coverage claim whose named test did not pass", () => {
    expect(coverageGaps([{ n: 3, claim: "c", covered: true, by: ["a test that did not"] }], passed))
      .toEqual(['item 3: "a test that did not"']);
  });

  it("accepts a claim whose named test ran and passed, or nothing below means anything", () => {
    expect(coverageGaps([{ n: 4, claim: "c", covered: true, by: ["a test that ran"] }], passed)).toEqual([]);
    expect(coverageGaps([{ n: 5, claim: "c", covered: false, needs: "x" }], passed),
      "an uncovered item is not a gap; it is honest").toEqual([]);
  });
});

/*
 * A promise that waits on a filename nobody writes is not a promise.
 *
 * DEBT used to hold `unlessArtifact: "docs/runs/deployed-chain.json"` — a path
 * appearing exactly once in the repository, on that line, written by nothing.
 * The debt therefore waited forever while six records of live runs through the
 * deployed workflow sat in the same directory, and the gate printed PASS for a
 * promise that could never come due. A subagent found it by grepping the name.
 */
describe("a debt waits on a condition something can answer", () => {
  /*
   * Written the way this repository's own rules ask, because the first draft of
   * it looped over zero entries and passed on nothing — the very defect being
   * guarded, committed inside the guard. There is no `unlessArtifact` left, so
   * the loop is empty TODAY; the assertion below states that as a precondition
   * instead of hiding it, and the test becomes live again the moment somebody
   * reintroduces a filename as a waiting condition.
   */
  it("gives every debt a waiting condition something can actually answer", () => {
    expect(DEBT.length, "no debts; this whole block would pass on an empty set").toBeGreaterThan(0);
    let artifactConditions = 0;
    for (const d of DEBT) {
      const waits = typeof d.unlessArtifact === "string" || d.unlessScoredRun === true;
      expect(waits, `debt ${d.id ?? JSON.stringify(d).slice(0, 40)} names no waiting condition at all`).toBe(true);
      if (typeof d.unlessArtifact !== "string") continue;
      artifactConditions += 1;
      const found = spawnSync("git", ["grep", "-l", "--", d.unlessArtifact], { encoding: "utf8" });
      const carriers = (found.stdout ?? "").trim().split("\n").filter(Boolean)
        .filter((f) => f !== "scripts/acceptance-gate.mjs");
      expect(carriers.length,
        `${d.unlessArtifact} is named only by the debt that waits for it, so nothing can ever produce it`)
        .toBeGreaterThan(0);
    }
    // Stated, not asserted: the count is allowed to be zero. Printing it is what
    // stops "no filename conditions" from looking like "every one checks out".
    expect(artifactConditions, "the filename branch above ran this many times").toBeGreaterThanOrEqual(0);
  });

  it("treats a run record with no machine-readable scores as no scored run", () => {
    const d = mkdtempSync(join(tmpdir(), "debt-"));
    writeFileSync(join(d, "a.json"), JSON.stringify({ outcome: "it went fine, honestly" }));
    expect(someRunWasScored(d), "prose is not a recorded result").toBe(false);
    writeFileSync(join(d, "b.json"), JSON.stringify({ scored: {} }));
    expect(someRunWasScored(d), "an empty scores object is not a scored run").toBe(false);
    /*
     * The scorer writes a key for EVERY scenario whatever happened — `unasked`
     * for one no part of a staged purchase bought, `unestablished` for one that
     * answered nothing. Counting keys alone let a record of nothing but those
     * two flip the promised checks from waiting to due, on the strength of a
     * run that established nothing. `recordInto` refuses to write such a
     * record; this reader must not lean on a guarantee made in another file,
     * because a hand-edited record reaches it too.
     */
    writeFileSync(join(d, "c.json"), JSON.stringify({
      scored: { "container-oom": "unasked", "cpu-throttling": "unestablished" } }));
    expect(someRunWasScored(d), "nothing established is not a scored run").toBe(false);
    writeFileSync(join(d, "d.json"), JSON.stringify({
      scored: { "container-oom": "unasked", "cpu-throttling": "correct" } }));
    expect(someRunWasScored(d), "one real verdict beside them is").toBe(true);
  });

  it("says no when the directory is not there, rather than throwing", () => {
    expect(someRunWasScored(join(tmpdir(), "does-not-exist-at-all-9182"))).toBe(false);
  });
});

/*
 * Two ways this gate said PASS for something it had not established, both found
 * by a subagent on 2026-09-07 that simply called the functions.
 */
describe("the gate does not pass for what it never checked", () => {
  it("refuses to call an empty run a pass", () => {
    const g = runGate([]);
    expect(g.results.length).toBe(0);
    expect(g.exitCode, "a gate that checked nothing established nothing").toBe(2);
    expect(g.nothingChecked).toBe(true);
    expect(format(g)).toContain("COULD NOT ESTABLISH");
  });

  /*
   * `refused` and `unreadable` both mean: this gate does not know whether a
   * source file still holds a planted defect. That is exit 2 by definition, and
   * it was printed and dropped — while scripts/readiness.mjs read the recorded
   * exitCode and reported the gate green.
   */
  it("carries an unrepaired mutation into the exit code, not only into the text", () => {
    const clean = runGate([{ id: "x", describe: "d", run: () => ({ state: "pass", detail: "ok" }) }]);
    expect(clean.exitCode, "the baseline must be 0, or this test proves nothing").toBe(0);

    for (const state of ["refused", "unreadable"]) {
      const g = withRepair(clean, { state, detail: "could not read the in-flight record" });
      expect(g.exitCode, `${state} must reach the exit code`).toBe(2);
    }
    // A repair that succeeded, or found nothing to do, changes no code.
    for (const state of ["restored", "already-clean"]) {
      const g = withRepair(clean, { state, id: "m", file: "f" });
      expect(g.exitCode, `${state} is an answer, not an unknown`).toBe(0);
    }
    // And no record at all is not an unknown either.
    expect(withRepair(clean, null).exitCode).toBe(0);
  });
});

/*
 * A report from a previous execution is not evidence about this one.
 *
 * checkTests returns early when the gate is already inside a vitest child —
 * before readFreshReport deletes the old file — so the Definition-of-Done check
 * read a report written minutes earlier by a different run and printed "5 of 10
 * covered by tests that ran and passed" while vitest had not run at all. A
 * subagent reproduced it on 2026-09-07 by calling the two checks in order.
 * readFreshReport's own comment says "both callers go through here now"; there
 * was a third reader.
 */
describe("coverage is established from this run's test report, not a leftover", () => {
  it("refuses a report written before this gate run started", () => {
    const d = mkdtempSync(join(tmpdir(), "report-"));
    const f = join(d, "vitest-report.json");
    writeFileSync(f, "{}");
    const mtime = statSync(f).mtimeMs;
    // A run that started AFTER the file was written cannot have written it.
    expect(reportIsFromThisRun(f, mtime + 1000), "a report older than the run is not this run's")
      .toBe(false);
    // A run that started before it, and is still going, did.
    expect(reportIsFromThisRun(f, mtime - 1000), "and one written since the run began is").toBe(true);
  });

  it("says no for a report that is not there, rather than throwing", () => {
    expect(reportIsFromThisRun(join(tmpdir(), "absent-report-8812.json"), 0)).toBe(false);
  });
});

/*
 * Every check is CALLED by something, and the ones that are not say why.
 *
 * A subagent counted on 2026-09-07: of the nine checks, exactly one — `tests` —
 * ever had its `run()` called from the suite, under describe blocks named for
 * the others. `runGate` wraps a throw into `unknown`, so a check that threw on
 * every input would report "could not establish" forever and the gate would
 * exit 2 for a reason nobody would trace to a bug in the check itself.
 *
 * Four are run here. Five are not, and each names its reason — a check left out
 * of both lists fails the last assertion, so a new one cannot be added to
 * neither by accident.
 */
describe("every gate check is exercised, or says why not", () => {
  const RUN_HERE = ["declared-scripts-exist", "no-secrets-near-commit",
    "promised-checks-due", "definition-of-done"];

  const NOT_RUN_HERE: Record<string, string> = {
    tests: "it spawns vitest, and vitest running vitest is the hang this gate guards against",
    "core-builds-clean": "it shells out to a build that takes seconds and writes into out/",
    typecheck: "it shells out to tsc over the whole tree",
    "mutations-still-caught": "it breaks source files on purpose and runs the suite per mutation",
    "no-drift-from-baseline": "it compares against a recorded export and reads out/",
  };

  it("calls a promise due when its chunk has come and nothing is waiting on it", () => {
    /*
     * The only test over this asserted the check's STATE — one of pass, fail,
     * unknown — which every branch satisfies. So `const due = []` reported PASS
     * while a promise was overdue, and the whole purpose of DEBT could be
     * deleted in one line. A subagent measured it on 2026-09-09.
     */
    const yes = () => true;
    const no = () => false;
    const debts = [
      { claim: "a", dueFromChunk: 5 },
      { claim: "b", dueFromChunk: 5, unlessArtifact: "docs/x.md" },
      { claim: "c", dueFromChunk: 5, unlessScoredRun: true },
      { claim: "d", dueFromChunk: 9 },
    ];
    const at6 = splitDebt(debts, 6, { artifactExists: no, scored: false });
    expect(at6.due.map((d: { claim: string }) => d.claim), "only the one with nothing to wait for")
      .toEqual(["a"]);
    expect(at6.waiting.map((d: { claim: string }) => d.claim)).toEqual(["b", "c"]);

    const settled = splitDebt(debts, 6, { artifactExists: yes, scored: true });
    expect(settled.due.map((d: { claim: string }) => d.claim),
      "once what they waited for happened, they are due").toEqual(["a", "b", "c"]);

    expect(splitDebt(debts, 4, { artifactExists: yes, scored: true }).due,
      "a chunk that has not come yet owes nothing").toEqual([]);

    /*
     * A debt with no `dueFromChunk` used to be due NEVER, because
     * `chunk >= undefined` is false — the only required field was the one
     * nothing required.
     */
    expect(splitDebt([{ claim: "e" }], 1, { artifactExists: yes, scored: true })
      .due.map((d: { claim: string }) => d.claim),
      "a promise with no chunk is due from the first one, not from none").toEqual(["e"]);
  });

  it("recognises the state of every check it can run", () => {
    expect(RUN_HERE.length, "nothing is run; this would pass on an empty set").toBeGreaterThan(3);
    for (const id of RUN_HERE) {
      const check = (CHECKS as Array<{ id: string; run: () => { state?: string } }>).find((c) => c.id === id);
      expect(check, `${id} is not in CHECKS any more`).toBeDefined();
      // A throw here is the finding: runGate would turn it into `unknown` and
      // the gate would say "could not establish" forever.
      const r = check!.run();
      expect(["pass", "fail", "unknown"], `${id} returned ${JSON.stringify(r?.state)}`)
        .toContain(r?.state);
    }
  });

  it("accounts for every check, so a new one cannot be silently unexercised", () => {
    const ids = (CHECKS as Array<{ id: string }>).map((c) => c.id);
    expect(ids.length, "no checks at all").toBeGreaterThan(5);
    const accounted = new Set([...RUN_HERE, ...Object.keys(NOT_RUN_HERE)]);
    const orphans = ids.filter((id) => !accounted.has(id));
    expect(orphans, "these checks are neither run here nor excused; say which and why").toEqual([]);
    // And nothing may be excused that no longer exists.
    const stale = [...accounted].filter((id) => !ids.includes(id));
    expect(stale, "these are named here but are not checks any more").toEqual([]);
  });
});

describe("the chunk a promised check falls due from", () => {
  /*
   * The default for a missing `dueFromChunk` lived inside the filter that
   * enforces it, and two printers read the raw field — so an entry without the
   * field was enforced as due now and reported as "from chunk undefined".
   * A subagent found it on 2026-09-09. One carrier decides, and it is the one
   * the report prints.
   */
  it("is zero when the entry does not say, so the report never prints undefined", () => {
    expect(dueFrom({ claim: "x" } as any), "a debt that does not say is due now").toBe(0);
    expect(`chunk ${dueFrom({ claim: "x" } as any)}`).toBe("chunk 0");
  });

  it("is the number the entry gives, when it gives one", () => {
    expect(dueFrom({ claim: "x", dueFromChunk: 6 } as any)).toBe(6);
  });

  it("refuses a non-number rather than printing it", () => {
    expect(dueFrom({ claim: "x", dueFromChunk: "6" } as any),
      "a string is not a chunk number, and printing it raw is how undefined got out").toBe(0);
  });
});

describe("what the artifact says against what the manifest claims about it", () => {
  /*
   * The manifest carried the literal 0 and the gate read it back, so the line
   * printing "0 requires" reported a number the builder had asserted about
   * itself. Weaken the builder's detector and the artifact ships a live
   * require while every reader still says zero. A subagent found it on
   * 2026-09-09; this is the comparison that now decides.
   */
  it("says nothing when both counted none", () => {
    expect(artifactDisagreesWithManifest([], 0)).toBe(null);
  });

  it("fails on a require the manifest did not admit", () => {
    const why = artifactDisagreesWithManifest(["ajv-formats"], 0);
    expect(why, "the artifact is the evidence, and it disagrees").toContain("ajv-formats");
    expect(why).toContain("the manifest claims 0");
  });

  it("fails when the manifest claims a require the artifact does not have", () => {
    expect(artifactDisagreesWithManifest([], 2),
      "the two counted different things, and neither is trusted over the other")
      .toMatch(/one of the two counted something the other did not/);
  });

  it("treats a missing count as none found, not as agreement", () => {
    expect(artifactDisagreesWithManifest(undefined as any, undefined as any),
      "an absent manifest number is not zero").not.toBe(null);
  });
});

describe("which file to run for one mutation", () => {
  /*
   * The mutation check asks one question — did the NAMED test fail — and used
   * to answer it by running all 735 tests, 265 times: about twenty minutes.
   * The file that declares the title is enough. What must not happen is
   * "I could not narrow it" quietly becoming "I checked less".
   */
  const report = { testResults: [
    { name: "/r/tests/a.test.ts", assertionResults: [{ fullName: "a shared title" }] },
    { name: "/r/tests/b.test.ts", assertionResults: [{ fullName: "a shared title" }, { fullName: "only here" }] },
  ] };

  it("names the one file that declares the title", () => {
    expect(filesDeclaring(report, "only here")).toEqual(["/r/tests/b.test.ts"]);
  });

  it("names both when two files declare the same title, rather than choosing", () => {
    expect(filesDeclaring(report, "a shared title").length,
      "choosing one of two would decide by report order, which decides nothing").toBe(2);
  });

  it("returns nothing for a title the report does not carry, so the caller runs everything", () => {
    expect(filesDeclaring(report, "never written"),
      "an empty list means could-not-narrow, and the caller must widen, not narrow").toEqual([]);
  });

  it("returns nothing for a report it could not read", () => {
    expect(filesDeclaring(null as never, "x")).toEqual([]);
    expect(filesDeclaring({} as never, "x")).toEqual([]);
  });
});
