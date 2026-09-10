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

/*
 * Two states, and there were three.
 *
 * `ambiguous` was declared and nothing ever built one: `ThreadIndex` holds one
 * incident per thread and refuses a collision when the thread is registered, so
 * `resolve` returns only `found` or `unknown`. Nothing narrowed on the third
 * either — no consumer imports `Lookup`, and no exhaustiveness check covered
 * it. A declared state that no input produces is the appearance of a
 * capability, which is the defect this repository keeps finding.
 * Codex agreed on 2026-09-10: delete, it changes no behaviour.
 */
export type Lookup =
  | { state: "found"; incidentId: string }
  | { state: "unknown"; reason: string };

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

/*
 * appendMessage moved to src/core/thread.ts on 2026-09-07 and is re-exported
 * here so every existing caller keeps working. It went because the thread has
 * to be buildable inside the n8n Code node, and a file the node carries may not
 * import anything — the same reason merge.ts sits apart from assemble.ts.
 */
export { appendMessage } from "../core/report.js";
