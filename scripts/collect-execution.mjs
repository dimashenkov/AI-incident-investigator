/**
 * Collect an answer that was paid for and never delivered.
 *
 * Two runs on 2026-09-11 came back HTTP 524 — the gateway cuts the connection
 * at about a hundred seconds and a reasoning chain takes longer. Both
 * executions are `status: success` in n8n. The answers exist; nothing here
 * re-runs anything, and nothing here can.
 *
 * This is a READER. It issues exactly two kinds of request, both GET:
 *
 *     GET /executions?workflowId=…&limit=…
 *     GET /executions/{id}?includeData=true
 *
 * It never touches the webhook and never touches a retry endpoint. Astra,
 * 2026-09-11: a retry operation on an execution EXECUTES work, and a webhook
 * probe can too — so „the executions endpoint" was not a precise enough rule to
 * be safe, and the precise one is the two lines above.
 *
 * `includeData=true` is REQUIRED and that is not obvious: without it the
 * response is still 200 and simply carries no `data` key. A reader written
 * without it would report „no answer" for a finished execution — a missing
 * field read as a missing answer.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeAtomic } from "./run-scenarios.mjs";

const API = (process.env.N8N_API_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.N8N_API_KEY ?? "";

/**
 * The node whose output IS the artifact.
 *
 * Named once. The document is taken verbatim from this node's first item, and
 * never reconstructed from the nodes before it: Astra, 2026-09-11, on keeping
 * the artifact comparable with every run scored before today — rebuild it from
 * intermediate output and the shape drifts without anyone deciding to change it.
 */
export const FINAL_NODE = "Report";
/** The node the alert arrives at. Its item is where request headers land. */
const ENTRY_NODE = "Incident Webhook";
/** Lowercase, because every HTTP stack in the path lowercases it. */
export const TOKEN_HEADER = "x-submission-token";

/**
 * What one execution holds, in four states rather than two.
 *
 * `pending` and `unavailable` are not `absent`: a run still going and a run
 * whose data n8n no longer keeps are different answers, and folding either into
 * „no answer" is what turns a retention window into a lost measurement.
 */
export function documentFrom(execution) {
  // An array is an object, and it is not an execution. Without this an empty
  // array reached the `finished !== true` branch and came back `pending`, which
  // would have reported a shape that is not an execution as a run in flight.
  if (execution === null || typeof execution !== "object" || Array.isArray(execution)) {
    return { state: "unavailable", why: "the execution could not be read as an object" };
  }
  const status = execution["status"];
  if (status === "error" || status === "crashed" || status === "canceled") {
    return { state: "failed", why: `the execution ended ${String(status)}` };
  }
  if (execution["finished"] !== true) {
    return { state: "pending", why: `the execution is ${String(status ?? "still going")}` };
  }
  const data = execution["data"];
  if (data === null || typeof data !== "object") {
    return { state: "unavailable",
      why: "the execution carries no data — n8n may not be saving it, or the request omitted includeData=true" };
  }
  const runData = data["resultData"] === null || typeof data["resultData"] !== "object"
    ? undefined : data["resultData"]["runData"];
  if (runData === null || typeof runData !== "object") {
    return { state: "unavailable", why: "the execution data carries no runData" };
  }
  const runs = runData[FINAL_NODE];
  if (!Array.isArray(runs) || runs.length === 0) {
    return { state: "unavailable", why: `the execution never ran ${FINAL_NODE}` };
  }
  const items = runs[runs.length - 1]?.data?.main?.[0];
  if (!Array.isArray(items) || items.length === 0) {
    return { state: "unavailable", why: `${FINAL_NODE} produced no item` };
  }
  const json = items[0]?.json;
  if (json === null || typeof json !== "object") {
    return { state: "unavailable", why: `${FINAL_NODE} produced an item with no json` };
  }
  return { state: "collected", document: json };
}

/**
 * Which answers file key a collected document belongs under.
 *
 * The runner keys by `scenario` or `scenario#attempt`. A document read out of
 * an execution knows its scenario and nothing about attempts, so the caller
 * says which key it is filling — and if it does not, the bare scenario is used
 * and a collision is REFUSED rather than overwritten.
 */
export function keyFor(document, given) {
  if (typeof given === "string" && given.length > 0) return given;
  const scenario = document?.["scenario"];
  return typeof scenario === "string" && scenario.length > 0 ? scenario : null;
}

/**
 * The submission token this execution was called with.
 *
 * It travels as a request HEADER, not in the alert body, for one reason: the
 * body is the model's input, and a token in there would become part of what the
 * chain is asked to reason about. The header lands in the entry node's item,
 * which was established by reading a real execution rather than assumed.
 *
 * Three states, because "I could not read this execution" is not "this
 * execution carries no token". Folding the two turns a retention gap into a
 * confident no-match, and a confident no-match is what would authorise paying
 * for the same question twice.
 */
export function tokenOf(execution) {
  if (execution === null || typeof execution !== "object" || Array.isArray(execution)) {
    return { state: "unreadable", why: "the execution could not be read as an object" };
  }
  const data = execution["data"];
  const resultData = data === null || typeof data !== "object" ? undefined : data["resultData"];
  const runData = resultData === null || typeof resultData !== "object" ? undefined : resultData["runData"];
  if (runData === null || typeof runData !== "object" || Array.isArray(runData)) {
    return { state: "unreadable",
      why: "the execution carries no runData — n8n may not be saving it, or includeData=true was omitted" };
  }
  const runs = runData[ENTRY_NODE];
  if (!Array.isArray(runs) || runs.length === 0) {
    return { state: "unreadable", why: `the execution has no ${ENTRY_NODE} run to read headers from` };
  }
  const headers = runs[0]?.data?.main?.[0]?.[0]?.json?.headers;
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    return { state: "unreadable", why: `${ENTRY_NODE} recorded no headers` };
  }
  // n8n lowercases incoming header names, and so does every HTTP stack in the
  // path. The lookup is case-insensitive anyway, because a header that arrived
  // in another case is the same header and not a missing one.
  for (const [name, value] of Object.entries(headers)) {
    if (String(name).toLowerCase() !== TOKEN_HEADER) continue;
    return typeof value === "string" && value.length > 0
      ? { state: "token", token: value }
      : { state: "none", why: `${TOKEN_HEADER} was present but empty` };
  }
  return { state: "none", why: `${TOKEN_HEADER} was not sent with this execution` };
}

/**
 * Which scanned execution belongs to one submission token.
 *
 * Four answers, and the fourth is the one that matters. `many` refuses rather
 * than picking: two executions carrying one token means the reconciliation
 * itself is wrong, and answering with either would hide that. `uncertain` is
 * zero matches where something could not be read — it is NOT permission to
 * submit again, which is exactly what a plain zero would become.
 */
export function matchByToken(scanned, token) {
  if (typeof token !== "string" || token.length === 0) {
    return { state: "uncertain", why: "no submission token was given to look for", unreadable: [] };
  }
  const hits = [];
  const unreadable = [];
  for (const { id, result } of Array.isArray(scanned) ? scanned : []) {
    if (result?.state === "token") { if (result.token === token) hits.push(id); continue; }
    if (result?.state === "unreadable") unreadable.push(id);
  }
  if (hits.length > 1) return { state: "many", ids: hits };
  if (hits.length === 1) {
    /*
     * One hit is not uniqueness while part of the window is unread.
     *
     * Astra, 2026-09-11: this returned `one` with unreadable executions in the
     * same window, so the promise to refuse a duplicate was unearned — the
     * duplicate could be sitting in the execution that could not be read. And
     * the answer it hands back would be another attempt's measurement, scored
     * as this one's.
     *
     * So the id is still reported, because it is real and a person may want
     * it, but the STATE says uniqueness was not established. Deciding to use
     * it anyway is a decision, not a default.
     */
    if (unreadable.length > 0) {
      return { state: "one-unverified", id: hits[0], unreadable,
        why: `one execution carried the token, and ${unreadable.length} in the same window could not be read, `
          + "so nothing here establishes that it is the only one" };
    }
    return { state: "one", id: hits[0], scanned: (scanned ?? []).length };
  }
  if (unreadable.length > 0) {
    return { state: "uncertain",
      why: `no execution in the scanned window carried the token, and ${unreadable.length} could not be read`,
      unreadable };
  }
  return { state: "none", scanned: (scanned ?? []).length };
}

async function get(path) {
  if (API === "" || KEY === "") {
    throw new Error("N8N_API_URL and N8N_API_KEY must be set. Source ~/.config/ai-sre/n8n.env first.");
  }
  const r = await fetch(`${API}${path}`, {
    headers: { "X-N8N-API-KEY": KEY },
    redirect: "error",
  });
  if (!r.ok) throw new Error(`GET ${path} answered ${r.status}`);
  return r.json();
}

/** The executions of one workflow, newest first. A read, and only a read. */
export async function recentExecutions(workflowId, limit = 10) {
  const q = workflowId === undefined ? "" : `workflowId=${encodeURIComponent(workflowId)}&`;
  const body = await get(`/executions?${q}limit=${Number(limit)}`);
  return Array.isArray(body?.data) ? body.data : [];
}

/** One execution, WITH its data. The parameter is not optional in practice. */
export async function executionWithData(id) {
  return get(`/executions/${encodeURIComponent(String(id))}?includeData=true`);
}

/** One page of executions, newest first, with the cursor to continue. A read. */
export async function executionPage(workflowId, limit = 20, cursor = undefined) {
  const q = [];
  if (workflowId !== undefined) q.push(`workflowId=${encodeURIComponent(workflowId)}`);
  q.push(`limit=${Number(limit)}`);
  if (typeof cursor === "string" && cursor.length > 0) q.push(`cursor=${encodeURIComponent(cursor)}`);
  const body = await get(`/executions?${q.join("&")}`);
  return {
    rows: Array.isArray(body?.data) ? body.data : [],
    // A cursor that is not a non-empty string ends the walk. Passing a null
    // through as "continue here" would ask for page one again, forever.
    cursor: typeof body?.nextCursor === "string" && body.nextCursor.length > 0 ? body.nextCursor : undefined,
  };
}

/**
 * Find the execution a submission token belongs to, by reading only.
 *
 * The list endpoint does not return execution data, so each candidate is
 * fetched with `includeData=true` to read its headers. Every call here is a
 * GET: nothing in this function can execute a workflow or spend anything.
 *
 * The window is bounded and the bound is REPORTED. A scan that quietly stopped
 * after one page would answer "not found" for an execution one row below the
 * edge, and "not found" is the answer that costs money.
 */
export async function scanForToken(workflowId, token, opts = {}) {
  const { pages = 5, perPage = 20, page = executionPage, one = executionWithData } = opts;
  const scanned = [];
  const seen = new Set();
  let cursor;
  let walked = 0;
  for (let i = 0; i < pages; i += 1) {
    let got;
    try { got = await page(workflowId, perPage, cursor); }
    catch (e) {
      /*
       * A page that could not be listed leaves the window short, and a short
       * window is never a clean miss.
       *
       * The first version returned `matchByToken` as it stood, so a failure on
       * page ONE — nothing scanned at all — came back `none`: "no execution
       * carries this token", stated after reading zero executions. `none` is
       * the answer that authorises paying again, so a failed listing falls to
       * `uncertain` unless something was actually matched.
       */
      const partial = matchByToken(scanned, token);
      const state = partial.state === "many" ? partial
        : partial.state === "one" || partial.state === "one-unverified" ? {
          // The listing stopped, so the rest of the window was never looked
          // at. A single hit inside a window that was not read to its end does
          // not establish that it is single.
          state: "one-unverified", id: partial.id, unreadable: partial.unreadable ?? [],
          why: `one execution carried the token, but the listing stopped after ${walked} page(s), `
            + "so the window was not read to its end",
        } : {
        state: "uncertain",
        why: `the listing stopped after ${walked} page(s), so the window was not read to its end`,
        unreadable: partial.unreadable ?? [],
      };
      return { ...state, pagesWalked: walked, listingStopped: e.message };
    }
    walked += 1;
    for (const row of got.rows) {
      const id = row?.id;
      if (id === undefined || id === null) {
        /*
         * A row with no id is coverage that was NOT checked, and skipping it
         * silently made the scan report uniqueness over a window it had not
         * read. Astra, 2026-09-11, by running it rather than reading it.
         */
        scanned.push({ id: null, result: { state: "unreadable", why: "the listing row carried no id" } });
        continue;
      }
      /*
       * The same execution can appear on two pages.
       *
       * n8n pages by cursor over a list that is still growing, so an overlap is
       * ordinary — and counting one execution twice reported a DUPLICATE TOKEN
       * where there was none, which refuses a collection that should have
       * succeeded. Astra, 2026-09-11.
       */
      if (seen.has(String(id))) continue;
      seen.add(String(id));
      let full;
      try { full = await one(id); }
      catch (e) { scanned.push({ id, result: { state: "unreadable", why: e.message } }); continue; }
      const result = tokenOf(full);
      scanned.push({ id, result });
      // A match does not end the walk. Stopping at the first hit is what makes
      // a duplicated token look unique, and `many` exists precisely to refuse
      // that case rather than pick a side of it.
    }
    cursor = got.cursor;
    if (cursor === undefined) break;
  }
  const found = matchByToken(scanned, token);
  /*
   * Running out of PAGES is not running out of executions.
   *
   * `cursor` still holding a value means n8n had more rows to give and the
   * bound stopped the walk. A hit inside a bounded window is a hit; it is not
   * the only hit, and this is the third way that distinction was being lost.
   */
  const exhausted = cursor !== undefined;
  if (exhausted && found.state === "one") {
    return { state: "one-unverified", id: found.id, unreadable: [],
      why: `one execution carried the token, and the scan stopped at its ${pages}-page bound with more `
        + "executions unread, so nothing here establishes that it is the only one",
      pagesWalked: walked, windowExhausted: true };
  }
  return { ...found, pagesWalked: walked, ...(exhausted ? { windowExhausted: true } : {}) };
}

/**
 * The token one key was submitted under, out of a run record.
 *
 * Three answers, because a record with no `submissions` field at all was
 * written by an older runner and cannot be reconciled — which is not the same
 * as a record that says this key was never submitted. Reported as such, so a
 * recovery that is impossible does not read as a key that was never bought.
 */
export function tokenInRecord(record, key) {
  const subs = record?.["submissions"];
  if (subs === undefined) {
    return { state: "unreconcilable",
      why: "this run record carries no submissions field; it predates token binding" };
  }
  if (subs === null || typeof subs !== "object" || Array.isArray(subs)) {
    return { state: "unreconcilable", why: "the submissions field is not an object of bindings" };
  }
  const bound = subs[key];
  const token = bound === null || typeof bound !== "object" ? undefined : bound["token"];
  if (typeof token !== "string" || token.length === 0) {
    return { state: "unbound", why: `the record binds no token to ${key}` };
  }
  return { state: "token", token };
}

/**
 * Which of the three modes was asked for, and with what.
 *
 * Exported because the shifting is where a silent mistake lives: read the
 * token where the answers path should be and the script writes an answer file
 * named `sub-...`, reporting success. Three modes, one shape out, so each can
 * be checked without running anything.
 */
export function parseReaderArgv(argv) {
  const a = argv.slice(2);
  if (a[0] === "--token") {
    return { mode: "token", token: a[1], answersPath: a[2], key: a[3] };
  }
  if (a[0] === "--record") {
    return { mode: "record", recordPath: a[1], key: a[2], answersPath: a[3] };
  }
  return { mode: "id", id: a[0], answersPath: a[1], key: a[2] };
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  /*
   * `--record` is the whole point of the mechanism: a key the runner marked
   * "may have been charged" is resolved by READING, instead of by a human
   * opening the n8n interface or — worse — by paying for the question again.
   */
  const asked = parseReaderArgv(process.argv);
  let idArg = asked.mode === "id" ? asked.id : asked.mode;
  const answersPath = asked.answersPath;
  const keyArg = asked.key;
  let tokenArg = asked.mode === "token" ? asked.token : undefined;
  const recordArg = asked.mode === "record"
    ? { recordPath: asked.recordPath, recordKey: asked.key } : undefined;
  if (idArg === undefined || answersPath === undefined) {
    process.stdout.write(
      "usage: node scripts/collect-execution.mjs <execution-id|latest> <answers.json> [key]\n"
      + "       node scripts/collect-execution.mjs --token <sub-...> <answers.json> [key]\n"
      + "       node scripts/collect-execution.mjs --record <run.json> <key> <answers.json>\n"
      + "  reads a FINISHED execution and writes its Report document into the answers file\n"
      + "  --token finds the execution a submission was made under, by reading only\n"
      + "  --record reads that token out of a run record, for a key marked may-have-been-charged\n"
      + "  GETs only, no webhook, no retry: it cannot spend anything\n");
    process.exit(2);
  }
  const run = async () => {
    let id = idArg;
    if (recordArg !== undefined) {
      if (recordArg.recordKey === undefined) {
        process.stdout.write("--record needs a key and an answers path\n"); process.exit(2);
      }
      let record;
      try { record = JSON.parse(readFileSync(recordArg.recordPath, "utf8")); }
      catch (e) { process.stdout.write(`cannot read ${recordArg.recordPath}: ${e.message}\n`); process.exit(2); }
      const held = tokenInRecord(record, recordArg.recordKey);
      if (held.state !== "token") {
        // Not an answer about the execution. It is an answer about the RECORD,
        // and reporting it as "nothing found" would blame the wrong thing.
        process.stdout.write(`${held.state}: ${held.why}\n`);
        process.exit(2);
      }
      tokenArg = held.token;
      process.stdout.write(`${recordArg.recordKey} was submitted as ${tokenArg}\n`);
    }
    if (tokenArg !== undefined) {
      const found = await scanForToken(process.env.N8N_WORKFLOW_ID, tokenArg, {});
      if (found.state === "one-unverified") {
        // The id is printed because it is real. Collecting it is a decision
        // someone takes by passing it, not one this script takes for them.
        process.stdout.write(`one-unverified: ${found.why}\n`
          + `  the execution that carried it is ${found.id}.\n`
          + `  read it deliberately with:  node scripts/collect-execution.mjs ${found.id} `
          + `${answersPath}${keyArg ? ` ${keyArg}` : ""}\n`);
        process.exit(3);
      }
      if (found.state !== "one") {
        process.stdout.write(`${found.state}: ${found.why ?? ""}`
          + `${found.ids ? ` executions ${found.ids.join(", ")}` : ""}`
          + ` (scanned ${found.pagesWalked} page(s))\n`
          + (found.state === "none"
            ? "  nothing in the window carried that token. That is not permission to submit again:\n"
            + "  widen the window or read the executions before spending anything.\n"
            : ""));
        process.exit(found.state === "many" ? 2 : 3);
      }
      id = found.id;
      process.stdout.write(`that token was carried by execution ${id}\n`);
    }
    if (idArg === "latest") {
      const rows = await recentExecutions(process.env.N8N_WORKFLOW_ID, 1);
      if (rows.length === 0) { process.stdout.write("no executions to read\n"); process.exit(2); }
      id = rows[0].id;
      process.stdout.write(`latest execution is ${id} (${rows[0].status})\n`);
    }
    const found = documentFrom(await executionWithData(id));
    if (found.state !== "collected") {
      process.stdout.write(`${found.state}: ${found.why}\n`);
      process.exit(found.state === "pending" ? 3 : 2);
    }
    const key = keyFor(found.document, keyArg);
    if (key === null) { process.stdout.write("the document names no scenario and no key was given\n"); process.exit(2); }

    const before = existsSync(answersPath)
      ? JSON.parse(readFileSync(answersPath, "utf8")) : {};
    if (Object.prototype.hasOwnProperty.call(before, key)) {
      process.stdout.write(
        `${answersPath} already holds ${key}. Refusing to overwrite an answer that was paid for;\n`
        + "  write it under another key if this is a different attempt.\n");
      process.exit(2);
    }
    before[key] = found.document;
    writeAtomic(answersPath, `${JSON.stringify(before, null, 2)}\n`);
    process.stdout.write(
      `collected execution ${id} into ${answersPath} under ${key}\n`
      + `  state ${String(found.document.state)} · code ${String(found.document.root_cause_code)}`
      + ` · confidence ${String(found.document.confidence)}\n`);
  };
  run().catch((e) => { process.stdout.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(2); });
}
