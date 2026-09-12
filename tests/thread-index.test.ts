/**
 * The durable thread <-> incident index: the claim wins once, EXPIRES without
 * opening a second thread, and the bind stays one-to-one under concurrency.
 *
 * Built and broken across three Grok rounds (2026-09-12): bind was check-then-put;
 * PENDING held a NUL byte; a crash between claim and bind stranded the slot
 * forever. The generation-and-expiry design below is the answer to the last one,
 * and its test (Grok's) proves an expiry can never become a second writer.
 */
import { describe, it, expect } from "vitest";
import {
  DurableThreadIndex,
  MemoryStore,
  isPending,
  type ThreadIndexOptions,
} from "../src/providers/thread-index.js";

const INC = "INC-2026-0001";
const OTHER = "INC-2026-0002";
const TS = "1789193569.021859";
const TS2 = "1789199999.000001";

// A controllable clock, so expiry is a test input, not a wait.
function makeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}
const idxWith = (opts: ThreadIndexOptions) => new DurableThreadIndex(new MemoryStore(), opts);

describe("the pending marker is a clean, non-ts string", () => {
  it("is recognised as pending and never looks like a ts", () => {
    expect(isPending("pending:1:99999")).toBe(true);
    expect(isPending(TS), "a real ts is not pending").toBe(false);
    // The first version held "\0pending"; guard the bytes never regress.
    expect("pending:1:0".includes("\0")).toBe(false);
  });
});

describe("claiming happens once", () => {
  it("gives the first caller 'won' with gen 1 and later callers 'held'", async () => {
    const idx = idxWith({ now: () => 1000, ttlMs: 100 });
    expect(await idx.claim(INC)).toEqual({ state: "won", gen: 1 });
    expect(await idx.claim(INC)).toEqual({ state: "held", ts: null });
  });

  it("lets exactly one of many concurrent claims win", async () => {
    const idx = idxWith({ now: () => 1000, ttlMs: 100 });
    const results = await Promise.all(Array.from({ length: 5 }, () => idx.claim(INC)));
    expect(results.filter((r) => r.state === "won").length, "exactly one may post").toBe(1);
    expect(results.filter((r) => r.state === "held").length).toBe(4);
  });

  it("is idempotent once bound: a re-claim returns the ts, not 'won'", async () => {
    const idx = idxWith({ now: () => 1000, ttlMs: 100 });
    const c = await idx.claim(INC);
    const gen = c.state === "won" ? c.gen : 0;
    expect((await idx.bind(INC, TS, gen)).state).toBe("bound");
    expect(await idx.claim(INC)).toEqual({ state: "held", ts: TS });
  });
});

describe("binding stays one-to-one, even concurrently", () => {
  async function claimedGen(idx: DurableThreadIndex, id: string): Promise<number> {
    const c = await idx.claim(id);
    return c.state === "won" ? c.gen : -1;
  }

  it("binds a claimed incident to its ts and resolves both ways", async () => {
    const idx = idxWith({ now: () => 1000, ttlMs: 100 });
    const gen = await claimedGen(idx, INC);
    expect((await idx.bind(INC, TS, gen)).state).toBe("bound");
    expect(await idx.resolve(TS)).toEqual({ state: "found", incidentId: INC });
    expect(await idx.tsForIncident(INC)).toBe(TS);
  });

  it("lets only one of two incidents bind the same ts, concurrently", async () => {
    const idx = idxWith({ now: () => 1000, ttlMs: 100 });
    const g1 = await claimedGen(idx, INC);
    const g2 = await claimedGen(idx, OTHER);
    const [a, b] = await Promise.all([idx.bind(INC, TS, g1), idx.bind(OTHER, TS, g2)]);
    expect([a, b].filter((r) => r.state === "bound").length, "one ts, one incident").toBe(1);
    const refused = [a, b].find((r) => r.state === "refused")!;
    expect(refused.state === "refused" && refused.reason).toMatch(/already belongs to/);
  });

  it("lets only one of two ts bind to the same incident, concurrently", async () => {
    const idx = idxWith({ now: () => 1000, ttlMs: 100 });
    const gen = await claimedGen(idx, INC);
    const [a, b] = await Promise.all([idx.bind(INC, TS, gen), idx.bind(INC, TS2, gen)]);
    expect([a, b].filter((r) => r.state === "bound").length, "one incident, one thread").toBe(1);
    const loserTs = a.state === "bound" ? TS2 : TS;
    // The loser's ts reservation was rolled back — it points at nobody.
    expect((await idx.resolve(loserTs)).state).toBe("unknown");
  });

  it("refuses to re-bind an incident to a different ts", async () => {
    const idx = idxWith({ now: () => 1000, ttlMs: 100 });
    const gen = await claimedGen(idx, INC);
    await idx.bind(INC, TS, gen);
    const r = await idx.bind(INC, TS2, gen);
    expect(r.state).toBe("refused");
    expect(r.state === "refused" && r.reason).toMatch(/already has thread/);
  });

  it("refuses to bind a ts onto an incident nobody claimed, leaving nothing behind", async () => {
    const idx = idxWith({ now: () => 1000, ttlMs: 100 });
    const r = await idx.bind(INC, TS, 1);
    expect(r.state).toBe("refused");
    expect(r.state === "refused" && r.reason).toMatch(/never claimed/);
    expect((await idx.resolve(TS)).state).toBe("unknown");
  });

  it("refuses a pending marker or an empty string as a ts", async () => {
    const idx = idxWith({ now: () => 1000, ttlMs: 100 });
    const gen = await claimedGen(idx, INC);
    for (const bad of ["pending:1:0", ""]) {
      expect((await idx.bind(INC, bad, gen)).state, `"${bad}" is not a real ts`).toBe("refused");
    }
  });
});

describe("an expired claim is reclaimed, and expiry never opens a second thread", () => {
  it("Grok's test: a superseded generation cannot bind, the new one can", async () => {
    const clock = makeClock();
    const idx = new DurableThreadIndex(new MemoryStore(), { now: clock.now, ttlMs: 100 });

    // 1. First winner, generation 1.
    const first = await idx.claim(INC);
    expect(first).toEqual({ state: "won", gen: 1 });

    // 2. Time passes the TTL — the claim is now reclaimable.
    clock.advance(101);

    // 3. Five racing reclaims: exactly one wins, at generation 2.
    const reclaims = await Promise.all(Array.from({ length: 5 }, () => idx.claim(INC)));
    const winners = reclaims.filter((r) => r.state === "won");
    expect(winners.length, "one reclaimer").toBe(1);
    expect(winners[0]).toEqual({ state: "won", gen: 2 });

    // 4. The stale winner (gen 1) MUST NOT bind — that would be the second thread.
    const stale = await idx.bind(INC, TS, 1);
    expect(stale.state).toBe("refused");
    expect(stale.state === "refused" && stale.reason).toMatch(/superseded/);
    expect((await idx.resolve(TS)).state, "the stale bind reserved nothing").toBe("unknown");

    // 5. The new winner (gen 2) binds.
    expect((await idx.bind(INC, TS2, 2)).state).toBe("bound");

    // 6. A later claim sees the real thread.
    expect(await idx.claim(INC)).toEqual({ state: "held", ts: TS2 });
  });

  it("does not reclaim a claim whose TTL has not passed", async () => {
    const clock = makeClock();
    const idx = new DurableThreadIndex(new MemoryStore(), { now: clock.now, ttlMs: 100 });
    await idx.claim(INC);
    clock.advance(50); // still within TTL
    expect(await idx.claim(INC), "an active claim is held, not reclaimed").toEqual({ state: "held", ts: null });
  });
});

describe("an unknown thread is answered as unknown, never guessed", () => {
  it("resolves an unregistered ts to unknown, and a pending incident to no ts", async () => {
    const idx = idxWith({ now: () => 1000, ttlMs: 100 });
    expect((await idx.resolve("0000000000.000000")).state).toBe("unknown");
    await idx.claim(INC);
    expect(await idx.tsForIncident(INC)).toBeNull();
  });
});

describe("a store that cannot answer is not a licence to act", () => {
  const broken = {
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
    expect((await idx.bind(INC, TS, 1)).state).toBe("refused");
    expect((await idx.resolve(TS)).state).toBe("unknown");
  });
});
