/**
 * The two-way bot's receiving-and-answering logic. These tests are about the ways
 * the bot could answer the wrong thing, answer itself, or answer from nothing:
 *  - the anti-loop must drop the bot's own messages (else it talks to itself);
 *  - a top-level message (no thread) has no incident, so it must NOT be answered;
 *  - the model must be handed the report as context, never left to invent one;
 *  - a missing report or a contentless model reply must produce no post.
 */
import { describe, it, expect } from "vitest";
import {
  classifyEvent, shouldReply, reportTextFrom, replyMessages, answerFrom, BOT_USER,
} from "../src/core/reply.js";

describe("classifyEvent", () => {
  it("echoes the url_verification challenge", () => {
    const c = classifyEvent({ type: "url_verification", challenge: "abc123" });
    expect(c).toEqual({ kind: "challenge", challenge: "abc123" });
  });

  it("classifies a real human message as not ignored, carrying its fields", () => {
    const c = classifyEvent({
      type: "event_callback", event_id: "Ev1",
      event: { type: "message", user: "UHUMAN", text: "what is the incident",
        thread_ts: "1757.001", channel: "C1" },
    });
    expect(c).toMatchObject({ kind: "event", ignored: false, thread_ts: "1757.001",
      channel: "C1", user: "UHUMAN", text: "what is the incident", event_id: "Ev1" });
  });

  it("ignores the bot's own message and nulls its text (anti-loop)", () => {
    const c = classifyEvent({ event: { user: BOT_USER, text: "my own report", thread_ts: "1" } });
    expect(c).toMatchObject({ kind: "event", ignored: true, text: null });
  });

  it("ignores anything carrying a bot_id, even without the bot user id", () => {
    const c = classifyEvent({ event: { bot_id: "B999", user: "USOMEONE", text: "x", thread_ts: "1" } });
    expect((c as { ignored: boolean }).ignored).toBe(true);
  });

  it("ignores a message with a subtype (edit/delete/join)", () => {
    const c = classifyEvent({ event: { subtype: "message_changed", user: "U", text: "x", thread_ts: "1" } });
    expect((c as { ignored: boolean }).ignored).toBe(true);
  });
});

describe("shouldReply", () => {
  const human = classifyEvent({
    event: { user: "UHUMAN", text: "why did it fail?", thread_ts: "1757.1", channel: "C1" },
  });

  it("replies to a threaded human question", () => {
    expect(shouldReply(human)).toBe(true);
  });

  it("does NOT reply to the challenge", () => {
    expect(shouldReply(classifyEvent({ type: "url_verification", challenge: "x" }))).toBe(false);
  });

  it("does NOT reply to an ignored (bot) message", () => {
    expect(shouldReply(classifyEvent({ event: { user: BOT_USER, thread_ts: "1", channel: "C1", text: "x" } }))).toBe(false);
  });

  it("does NOT reply to a top-level message with no thread — it ties to no incident", () => {
    // This is the owner's own case on 2026-09-12: "kakuv e incidenta" posted at
    // channel top level (thread_ts null). There is no incident thread to answer
    // from, so the bot stays silent rather than answering from nothing.
    const topLevel = classifyEvent({ event: { user: "UHUMAN", text: "kakuv e incidenta", channel: "C1" } });
    expect(shouldReply(topLevel)).toBe(false);
  });

  it("does NOT reply to an empty or whitespace-only message", () => {
    const blank = classifyEvent({ event: { user: "U", text: "   ", thread_ts: "1", channel: "C1" } });
    expect(shouldReply(blank)).toBe(false);
  });

  it("does NOT reply when there is no channel to answer in", () => {
    const noChannel = classifyEvent({ event: { user: "U", text: "hi", thread_ts: "1" } });
    expect(shouldReply(noChannel)).toBe(false);
  });
});

describe("reportTextFrom", () => {
  it("returns the thread parent's text — the posted report", () => {
    const body = { ok: true, messages: [{ text: "INC-1: payment-api — root cause OOM" }, { text: "a human reply" }] };
    expect(reportTextFrom(body)).toBe("INC-1: payment-api — root cause OOM");
  });

  it("returns null when the call did not succeed — no context is invented", () => {
    expect(reportTextFrom({ ok: false, error: "channel_not_found" })).toBeNull();
  });

  it("returns null when there is no parent message", () => {
    expect(reportTextFrom({ ok: true, messages: [] })).toBeNull();
  });

  it("returns null when the parent has empty text", () => {
    expect(reportTextFrom({ ok: true, messages: [{ text: "  " }] })).toBeNull();
  });
});

describe("replyMessages", () => {
  const msgs = replyMessages("INC-1 report body", "why did it crash?");

  it("hands the model the report as context and the question separately", () => {
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[1]!.content).toContain("INC-1 report body");
    expect(msgs[1]!.content).toContain("why did it crash?");
  });

  it("the prompt lets the model advise AND states the system is read-only (prompt text, not an enforced control)", () => {
    // The owner asked for more than paraphrase. The prompt must permit remediation
    // suggestions AND state the system takes no actions, so the bot cannot imply
    // it did something.
    expect(msgs[0]!.content).toMatch(/suggest remediation|reason/i);
    expect(msgs[0]!.content).toMatch(/read-only|takes no actions|cannot run/i);
  });

  it("the prompt INSTRUCTS grounding — not an enforced guard; nothing in code stops invention", () => {
    expect(msgs[0]!.content).toMatch(/ground|do not.*guess|rather than guessing/i);
  });

  it("answers from the report ONLY — never asks for or embeds raw observation data", () => {
    // Grok's leak review 2026-09-13, owner-accepted ("as Grok says"): the primary
    // control is that the reply path does not fetch raw. So replyMessages takes NO
    // data argument, and its prompt must not tell the model it has raw observations.
    expect(replyMessages.length, "replyMessages must take (report, question) only — no data param").toBe(2);
    expect(msgs[1]!.content).not.toMatch(/raw observations/i);
    expect(msgs[0]!.content).toMatch(/report to answer from|in the report|from the report/i);
  });
});

describe("answerFrom", () => {
  it("pulls and trims the model's answer", () => {
    expect(answerFrom({ choices: [{ message: { content: "  It was OOM-killed.  " } }] })).toBe("It was OOM-killed.");
  });

  it("returns null when there are no choices — nothing to post", () => {
    expect(answerFrom({ choices: [] })).toBeNull();
  });

  it("returns null when the content is empty", () => {
    expect(answerFrom({ choices: [{ message: { content: "" } }] })).toBeNull();
  });

  it("returns the RAW answer — redaction now happens at the posting node, not here (2026-09-14)", () => {
    // redactSecrets moved to the shared redact.ts so it guards the report path too.
    // answerFrom is pure extraction; the Build reply node applies redactSecrets to
    // what it returns. This test pins that contract so a future reader does not think
    // answerFrom still redacts (it must not — the net is one place, the redact node).
    const raw = answerFrom({ choices: [{ message: { content: "  Use sk-abcdef0123456789ABCD.  " } }] });
    expect(raw, "extraction only — the node redacts").toBe("Use sk-abcdef0123456789ABCD.");
  });
});
