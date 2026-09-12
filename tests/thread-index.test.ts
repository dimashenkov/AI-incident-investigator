/**
 * The durable thread <-> incident index: the claim wins once, the bind stays
 * one-to-one under concurrency, and "could not check" never reads as "free to act".
 *
 * These are the guarantees Grok said to build and prove BEFORE any Slack post
 * (2026-09-12), and the two he then caught missing on the first version: `bind`
 * was check-then-put, so two binds could collide (200/200 repro), and the PENDING
 * marker carried a NUL byte. Both are covered here now.
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
const TS2 = "1789199999.000001";

describe("the PENDING marker is a clean, non-ts string", () => {
  it("carries no NUL byte and cannot be mistaken for a ts", () => {
    // The first version held "\0pending"; a store that strips NUL would turn it
    // into a value that reads like a real thread. Guard the bytes directly.
    expect(PENDING.includes("\0"), "PENDING must not contain a NUL byte").toBe(false);
    expect(/^\d+\.\d+$/.test(PENDING), "PENDING must not look like a Slack ts").toBe(false);
  });
});

describe("claiming the right to open a thread happens once", () => {
  it("gives the first caller 'won' and every later caller 'held'", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    expect((await idx.claim(INC)).state).toBe("won");
    expect(await idx.claim(INC)).toEqual({ state: "held", ts: null });
  });

  it("lets exactly one of many concurrent claims win", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    const results = await Promise.all(Array.from({ length: 5 }, () => idx.claim(INC)));
    expect(results.filter((r) => r.state === "won").length, "exactly one may post").toBe(1);
    expect(results.filter((r) => r.state === "held").length).toBe(4);
  });

  it("is idempotent once the thread exists: a re-claim returns the ts, not 'won'", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    await idx.claim(INC);
    expect((await idx.bind(INC, TS)).state).toBe("bound");
    expect(await idx.claim(INC)).toEqual({ state: "held", ts: TS });
  });
});

describe("binding the real ts stays one-to-one, even concurrently", () => {
  it("binds a claimed incident to its ts and resolves both ways", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    await idx.claim(INC);
    expect((await idx.bind(INC, TS)).state).toBe("bound");
    expect(await idx.resolve(TS)).toEqual({ state: "found", incidentId: INC });
    expect(await idx.tsForIncident(INC)).toBe(TS);
  });

  it("lets only one of two incidents bind the same ts, concurrently", async () => {
    /*
     * The race Grok reproduced 200/200 against check-then-put: two incidents
     * binding one ts. With ts reserved by putIfAbsent, exactly one wins and the
     * other is refused — the cross-incident link the index exists to forbid.
     */
    const idx = new DurableThreadIndex(new MemoryStore());
    await idx.claim(INC);
    await idx.claim(OTHER);
    const [a, b] = await Promise.all([idx.bind(INC, TS), idx.bind(OTHER, TS)]);
    const bound = [a, b].filter((r) => r.state === "bound");
    const refused = [a, b].filter((r) => r.state === "refused");
    expect(bound.length, "one ts, one incident").toBe(1);
    expect(refused.length).toBe(1);
    const only = refused[0]!;
    expect(only.state === "refused" && only.reason).toMatch(/already belongs to/);
    // And the winner is the one resolve points at.
    const winner = a.state === "bound" ? INC : OTHER;
    expect(await idx.resolve(TS)).toEqual({ state: "found", incidentId: winner });
  });

  it("lets only one of two ts bind to the same incident, concurrently", async () => {
    /*
     * The other direction: one incident, two ts racing. Only the compareAndSwap
     * from PENDING succeeds; the loser is refused and its ts reservation is rolled
     * back, so it does not strand a ts pointing at this incident.
     */
    const idx = new DurableThreadIndex(new MemoryStore());
    await idx.claim(INC);
    const [a, b] = await Promise.all([idx.bind(INC, TS), idx.bind(INC, TS2)]);
    expect([a, b].filter((r) => r.state === "bound").length, "one incident, one thread").toBe(1);
    expect([a, b].filter((r) => r.state === "refused").length).toBe(1);

    const winnerTs = a.state === "bound" ? TS : TS2;
    const loserTs = a.state === "bound" ? TS2 : TS;
    expect(await idx.tsForIncident(INC)).toBe(winnerTs);
    // The loser's ts reservation was rolled back — it points at nobody.
    expect((await idx.resolve(loserTs)).state).toBe("unknown");
  });

  it("re-binding the exact same pair is idempotent", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    await idx.claim(INC);
    expect((await idx.bind(INC, TS)).state).toBe("bound");
    expect((await idx.bind(INC, TS)).state, "same pair again is not a second thread").toBe("bound");
  });

  it("refuses to re-bind an incident to a different ts", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    await idx.claim(INC);
    await idx.bind(INC, TS);
    const r = await idx.bind(INC, TS2);
    expect(r.state).toBe("refused");
    expect(r.state === "refused" && r.reason).toMatch(/already has thread/);
  });

  it("refuses to bind a ts onto an incident nobody claimed", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    const r = await idx.bind(INC, TS);
    expect(r.state).toBe("refused");
    expect(r.state === "refused" && r.reason).toMatch(/never claimed/);
    // A refused bind leaves nothing behind — the ts reservation was rolled back.
    expect((await idx.resolve(TS)).state).toBe("unknown");
  });

  it("refuses a pending marker or an empty string as a ts", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    await idx.claim(INC);
    for (const bad of [PENDING, ""]) {
      expect((await idx.bind(INC, bad)).state, `"${bad}" is not a real ts`).toBe("refused");
    }
  });
});

describe("an unknown thread is answered as unknown, never guessed", () => {
  it("resolves an unregistered ts to unknown", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    expect((await idx.resolve("0000000000.000000")).state).toBe("unknown");
  });

  it("reports no ts for an incident that only claimed, never bound", async () => {
    const idx = new DurableThreadIndex(new MemoryStore());
    await idx.claim(INC);
    expect(await idx.tsForIncident(INC)).toBeNull();
  });
});

describe("a store that cannot answer is not a licence to act", () => {
  const broken: AtomicStore = {
    putIfAbsent: async () => { throw new Error("store down"); },
    compareAndSwap: async () => { throw new Error("store down"); },
    compareAndDelete: async () => { throw new Error("store down"); },
    get: async () => { throw new Error("store down"); },
  };

  it("makes claim error rather than won when the store throws", async () => {
    const r = await new DurableThreadIndex(broken).claim(INC);
    expect(r.state).toBe("error");
    expect(r.state !== "won").toBe(true);
  });

  it("refuses bind and returns unknown from resolve when the store throws", async () => {
    const idx = new DurableThreadIndex(broken);
    expect((await idx.bind(INC, TS)).state).toBe("refused");
    expect((await idx.resolve(TS)).state).toBe("unknown");
  });
});
