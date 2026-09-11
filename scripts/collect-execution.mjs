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

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [, , idArg, answersPath, keyArg] = process.argv;
  if (idArg === undefined || answersPath === undefined) {
    process.stdout.write(
      "usage: node scripts/collect-execution.mjs <execution-id|latest> <answers.json> [key]\n"
      + "  reads a FINISHED execution and writes its Report document into the answers file\n"
      + "  two GETs, no webhook, no retry: it cannot spend anything\n");
    process.exit(2);
  }
  const run = async () => {
    let id = idArg;
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
