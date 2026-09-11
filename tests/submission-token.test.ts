/**
 * The name a submission is given before it is paid for.
 *
 * Two runs on 2026-09-11 were charged and answered while the runner saw HTTP
 * 524. Their answers were recoverable only because a human went and looked. A
 * token bound before the POST is what lets the runner find them by reading —
 * and the tests here are for the ways that binding can be useless: a token that
 * never reaches the request, one that reaches the model's input instead, and a
 * scan that reports "not found" when it merely stopped early.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs, the same file node runs.
import { submissionToken, callOnce, recordShape, classifyReply, claimKey, claimPathFor, releaseClaim, ledgerFrom, liveCallFromTestLedger, liveCallAllowed, hostOf, canonical, isInside, ensureDurableDir, writeClaimFile, writeAtomic, CLAIM_CREATED, LEDGER, TOKEN_HEADER } from "../scripts/run-scenarios.mjs";
// @ts-expect-error — plain .mjs, the same file node runs.
import { tokenOf, matchByToken, scanForToken, tokenInRecord, parseReaderArgv, TOKEN_HEADER as READ_HEADER } from "../scripts/collect-execution.mjs";
import { readFileSync, writeFileSync, mkdtempSync, realpathSync, existsSync, symlinkSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const webhookItem = (headers: unknown) => ({
  status: "success",
  finished: true,
  data: { resultData: { runData: { "Incident Webhook": [{ data: { main: [[{ json: { headers } }]] } }] } } },
});

describe("the submission token", () => {
  it("is written the same way by both sides", () => {
    // The runner sends this header and the reader looks for that one. Two
    // spellings of the same constant is the second-carrier defect, and it
    // fails silently: every scan reports "not found" and every recovery
    // becomes a reason to pay again.
    expect(READ_HEADER).toBe(TOKEN_HEADER);
  });

  it("is opaque and does not repeat", () => {
    const a = submissionToken();
    const b = submissionToken();
    expect(a).toMatch(/^sub-[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("reaches the request as a header and never as part of the alert", async () => {
    let seen: { headers?: Record<string, string>; body?: string } = {};
    await callOnce("https://example/webhook/x", { alert: { kind: "oom" } }, {
      token: "sub-abc",
      fetchImpl: async (_u: string, init: { headers: Record<string, string>; body: string }) => {
        seen = { headers: init.headers, body: init.body };
        return { ok: true, status: 200, text: async () => JSON.stringify({ state: "ok" }) };
      },
    });
    expect(seen.headers?.[TOKEN_HEADER], "the token must travel with the request").toBe("sub-abc");
    // The body is what the chain reasons about. A token in there changes the
    // model's input, and a run with different inputs is not comparable with
    // the runs already scored.
    expect(seen.body).not.toContain("sub-abc");
  });

  it("is absent from the request when no token was given", async () => {
    // The initial value is an empty object, which would satisfy the assertion
    // whether or not fetch ever ran. So it starts as null and the test says it
    // was replaced. Astra, 2026-09-11.
    let headers: Record<string, string> | null = null;
    await callOnce("https://example/webhook/x", {}, {
      fetchImpl: async (_u: string, init: { headers: Record<string, string> }) => {
        headers = init.headers;
        return { ok: true, status: 200, text: async () => "{}" };
      },
    });
    expect(headers, "the request was actually made").not.toBeNull();
    expect(Object.keys(headers ?? {}), "and it carried the ordinary headers").toContain("Content-Type");
    expect(Object.keys(headers ?? {})).not.toContain(TOKEN_HEADER);
  });

  it("is bound in the record, and the record says so even when nothing was sent", () => {
    const bound = recordShape(["a"], { when: "2026-09-11", webhookHost: "h", outcomes: {}, submissions: { a: { token: "sub-1" } } });
    expect(bound.submissions).toEqual({ a: { token: "sub-1" } });
    // An absent field would read as "this runner does not bind tokens", which
    // is a different statement from "this run bound none".
    expect(recordShape(["a"], { when: "2026-09-11", webhookHost: "h", outcomes: {} }).submissions).toEqual({});
  });

  it("is bound before the call, in the source that does the calling", () => {
    /*
     * This asserts an ORDER OF STATEMENTS, which is exactly the property at
     * stake and nothing more. The runner's loop is not exported, so this is
     * what can be checked without refactoring a path that spends money: the
     * binding, then the write, then the call. Move the call above the write
     * and this fails.
     */
    const src: string = readFileSync(resolve(ROOT, "scripts/run-scenarios.mjs"), "utf8");
    const bind = src.indexOf("submissions[key] = { token");
    const write = src.indexOf("if (!flush()) {");
    const call = src.indexOf("await callOnce(url, alert, { token })");
    expect(bind, "the binding must exist to be ordered").toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(bind);
    expect(call).toBeGreaterThan(write);
  });
});

describe("reading a token back out of an execution", () => {
  it("finds it however it was cased", () => {
    expect(tokenOf(webhookItem({ "X-Submission-Token": "sub-9" }))).toEqual({ state: "token", token: "sub-9" });
  });

  it("says none when the header was not sent, and none when it was empty", () => {
    expect(tokenOf(webhookItem({ "user-agent": "node" })).state).toBe("none");
    expect(tokenOf(webhookItem({ [TOKEN_HEADER]: "" })).state).toBe("none");
  });

  it("says unreadable — not none — when it could not look", () => {
    // This is the distinction the whole mechanism rests on. "I could not read
    // this execution" answered as "this execution has no token" turns a
    // retention gap into a confident no-match, and a confident no-match is
    // what authorises paying for the same question a second time.
    expect(tokenOf({ status: "success", finished: true }).state).toBe("unreadable");
    expect(tokenOf(webhookItem(null)).state).toBe("unreadable");
    expect(tokenOf(null).state).toBe("unreadable");
    expect(tokenOf([]).state).toBe("unreadable");
  });
});

describe("matching a token against what was scanned", () => {
  const t = (id: number, token: string) => ({ id, result: { state: "token", token } });

  it("answers with the one execution that carried it", () => {
    expect(matchByToken([t(1, "a"), t(2, "b")], "b")).toMatchObject({ state: "one", id: 2 });
  });

  it("refuses rather than picking when two carried it", () => {
    const m = matchByToken([t(1, "a"), t(2, "a")], "a");
    expect(m.state).toBe("many");
    expect(m.ids).toEqual([1, 2]);
  });

  it("separates a clean miss from a miss it could not verify", () => {
    expect(matchByToken([t(1, "a")], "z").state).toBe("none");
    const u = matchByToken([t(1, "a"), { id: 7, result: { state: "unreadable", why: "gone" } }], "z");
    expect(u.state, "zero matches with something unread is not zero matches").toBe("uncertain");
    expect(u.unreadable).toEqual([7]);
  });

  it("treats a missing token as uncertain, never as a match", () => {
    expect(matchByToken([t(1, "a")], "").state).toBe("uncertain");
    expect(matchByToken([t(1, "a")], undefined as unknown as string).state).toBe("uncertain");
  });
});

describe("scanning for a token", () => {
  const page = (rows: number[], cursor?: string) => async () => ({ rows: rows.map((id) => ({ id })), cursor });

  it("walks past the first page rather than answering from it", async () => {
    const pages = [page([1], "c2"), page([2, 3])];
    let i = 0;
    const r = await scanForToken("w", "sub-3", {
      page: async () => pages[i++]!(),
      one: async (id: number) => webhookItem({ [TOKEN_HEADER]: `sub-${id}` }),
    });
    expect(r).toMatchObject({ state: "one", id: 3 });
    expect(r.pagesWalked).toBe(2);
  });

  it("keeps looking after a hit, so a duplicate is seen as a duplicate", async () => {
    const r = await scanForToken("w", "sub-x", {
      page: page([1, 2]),
      one: async () => webhookItem({ [TOKEN_HEADER]: "sub-x" }),
    });
    expect(r.state, "stopping at the first match is what makes a duplicate look unique").toBe("many");
  });

  it("says the window was short when a page could not be listed", async () => {
    const r = await scanForToken("w", "sub-x", {
      page: async () => { throw new Error("HTTP 500"); },
      one: async () => webhookItem({}),
    });
    // A listing failure that reported a plain "none" would be a short window
    // read as a complete one, and the answer to a short window is not "pay
    // again".
    expect(r.state).toBe("uncertain");
    expect(r.listingStopped).toBe("HTTP 500");
  });

  it("counts an execution it could not fetch as unread, not as absent", async () => {
    const r = await scanForToken("w", "sub-x", {
      page: page([1]),
      one: async () => { throw new Error("HTTP 404"); },
    });
    expect(r.state).toBe("uncertain");
    expect(r.unreadable).toEqual([1]);
  });

  it("stops at the page bound and reports how far it got", async () => {
    const r = await scanForToken("w", "sub-x", {
      pages: 2,
      page: page([1], "always-more"),
      one: async () => webhookItem({ [TOKEN_HEADER]: "sub-other" }),
    });
    expect(r.pagesWalked).toBe(2);
    expect(r.state).toBe("none");
  });
});

describe("recovering a key that may have been charged", () => {
  const rec = (submissions: unknown) => ({ keys: ["a"], outcomes: {}, submissions });

  it("finds the token a key was submitted under", () => {
    expect(tokenInRecord(rec({ "a#2": { token: "sub-7" } }), "a#2")).toEqual({ state: "token", token: "sub-7" });
  });

  it("separates a record that cannot be reconciled from a key that was not submitted", () => {
    // An older run record has no submissions field at all. Answering that as
    // "this key was never submitted" would say the money was never spent,
    // which is the opposite of what such a record means.
    expect(tokenInRecord({ keys: ["a"] }, "a").state).toBe("unreconcilable");
    expect(tokenInRecord(rec(null), "a").state).toBe("unreconcilable");
    expect(tokenInRecord(rec([]), "a").state).toBe("unreconcilable");
    expect(tokenInRecord(rec({}), "a").state).toBe("unbound");
    expect(tokenInRecord(rec({ a: { token: "" } }), "a").state).toBe("unbound");
    expect(tokenInRecord(rec({ a: "sub-7" }), "a").state, "a bare string is not a binding").toBe("unbound");
  });

  it("reads each mode's arguments into the right slots", () => {
    /*
     * The shifting is the risk. Read the token where the answers path belongs
     * and the script writes a file called `sub-...` and reports success — a
     * paid answer saved somewhere nobody will look.
     */
    expect(parseReaderArgv(["node", "s", "313", "out/a.json", "k"]))
      .toEqual({ mode: "id", id: "313", answersPath: "out/a.json", key: "k" });
    expect(parseReaderArgv(["node", "s", "--token", "sub-1", "out/a.json", "k"]))
      .toEqual({ mode: "token", token: "sub-1", answersPath: "out/a.json", key: "k" });
    expect(parseReaderArgv(["node", "s", "--record", "docs/runs/r.json", "k", "out/a.json"]))
      .toEqual({ mode: "record", recordPath: "docs/runs/r.json", key: "k", answersPath: "out/a.json" });
  });

  it("leaves the answers path undefined when it was not given, rather than borrowing a flag", () => {
    // The usage line must print instead of the script treating `--token` as an
    // execution id and fetching `/executions/--token`.
    expect(parseReaderArgv(["node", "s", "--token", "sub-1"]).answersPath).toBeUndefined();
    expect(parseReaderArgv(["node", "s"]).id).toBeUndefined();
  });
});

describe("a 200 that is not an answer", () => {
  it("recognises the chain's report by what it carries", () => {
    expect(classifyReply({ state: "resolved", root_cause_code: "oom", confidence: 0.8 }).state).toBe("report");
    expect(classifyReply({ state: "refused", raw_answers: {} }).state).toBe("report");
  });

  it("calls n8n's acceptance an acknowledgement, and does not match on its wording", () => {
    /*
     * Matching the text would break the day n8n rewords it — and it would
     * break in the direction that saves the acknowledgement as a measurement.
     * So a report is recognised by its fields, and everything else is an ack.
     */
    expect(classifyReply({ message: "Workflow was started" }).state).toBe("acknowledged");
    expect(classifyReply({ message: "accepted for processing" }).state).toBe("acknowledged");
    expect(classifyReply({}).state).toBe("acknowledged");
    // A half-report is not a report. `state` with no findings anywhere is what
    // an error envelope looks like, and grading it would grade nothing.
    expect(classifyReply({ state: "resolved" }).state).toBe("acknowledged");
  });

  it("does not mistake a non-object for either", () => {
    expect(classifyReply(null).state).toBe("unrecognised");
    expect(classifyReply([{ state: "x", root_cause_code: "y" }]).state).toBe("unrecognised");
    expect(classifyReply("started").state).toBe("unrecognised");
  });

  it("is the mode the generated workflow actually runs in", () => {
    /*
     * The two halves have to agree. A workflow still on `lastNode` with a
     * runner expecting an acknowledgement would hit the gateway deadline that
     * this whole shape exists to remove — and the runner would record the
     * timeout as "may have been charged", which is where today started.
     */
    const w = JSON.parse(readFileSync(resolve(ROOT, "workflows/incident.json"), "utf8"));
    const hook = w.nodes.find((n: { type: string }) => n.type.includes("webhook"));
    expect(hook.parameters.responseMode).toBe("onReceived");
  });
});

describe("the four defects Astra found in this diff", () => {
  const t = (id: number, token: string) => ({ id, result: { state: "token", token } });
  const unread = (id: number) => ({ id, result: { state: "unreadable", why: "gone" } });
  const page = (rows: number[], cursor?: string) => async () => ({ rows: rows.map((id) => ({ id })), cursor });

  it("does not call one hit unique while part of the window is unread", () => {
    /*
     * The duplicate this scan promises to refuse could be sitting in the
     * execution that could not be read. Answering `one` there hands back an
     * answer that may belong to another attempt, scored as this one's.
     */
    const m = matchByToken([t(1, "a"), unread(7)], "a");
    expect(m.state).toBe("one-unverified");
    expect(m.id, "the id is still reported, because it is real").toBe(1);
    expect(m.unreadable).toEqual([7]);
    // With nothing unread, it is uniqueness and says so.
    expect(matchByToken([t(1, "a")], "a").state).toBe("one");
  });

  it("does not keep a hit as unique when the listing stopped", async () => {
    const r = await scanForToken("w", "sub-1", {
      page: async (_w: string, _l: number, cursor?: string) => {
        if (cursor === undefined) return { rows: [{ id: 1 }], cursor: "c2" };
        throw new Error("HTTP 500");
      },
      one: async () => webhookItem({ [TOKEN_HEADER]: "sub-1" }),
    });
    expect(r.state).toBe("one-unverified");
    expect(r.id).toBe(1);
    expect(r.listingStopped).toBe("HTTP 500");
  });

  it("does not keep a hit as unique when the page bound cut the walk short", async () => {
    // Running out of pages is not running out of executions, and the cursor
    // still holding a value is n8n saying there were more rows to read.
    const r = await scanForToken("w", "sub-1", {
      pages: 1,
      page: page([1], "there-is-more"),
      one: async () => webhookItem({ [TOKEN_HEADER]: "sub-1" }),
    });
    expect(r.state).toBe("one-unverified");
    expect(r.windowExhausted).toBe(true);
  });

  it("still reports a duplicate as a duplicate when coverage is short", async () => {
    // `many` must survive the same conditions: an ambiguous answer is worse
    // than an unverified one, and it must not be softened into it.
    const r = await scanForToken("w", "sub-1", {
      pages: 1,
      page: page([1, 2], "there-is-more"),
      one: async () => webhookItem({ [TOKEN_HEADER]: "sub-1" }),
    });
    expect(r.state).toBe("many");
  });

  it("confirms the directory entry, and reports the write either way", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const at = join(dir, "x.json");
    expect(writeAtomic(at, "{}\n")).toEqual({ durable: true });
    expect(readFileSync(at, "utf8")).toBe("{}\n");
    /*
     * What this can and cannot prove, said rather than implied.
     *
     * Whether the directory entry survives a HOST crash is not observable from
     * here — no test in this suite can pull the power. So the behaviour is
     * asserted at the source: the fsync is on the DIRECTORY of the path, not on
     * the file a second time. Delete that line and this fails; it still does
     * not prove durability, and it is not written as if it did.
     */
    const src: string = readFileSync(resolve(ROOT, "scripts/run-scenarios.mjs"), "utf8");
    expect(src).toContain('const dir = openSync(dirname(path), "r");');
  });

  it("claims a key exclusively, and the second claim is refused rather than allowed", () => {
    const runs = mkdtempSync(join(tmpdir(), "claims-"));
    const first = claimKey("image-pull-failure#2", "sub-1", { dir: runs });
    expect(first.state).toBe("claimed");
    // Reading a state is not holding it. The second runner must be told, not
    // waved through: being waved through is two charges for one question.
    const second = claimKey("image-pull-failure#2", "sub-2", { dir: runs });
    expect(second.state).toBe("held");
    expect(second.token, "the held claim names the token that can be collected").toBe("sub-1");
  });

  it("detects two keys that flatten to one claim filename", () => {
    const runs = mkdtempSync(join(tmpdir(), "claims-"));
    claimKey("a#1", "sub-1", { dir: runs });
    // `a#1` and `a?1` both flatten to `a_1.json`. Sharing a claim would let
    // one key's payment look like the other's.
    expect(claimPathFor("a#1", runs)).toBe(claimPathFor("a?1", runs));
    expect(claimKey("a?1", "sub-2", { dir: runs }).state).toBe("collision");
  });

  it("treats an unreadable claim as a claim", () => {
    const runs = mkdtempSync(join(tmpdir(), "claims-"));
    const held = claimKey("a", "sub-1", {
      dir: runs,
      write: () => { const e: NodeJS.ErrnoException = new Error("exists"); e.code = "EEXIST"; throw e; },
      read: () => "not json",
      ensure: () => {},
    });
    expect(held.state, "an unreadable claim read as absent is how exclusivity becomes advisory").toBe("held");
  });

  it("separates a claim that exists from a claim it could not make", () => {
    const runs = mkdtempSync(join(tmpdir(), "claims-"));
    const no = claimKey("a", "sub-1", {
      dir: runs,
      write: () => { throw new Error("read-only filesystem"); },
      ensure: () => {},
    });
    expect(no.state, "cannot claim is not already claimed — only one of them means somebody paid").toBe("unclaimable");
  });

  it("counts measurements, not acknowledged calls, in the source that counts them", () => {
    /*
     * The runner's loop is not exported, so this checks the condition the
     * counter is guarded by. Without `kind.state === "report"` the ordinary
     * asynchronous acknowledgement printed "1 answer(s) written" with nothing
     * written — a false sentence, which is the part a person reads.
     */
    const src: string = readFileSync(resolve(ROOT, "scripts/run-scenarios.mjs"), "utf8");
    expect(src).toContain('if (r.state === "answered" && kind.state === "report" && saved) written += 1;');
  });

  it("claims before it writes and writes before it calls", () => {
    const src: string = readFileSync(resolve(ROOT, "scripts/run-scenarios.mjs"), "utf8");
    const claim = src.indexOf("const claim = claimKey(key, token);");
    const bind = src.indexOf("submissions[key] = { token");
    const write = src.indexOf("if (!flush()) {");
    const call = src.indexOf("await callOnce(url, alert, { token })");
    expect(claim).toBeGreaterThan(-1);
    expect(bind).toBeGreaterThan(claim);
    expect(write).toBeGreaterThan(bind);
    expect(call).toBeGreaterThan(write);
  });
});

describe("the hole in the first version of the claim", () => {
  it("does not let the ledger move with --record", () => {
    /*
     * Found while the gate was running, in the fix written an hour earlier.
     * The claims directory was `dirname(recordAt)`, and `--record` accepts any
     * path — so two runners with different record paths claimed in different
     * directories, both succeeded, and both paid. `wx` is exclusive per PATH,
     * and the path had been made variable.
     *
     * The signature is the fix: there is no argument for the caller to vary.
     */
    const src: string = readFileSync(resolve(ROOT, "scripts/run-scenarios.mjs"), "utf8");
    expect(src).toContain("const claim = claimKey(key, token);");
    expect(src, "the ledger is one fixed place, not a per-run one")
      .toContain('join(ROOT, "docs", "claims")');
    /*
     * And NOT inside docs/runs, which the spend counter walks — a claim there
     * was read as an unpriced RUN, quietly adding to a total that is already a
     * floor.
     */
    expect(src).not.toContain('join(ROOT, "docs", "runs", "claims")');
    // And it is printed, because an override nobody can see is the same hole
    // wearing a different name.
    expect(src).toContain("claims  → ${CLAIMS_DIR}");
  });

  it("puts a claim where the ledger is, whatever the key looks like", () => {
    expect(claimPathFor("container-oom#3", "/led")).toBe("/led/container-oom_3.json");
  });
});

describe("the five Astra found in the fixes", () => {
  const web = (h: unknown) => ({
    status: "success", finished: true,
    data: { resultData: { runData: { "Incident Webhook": [{ data: { main: [[{ json: { headers: h } }]] } }] } } },
  });

  it("counts a listing row with no id as unread, not as nothing", async () => {
    // Skipping it silently made the scan report uniqueness over a window it
    // had not read. Found by running the code, not by reading it.
    const r = await scanForToken("w", "sub-1", {
      page: async () => ({ rows: [{ id: 1 }, {}], cursor: undefined }),
      one: async () => web({ [TOKEN_HEADER]: "sub-1" }),
    });
    expect(r.state).toBe("one-unverified");
    expect(r.unreadable).toEqual([null]);
  });

  it("counts one execution once, however many pages it appears on", async () => {
    /*
     * n8n pages by cursor over a list that is still growing, so an overlap is
     * ordinary. Counting the same execution twice reported a duplicate token
     * where there was none — refusing a collection that should have succeeded.
     */
    const r = await scanForToken("w", "sub-1", {
      page: async (_w: string, _l: number, c?: string) => (c === undefined
        ? { rows: [{ id: 1 }], cursor: "c2" } : { rows: [{ id: 1 }], cursor: undefined }),
      one: async () => web({ [TOKEN_HEADER]: "sub-1" }),
    });
    expect(r.state, "the same execution on two pages is one execution").toBe("one");
    expect(r.id).toBe(1);
  });

  it("gives a claim back when nothing was called under it", () => {
    /*
     * The claim was taken, the intent write failed, no POST happened — and the
     * claim stayed forever. The next attempt was told to collect a submission
     * that does not exist, for a key nobody had bought. A guard against paying
     * twice had become a guard against paying once.
     */
    const dir = mkdtempSync(join(tmpdir(), "led-"));
    expect(claimKey("a", "sub-1", { dir }).state).toBe("claimed");
    expect(releaseClaim("a", { dir }).state).toBe("released");
    expect(claimKey("a", "sub-2", { dir }).state, "and then the key can be bought").toBe("claimed");
  });

  it("says a claim it could not give back is still held", () => {
    const dir = mkdtempSync(join(tmpdir(), "led-"));
    const stuck = releaseClaim("never-claimed", { dir });
    expect(stuck.state, "a removal that failed is not a removal").toBe("still-held");
    expect(stuck.why).toContain("will be refused until it is");
  });

  it("writes the claim durably, not just visibly", () => {
    /*
     * The claim guards against the crash, so it has to survive the crash. It
     * was written with a plain write and no fsync at all.
     *
     * Checked by BEHAVIOUR rather than by reading the source: the file's own
     * descriptor is synced, and so is the directory that names it. Bytes that
     * outlive their name are not durable.
     */
    const dir = mkdtempSync(join(tmpdir(), "dur-"));
    const at = join(dir, "c.json");
    const opened = new Map<number, string>();
    const synced: string[] = [];
    const closed: string[] = [];
    writeClaimFile(at, "{}", {
      open: (p: string, flag: string) => {
        const fd = openSync(p, flag as "r");
        opened.set(fd, `${p}|${flag}`);
        return fd;
      },
      /*
       * The ARGUMENT is recorded, not the count. Astra, 2026-09-11: counting
       * calls let `sync(fd)` stand in for `sync(d)` — two syncs happened and
       * the directory was never one of them, which is precisely the defect the
       * test is named after.
       */
      sync: (fd: number) => { synced.push(opened.get(fd) ?? `unknown ${fd}`); },
      close: (fd: number) => { closed.push(opened.get(fd) ?? `unknown ${fd}`); closeSync(fd); },
    });
    expect(synced, "the file's own descriptor, then the directory that names it")
      .toEqual([`${at}|wx`, `${dir}|r`]);
    expect(closed, "and both are closed, in the same order").toEqual([`${at}|wx`, `${dir}|r`]);
  });

  it("never removes a claim it cannot establish it created", () => {
    /*
     * The worst thing found in this work. `openSync` with `wx` can fail for
     * reasons that say nothing about the path — out of descriptors — and the
     * cleanup ran anyway, unlinking another runner's PAID claim and its
     * recovery token with it. A guard against paying twice that could delete
     * the evidence of having paid once.
     *
     * Unknown falls to not cleaning up: a stranded half-claim is a key refused
     * until a person looks, and a deleted claim is a second charge nobody can
     * see.
     */
    const dir = mkdtempSync(join(tmpdir(), "own-"));
    expect(claimKey("k", "sub-theirs", { dir }).state).toBe("claimed");
    const theirs = readFileSync(claimPathFor("k", dir), "utf8");
    const ours = claimKey("k", "sub-ours", {
      dir,
      write: () => { const e: Error & { code?: string } = new Error("EMFILE"); e.code = "EMFILE"; throw e; },
    });
    expect(ours.state).toBe("unclaimable");
    expect(ours.why).toContain("nothing was removed");
    expect(readFileSync(claimPathFor("k", dir), "utf8"), "their claim is untouched").toBe(theirs);
  });

  it("confirms every directory it created, and the entry that links them in", () => {
    /*
     * `mkdirSync` creates a chain and only the leaf was fsynced, so a host
     * crash could lose the directory holding the claim while the claim's own
     * bytes were safe. A name nobody can reach is the same as no name.
     */
    const root = mkdtempSync(join(tmpdir(), "dur-"));
    const deep = join(root, "a", "b", "c");
    const made = ensureDurableDir(deep);
    expect(made.created).toBe(true);
    expect(made.synced.slice(0, 4), "the leaf and every directory above it").toEqual(
      [deep, join(root, "a", "b"), join(root, "a"), root]);
    expect(made.synced[made.synced.length - 1], "all the way to the root").toBe(sep);
    /*
     * And AGAIN on a directory that already exists. Returning early there
     * equated "it already existed" with "durably linked": a previous run whose
     * fsync failed left the directories in place, and every run after it took
     * the shortcut — so a host crash could lose the ledger subtree forever
     * after, while each claim's own fsync succeeded.
     */
    const retry = ensureDurableDir(deep);
    expect(retry.created).toBe(false);
    expect(retry.synced, "confirmed again, not skipped").toEqual(made.synced);
  });

  it("says which directories it could not confirm, instead of implying all of them", () => {
    const root = mkdtempSync(join(tmpdir(), "dur-"));
    const r = ensureDurableDir(join(root, "x"), {
      open: (at: string) => { if (at === sep) throw new Error("not permitted"); return openSync(at, "r"); },
    });
    expect(r.skipped?.map((x: { at: string }) => x.at), "one unopenable directory is named").toEqual([sep]);
  });

  it("refuses a ledger pointed anywhere a real run could point it", () => {
    /*
     * An override is an override: two runners with different values both claim
     * and both pay, and printing the value does not stop that. So it is
     * accepted only inside the temporary directory, which tests use and a real
     * run never does.
     */
    expect(ledgerFrom({}).dir).toBe(LEDGER);
    expect(ledgerFrom({ AI_SRE_CLAIMS_DIR: "" }).dir).toBe(LEDGER);
    expect(ledgerFrom({ AI_SRE_CLAIMS_DIR: join(tmpdir(), "t") }).overridden).toBe(true);
    const no = ledgerFrom({ AI_SRE_CLAIMS_DIR: "/etc/somewhere" });
    expect(no.dir, "a ledger outside the temp directory is refused, not accepted quietly").toBe(null);
    expect(no.why).toContain("two runners can both pay");
    // A path that merely starts with the same characters is not inside it.
    expect(ledgerFrom({ AI_SRE_CLAIMS_DIR: `${tmpdir()}-elsewhere` }).dir).toBe(null);
  });

  it("judges containment by components, on whatever platform it runs", () => {
    // `C:\Temp\claims` inside `C:\Temp` is the Windows half of this and is
    // NOT exercised here: `sep` is "/" on this machine, so the split cannot
    // see backslashes. What is checked is that the comparison is by components
    // rather than by text, which is what makes the Windows case work at all.
    expect(isInside(join("/a", "b", "c"), join("/a", "b"))).toBe(true);
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/bb", "/a/b"), "a longer name is not a child").toBe(false);
    expect(isInside("/a", "/a/b"), "a parent is not inside its child").toBe(false);
  });

  it("resolves a path that does not exist yet through the part that does", () => {
    const root = mkdtempSync(join(tmpdir(), "can-"));
    expect(canonical(join(root, "not", "yet")))
      .toBe(join(realpathSync(root), "not", "yet"));
  });

  it("does not let a symlink out of the temp directory pass as inside it", () => {
    /*
     * `resolve` normalises text and follows nothing, so `/tmp/alias` pointing
     * at somewhere else passed a containment test against `/tmp` — no race and
     * no retargeting needed, just a link somebody made.
     */
    const tmp = mkdtempSync(join(tmpdir(), "tmp-"));
    const outside = mkdtempSync(join(tmpdir(), "out-"));
    const alias = join(tmp, "alias");
    symlinkSync(outside, alias);
    expect(isInside(join(alias, "claims"), tmp),
      "a link that leaves the directory is not inside the directory").toBe(false);
    expect(ledgerFrom({ AI_SRE_CLAIMS_DIR: join(alias, "claims") }, tmp).dir).toBe(null);
  });

  it("accepts both spellings of the temp directory, because macOS has two", () => {
    /*
     * `os.tmpdir()` answers `/var/folders/...`, which is a symlink to
     * `/private/var/folders/...`. Comparing text alone refused a caller that
     * had resolved its own path — for pointing at the very directory the rule
     * allows. The rule must not depend on which spelling someone happens to
     * have.
     */
    const t = mkdtempSync(join(tmpdir(), "led-"));
    expect(ledgerFrom({ AI_SRE_CLAIMS_DIR: t }).overridden).toBe(true);
    expect(ledgerFrom({ AI_SRE_CLAIMS_DIR: realpathSync(t) }).overridden).toBe(true);
    // And a directory that does not exist yet is still judged by where it is.
    expect(ledgerFrom({ AI_SRE_CLAIMS_DIR: join(t, "deep", "er") }).overridden).toBe(true);
    // The real case Astra reproduced: /tmp and /private/tmp are one directory
    // on macOS, and a run pointed at either must be judged the same way.
    expect(ledgerFrom({ AI_SRE_CLAIMS_DIR: "/private/tmp/claims" }, "/tmp").overridden).toBe(true);
    expect(ledgerFrom({ AI_SRE_CLAIMS_DIR: "/tmp/claims" }, "/private/tmp").overridden).toBe(true);
  });
});

describe("the writer that actually runs in production", () => {
  it("marks a failure that happened after it created the file", () => {
    /*
     * The mark used to be on the RETURN value only, and a real `writeFileSync`
     * failure raises an ordinary filesystem error with no mark on it — so the
     * one case the cleanup exists for could not be cleaned up. It worked in the
     * test, where the error was hand-made, and not in life.
     *
     * This is the production writer, not a stand-in: it is exported precisely
     * so the path that runs can be the path that is checked.
     */
    const dir = mkdtempSync(join(tmpdir(), "own-"));
    const at = join(dir, "c.json");
    let raised: unknown = null;
    try {
      writeClaimFile(at, "{}", { write: () => { throw new Error("EIO"); } });
    } catch (e) { raised = e; }
    expect((raised as Record<symbol, unknown>)[CLAIM_CREATED],
      "the file exists, so this run owns it").toBe(true);
    expect(existsSync(at), "and it really did create it").toBe(true);
  });

  it("is the writer claimKey uses, and its owner cleans up after it", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-"));
    const r = claimKey("k", "sub-1", {
      dir,
      write: (p: string, t: string) => writeClaimFile(p, t, { write: () => { throw new Error("EIO"); } }),
    });
    expect(r.state).toBe("unclaimable");
    expect(existsSync(claimPathFor("k", dir)), "no key is left claimed by a call nobody made").toBe(false);
  });

  it("cannot be fooled by a foreign error that happens to carry a field", () => {
    /*
     * A plain `created` property would be trusted from any error carrying it.
     * A symbol cannot be set by accident, and that is cheaper than an argument
     * about how likely an accident is.
     */
    const dir = mkdtempSync(join(tmpdir(), "own-"));
    expect(claimKey("k", "sub-theirs", { dir }).state).toBe("claimed");
    const ours = claimKey("k", "sub-ours", {
      dir,
      write: () => {
        const e: Error & { created?: boolean; code?: string } = new Error("EMFILE");
        e.created = true;                       // the plain field, deliberately
        e.code = "EMFILE";
        throw e;
      },
    });
    expect(ours.state).toBe("unclaimable");
    expect(existsSync(claimPathFor("k", dir)), "their claim survives a lookalike").toBe(true);
  });

  it("carries the directories it could not confirm, instead of dropping them", () => {
    /*
     * `ensureDurableDir` reported them and `claimKey` threw the report away, so
     * a failed ancestor sync was accepted in silence — which is claiming
     * durability that was never established.
     */
    const dir = mkdtempSync(join(tmpdir(), "own-"));
    const claimed = claimKey("k", "sub-1", {
      dir,
      ensure: () => ({ created: false, synced: [], skipped: [{ at: "/", why: "not permitted" }] }),
    });
    expect(claimed.state).toBe("claimed");
    expect(claimed.unconfirmed).toEqual([{ at: "/", why: "not permitted" }]);
    /*
     * And nothing is invented when everything was confirmed — but `undefined`
     * is also what an `unclaimable` or `held` result carries, so the state is
     * asserted first. Otherwise this passes when the claim failed outright.
     */
    const clean = claimKey("j", "sub-2", { dir });
    expect(clean.state).toBe("claimed");
    expect(clean.unconfirmed).toBeUndefined();
  });
});

describe("what the runner does with a durability it could not confirm", () => {
  it("says out loud when the claim's durability could not be confirmed", () => {
    /*
     * `claimKey` reported the directories it could not sync and nothing read
     * the report, so a failed ancestor sync still allowed the POST in silence.
     * Returning the information had moved the defect one level outward.
     *
     * The source is asserted because the loop that spends money is not
     * exported; what it asserts is that the reported field is READ, which is
     * the whole property. It does not stop the run: the claim is on disk and
     * exclusive, and what is unestablished is only whether a host crash could
     * lose the directory naming it.
     */
    const src: string = readFileSync(resolve(ROOT, "scripts/run-scenarios.mjs"), "utf8");
    expect(src).toContain("if (Array.isArray(claim.unconfirmed) && claim.unconfirmed.length > 0) {");
    expect(src, "and it names them").toContain("NOT CONFIRMED DURABLE: the claim on ${key} is written");
  });
});

describe("a test ledger pointed at a paid instance", () => {
  /*
   * Measured on 2026-09-11: twelve container-oom executions reached the live
   * instance carrying this runner's submission-token header, with only ONE
   * claim in docs/runs/claims — and a real run always leaves a claim per key
   * and refuses the second submission of the same key. A temporary ledger is
   * the only thing that explains both.
   *
   * What produced them was not established. This interlock is what makes the
   * next occurrence free: it refuses before the POST rather than after the
   * bill.
   */
  it("refuses a paid address when the ledger is a temporary one", () => {
    const no = liveCallFromTestLedger("https://x.app.n8n.cloud/webhook/y", true);
    expect(no).not.toBeNull();
    expect(no).toContain("refusing to call x.app.n8n.cloud");
    expect(no, "and it says what to do instead").toContain("unset AI_SRE_CLAIMS_DIR");
  });

  it("allows the loopback address every test uses, port and all", () => {
    /*
     * `hostOf` answers with the port attached, because that is what a run
     * record wants. The first version of this interlock compared the whole
     * string and so refused `127.0.0.1:5000` — which would have turned a guard
     * against spending into a suite that cannot run. Caught by running it.
     */
    expect(hostOf("http://127.0.0.1:5000/webhook/x"), "the port really is in there").toBe("127.0.0.1:5000");
    expect(liveCallFromTestLedger("http://127.0.0.1:5000/webhook/x", true)).toBeNull();
    expect(liveCallFromTestLedger("http://localhost:8080/x", true)).toBeNull();
    expect(liveCallFromTestLedger("http://[::1]:9/x", true)).toBeNull();
  });

  it("is not fooled by a host that merely begins with a loopback address", () => {
    expect(liveCallFromTestLedger("http://127.0.0.1.evil.com/x", true)).not.toBeNull();
    expect(liveCallFromTestLedger("http://localhost.evil.com/x", true)).not.toBeNull();
  });

  it("says nothing at all when the ledger is the real one", () => {
    // A real run against a paid instance is the whole point of the script.
    expect(liveCallFromTestLedger("https://x.app.n8n.cloud/webhook/y", false)).toBeNull();
    expect(liveCallFromTestLedger("", false)).toBeNull();
  });

  it("refuses an address it could not read, rather than allowing it", () => {
    // Unknown falls to stopping: an unreadable address under a test ledger is
    // exactly the state where nobody can say where the POST would land.
    expect(liveCallFromTestLedger("not a url", true)).not.toBeNull();
    expect(liveCallFromTestLedger("", true)).not.toBeNull();
  });

  it("is wired in before anything is read, let alone POSTed", () => {
    const src: string = readFileSync(resolve(ROOT, "scripts/run-scenarios.mjs"), "utf8");
    const guard = src.indexOf("const contradiction = liveCallFromTestLedger(url ?? \"\", LEDGER_ASKED.overridden);");
    const plan = src.indexOf("plan = planFor(keys);");
    const call = src.indexOf("await callOnce(url, alert, { token })");
    expect(guard).toBeGreaterThan(-1);
    expect(plan, "the guard comes before the plan is even built").toBeGreaterThan(guard);
    expect(call).toBeGreaterThan(guard);
  });
});

describe("the gate was paying for its own mutation, and how that is floored", () => {
  it("arms the interlock on every test that spawns the runner", () => {
    /*
     * Established on 2026-09-11, after twenty-one paid executions.
     *
     * The gate applies `the-env-file-overriding-a-chosen-value`, which deletes
     * the line making the environment beat the `.env` file. It then runs the
     * file declaring that mutation's named test — the same file whose tests
     * spawn this script as a real child. With the guard gone, `.env`
     * overwrote the test's 127.0.0.1 address with the paid instance, and three
     * tests POSTed to it. Three executions per gate run, every gate run.
     *
     * The interlock only fires when a temporary ledger is in use, so every
     * spawn has to set one. A spawn without it is a spawn the floor does not
     * reach — which is this defect with a new door.
     */
    const src: string = readFileSync(resolve(ROOT, "tests/run-scenarios.test.ts"), "utf8");
    const spawns = src.split("spawn(process.execPath").length - 1;
    expect(spawns, "this test is vacuous if nothing spawns the runner").toBeGreaterThan(0);
    const armed = src.split("AI_SRE_CLAIMS_DIR").length - 1;
    expect(armed, "every spawn of the runner sets a temporary ledger").toBeGreaterThanOrEqual(spawns);
  });

  it("keeps the mutation that caused it, because the property is real", () => {
    /*
     * The answer is not to delete the mutation. `.env` beating a chosen
     * environment value is a genuine defect — it once sent a run to whatever
     * instance the file still named. The mutation stays and the floor goes
     * under it.
     */
    const muts: string = readFileSync(resolve(ROOT, "scripts/mutations.mjs"), "utf8");
    expect(muts).toContain("the-env-file-overriding-a-chosen-value");
  });
});

describe("the floor that does not depend on what a test happens to set", () => {
  /*
   * The ledger floor guards the SHAPE the test helper uses, not "a test": a
   * spawn that omitted AI_SRE_CLAIMS_DIR went straight through it. And the
   * `.env` file was read at IMPORT, so every vitest worker that imported the
   * runner carried the paid address in its own environment, and any child it
   * spawned with `{ ...process.env }` inherited it — no mutation needed.
   *
   * Both were found on 2026-09-11 by subagents reading for one class of defect
   * each, after the gate had already been paying for its mutation runs.
   */
  it("requires the live flag before any address off this machine", () => {
    expect(liveCallAllowed({}).allowed).toBe(false);
    expect(liveCallAllowed({ AI_SRE_LIVE: "0" }).allowed).toBe(false);
    expect(liveCallAllowed({ AI_SRE_LIVE: "true" }, []).allowed, "only the exact value counts").toBe(false);
    expect(liveCallAllowed({ AI_SRE_LIVE: "1" }, []).allowed).toBe(true);
  });

  it("refuses the flag when it came from the file every invocation reads", () => {
    /*
     * `.env` is read by every invocation, including the ones under test. A
     * live flag from there would re-arm exactly the runs this floor exists to
     * stop, while looking like an operator's decision.
     */
    const fromFile = liveCallAllowed({ AI_SRE_LIVE: "1" }, ["N8N_WEBHOOK_URL", "AI_SRE_LIVE"]);
    expect(fromFile.allowed).toBe(false);
    expect(fromFile.why).toContain("Give it on the command line instead");
    // A file that set only the address does not disarm it.
    expect(liveCallAllowed({ AI_SRE_LIVE: "1" }, ["N8N_WEBHOOK_URL"]).allowed).toBe(true);
  });

  it("says what to do instead, so the refusal is not a dead end", () => {
    expect(liveCallAllowed({}).why).toContain("put AI_SRE_LIVE=1 in front of the command");
  });

  it("does not read the .env file merely because it was imported", () => {
    /*
     * Importing a module must not change the environment of the process that
     * imported it. Asserted at the source because the import has already
     * happened by the time this test runs: the load lives in a function the
     * runner calls, not at module level.
     */
    const src: string = readFileSync(resolve(ROOT, "scripts/run-scenarios.mjs"), "utf8");
    expect(src).toContain("function loadDotEnvOnce(");
    expect(src).toContain("const setByFile = loadDotEnvOnce();");
    const top = src.slice(0, src.indexOf("function loadDotEnvOnce("));
    expect(top, "nothing reads .env before that function is even defined").not.toContain('join(ROOT, ".env")');
  });

  it("checks the flag before the plan is built and long before any call", () => {
    const src: string = readFileSync(resolve(ROOT, "scripts/run-scenarios.mjs"), "utf8");
    const flag = src.indexOf("const may = liveCallAllowed(process.env, setByFile);");
    const plan = src.indexOf("plan = planFor(keys);");
    const call = src.indexOf("await callOnce(url, alert, { token })");
    expect(flag).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(flag);
    expect(call).toBeGreaterThan(flag);
  });
});
