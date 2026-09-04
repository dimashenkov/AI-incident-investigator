/**
 * The fake Slack thread.
 *
 * One thread per incident, and the link between them is what the whole
 * conversation layer rests on. Codex listed it in the plan's uncovered items:
 * "Exact one-to-one thread/incident invariants, including unknown and duplicate
 * thread IDs" and "The created Slack thread is durably linked, not merely
 * returned."
 *
 * Both of those are about the same failure: a thread that exists but cannot be
 * found again, or found again and belonging to somebody else. So this keeps an
 * index, and every operation through it either resolves to exactly one incident
 * or refuses.
 */
import { validate } from "../schema/validate.js";

export type Message = { role: "system" | "user" | "agent"; text: string; ts: string; incident_id: string; cited_evidence?: Array<{ source: string; fact: string }> };

export type ThreadResult =
  | { state: "ok"; conversation: Record<string, unknown> }
  | { state: "refused"; reason: string; errors?: string[] };

export type Lookup =
  | { state: "found"; incidentId: string }
  | { state: "unknown"; reason: string }
  | { state: "ambiguous"; incidentIds: string[] };

/** thread_id is derived from incident_id and nothing else. */
export function threadIdFor(incidentId: string): string {
  return `thread-${incidentId}`;
}

/**
 * The index from thread to incident.
 *
 * Deliberately a class holding state, because the durability question — "can
 * this thread be found again" — is meaningless for a function that computes an
 * answer and forgets it. A derived id could always be recomputed; that is not
 * the same as the thread having been recorded.
 */
export class ThreadIndex {
  #byThread = new Map<string, string>();
  #byIncident = new Map<string, string>();

  /**
   * Register a thread for an incident.
   *
   * Refuses a second thread for the same incident and a second incident for the
   * same thread. One-to-one is checked in both directions, because checking one
   * of them leaves the other free to break.
   */
  register(
    incidentId: string,
    threadId: string,
    derive: (id: string) => string = threadIdFor,
  ): { state: "registered" } | { state: "refused"; reason: string } {
    if (threadId !== derive(incidentId)) {
      return { state: "refused", reason: `${threadId} is not derived from ${incidentId}` };
    }
    // The two checks below are unreachable while the derivation is injective —
    // two incidents cannot produce one thread id. They are here because that
    // property lives in another function, and a collision introduced there
    // would otherwise be silently absorbed by an index that trusts it. The
    // `derive` parameter exists so the tests can reach them.
    const existingIncident = this.#byThread.get(threadId);
    if (existingIncident !== undefined && existingIncident !== incidentId) {
      return { state: "refused", reason: `${threadId} already belongs to ${existingIncident}` };
    }
    const existingThread = this.#byIncident.get(incidentId);
    if (existingThread !== undefined && existingThread !== threadId) {
      return { state: "refused", reason: `${incidentId} already has thread ${existingThread}` };
    }
    this.#byThread.set(threadId, incidentId);
    this.#byIncident.set(incidentId, threadId);
    return { state: "registered" };
  }

  /** Which incident does this thread belong to? Unknown is not "probably fine". */
  resolve(threadId: string): Lookup {
    const incidentId = this.#byThread.get(threadId);
    if (incidentId === undefined) {
      // A derivable id is not a registered one. Answering from the pattern would
      // mean an unknown thread resolves to an incident nobody ever opened.
      return { state: "unknown", reason: `${threadId} was never registered` };
    }
    return { state: "found", incidentId };
  }

  get size(): number {
    return this.#byThread.size;
  }
}

/** Open a thread for an incident, or refuse. The conversation is validated here. */
export function openThread(incidentId: string, index: ThreadIndex, channelId = "fake-prod-incidents"): ThreadResult {
  const threadId = threadIdFor(incidentId);
  const registered = index.register(incidentId, threadId);
  if (registered.state === "refused") return { state: "refused", reason: registered.reason };

  const conversation = { provider: "fake-slack", channel_id: channelId, thread_id: threadId, incident_id: incidentId, messages: [] };
  const r = validate("conversation", conversation);
  if (r.state !== "valid") {
    return { state: "refused", reason: "the opened conversation does not validate", errors: r.state === "invalid" ? r.errors : [r.reason] };
  }
  return { state: "ok", conversation };
}

/**
 * Append a message to a conversation.
 *
 * The message must carry the same incident id as the thread. Stamping every
 * message is what makes a leak visible without running a model, and appending
 * one that disagrees is precisely the leak.
 */
export function appendMessage(conversation: Record<string, unknown>, message: Message): ThreadResult {
  const incidentId = conversation["incident_id"];
  if (typeof incidentId !== "string") return { state: "refused", reason: "the conversation names no incident" };
  if (message.incident_id !== incidentId) {
    return { state: "refused", reason: `message names ${message.incident_id}, thread belongs to ${incidentId}` };
  }

  const messages = Array.isArray(conversation["messages"]) ? (conversation["messages"] as unknown[]) : [];
  const next = { ...conversation, messages: [...messages, message] };
  const r = validate("conversation", next);
  if (r.state !== "valid") {
    return { state: "refused", reason: "the message would make the conversation invalid", errors: r.state === "invalid" ? r.errors : [r.reason] };
  }
  return { state: "ok", conversation: next };
}
