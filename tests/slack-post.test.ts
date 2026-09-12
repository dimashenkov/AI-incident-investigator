/**
 * Posting an incident report once: the sequential retry does not open a second
 * thread, the steps happen in the order that keeps that true, and a failure at any
 * step is reported honestly rather than claimed as success.
 *
 * This is the brick Grok chose (2026-09-12): the real Slack post, deduped by
 * incident_id. It closes the SEQUENTIAL retry only; the concurrent race is the
 * recorded SKIP-Redis limitation and is deliberately NOT tested as closed.
 */
import { describe, it, expect } from "vitest";
import { postIncidentReport, type ThreadStore, type SlackPoster } from "../src/providers/slack-post.js";

const CH = "C0C1AQLTRM4";
const INC = "INC-2026-0001";

function memStore(seed: Record<string, string> = {}): ThreadStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async tsFor(id) { return map.has(id) ? (map.get(id) as string) : null; },
    async remember(id, ts) { map.set(id, ts); },
  };
}

function countingPoster(ts = "1789193569.021859"): SlackPoster & { calls: number } {
  return {
    calls: 0,
    async post(_channel, _text) { this.calls += 1; return { ts }; },
  };
}

describe("posting an incident report once", () => {
  it("posts a new thread and records the ts", async () => {
    const store = memStore();
    const poster = countingPoster("1789.001");
    const r = await postIncidentReport(INC, "boom", CH, store, poster);
    expect(r).toEqual({ state: "posted", ts: "1789.001" });
    expect(poster.calls).toBe(1);
    expect(store.map.get(INC)).toBe("1789.001");
  });

  it("does not post a second thread for the same incident fired again", async () => {
    const store = memStore();
    const poster = countingPoster("1789.001");
    await postIncidentReport(INC, "boom", CH, store, poster);
    const again = await postIncidentReport(INC, "boom again", CH, store, poster);
    expect(again, "the sequential retry returns the existing thread").toEqual({ state: "existing", ts: "1789.001" });
    expect(poster.calls, "the model of the guarantee: one post per incident, sequentially").toBe(1);
  });

  it("looks up before it posts — an already-known incident never calls Slack", async () => {
    const store = memStore({ [INC]: "1789.seed" });
    const poster = countingPoster();
    const r = await postIncidentReport(INC, "boom", CH, store, poster);
    expect(r).toEqual({ state: "existing", ts: "1789.seed" });
    expect(poster.calls, "lookup precedes post").toBe(0);
  });

  it("refuses an empty report and a missing incident id, without posting", async () => {
    const poster = countingPoster();
    expect((await postIncidentReport(INC, "", CH, memStore(), poster)).state).toBe("error");
    expect((await postIncidentReport("", "boom", CH, memStore(), poster)).state).toBe("error");
    expect(poster.calls).toBe(0);
  });

  it("reports a Slack failure as error, and records nothing", async () => {
    const store = memStore();
    const poster: SlackPoster = { async post() { throw new Error("slack 500"); } };
    const r = await postIncidentReport(INC, "boom", CH, store, poster);
    expect(r.state).toBe("error");
    expect(r.state === "error" && r.reason).toMatch(/post failed/);
    expect(store.map.has(INC), "a failed post records no thread").toBe(false);
  });

  it("treats a post with no ts as an error, not a silent success", async () => {
    const store = memStore();
    const poster: SlackPoster = { async post() { return { ts: "" }; } };
    const r = await postIncidentReport(INC, "boom", CH, store, poster);
    expect(r.state).toBe("error");
    expect(store.map.has(INC)).toBe(false);
  });

  it("reports posted-but-not-recorded honestly, so the next run is not misled", async () => {
    /*
     * The ts came back but the store write failed. Claiming "existing" would tell
     * a later run a thread is tracked when it is not; the honest report is error,
     * and a later run posting again is the lesser evil.
     */
    const poster = countingPoster("1789.xyz");
    const store: ThreadStore = {
      async tsFor() { return null; },
      async remember() { throw new Error("data table down"); },
    };
    const r = await postIncidentReport(INC, "boom", CH, store, poster);
    expect(r.state).toBe("error");
    expect(r.state === "error" && r.reason).toMatch(/could not record/);
  });
});
