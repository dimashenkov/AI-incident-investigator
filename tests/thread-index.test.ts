/**
 * The durable thread <-> incident index: the claim wins once, the bind keeps the
 * link one-to-one, and "could not check" never reads as "free to post".
 *
 * These are the guarantees Grok said to build and prove BEFORE any Slack post
 * (2026-09-12): without them two executions of one incident open two threads, and
 * an inbound reply resolves to an incident nobody opened.
 */
import { describe, it, expect } from "vitest";
import {
  DurableThreadIndex,
  MemoryStore,
  PENDING,
  type AtomicStore,
} from "../src/providers/thread-index.js";

const INC = "INC-2026-0001";
const OTHER = "INC-2026-0002";
const TS = "1789193569.021859";

describe("claiming the right to open a thread happens once", () => {
  it("gives the first caller 'won' and every later caller 'held'", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    const first = await idx.claim(INC);
    expect(first.state).toBe("won");

    const second = await idx.claim(INC);
    // A second attempt must never win — winning is what licenses a post.
    expect(second).toEqual({ state: "held", ts: null });
  });

  it("lets exactly one of many concurrent claims win", async () => {
    /*
     * The race itself. With an atomic putIfAbsent, five callers racing for one
     * incident must produce one winner and four losers — never zero (nobody
     * posts) and never two (two threads). This is the single property the whole
     * design rests on; if MemoryStore's putIfAbsent were not atomic this would
     * flake, which is the point.
     */
    const idx = new DurableThreadIndex(new MemoryStore());
    const results = await Promise.all(
      Array.from({ length: 5 }, () => idx.claim(INC)),
    );
    const winners = results.filter((r) => r.state === "won");
    expect(winners.length, "exactly one caller may post").toBe(1);
    expect(results.filter((r) => r.state === "held").length).toBe(4);
  });

  it("is idempotent once the thread exists: a re-claim returns the ts, not 'won'", async () => {
    /*
     * dod-7's durability at the real level: after the thread is open, asking
     * again returns WHERE it is, so nothing posts a second time. A design that
     * returned 'won' here would repost on every retry.
     */
    const idx = new DurableThreadIndex(new MemoryStore());
    await idx.claim(INC);
    expect((await idx.bind(INC, TS)).state).toBe("bound");

    const again = await idx.claim(INC);
    expect(again).toEqual({ state: "held", ts: TS });
  });
});

describe("binding the real ts keeps the link one-to-one", () => {
  it("binds a claimed incident to its ts and resolves both ways", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    await idx.claim(INC);
    expect((await idx.bind(INC, TS)).state).toBe("bound");

    expect(await idx.resolve(TS)).toEqual({ state: "found", incidentId: INC });
    expect(await idx.tsForIncident(INC)).toBe(TS);
  });

  it("refuses a ts that already belongs to another incident", async () => {
    /*
     * The cross-incident leak Grok named: a reply carrying a foreign ts must not
     * be able to attach that ts to a second incident. One thread, one incident.
     */
    const idx = new DurableThreadIndex(new MemoryStore());
    await idx.claim(INC);
    await idx.bind(INC, TS);

    await idx.claim(OTHER);
    const r = await idx.bind(OTHER, TS);
    expect(r.state).toBe("refused");
    expect(r.state === "refused" && r.reason).toMatch(/already belongs to/);
  });

  it("refuses to re-bind an incident to a different ts", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    await idx.claim(INC);
    await idx.bind(INC, TS);

    const r = await idx.bind(INC, "9999999999.000000");
    expect(r.state).toBe("refused");
    expect(r.state === "refused" && r.reason).toMatch(/already has thread/);
  });

  it("refuses to bind a ts onto an incident nobody claimed", async () => {
    /*
     * A post that skipped `claim` must not be able to write the index — that is
     * the path that would let the race protection be bypassed entirely.
     */
    const idx = new DurableThreadIndex(new MemoryStore());
    const r = await idx.bind(INC, TS);
    expect(r.state).toBe("refused");
    expect(r.state === "refused" && r.reason).toMatch(/never claimed/);
  });

  it("refuses a pending marker or an empty string as a ts", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    await idx.claim(INC);
    for (const bad of [PENDING, ""]) {
      const r = await idx.bind(INC, bad);
      expect(r.state, `"${bad}" is not a real ts`).toBe("refused");
    }
  });
});

describe("an unknown thread is answered as unknown, never guessed", () => {
  it("resolves an unregistered ts to unknown", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    const r = await idx.resolve("0000000000.000000");
    expect(r.state).toBe("unknown");
  });

  it("reports no ts for an incident that only ever claimed, never bound", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    await idx.claim(INC);
    // Claimed but mid-post: there is no thread yet, and saying there is one would
    // be the absence-as-consent defect one layer over.
    expect(await idx.tsForIncident(INC)).toBeNull();
  });
});

describe("a store that cannot answer is not a licence to act", () => {
  /*
   * "Could not check" and "checked, it is free" are different answers with
   * different consequences. A failing store must make claim error (not win),
   * bind refuse, and resolve unknown — never the reading that lets a post or a
   * reply through on a shrug.
   */
  const broken: AtomicStore = {
    putIfAbsent: async () => { throw new Error("store down"); },
    get: async () => { throw new Error("store down"); },
    put: async () => { throw new Error("store down"); },
  };

  it("makes claim error rather than won when the store throws", async () => {
    const idx = new DurableThreadIndex(broken);
    const r = await idx.claim(INC);
    expect(r.state).toBe("error");
    expect(r.state !== "won").toBe(true);
  });

  it("refuses bind and returns unknown from resolve when the store throws", async () => {
    const idx = new DurableThreadIndex(broken);
    expect((await idx.bind(INC, TS)).state).toBe("refused");
    expect((await idx.resolve(TS)).state).toBe("unknown");
  });
});
