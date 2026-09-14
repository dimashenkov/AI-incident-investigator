/**
 * The two-way bot's receiving-and-answering logic, kept pure so it can be tested
 * and mutation-covered. The listener workflow (generate-listener.mjs) transpiles
 * this file into its Code nodes, exactly as the incident workflow carries
 * thread.ts — so no imports here, and everything is plain data in, plain data out.
 *
 * The shape of the round trip:
 *   Slack event  -> classifyEvent   -> {challenge}         (verification)
 *                                    -> {event, ignored…}  (a real message)
 *   a real, non-ignored, threaded question
 *                -> shouldReply      -> yes/no
 *   conversations.replies(thread)    -> reportTextFrom     -> the report to answer from
 *   report + question                -> replyMessages      -> the model call (SPENDS)
 *   model response                   -> answerFrom         -> the text to post back
 *
 * Nothing here calls a model or the network; it only decides and formats.
 *
 * Leak posture (Grok, 2026-09-13/14): the PRIMARY control is that the reply path does
 * NOT fetch the raw observations — it answers from the curated report, the discipline
 * root-cause already follows. The output net is `redactSecrets` (src/core/redact.ts,
 * the single source), applied at the NODE that posts to Slack. As of 2026-09-14 that
 * same net guards BOTH Slack-bound strings from one source: the two-way reply here,
 * AND the FIRST incident post (slackReport's slack_text and Block Kit, redacted in
 * the Report node) — closing the report-path gap this comment used to name as open.
 * The net is deliberately NARROW (see redact.ts) so it cannot clobber legitimate
 * incident content. In this prototype the fixtures carry no real secrets, so it is a
 * real-deploy safeguard, not a live-leak fix.
 */

/** The bot's own Slack user id. A message from it, or carrying a bot_id, or with
 *  any subtype (edit/delete/join), is never answered — that is the anti-loop. */
export const BOT_USER = "U0C1ELPQCGH";

export type Classified =
  | { kind: "challenge"; challenge: string }
  | {
      kind: "event";
      ignored: boolean;
      thread_ts: string | null;
      channel: string | null;
      user: string | null;
      text: string | null;
      event_id: string | null;
    };

/**
 * Turn a Slack webhook body into a decision. The url_verification handshake must
 * echo the challenge or Slack never enables events; everything else is an event
 * we classify. A message is IGNORED when anything says a bot or an edit wrote it:
 * a present bot_id, the bot's own user id, or any subtype (Grok, 2026-09-12:
 * subtype alone is unreliable, so bot_id and the user id are the load-bearing
 * checks, and a present subtype is dropped too).
 */
export function classifyEvent(body: unknown): Classified {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b["type"] === "url_verification") {
    return { kind: "challenge", challenge: typeof b["challenge"] === "string" ? (b["challenge"] as string) : "" };
  }
  const ev = (b["event"] ?? {}) as Record<string, unknown>;
  const fromBotOrEdit =
    Boolean(ev["bot_id"]) || ev["user"] === BOT_USER || Boolean(ev["subtype"]);
  return {
    kind: "event",
    ignored: fromBotOrEdit,
    thread_ts: typeof ev["thread_ts"] === "string" ? (ev["thread_ts"] as string) : null,
    channel: typeof ev["channel"] === "string" ? (ev["channel"] as string) : null,
    user: typeof ev["user"] === "string" ? (ev["user"] as string) : null,
    text: fromBotOrEdit ? null : (typeof ev["text"] === "string" ? (ev["text"] as string) : null),
    event_id: typeof b["event_id"] === "string" ? (b["event_id"] as string) : null,
  };
}

/**
 * Whether this classified event should draw a reply. Four conditions, and each
 * closes a way to answer nothing useful or to loop:
 *  - it is an event, not the challenge;
 *  - it was not ignored (not the bot, not an edit);
 *  - it is INSIDE a thread (thread_ts present) — a top-level channel message is
 *    not tied to any incident, so there is nothing to answer from;
 *  - it carries non-empty text and a channel to answer in.
 */
export function shouldReply(c: Classified): boolean {
  if (c.kind !== "event") return false;
  if (c.ignored) return false;
  if (typeof c.thread_ts !== "string" || c.thread_ts === "") return false;
  if (typeof c.channel !== "string" || c.channel === "") return false;
  if (typeof c.text !== "string" || c.text.trim() === "") return false;
  return true;
}

/**
 * The incident report to answer from, pulled out of a conversations.replies
 * response. The thread parent (messages[0]) is the bot's original report; its
 * `text` is the plain-thread fallback the report was posted with. Returns null
 * when the call did not succeed or carried no parent — the caller must not
 * invent context, so a missing report means no answer rather than a guess.
 */
export function reportTextFrom(repliesBody: unknown): string | null {
  const b = (repliesBody ?? {}) as Record<string, unknown>;
  if (b["ok"] !== true) return null;
  const messages = b["messages"];
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const parent = (messages[0] ?? {}) as Record<string, unknown>;
  const text = parent["text"];
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

/**
 * The system+user messages for the model. The bot answers from the curated
 * incident report — NOT the raw observations. The owner (2026-09-12) asked that
 * the bot may REASON and SUGGEST remediation, not merely paraphrase; that stands.
 * What changed on 2026-09-13 (Grok's leak review) is that it no longer receives
 * the raw observation blob: a credential that is never fetched cannot be echoed.
 *
 * Grounding is INSTRUCTED, not enforced (subagent audit 2026-09-12): nothing in
 * code stops the model inventing, so the prompt asks it to ground every claim in
 * the report and to say plainly when the report lacks what a question needs.
 *
 * The honest cost of answering from the report only: a question about an exact
 * metric or log line that the report did not summarise cannot be answered from
 * the thread — the bot says so rather than guessing. A future version could
 * ALLOWLIST specific safe fields (pod, CPU, restart count) instead of handing over
 * the whole blob (Grok's suggested shape); that is in the backlog, not built.
 */
export function replyMessages(
  reportText: string,
  question: string,
): Array<{ role: string; content: string }> {
  const system =
    "You are the incident-investigation assistant answering a question in a Slack " +
    "thread about ONE incident. You are given the incident report to answer from. " +
    "Answer the specific question concisely. You MAY reason about the facts and " +
    "SUGGEST remediation steps — but frame them as advice for a human operator: " +
    "this system is read-only, it takes no actions and cannot run anything. Ground " +
    "every claim in the report; if the report does not contain what is needed, say " +
    "so plainly rather than guessing. Do not restate the whole report, and answer " +
    "in prose.";
  const user = `Incident report:\n${reportText}\n\nQuestion: ${question}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * The answer text out of an OpenAI chat.completions response. Returns null when the
 * response has no content — a null answer must not be posted as if the bot had
 * something to say. The secret-redaction net is applied at the NODE that posts to
 * Slack (Build reply calls redactSecrets from the shared redact.ts, spliced into the
 * node), NOT here — the same net now guards the report path too, from one source
 * (2026-09-14). Keeping answerFrom a pure extraction lets it stay import-free while
 * the redactor lives once in redact.ts.
 */
export function answerFrom(openaiBody: unknown): string | null {
  const b = (openaiBody ?? {}) as Record<string, unknown>;
  const choices = b["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const msg = ((choices[0] ?? {}) as Record<string, unknown>)["message"];
  const content = ((msg ?? {}) as Record<string, unknown>)["content"];
  if (typeof content !== "string" || content.trim() === "") return null;
  return content.trim();
}
