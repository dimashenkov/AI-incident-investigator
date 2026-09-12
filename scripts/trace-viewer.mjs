/**
 * A local, read-only trace viewer for the incident runs.
 *
 * Owner asked (2026-09-12) for a viewer like Langfuse's, but written here rather
 * than run externally. Grok reviewed the shape the same day and set the rules this
 * follows:
 *
 *  - the SOURCE is the n8n incident executions — one execution is one RUN, a node
 *    pipeline, NOT a Langfuse trace. The frontend renders runData node-by-node;
 *    it never invents a trace join the data does not have.
 *  - it REUSES the existing readers (`recentExecutions`, `executionWithData` from
 *    collect-execution.mjs) rather than opening a second path to the n8n API.
 *  - it binds 127.0.0.1 only, keeps the N8N_API_KEY server-side (never in the page),
 *    strips the webhook submission token from what it serves, and writes NOTHING to
 *    disk — no DB, no cache, no saving (the spec's "do NOT").
 *  - read-only: two GETs, no mutation, no annotation.
 *
 * Run: node scripts/trace-viewer.mjs   (needs the n8n env sourced), then open
 * http://127.0.0.1:7333 . Ctrl-C to stop.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { recentExecutions, executionWithData, TOKEN_HEADER } from "./collect-execution.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(resolve(ROOT, "public/trace-viewer.html"), "utf8");
const HOST = "127.0.0.1";
const PORT = Number(process.env.TRACE_VIEWER_PORT || 7333);
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID;

/**
 * Redact the secrets that ride inside execution data before the page sees any.
 *
 * Grok, 2026-09-12: it is not only the webhook submission token. A FAILED HTTP
 * node can carry its request headers — `Authorization: Bearer <bot token>` — and
 * other webhooks (were one ever listed) carry `x-slack-signature` and cookies. So
 * this redacts a SET of sensitive key names (case-insensitive), by name, wherever
 * they nest. The incident's own content — observations, findings, the thread — is
 * the point of the viewer and is left intact; credentials are otherwise referenced
 * by id and do not appear.
 */
const REDACT_KEYS = new Set([
  TOKEN_HEADER,            // x-submission-token
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-slack-signature",
  "x-n8n-api-key",
  "token",
  "password",
  "secret",
]);
export function stripToken(value) {
  if (Array.isArray(value)) return value.map(stripToken);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? "[redacted]" : stripToken(v);
    }
    return out;
  }
  return value;
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method !== "GET") return json(res, 405, { error: "read-only: GET only" });

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(HTML);
    }

    // The list: recent runs of the INCIDENT workflow only (never the slack-listener).
    // Minimal fields — no bodies, no token — so the list itself carries nothing.
    if (url.pathname === "/api/runs") {
      if (!WORKFLOW_ID) return json(res, 500, { error: "N8N_WORKFLOW_ID is not set; source the n8n env first" });
      const rows = await recentExecutions(WORKFLOW_ID, 25);
      const runs = (Array.isArray(rows) ? rows : []).map((e) => ({
        id: e.id, status: e.status ?? null, startedAt: e.startedAt ?? null,
        // stoppedAt lets the frontend show total wall time without any body.
        stoppedAt: e.stoppedAt ?? null,
      }));
      return json(res, 200, { runs });
    }

    // One run, full node-by-node data, with secrets redacted — and SCOPED to the
    // incident workflow. Grok, 2026-09-12: without the scope check, this served ANY
    // execution the key can read (ids are sequential), so a slack-listener run or
    // another workflow's run — with its own headers/secrets — could be viewed.
    const m = url.pathname.match(/^\/api\/runs\/(\d+)$/);
    if (m) {
      if (!WORKFLOW_ID) return json(res, 500, { error: "N8N_WORKFLOW_ID is not set; source the n8n env first" });
      const exec = await executionWithData(m[1]);
      if (exec === null || exec === undefined) return json(res, 404, { error: `no execution ${m[1]}` });
      if (exec.workflowId !== WORKFLOW_ID) {
        return json(res, 404, { error: `execution ${m[1]} is not an incident run` });
      }
      return json(res, 200, stripToken(exec));
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 502, { error: `reading n8n failed: ${e instanceof Error ? e.message : String(e)}` });
  }
});

// Start listening only when run directly — importing this file (a test reaching
// stripToken) must not bind a port.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  server.listen(PORT, HOST, () => {
    process.stdout.write(`trace viewer on http://${HOST}:${PORT}  (incident workflow ${WORKFLOW_ID ?? "— set N8N_WORKFLOW_ID"})\n`);
    process.stdout.write("read-only: two GETs, binds localhost, writes nothing. Ctrl-C to stop.\n");
  });
}
