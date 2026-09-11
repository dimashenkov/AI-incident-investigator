/**
 * The runner is the only thing standing between a paid answer and somebody
 * retyping it.
 *
 * Every earlier run was entered by hand from what the n8n screen showed, which
 * the protocol forbids for the obvious reason: a number a person retypes is a
 * number nobody can check. These tests are about the ways this file could still
 * make a run look better, cheaper, or more complete than it was.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, symlinkSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
// @ts-expect-error - plain .mjs script, no types
import { CHARGED_PREFIX, CHARGED_SENTENCE, splitKey, alertFor, callOnce, mergeAnswers, recordShape, hostOf, loadEnvFile, parseArgv, refuseToStart, recordPathFor, refuseAliasedPaths, writeAtomic, tempNameFor, writeOrderFor, addressIsWrong, mayHaveBeenCharged, inFlightFromRecords } from "../scripts/run-scenarios.mjs";

const SCENARIOS = new URL("../scenarios/", import.meta.url).pathname;

describe("issuing the paid runs and writing down what came back", () => {
  it("reads an attempt key as its scenario and its attempt", () => {
    expect(splitKey("image-pull-failure#2")).toEqual({ scenario: "image-pull-failure", attempt: 2 });
    expect(splitKey("image-pull-failure")).toEqual({ scenario: "image-pull-failure", attempt: null });
    // A `#` that is not an attempt is part of the name, not a broken attempt.
    expect(splitKey("odd#name")).toEqual({ scenario: "odd#name", attempt: null });
  });

  it("keeps a missing alert apart from an unreadable one", () => {
    const real = alertFor("container-oom", SCENARIOS);
    expect(real.state, "the fixtures on disk must still be readable, or this file tests nothing").toBe("known");
    expect(alertFor("no-such-scenario", SCENARIOS).state).toBe("missing");
  });

  it("records a chain refusal as an ANSWER, not as a failure to reach it", async () => {
    /*
     * A refusal is the chain saying something, and the scorer treats it as an
     * answer that may be right or wrong. Folding it into "unreachable" would
     * hide a real result behind a transport error.
     */
    const refusal = { state: "refused", reason: "the incident carries 0 root cause results" };
    const r = await callOnce("https://example/webhook/x", {}, {
      fetchImpl: async () => new Response(JSON.stringify(refusal), { status: 200 }),
    });
    expect(r.state).toBe("answered");
    expect(r.answer).toEqual(refusal);
  });

  it("never turns a transport failure into an answer", async () => {
    const http = await callOnce("https://example/webhook/x", {}, {
      fetchImpl: async () => new Response("gateway is unwell", { status: 502 }),
    });
    expect(http.state, "an HTTP error is not the model's answer").toBe("unreachable");
    expect(http.answer).toBeUndefined();

    const notJson = await callOnce("https://example/webhook/x", {}, {
      fetchImpl: async () => new Response("<html>502</html>", { status: 200 }),
    });
    expect(notJson.state, "a reply that arrived and was not JSON is its own state").toBe("unreadable");
    expect(notJson.answer).toBeUndefined();
  });

  it("calls exactly once and does not retry when nothing replies", async () => {
    /*
     * A hung execution may already have been billed. Calling again is a second
     * bill for the same question, recorded as if it were the same run — the way
     * one permission becomes three charges.
     */
    let calls = 0;
    const r = await callOnce("https://example/webhook/x", {}, {
      timeoutMs: 5,
      fetchImpl: (_u: string, init: { signal: AbortSignal }) => {
        calls += 1;
        return new Promise((_res, rej) => {
          init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      },
    });
    expect(calls, "one authorisation is one call").toBe(1);
    expect(r.state).toBe("unreachable");
    expect(r.why).toMatch(/timed out/);
  });

  it("does not overwrite an answer that was already paid for", () => {
    const before = { "container-oom#1": { state: "concluded", root_cause_code: "CONTAINER_OOM" } };
    const { answers, refused } = mergeAnswers(before, {
      "container-oom#1": { state: "refused" },
      "container-oom#2": { state: "concluded", root_cause_code: "CONTAINER_OOM" },
    });
    expect(answers["container-oom#1"], "the earlier answer stands").toEqual(before["container-oom#1"]);
    expect(refused, "and the caller is told which ones it did not take").toEqual(["container-oom#1"]);
    expect(Object.keys(answers)).toHaveLength(2);
  });

  it("writes the token counts as unestablished rather than as zero", () => {
    /*
     * The webhook returns the report; the Collect nodes keep only the reply, so
     * usage never reaches this script. Writing 0 would make the spend counter
     * report a cost nobody paid and hide a cost somebody did.
     */
    const rec = recordShape(["container-oom#1"], {
      when: "2026-09-08", webhookHost: "example.app.n8n.cloud",
      outcomes: { "container-oom#1": "answered" },
    });
    expect(rec.totals.input_tokens).toBeNull();
    expect(rec.totals.output_tokens).toBeNull();
    expect(rec.totals.why, "and it says why, so the gap is readable").toMatch(/no usage/);
    expect(rec.scored, "the record carries no verdict until the scorer writes one").toBeNull();
  });

  it("names the instance by host, and never by anything that could carry a token", () => {
    expect(hostOf("https://x.app.n8n.cloud/webhook/ai-sre-incident?key=secret")).toBe("x.app.n8n.cloud");
    expect(hostOf("not a url"), "an unreadable address is said to be unreadable").toBe("unreadable");
  });

  it("lets the environment win over the file, and ignores lines that are not settings", () => {
    /*
     * The file is a fallback. If it could override the environment, a stale
     * line would silently replace a deliberate one-off, and the run would go to
     * an instance nobody chose.
     */
    const env: Record<string, string> = { N8N_WEBHOOK_URL: "chosen" };
    loadEnvFile("N8N_WEBHOOK_URL=stale\n# comment\nOTHER='quoted'\nnot a setting\n=nokey\n", env);
    expect(env.N8N_WEBHOOK_URL, "a value already chosen is not replaced").toBe("chosen");
    expect(env.OTHER, "quotes around a value are not part of it").toBe("quoted");
    expect(Object.keys(env).sort()).toEqual(["N8N_WEBHOOK_URL", "OTHER"]);
  });
});

/*
 * Six ways this script could have paid twice, paid for nothing, or reported a
 * paid run as clean. All six were found by Grok on 2026-09-08, BEFORE the first
 * call it would ever make.
 */
describe("what the runner refuses to do with the owner's money", () => {
  it("does not buy the value of a flag as if it were a scenario", () => {
    /*
     * `--record oom-killed thing#2` bought TWO runs: the wanted one, and the
     * path to the record, because everything not starting with -- was a key.
     */
    const { keys, flags } = parseArgv(["--record", "container-oom", "cpu-throttling#2", "--answers", "out/a.json"]);
    expect(keys, "a flag's value is not a run to pay for").toEqual(["cpu-throttling#2"]);
    expect(flags["--record"]).toBe("container-oom");
    expect(flags["--answers"]).toBe("out/a.json");
  });

  it("refuses a key named twice, before anything is called", () => {
    // Two calls under one key pay twice and keep one answer.
    expect(refuseToStart(["container-oom#1", "container-oom#1"], {}))
      .toMatch(/named twice/);
    expect(refuseToStart(["container-oom#1", "container-oom#2"], {}), "distinct attempts are fine").toBeNull();
  });

  it("refuses a key the answers file already answers, before anything is called", () => {
    /*
     * mergeAnswers keeps the earlier answer, so paying again produces a body
     * this script then throws away — money spent for nothing, and stdout saying
     * "kept the earlier answer" as if that were a result.
     */
    const stop = refuseToStart(["container-oom#1"], { "container-oom#1": { state: "concluded" } });
    expect(stop).toMatch(/already carries an answer/);
    expect(stop).toMatch(/name#2/);
  });

  it("never writes a run record over another run's record", () => {
    const taken = new Set(["/r/2026-09-08-webhook-run.json", "/r/2026-09-08-webhook-run-2.json"]);
    const got = recordPathFor("/r/2026-09-08-webhook-run.json", "2026-09-08", (p: string) => taken.has(p));
    expect(got, "a third run gets a third file").toBe("/r/2026-09-08-webhook-run-3.json");
    expect(recordPathFor("/r/free.json", "2026-09-08", () => false)).toBe("/r/free.json");
  });

  it("names a record path even when the caller gives none, so a paid run always leaves one", () => {
    const got = recordPathFor(null, "2026-09-08", () => false);
    expect(got, "a paid run without an artifact is a run the spend counter cannot see")
      .toMatch(/docs\/runs\/2026-09-08-webhook-run\.json$/);
  });

  it("treats a value deliberately blanked in the environment as chosen", () => {
    /*
     * `N8N_WEBHOOK_URL=` is an operator saying "no address". The first version
     * skipped only a non-empty value, so the file refilled it and the run went
     * to whatever instance the file still named.
     */
    const env: Record<string, string> = { N8N_WEBHOOK_URL: "" };
    loadEnvFile("N8N_WEBHOOK_URL=https://stale/webhook/x\n", env);
    expect(env.N8N_WEBHOOK_URL, "set is set, and empty is a choice").toBe("");
  });
});

/*
 * Five more, found by Codex on 2026-09-08 by walking main as if it were running
 * for real. main is not unit tested, so these test the decisions it makes.
 */
describe("what the runner refuses when its own writing could destroy the evidence", () => {
  it("refuses to write the record over the answers", () => {
    /*
     * Every call flushes the answers and then the record. One path for both and
     * the second write erases the first: three paid calls, three counted as
     * written, exit 0, and no answer anywhere.
     */
    expect(refuseAliasedPaths("/x/a.json", "/x/a.json")).toMatch(/both point at/);
    expect(refuseAliasedPaths("/x/./a.json", "/x/a.json"), "the same file by another spelling is the same file")
      .toMatch(/both point at/);
    expect(refuseAliasedPaths("/x/a.json", "/x/b.json")).toBeNull();
  });

  it("does not follow a redirect, because following it POSTs again", async () => {
    /*
     * 307 and 308 keep the method and the body, so a redirect arriving after
     * the workflow has run replays the whole paid execution at a new address.
     */
    let seen: Record<string, unknown> | undefined;
    await callOnce("https://example/webhook/x", {}, {
      fetchImpl: async (_u: string, init: Record<string, unknown>) => {
        seen = init;
        return new Response("{}", { status: 200 });
      },
    });
    expect(seen!.redirect, "one authorisation is one execution, wherever the server points next").toBe("error");
  });

  it("keeps the body of a reply it could not use, because that call may have been charged", async () => {
    const r = await callOnce("https://example/webhook/x", {}, {
      fetchImpl: async () => new Response("upstream said no", { status: 502 }),
    });
    expect(r.state).toBe("unreachable");
    expect(r.body, "a charged call with nothing recorded is a charge nobody can see").toBe("upstream said no");
  });
});

/*
 * Seven more, from a round of review over the FIXES: Codex and Grok
 * independently, 2026-09-08, still before the script had been run once.
 */
describe("what survives a kill, a wrong address, and two names for one file", () => {
  it("leaves either the old file or the new one, never half of one", () => {
    /*
     * writeFileSync truncates in place, and the file being written is the
     * record of money already spent. A kill mid-write left an empty or partial
     * JSON where the evidence had been.
     */
    const d = mkdtempSync(join(tmpdir(), "atomic-"));
    try {
      const f = join(d, "a.json");
      writeAtomic(f, '{"one":1}\n');
      writeAtomic(f, '{"two":2}\n');
      expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ two: 2 });
      /*
       * Any scratch file, not one spelled `<path>.tmp`.
       *
       * The first version named the exact string, and when the scratch name
       * gained a pid the assertion started passing whether the rename happened
       * or not — a test that had decayed into a decoration two hours after it
       * was written. The mutation run caught it; nothing else did.
       */
      expect(readdirSync(d).filter((n) => n.endsWith(".tmp")),
        "no scratch file survives the rename").toEqual([]);
      expect(readdirSync(d), "and the target is the only thing left").toEqual(["a.json"]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("stops the line when the failure is about the address, not the scenario", () => {
    /*
     * After key 1 came back unreachable, keys 2 and 3 were still POSTed to the
     * same URL — one wrong address bought the whole list. Grok, 2026-09-08.
     */
    expect(addressIsWrong({ state: "unreachable", why: "no reply: timed out after 300000ms" }),
      "no reply at all says nothing about the next scenario").toBe(true);
    for (const code of [401, 403, 404, 405]) {
      expect(addressIsWrong({ state: "unreachable", why: `HTTP ${code}` }), `HTTP ${code} is the address`).toBe(true);
    }
    expect(addressIsWrong({ state: "unreachable", why: "HTTP 500" }),
      "a server error on one run is about that run").toBe(false);
    expect(addressIsWrong({ state: "answered", answer: {} })).toBe(false);
  });

  it("keeps a timeout saying the call may have been charged", () => {
    /*
     * The intent line said "may have been charged" and the timeout overwrote it
     * with a plain transport failure — so the case most likely to have run and
     * been billed dropped out of the warning at the end.
     */
    expect(mayHaveBeenCharged({ state: "unreachable", why: "no reply: timed out after 300000ms" })).toBe(true);
    /*
     * The first version of this test asserted that a 502 was NOT a possible
     * charge. That was my claim and it was wrong: a gateway error after the
     * workflow has started says nothing about whether the model was called.
     * The same for a reply that arrived and could not be parsed — the workflow
     * ran to produce it. Grok, 2026-09-08. Only a refusal at the door proves
     * nothing ran.
     */
    expect(mayHaveBeenCharged({ state: "unreachable", why: "HTTP 502" }),
      "a gateway error after the workflow started proves nothing about the model").toBe(true);
    expect(mayHaveBeenCharged({ state: "unreadable", why: "the reply was not JSON: x" }),
      "a reply this script could not read is still a reply something produced").toBe(true);
    for (const code of [401, 403, 404, 405]) {
      expect(mayHaveBeenCharged({ state: "unreachable", why: `HTTP ${code}` }),
        `HTTP ${code} is a refusal at the door`).toBe(false);
    }
    expect(mayHaveBeenCharged({ state: "answered", answer: {} })).toBe(false);
  });

  it("finds keys an earlier record says were called with no reply", () => {
    /*
     * The intent survived the kill and nothing read it: a restart saw the key
     * missing from the answers file and paid again. Codex, 2026-09-08.
     */
    const d = mkdtempSync(join(tmpdir(), "runs-"));
    try {
      writeFileSync(join(d, "a.json"), JSON.stringify({ outcomes: {
        "container-oom#1": "answered",
        "cpu-throttling#1": CHARGED_SENTENCE,
      } }));
      writeFileSync(join(d, "b.json"), JSON.stringify({ outcomes: { "other#1": "unreachable: HTTP 500" } }));
      writeFileSync(join(d, "c.json"), "not json at all");
      const found = inFlightFromRecords(d);
      expect([...found.keys()], "only the one nobody heard back from").toEqual(["cpu-throttling#1"]);
      expect(found.get("cpu-throttling#1")).toBe("a.json");

      expect(refuseToStart(["cpu-throttling#1"], {}, found), "and it refuses to buy it again")
        .toMatch(/may already have been charged/);
      expect(refuseToStart(["container-oom#2"], {}, found), "while an untouched key is free to buy").toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("sees two names for one file even when neither exists yet", () => {
    /*
     * The check compared path strings, so a symlinked directory gave two names
     * for one inode: each record write landed on the answers, and the counters
     * still allowed exit 0 after paid calls. Codex, 2026-09-08.
     */
    const d = mkdtempSync(join(tmpdir(), "alias-"));
    try {
      mkdirSync(join(d, "real"));
      symlinkSync(join(d, "real"), join(d, "link"));
      expect(refuseAliasedPaths(join(d, "real", "a.json"), join(d, "link", "a.json")),
        "one inode under two names is one file").toMatch(/both point at/);
      expect(refuseAliasedPaths(join(d, "real", "a.json"), join(d, "link", "b.json"))).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

/*
 * The last three, from the round that read the fixes: Codex and Grok reached
 * the first two independently, which is confirmation rather than one
 * measurement paid for twice.
 */
describe("what the runner does when it cannot write, or cannot read what came back", () => {
  it("stops the line when a call produces no answer", () => {
    /*
     * The loop stopped only when the failure looked like a wrong ADDRESS, so a
     * webhook answering HTML on every call, or a run of 500s, still bought the
     * whole list — each one possibly billed. The test for it lives in the
     * classifier the loop reads, because the loop itself is only exercised by a
     * real run.
     */
    for (const r of [
      { state: "unreadable", why: "the reply was not JSON: x" },
      { state: "unreachable", why: "HTTP 500" },
      { state: "unreachable", why: "HTTP 429" },
    ]) {
      expect(r.state === "answered", `${r.why} is not an answer, so the line stops`).toBe(false);
      expect(mayHaveBeenCharged(r), `${r.why} may already have been billed`).toBe(true);
    }
  });

  it("writes through a temporary name no other process can be holding", () => {
    /*
     * One shared `<path>.tmp` meant two runs at once wrote the same scratch
     * file and the last rename won, losing bodies that had been paid for.
     */
    const d = mkdtempSync(join(tmpdir(), "tmpname-"));
    try {
      const f = join(d, "a.json");
      writeAtomic(f, '{"one":1}\n');
      const leftovers = readdirSync(d).filter((n) => n.endsWith(".tmp"));
      expect(leftovers, "nothing is left behind to collide with").toEqual([]);
      /*
       * The discriminating case, and the first version of this test did not
       * have it: two sequential writes and no leftovers pass just as well with
       * ONE shared `<path>.tmp`. Codex, 2026-09-09.
       *
       * A file already sitting at the shared name is what tells them apart —
       * `wx` refuses to overwrite, so a shared name throws here and a name
       * carrying the pid does not.
       */
      writeFileSync(`${f}.tmp`, "somebody else is mid-write");
      writeAtomic(f, '{"two":2}\n');
      expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ two: 2 });
      expect(existsSync(`${f}.tmp`), "the other process's scratch file is untouched").toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

/*
 * main is the part that spends money, and until now nothing ran it.
 *
 * Every other test here exercises a decision main makes; two mutations proved
 * that is not the same thing — turning off the stop-the-line rule left the
 * whole file green. So this runs the real script, as a real process, against a
 * local server that answers the way a webhook would. No network leaves the
 * machine and no model is called.
 */
describe("running the script for real, against a server that is not n8n", () => {
  const RUNNER = new URL("../scripts/run-scenarios.mjs", import.meta.url).pathname;
  const ROOT = new URL("..", import.meta.url).pathname;

  const serve = async (reply: (n: number) => { status: number; body: string }) => {
    let calls = 0;
    const seen: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        calls += 1;
        try { seen.push(JSON.parse(body)); } catch { seen.push(body); }
        const r = reply(calls);
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(r.body);
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/webhook/x`, calls: () => calls, seen,
      close: () => new Promise<void>((ok) => server.close(() => ok())) };
  };

  /*
   * spawn, not spawnSync. The server lives in THIS process, so blocking the
   * thread while waiting for the child means the child waits for a reply that
   * can never come. The first version of this test deadlocked exactly there.
   */
  const run = (url: string, args: string[], d: string) =>
    new Promise<{ status: number; stdout: string; stderr: string }>((ok) => {
      const c = spawn(process.execPath, [RUNNER, ...args], {
        /*
         * The claims ledger is pointed at this test's own directory.
         *
         * It lives in `docs/runs/claims` for real runs, and a test that used
         * that would write into the ledger of paid keys — after which the next
         * real run would refuse a key no money was ever spent on. The override
         * exists for exactly this, and the runner prints where it is pointing.
         */
        cwd: ROOT, env: { ...process.env, N8N_WEBHOOK_URL: url, HOME: d, AI_SRE_CLAIMS_DIR: join(d, "claims") },
      });
      let stdout = ""; let stderr = "";
      c.stdout.on("data", (b) => { stdout += String(b); });
      c.stderr.on("data", (b) => { stderr += String(b); });
      c.on("close", (status) => ok({ status: status ?? -1, stdout, stderr }));
    });

  it("keeps every answer it paid for, and says so", async () => {
    const s = await serve(() => ({ status: 200, body: JSON.stringify({ state: "concluded", root_cause_code: "CONTAINER_OOM" }) }));
    const d = mkdtempSync(join(tmpdir(), "e2e-"));
    try {
      const answers = join(d, "answers.json");
      const record = join(d, "rec.json");
      const r = await run(s.url, ["container-oom#1", "cpu-throttling#1", "--answers", answers, "--record", record], d);
      expect(s.calls(), "one key is one call").toBe(2);
      expect(r.status, "everything answered and written").toBe(0);
      const got = JSON.parse(readFileSync(answers, "utf8"));
      expect(Object.keys(got).sort()).toEqual(["container-oom#1", "cpu-throttling#1"]);
      const rec = JSON.parse(readFileSync(record, "utf8"));
      expect(rec.outcomes["container-oom#1"]).toBe("answered");
      expect(rec.totals.input_tokens, "the webhook carries no usage and nothing invents it").toBeNull();
      // The alert that was posted is the scenario's own, not something built here.
      expect((s.seen[0] as { id: string }).id).toBe(JSON.parse(
        readFileSync(join(ROOT, "scenarios/container-oom/alert.json"), "utf8")).id);
    } finally { await s.close(); rmSync(d, { recursive: true, force: true }); }
  });

  it("stops after a call that produced no answer, and does not buy the rest", async () => {
    /*
     * The second call answers HTML with a 200 — a workflow that ran, was
     * billed, and said something this script cannot read. The third key must
     * never be called, and the run must not exit 0.
     */
    const s = await serve((n) => n === 2
      ? { status: 200, body: "<html>not json</html>" }
      : { status: 200, body: JSON.stringify({ state: "concluded", root_cause_code: "CONTAINER_OOM" }) });
    const d = mkdtempSync(join(tmpdir(), "e2e-"));
    try {
      const answers = join(d, "answers.json");
      const record = join(d, "rec.json");
      const r = await run(s.url, ["container-oom#1", "cpu-throttling#1", "image-pull-failure#1",
        "--answers", answers, "--record", record], d);
      expect(s.calls(), "the third key was never called").toBe(2);
      expect(r.status, "a run that established less than it was asked to is not a success").toBe(2);
      const rec = JSON.parse(readFileSync(record, "utf8"));
      expect(rec.outcomes["cpu-throttling#1"], "and the unreadable reply may have been charged")
        .toMatch(/may have been charged/);
      expect(rec.outcomes["image-pull-failure#1"], "the key never called says nothing").toBeUndefined();
      const got = JSON.parse(readFileSync(answers, "utf8"));
      expect(Object.keys(got), "the answer that did arrive is kept").toEqual(["container-oom#1"]);
    } finally { await s.close(); rmSync(d, { recursive: true, force: true }); }
  });

  it("refuses to call anything when a key is already answered", async () => {
    const s = await serve(() => ({ status: 200, body: JSON.stringify({ state: "concluded" }) }));
    const d = mkdtempSync(join(tmpdir(), "e2e-"));
    try {
      const answers = join(d, "answers.json");
      writeFileSync(answers, JSON.stringify({ "container-oom#1": { state: "concluded" } }));
      const r = await run(s.url, ["container-oom#1", "--answers", answers, "--record", join(d, "rec.json")], d);
      expect(s.calls(), "nothing is called when the plan is refused").toBe(0);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/already carries an answer/);
    } finally { await s.close(); rmSync(d, { recursive: true, force: true }); }
  });

  it("does not call anything when it cannot write what a call would produce", async () => {
    /*
     * flush returned false and the caller ignored it, so a run that could not
     * record anything went on spending — and then printed "answers written" and
     * exited 0. Codex and Grok both reached it, 2026-09-08. Here the record
     * path IS a directory, so the first write inside the loop fails.
     */
    const s = await serve(() => ({ status: 200, body: JSON.stringify({ state: "concluded" }) }));
    const d = mkdtempSync(join(tmpdir(), "e2e-"));
    try {
      /*
       * The record's directory exists and is read-only. The pre-flight passes —
       * it only mkdirs an existing directory and writes the ANSWERS elsewhere —
       * and the first write inside the loop is the one that fails, which is the
       * exact path the guard is about.
       */
      const box = join(d, "locked");
      mkdirSync(box);
      chmodSync(box, 0o500);
      const r = await run(s.url, ["container-oom#1", "--answers", join(d, "answers.json"),
        "--record", join(box, "rec.json")], d);
      chmodSync(box, 0o700);
      expect(s.calls(), "nothing is called when the evidence cannot be saved").toBe(0);
      expect(r.status, "and it is not a success").toBe(2);
      /*
       * The claim is given back, because nothing was called under it. Keeping
       * it would block a key nobody bought and point the next attempt at a
       * submission that does not exist.
       */
      expect(r.stderr).toMatch(/the claim on container-oom#1 was given back/);
      /*
       * And the record cannot be corrected here, because the record is exactly
       * what could not be written — so the run SAYS so, naming the file.
       *
       * The other branch, where the correction succeeds, is not reachable from
       * a test: the pre-flight proves the answers file is writable before
       * anything is called, so the only write that can fail inside the loop is
       * the record's own.
       */
      expect(r.stderr).toMatch(/may still say container-oom#1 may have been charged\. It was NOT called/);
    } finally { await s.close(); rmSync(d, { recursive: true, force: true }); }
  });

  it("does not count an acknowledgement as an answer it wrote", async () => {
    /*
     * With the webhook answering on receipt, a 200 carries n8n's acceptance
     * and not the chain's report. The counter used to increment for any parsed
     * 200, so the ordinary asynchronous case printed "1 answer(s) written"
     * with nothing written — and the record must say the key may have been
     * charged, because it was.
     *
     * Behaviour, not spelling: this runs the real script against a server that
     * answers the way n8n now does.
     */
    const s = await serve(() => ({ status: 200, body: JSON.stringify({ message: "Workflow was started" }) }));
    const d = mkdtempSync(join(tmpdir(), "e2e-"));
    try {
      const answers = join(d, "answers.json");
      const record = join(d, "rec.json");
      const r = await run(s.url, ["container-oom#1", "cpu-throttling#1", "--answers", answers, "--record", record], d);
      expect(s.calls(), "one submission, then it stops and lets a person look").toBe(1);
      expect(r.stdout).toMatch(/0 answer\(s\) written/);
      expect(r.stdout, "and it says where the answer actually is").toMatch(/collect it with/);
      expect(r.status, "an accepted submission is not a finished measurement").toBe(2);
      const got = JSON.parse(readFileSync(answers, "utf8"));
      expect(got, "an acknowledgement is never saved as a measurement").toEqual({});
      const rec = JSON.parse(readFileSync(record, "utf8"));
      expect(rec.outcomes["container-oom#1"]).toMatch(/^called,/);
      expect(rec.outcomes["container-oom#1"]).toMatch(/awaiting collection/);
      expect(rec.submissions["container-oom#1"].token, "the token is bound, so it can be found")
        .toMatch(/^sub-[0-9a-f]{32}$/);
      expect(rec.outcomes["cpu-throttling#1"], "the second key was never called").toBeUndefined();
    } finally { await s.close(); rmSync(d, { recursive: true, force: true }); }
  });

  it("writes the cautious half first, and which half that is depends on the direction", () => {
    /*
     * Before a call the record must land first: "may have been charged" has to
     * survive a kill. After a successful call the ANSWERS must land first, or a
     * record saying `answered` outlives the answer and the restart check — which
     * ignores `answered` — pays for the key again.
     */
    expect(writeOrderFor({ answersFirst: false }), "before a call, the warning goes down first")
      .toEqual(["record", "answers"]);
    expect(writeOrderFor({ answersFirst: true }), "after an answer, the answer goes down first")
      .toEqual(["answers", "record"]);
  });

  it("refuses a key an earlier run may have paid for, wherever that run's record was written", async () => {
    /*
     * The restart scan read only `docs/runs`, while `--record` accepts any
     * path — so a run recorded elsewhere left its "may have been charged" mark
     * somewhere nothing read, and the same command paid for that key again.
     * Codex, 2026-09-09, by walking the restart rather than the helper: the
     * helper test handed it the right directory, so it could not see the runner
     * looking in the wrong one.
     */
    const s = await serve(() => ({ status: 200, body: JSON.stringify({ state: "concluded" }) }));
    const d = mkdtempSync(join(tmpdir(), "e2e-"));
    try {
      // A record from an earlier run, in a directory of the caller's choosing.
      writeFileSync(join(d, "rec.json"), JSON.stringify({
        when: "2026-09-09",
        outcomes: { "container-oom#1": CHARGED_SENTENCE },
      }));
      const r = await run(s.url, ["container-oom#1", "--answers", join(d, "answers.json"),
        "--record", join(d, "rec.json")], d);
      expect(s.calls(), "a key that may already have been charged is not bought again").toBe(0);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/may already have been charged/);
    } finally { await s.close(); rmSync(d, { recursive: true, force: true }); }
  });

  it("gives each write its own scratch name", () => {
    const a = tempNameFor("/x/a.json", 111);
    const b = tempNameFor("/x/a.json", 111);
    expect(a).not.toBe(b);
    expect(a).toMatch(/\/x\/a\.json\.111\.\d+\.tmp$/);
  });
});

describe("the marker that says a key may have been charged", () => {
  /*
   * The marker was spelled out inside four prose sentences, and the tests
   * carried their own copy — so rewording the sentence left every test green
   * while `inFlightFromRecords` matched nothing, and a key that was CHARGED
   * read as unbought. A subagent found it on 2026-09-09.
   */
  it("is one string that the writers and the readers share", () => {
    expect(CHARGED_SENTENCE.startsWith(CHARGED_PREFIX),
      "the sentence a run writes must begin with the prefix its readers match on").toBe(true);
  });

  it("is found by the reader when the writer's sentence is reworded", () => {
    const runs = new Map([["r.json", JSON.stringify({
      outcomes: { "cpu-throttling#1": `${CHARGED_PREFIX} whatever wording comes later` } })]]);
    const found = inFlightFromRecords("/runs",
      (p: string) => runs.get(String(p).split("/").pop() as string) as string,
      () => [...runs.keys()]);
    expect(found.get("cpu-throttling#1"),
      "the prefix decides, so the prose around it can change").toBe("r.json");
  });
});

describe("the replies that mean the door refused us", () => {
  /*
   * The list of codes was written twice, three lines apart, in opposite senses.
   * Adding one to a single copy makes the two answers disagree, and together
   * they decide whether a key is recorded as possibly billed.
   */
  const codes = [401, 403, 404, 405, 429, 500, 502];
  it("gives exactly opposite answers for every code, from one list", () => {
    for (const c of codes) {
      const r = { state: "unreachable", why: `HTTP ${c}` };
      expect(addressIsWrong(r as any), `HTTP ${c}: the two readers must not disagree`)
        .toBe(!mayHaveBeenCharged(r as any));
    }
  });
});
