/**
 * Generate the two-way bot's LISTENER workflow — the half that hears a human
 * question in an incident thread and answers it.
 *
 * It is a separate workflow from the incident investigator (that one POSTS a
 * report; this one REPLIES in the thread). Like the incident workflow, its Code
 * nodes carry transpiled `src/core/reply.ts`, so the logic that decides and
 * formats is tested and mutation-covered in the repo rather than typed into n8n.
 *
 * The chain, and why each node is there:
 *   Slack Events (webhook, responseNode)
 *     → Handle            classify the event; challenge vs a real message
 *     → Is challenge?  ── true → Respond challenge   (Slack verification)
 *                     └─ false → Respond ack (200)   ← ACK inside Slack's 3s, so
 *                                                       Slack does not retry on a
 *                                                       timeout (it still MIGHT on
 *                                                       a lost 200 — see dedup)
 *        → Should reply? ── true → Seen event? (rowNotExists on event_id)
 *              → Mark seen        record event_id BEFORE spending
 *              → Fetch thread     (conversations.replies: the report is the parent)
 *              → Find incident    (thread_ts in incident_threads → incident_id + OWNERSHIP)
 *              → Owned? ── true → Build ask (answers from the report; NO raw pull)
 *              → Build ask        report + question (no report → stop)
 *              → Has report? ── true → Ask model     (gpt-5 — THIS SPENDS)
 *                    → Build reply     answerFrom (no answer → post nothing)
 *                    → Has answer? ── true → Post reply  (chat.postMessage in the thread)
 *
 * No model is called unless a real, non-bot, threaded question arrives AND its
 * event_id has not been seen AND the thread is one the bot itself opened (in
 * incident_threads) AND the model returned text. Every other path stops without
 * spending. The ownership check is the leak fix (2026-09-12): the bot answers only
 * in its own report threads, so a human thread that merely names an incident id
 * can never pull that incident's private data.
 *
 * DUPLICATE DELIVERY, honestly. Slack Events is at-least-once: a lost 200 or a
 * retry re-delivers the SAME event_id. The fast ACK reduces retries but is NOT
 * dedup — Grok, 2026-09-12, caught an earlier version claiming it was. So the
 * `Seen event?` node (dataTable rowNotExists on event_id) drops a re-delivered
 * event before Ask model, closing the SEQUENTIAL retry double-spend. What it does
 * NOT close is the CONCURRENT case: n8n Cloud runs webhooks in parallel and the
 * data table has no atomic insert-if-absent (the same fact behind the SKIP-Redis
 * limitation for the poster), so two simultaneous deliveries of one event_id can
 * both pass rowNotExists and both spend. That is a stated limitation, not a closed
 * hole; the demo answers a human typing occasionally, where it does not arise.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { transpile } from "./workflow-runtime.mjs";
import { MODEL, OPENAI_CREDENTIAL, SLACK_CREDENTIAL } from "./generate-workflow.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "workflows/slack-listener.json");

/** The data table of event_ids already handled, for duplicate-delivery dedup.
 *  Created 2026-09-12; a pointer, not a secret, like the other table/credential
 *  ids — drift masks the id and compares surrounding structure. */
const SEEN_TABLE = "uBZvrUFgQcderwqF";
// (removed 2026-09-13) DATA_TABLE / "Fetch data": the reply path no longer pulls the
// raw observations. Grok's leak review, owner-accepted: answer from the curated
// report only, so a stored credential is never fetched into a model prompt. The
// incident workflow still WRITES that table (generate-workflow.mjs); the bot just
// never reads it.
/** The threads the incident workflow opened when it posted a report (incident_id
 *  <-> ts). The bot answers ONLY in these — a reply thread_ts found here proves
 *  ownership and yields the incident_id. Leak audit 2026-09-12. */
const THREAD_TABLE = "HXGSOCOFnTmnAZtJ";

/** The reply logic, transpiled so the Code nodes carry it (no imports). */
const REPLY = transpile("src/core/reply.ts");

const ifOptions = { caseSensitive: true, typeValidation: "strict", version: 2 };

/** A boolean-true IF on one field. */
function ifTrue(field) {
  return {
    conditions: { options: ifOptions, combinator: "and", conditions: [{
      leftValue: `={{ ${field} }}`, rightValue: true,
      operator: { type: "boolean", operation: "true", singleValue: true } }] },
  };
}

/** An equals IF on one field against a string. */
function ifEquals(field, value) {
  return {
    conditions: { options: ifOptions, combinator: "and", conditions: [{
      leftValue: `={{ ${field} }}`, rightValue: value,
      operator: { type: "string", operation: "equals" } }] },
  };
}

export function buildListener({ name = "AI SRE — Slack listener" } = {}) {
  const nodes = [];
  const connections = {};
  let x = 0;
  const step = 240;
  const pos = () => { const p = [x, 0]; x += step; return p; };

  // 1. Webhook — responseNode so we choose WHEN to answer Slack (fast ACK, or the
  //    challenge), instead of after the whole chain finishes.
  nodes.push({
    id: "wh", name: "Slack Events", type: "n8n-nodes-base.webhook", typeVersion: 2,
    position: pos(), webhookId: "ea80d73c-8d02-42ce-bb33-2efe21978bd2",
    parameters: { httpMethod: "POST", path: "slack-events", responseMode: "responseNode" },
  });

  // 2. Handle — classify, and decide whether a reply is owed. The webhook body is
  //    at $json.body.
  nodes.push({
    id: "handle", name: "Handle", type: "n8n-nodes-base.code", typeVersion: 2,
    position: pos(),
    parameters: { language: "javaScript", mode: "runOnceForAllItems", jsCode:
`${REPLY}
const body = ($input.first() && $input.first().json && $input.first().json.body) || {};
const c = classifyEvent(body);
if (c.kind === "challenge") return [{ json: c }];
return [{ json: Object.assign({}, c, { reply: shouldReply(c) }) }];`
    },
  });
  connections["Slack Events"] = { main: [[{ node: "Handle", type: "main", index: 0 }]] };

  // 3. Is challenge? true → echo the challenge; false → ACK 200 and go on.
  nodes.push({
    id: "is-chal", name: "Is challenge", type: "n8n-nodes-base.if", typeVersion: 2.2,
    position: pos(), parameters: ifEquals("$json.kind", "challenge"),
  });
  connections["Handle"] = { main: [[{ node: "Is challenge", type: "main", index: 0 }]] };

  nodes.push({
    id: "resp-chal", name: "Respond challenge", type: "n8n-nodes-base.respondToWebhook",
    typeVersion: 1.1, position: [x, -160],
    parameters: { respondWith: "json", responseBody: "={{ JSON.stringify({ challenge: $json.challenge }) }}" },
  });
  nodes.push({
    id: "resp-ack", name: "Respond ack", type: "n8n-nodes-base.respondToWebhook",
    typeVersion: 1.1, position: pos(),
    parameters: { respondWith: "text", responseBody: "ok", options: { responseCode: 200 } },
  });
  // true → challenge, false → ack.
  connections["Is challenge"] = { main: [
    [{ node: "Respond challenge", type: "main", index: 0 }],
    [{ node: "Respond ack", type: "main", index: 0 }],
  ] };

  // 4. Should reply? Only a real, non-bot, threaded question with a channel.
  nodes.push({
    id: "should", name: "Should reply", type: "n8n-nodes-base.if", typeVersion: 2.2,
    position: pos(), parameters: ifTrue("$json.reply"),
  });
  connections["Respond ack"] = { main: [[{ node: "Should reply", type: "main", index: 0 }]] };

  const dtSeen = { __rl: true, mode: "id", value: SEEN_TABLE };

  // 4b. Seen event? — duplicate-delivery dedup. rowNotExists PASSES a miss (a new
  //     event) through unchanged and DROPS a hit (a re-delivered event_id), so a
  //     retried delivery never reaches Ask model. Closes the sequential retry
  //     double-spend; the concurrent case is the stated limitation (see header).
  nodes.push({
    id: "seen", name: "Seen event", type: "n8n-nodes-base.dataTable", typeVersion: 1.1,
    position: pos(),
    parameters: { resource: "row", operation: "rowNotExists", dataTableId: dtSeen,
      filters: { conditions: [{ keyName: "event_id", condition: "eq",
        keyValue: "={{ $json.event_id }}" }] } },
  });
  // Should reply: true → dedup, false → nothing.
  connections["Should reply"] = { main: [[{ node: "Seen event", type: "main", index: 0 }], []] };

  // 4c. Mark seen — record the event_id BEFORE spending, so a retry that arrives
  //     after this point is dropped by the rowNotExists above.
  nodes.push({
    id: "mark", name: "Mark seen", type: "n8n-nodes-base.dataTable", typeVersion: 1.1,
    position: pos(),
    parameters: { resource: "row", operation: "insert", dataTableId: dtSeen,
      columns: { mappingMode: "defineBelow",
        value: { event_id: "={{ $json.event_id }}" },
        matchingColumns: [], schema: [
          { id: "event_id", displayName: "event_id", type: "string", canBeUsedToMatch: true, required: false, display: true, defaultMatch: false },
        ] } },
  });
  connections["Seen event"] = { main: [[{ node: "Mark seen", type: "main", index: 0 }]] };

  // 5. Fetch thread — the report is the thread parent. limit=1 gets only it.
  //    channel/thread_ts are read from Handle by name, not $json, because the
  //    dataTable insert above may replace the item with the inserted row.
  nodes.push({
    id: "fetch", name: "Fetch thread", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2,
    position: pos(),
    credentials: { httpHeaderAuth: { id: SLACK_CREDENTIAL.id, name: SLACK_CREDENTIAL.name } },
    parameters: { method: "GET", url: "https://slack.com/api/conversations.replies",
      authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth",
      sendQuery: true, queryParameters: { parameters: [
        { name: "channel", value: "={{ $('Handle').first().json.channel }}" },
        { name: "ts", value: "={{ $('Handle').first().json.thread_ts }}" },
        { name: "limit", value: "1" },
      ] }, options: {} },
  });
  connections["Mark seen"] = { main: [[{ node: "Fetch thread", type: "main", index: 0 }]] };

  // 5b. Find incident — the bot answers ONLY in a thread it opened ITSELF.
  //     Grok/subagent leak audit (2026-09-12): the old version regex-matched an
  //     "INC-..." out of WHATEVER text rooted the thread — so a human thread that
  //     merely mentioned an incident id pulled that incident's full private data
  //     into a thread the bot never posted. The fix ties the answer to ownership:
  //     look the reply's thread_ts up in incident_threads (the table the incident
  //     workflow writes when IT posts a report). A hit gives the incident_id AND
  //     proves the bot owns this thread. A miss (onError-continue) means not ours.
  nodes.push({
    id: "find-incident", name: "Find incident", type: "n8n-nodes-base.dataTable", typeVersion: 1.1,
    position: pos(), onError: "continueRegularOutput",
    parameters: { resource: "row", operation: "get",
      dataTableId: { __rl: true, mode: "id", value: THREAD_TABLE },
      filters: { conditions: [{ keyName: "ts", condition: "eq",
        keyValue: "={{ $('Handle').first().json.thread_ts }}" }] } },
  });
  connections["Fetch thread"] = { main: [[{ node: "Find incident", type: "main", index: 0 }]] };

  // 5c. Owned? — only a thread found in incident_threads (a report the bot posted)
  //     is answered. Not ours → stop: no data pull, no reply.
  nodes.push({
    id: "owned", name: "Owned", type: "n8n-nodes-base.if", typeVersion: 2.2,
    position: pos(),
    parameters: { conditions: { options: ifOptions, combinator: "and", conditions: [{
      leftValue: "={{ $json.incident_id }}", rightValue: "",
      operator: { type: "string", operation: "notEmpty" } }] } },
  });
  connections["Find incident"] = { main: [[{ node: "Owned", type: "main", index: 0 }]] };

  // 5d. (removed 2026-09-13) There is no "Fetch data" node any more. Grok's leak
  //     review, accepted by the owner: the reply path must NOT pull the raw
  //     observations — a credential never fetched cannot be echoed to Slack. The
  //     bot answers from the curated report alone (the thread parent), the same
  //     discipline root-cause already follows. Owned true -> Build ask directly.
  connections["Owned"] = { main: [[{ node: "Build ask", type: "main", index: 0 }], []] };

  // 6. Build ask — report + question → model messages. The report is the thread
  //    parent (Fetch thread). No raw data is fetched or passed. No report → stop.
  nodes.push({
    id: "build-ask", name: "Build ask", type: "n8n-nodes-base.code", typeVersion: 2,
    position: pos(),
    parameters: { language: "javaScript", mode: "runOnceForAllItems", jsCode:
`${REPLY}
const h = $('Handle').first().json;
const report = reportTextFrom(($('Fetch thread').first() && $('Fetch thread').first().json) || {});
if (report === null) return [{ json: { ok: false, why: "no report found in the thread" } }];
return [{ json: { ok: true, channel: h.channel, thread_ts: h.thread_ts,
  messages: replyMessages(report, h.text) } }];`
    },
  });

  nodes.push({
    id: "has-report", name: "Has report", type: "n8n-nodes-base.if", typeVersion: 2.2,
    position: pos(), parameters: ifTrue("$json.ok"),
  });
  connections["Build ask"] = { main: [[{ node: "Has report", type: "main", index: 0 }]] };

  // 7. Ask model — THE ONLY node that spends. Plain-text answer (no json_object).
  nodes.push({
    id: "ask", name: "Ask model", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2,
    position: pos(),
    credentials: { openAiApi: { id: OPENAI_CREDENTIAL.id, name: OPENAI_CREDENTIAL.name } },
    parameters: { method: "POST", url: "https://api.openai.com/v1/chat/completions",
      authentication: "predefinedCredentialType", nodeCredentialType: "openAiApi",
      sendBody: true, specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ model: " + JSON.stringify(MODEL) + ", messages: $json.messages }) }}",
      options: {} },
  });
  // Has report: true → ask, false → nothing.
  connections["Has report"] = { main: [[{ node: "Ask model", type: "main", index: 0 }], []] };

  // 8. Build reply — the answer text. No answer → post nothing.
  nodes.push({
    id: "build-reply", name: "Build reply", type: "n8n-nodes-base.code", typeVersion: 2,
    position: pos(),
    parameters: { language: "javaScript", mode: "runOnceForAllItems", jsCode:
`${REPLY}
const ba = $('Build ask').first().json;
const answer = answerFrom(($input.first() && $input.first().json) || {});
if (answer === null) return [{ json: { ok: false, why: "the model returned no answer" } }];
return [{ json: { ok: true, channel: ba.channel, thread_ts: ba.thread_ts, text: answer } }];`
    },
  });
  connections["Ask model"] = { main: [[{ node: "Build reply", type: "main", index: 0 }]] };

  nodes.push({
    id: "has-answer", name: "Has answer", type: "n8n-nodes-base.if", typeVersion: 2.2,
    position: pos(), parameters: ifTrue("$json.ok"),
  });
  connections["Build reply"] = { main: [[{ node: "Has answer", type: "main", index: 0 }]] };

  // 9. Post reply — in the SAME thread (thread_ts), so the answer lands under the
  //    question, not as a new top-level message.
  nodes.push({
    id: "post", name: "Post reply", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2,
    position: pos(),
    credentials: { httpHeaderAuth: { id: SLACK_CREDENTIAL.id, name: SLACK_CREDENTIAL.name } },
    parameters: { method: "POST", url: "https://slack.com/api/chat.postMessage",
      authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth",
      sendHeaders: true, headerParameters: { parameters: [{ name: "Content-Type", value: "application/json; charset=utf-8" }] },
      sendBody: true, specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ channel: $json.channel, thread_ts: $json.thread_ts, text: $json.text }) }}",
      options: {} },
  });
  // Has answer: true → post, false → nothing.
  connections["Has answer"] = { main: [[{ node: "Post reply", type: "main", index: 0 }], []] };

  return { name, nodes, connections, settings: { executionOrder: "v1" } };
}

/** Stable JSON, same as the incident generator. */
export function serialise(workflow) {
  return JSON.stringify(workflow, null, 2) + "\n";
}

export function generate() {
  const workflow = buildListener();
  const text = serialise(workflow);
  return { workflow, text, sha256: createHash("sha256").update(text).digest("hex") };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { text, sha256 } = generate();
  mkdirSync(dirname(OUT), { recursive: true });
  const changed = !existsSync(OUT) || readFileSync(OUT, "utf8") !== text;
  writeFileSync(OUT, text);
  process.stdout.write(`workflows/slack-listener.json ${text.length} bytes, sha256 ${sha256.slice(0, 12)}… ${changed ? "(changed)" : "(unchanged)"}\n`);
}
