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
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { runGate, format, restoreInterruptedMutation, CHECKS, CHILD_MARKER, LIMITATIONS, DEBT, SECRET_SHAPED, readFreshReport, interpretVitestReport, interpretScripts, findSecretShaped, parsePorcelainZ, readCurrentChunk, namedTestFailed } from "../scripts/acceptance-gate.mjs";
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
    for (const { re, catches } of SECRET_SHAPED) {
      const alternations = re.source.match(/\(([^()?][^()]*)\)/g) ?? [];
      for (const group of alternations) {
        for (const alt of group.slice(1, -1).split("|")) {
          const literal = alt.replace(/\\/g, "");
          if (literal === "" || literal === "^" || literal === "/") continue;
          const declared = catches.some((c: string) => c.includes(literal));
          expect(declared, `${re} can match "${literal}" but no declared name contains it`).toBe(true);
        }
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

  it("does not treat a test that vanished as caught", () => {
    // A renamed or deleted test must never read as "the defect was noticed".
    expect(namedTestFailed(report("something else", "failed"), "refuses X")).toBe(false);
  });

  it("survives a report with no results at all", () => {
    expect(namedTestFailed({}, "refuses X")).toBe(false);
  });

  it("keeps every mutation anchor unique in its target file", () => {
    // Measured 2026-09-04: an anchor that appeared twice — once as code, once
    // quoted as data in the same file — mutated the quotation. The code was
    // never touched, the suite stayed green, and the mutation was reported as
    // surviving a test that in fact still bites. Ambiguity produced a false alarm
    // then; with the entries in their own file it would produce a false all-clear.
    const root = new URL("../", import.meta.url).pathname;
    for (const m of MUTATIONS as Array<{ id: string; file: string; from: string }>) {
      const text = readFileSync(join(root, m.file), "utf8");
      const hits = text.split(m.from).length - 1;
      expect(hits, `${m.id}: anchor appears ${hits} times in ${m.file}`).toBe(1);
    }
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
    const declared = new Set([...suite.matchAll(/\bit\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]));
    expect(declared.size, "no it() declarations were found; the matcher is broken").toBeGreaterThan(20);
    for (const m of MUTATIONS as Array<{ id: string; mustFail: string }>) {
      expect(declared.has(m.mustFail), `${m.id} names a test that is not declared anywhere: ${m.mustFail}`).toBe(true);
    }
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

