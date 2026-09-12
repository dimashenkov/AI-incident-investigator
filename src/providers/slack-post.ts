/**
 * Posting an incident report to a real Slack channel, once per incident.
 *
 * Grok chose this brick (2026-09-12, "B, not A"): the prototype already
 * investigates; what is missing is the visible result — a report in the real
 * #incidents from a live run. The simulated thread in slack.ts is a rehearsal
 * log; this is the real post.
 *
 * This file is the CONTRACT and the algorithm, testable on its own. The deployed
 * n8n workflow reimplements the same shape in nodes (a Data Table lookup, an HTTP
 * chat.postMessage, a Data Table write of the returned ts), because a Code node
 * cannot reach a Data Table and the generated workflow carries no imports. Keeping
 * the algorithm here, with a test, is what stops the node version from quietly
 * drifting into something that double-posts.
 *
 * What it deliberately does NOT do: it is NOT a compare-and-swap. The lookup and
 * the post are two steps with a gap, and n8n Cloud runs webhooks concurrently
 * (measured 2026-09-12), so two SIMULTANEOUS runs of one incident can still both
 * find "no thread" and both post. That race is a recorded LIMITATION (SKIP Redis,
 * CLAUDE.md §13). This closes the SEQUENTIAL retry — the same incident fired
 * again after the first finished — which is the common case, and it does not
 * pretend to close the concurrent one.
 */

/** Where the incident -> thread ts mapping lives. A plain durable dictionary
 *  (the n8n Data Table in the deployed path), NOT an atomic store. */
export interface ThreadStore {
  /** The Slack ts already recorded for this incident, or null. */
  tsFor(incidentId: string): Promise<string | null>;
  /** Record the ts a post returned. Called only after a successful post. */
  remember(incidentId: string, ts: string): Promise<void>;
}

/** The one Slack call this needs: post a message, get back the thread ts. */
export interface SlackPoster {
  post(channel: string, text: string): Promise<{ ts: string }>;
}

export type PostResult =
  /** A new thread was opened; `ts` is Slack's. */
  | { state: "posted"; ts: string }
  /** A thread already existed for this incident; nothing was posted again. */
  | { state: "existing"; ts: string }
  /** The lookup, the post, or the write failed. Nothing is claimed about Slack. */
  | { state: "error"; reason: string };

/**
 * Post the report for an incident, or return the thread that already exists.
 *
 * Order matters and is the honest half of the sequential guarantee: look up
 * FIRST; only post if nothing is recorded; write the ts only AFTER the post
 * returned it. A post that succeeds but whose ts fails to record is reported as
 * an error, not as "existing" — the next run would then post again, which is the
 * lesser evil over silently claiming a thread the store does not know.
 */
export async function postIncidentReport(
  incidentId: string,
  text: string,
  channel: string,
  store: ThreadStore,
  poster: SlackPoster,
): Promise<PostResult> {
  if (!incidentId) return { state: "error", reason: "no incident id to key the thread on" };
  if (!text) return { state: "error", reason: "refusing to post an empty report" };

  let existing: string | null;
  try {
    existing = await store.tsFor(incidentId);
  } catch (e) {
    return { state: "error", reason: `could not look up the thread: ${msg(e)}` };
  }
  if (existing) return { state: "existing", ts: existing };

  let posted: { ts: string };
  try {
    posted = await poster.post(channel, text);
  } catch (e) {
    return { state: "error", reason: `the Slack post failed: ${msg(e)}` };
  }
  if (!posted || typeof posted.ts !== "string" || posted.ts.length === 0) {
    return { state: "error", reason: "the Slack post returned no thread ts" };
  }

  try {
    await store.remember(incidentId, posted.ts);
  } catch (e) {
    // Posted but not recorded: report it honestly. A later run will not find the
    // ts and may post again — worse than a lie the other way would be, which is
    // claiming a thread the store cannot produce.
    return { state: "error", reason: `posted ${posted.ts} but could not record it: ${msg(e)}` };
  }
  return { state: "posted", ts: posted.ts };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
