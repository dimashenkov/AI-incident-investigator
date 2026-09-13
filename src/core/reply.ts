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
 * Leak posture (Grok, 2026-09-13, "as Grok says"): the PRIMARY control is that the
 * reply path does NOT fetch the raw observations at all — it answers from the
 * curated report, the same discipline the root-cause agent already follows. A
 * denylist on the raw input would have been permission to keep fetching it. The
 * only remaining net is `redactSecrets` on the OUTPUT — the string that is actually
 * posted to Slack — for fixed-shape credentials that a report or the model's
 * reasoning could still surface. That net is deliberately NARROW (see redactSecrets)
 * so it cannot clobber legitimate incident content.
 *
 * NOT addressed here, and named so it is not mistaken for solved (Grok, 2026-09-13):
 * the FIRST Slack post — the incident report itself — is built by slackReport in
 * thread.ts and posted by the incident workflow, quoting finding.fact and cited
 * message lines. It never passes through this module, so a secret an agent quotes
 * into the report reaches Slack before the bot ever replies. This does NOT require
 * duplicating redactSecrets: buildRuntime splices core files into every node's
 * prelude, so a shared redactor could be applied to slack_text AND the Block Kit
 * text from one source. It is deferred (a backlog brick) rather than impossible —
 * closing it means redacting the structured blocks too, not just the plain text.
 * In this prototype the observations are simulated fixtures with no real secrets,
 * so it is a real-deploy gap, not a live leak.
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
 * Redact fixed-shape credentials from a string BEFORE it is posted to Slack. This
 * is the OUTPUT net, not the primary control — the primary control is that the
 * reply path never fetches raw observations. Grok, 2026-09-13, named the boundary:
 * a Slack leak is the string Post reply sends, so the filter belongs here, on the
 * text on its way out, not on the model's input.
 *
 * It is deliberately NARROW. It matches ONLY shapes that a curated incident report
 * or a remediation suggestion would never legitimately contain:
 *   - provider keys with a fixed prefix: sk-…, xox[baprs]-…, AKIA…, AIza…, ghp_/gho_…
 *   - PEM private-key blocks
 *   - a Bearer token, and credentials embedded in a URL (user:pass@host)
 *   - the VALUE after a secret-named key: password / passwd / pwd / secret /
 *     api_key / apikey / access_key / client_secret / dsn — in either `k=v` or
 *     JSON `"k":"v"` form (the JSON form is the one Grok showed slipping through).
 * It does NOT touch bare `token=` or JWTs (eyJ…): a Kubernetes service-account
 * token is legitimate content an operator may be asking about, and eating it would
 * hide the very evidence they want (Grok's over-redaction case). That is an honest
 * gap, not an oversight: a denylist catches known shapes, not novel ones, and this
 * one errs toward keeping evidence readable.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== "string" || text === "") return text;
  let out = text;
  const R = "[redacted]";
  // PEM private-key blocks (any BEGIN…END PRIVATE KEY).
  out = out.replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, R);
  // Provider keys with an unambiguous prefix.
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, R);                 // OpenAI
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, R);           // Slack
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, R);                    // AWS access key id
  out = out.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, R);               // Google API key
  out = out.replace(/\bgh[posru]_[A-Za-z0-9]{20,}/g, R);            // GitHub tokens
  // Credentials embedded in a URL: scheme://user:pass@host -> scheme://[redacted]@host
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${R}@`);
  // A Bearer token. Require length AND a digit so a dictionary word — "Bearer
  // authentication failed" — is not eaten (Grok, 2026-09-13): a real token is long
  // and mixed, a prose word is neither.
  out = out.replace(/\bBearer\s+(?=[^\s]*\d)[A-Za-z0-9._~+/=-]{16,}/g, `Bearer ${R}`);
  // The value of a secret-named assignment. The key may carry a prefix so it ENDS
  // in the secret word (DB_PASSWORD, aws_secret_access_key), and the value may be
  // quoted with spaces — both were slipping before (Grok, 2026-09-13). `key` is an
  // optionally-quoted identifier ending in a secret word, not preceded by an
  // identifier char (so it starts a real key, not mid-word).
  const secretKey = "(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|dsn)";
  const key = `(?<![A-Za-z0-9_.])"?[A-Za-z0-9_.]*${secretKey}"?`;
  // A quoted value matched to its TRUE closing quote, so an escaped quote inside the
  // value does not end the match early and leak the tail (Grok, 2026-09-13):
  // "say \"hi\" world" is redacted whole, not up to the first \".
  const dq = '"(?:\\\\.|[^"\\\\])*"';
  const sq = "'(?:\\\\.|[^'\\\\])*'";
  // '=' assignment: quoted (escapes handled) or a bare value.
  out = out.replace(new RegExp(`(${key}\\s*=\\s*)${dq}`, "gi"), `$1"${R}"`);
  out = out.replace(new RegExp(`(${key}\\s*=\\s*)${sq}`, "gi"), `$1'${R}'`);
  out = out.replace(new RegExp(`(${key}\\s*=\\s*)[^\\s"',;}]+`, "gi"), `$1${R}`);
  // ':' with a QUOTED value only (JSON "k":"v" and YAML k: "v"). A BARE value after
  // ':' is a reference/name — a Kubernetes Secret NAME (secret: partner-gateway-tls)
  // is content, not a credential, so it is left intact (Grok's over-redaction case).
  out = out.replace(new RegExp(`(${key}\\s*:\\s*)${dq}`, "gi"), `$1"${R}"`);
  out = out.replace(new RegExp(`(${key}\\s*:\\s*)${sq}`, "gi"), `$1'${R}'`);
  return out;
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
 * The answer text out of an OpenAI chat.completions response, passed through
 * redactSecrets before it leaves this module. Returns null when the response has
 * no content — a null answer must not be posted as if the bot had something to
 * say. Redacting HERE, at the single extraction point, means no caller can obtain
 * an un-redacted answer to post (Grok: the net belongs on the outgoing string).
 */
export function answerFrom(openaiBody: unknown): string | null {
  const b = (openaiBody ?? {}) as Record<string, unknown>;
  const choices = b["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const msg = ((choices[0] ?? {}) as Record<string, unknown>)["message"];
  const content = ((msg ?? {}) as Record<string, unknown>)["content"];
  if (typeof content !== "string" || content.trim() === "") return null;
  return redactSecrets(content.trim());
}
