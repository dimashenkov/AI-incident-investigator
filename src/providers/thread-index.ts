/**
 * The durable thread <-> incident index: the claim wins once, it can EXPIRE
 * without becoming a second writer, and the bind stays one-to-one.
 *
 * Grok drove three rounds of this (2026-09-12). The in-memory ThreadIndex in
 * slack.ts dies with the n8n execution, so two executions of one incident both
 * post and Slack ends up with two threads. So the decision "may I open a thread"
 * is made once, atomically, in a store that outlives the execution, BEFORE the
 * visible act of posting.
 *
 * Round 1 was wrong two ways (bind was check-then-put; PENDING held a NUL byte).
 * Round 2 fixed the target races. Round 3 found what remained and set this round:
 *   - a winner that crashes between `claim` and `bind` left the slot PENDING
 *     FOREVER, so that incident could never open a thread again;
 *   - the rollback could delete a ts a concurrent same-incident binder had
 *     legitimately bound, on a network store where a delete follows an await.
 *
 * The fix is a GENERATION carried in the pending marker: `pending:<gen>:<expMs>`.
 *   - `claim` stamps gen 1 and an expiry. A later caller whose expiry has passed
 *     RECLAIMS by compare-and-swapping the marker to gen+1 — so exactly one
 *     reclaimer wins, and the stale winner (holding the old gen) can no longer
 *     bind. Expiry is a CAS on the marker, never a second write of a ts, so it
 *     cannot open a second thread.
 *   - `bind` takes the gen it was granted and checks the slot still holds that
 *     exact gen BEFORE it reserves the ts. A stale-gen bind refuses without
 *     touching anything, which is what closes the rollback hole: only the caller
 *     whose gen currently holds the slot ever reserves the ts.
 *
 * The wall, stated not hidden (Grok): the index does not reach into Slack. A
 * stale winner that was reclaimed can still send a late Slack message and orphan
 * a thread in the channel — the index will not double-bind, but it cannot un-post.
 * The poster must claim/bind with the CURRENT gen, never a `won` it cached before.
 *
 * Correctness rests on two atomic store primitives, `putIfAbsent` and
 * `compareAndSwap` (plus `compareAndDelete` for rollback), never a plain write. A
 * store whose only conditional write is upsert (an n8n Data Table) cannot back
 * this — the adapter must be checked for insert-fail-on-duplicate and a real CAS.
 */

export interface AtomicStore {
  putIfAbsent(key: string, value: string): Promise<boolean>;
  compareAndSwap(key: string, expected: string, next: string): Promise<boolean>;
  compareAndDelete(key: string, expected: string): Promise<boolean>;
  get(key: string): Promise<string | null>;
}

const incidentKey = (incidentId: string) => `incident:${incidentId}`;
const tsKey = (ts: string) => `ts:${ts}`;

/** A claimed-but-unposted slot: `pending:<gen>:<expiryMs>`. Plain ASCII, and a
 *  shape no Slack ts ("digits.digits") can equal, so it can never be mistaken for
 *  a real thread even across a store round-trip. */
function mkPending(gen: number, expiryMs: number): string {
  return `pending:${gen}:${expiryMs}`;
}
/** Parse a pending marker, or null if the value is not one (e.g. it is a real ts). */
function parsePending(value: string): { gen: number; expiryMs: number } | null {
  const m = /^pending:(\d+):(\d+)$/.exec(value);
  if (m === null) return null;
  return { gen: Number(m[1]), expiryMs: Number(m[2]) };
}
/** Exposed only so a test can assert the marker's shape without hard-coding it. */
export const isPending = (value: string): boolean => parsePending(value) !== null;

export type Claim =
  /** Won: this caller MUST be the one to post, and MUST pass `gen` to bind. */
  | { state: "won"; gen: number }
  /** Held by someone else: `ts` if the thread exists, null while mid-post/pending. */
  | { state: "held"; ts: string | null }
  | { state: "error"; reason: string };

export type Resolve =
  | { state: "found"; incidentId: string }
  | { state: "unknown"; reason: string };

export type Bind =
  | { state: "bound" }
  | { state: "refused"; reason: string };

export interface ThreadIndexOptions {
  /** Wall-clock, injected so tests can advance it. Defaults to Date.now. */
  now?: () => number;
  /** How long a claim holds before it may be reclaimed. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class DurableThreadIndex {
  #store: AtomicStore;
  #now: () => number;
  #ttlMs: number;

  constructor(store: AtomicStore, opts: ThreadIndexOptions = {}) {
    this.#store = store;
    this.#now = opts.now ?? (() => Date.now());
    this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Claim the right to open a thread for this incident, once.
   *
   * A fresh incident is claimed with `putIfAbsent` at gen 1. If the slot is
   * already held but its expiry has passed, this RECLAIMS it: compare-and-swap the
   * exact stale marker to gen+1. The compare-and-swap is what makes reclaim safe —
   * only one caller moves the marker, and the previous winner, still holding the
   * old gen, can no longer bind.
   */
  async claim(incidentId: string): Promise<Claim> {
    const key = incidentKey(incidentId);
    const fresh = mkPending(1, this.#now() + this.#ttlMs);
    try {
      if (await this.#store.putIfAbsent(key, fresh)) return { state: "won", gen: 1 };

      const cur = await this.#store.get(key);
      if (cur === null) return { state: "held", ts: null };
      const p = parsePending(cur);
      if (p === null) return { state: "held", ts: cur }; // a real ts: the thread exists
      if (this.#now() <= p.expiryMs) return { state: "held", ts: null }; // active claim

      // Expired: try to reclaim by advancing the generation.
      const next = mkPending(p.gen + 1, this.#now() + this.#ttlMs);
      if (await this.#store.compareAndSwap(key, cur, next)) {
        return { state: "won", gen: p.gen + 1 };
      }
      return { state: "held", ts: null }; // someone else reclaimed first
    } catch (e) {
      return { state: "error", reason: msg(e) };
    }
  }

  /**
   * Record the real Slack ts against an incident, for the generation that was
   * granted. Gen is checked FIRST, before the ts is reserved, so a stale claim
   * refuses without touching anything — which is what keeps a rollback from ever
   * deleting a ts a current-gen binder owns.
   */
  async bind(incidentId: string, ts: string, gen: number): Promise<Bind> {
    if (ts.length === 0 || parsePending(ts) !== null) {
      return { state: "refused", reason: "a thread ts must be a real, non-empty Slack id" };
    }
    const key = incidentKey(incidentId);

    let cur: string | null;
    try {
      cur = await this.#store.get(key);
    } catch (e) {
      return { state: "refused", reason: msg(e) };
    }
    if (cur === null) {
      return { state: "refused", reason: `${incidentId} was never claimed; bind must follow a won claim` };
    }
    if (cur === ts) return { state: "bound" }; // idempotent re-bind of the same pair
    const p = parsePending(cur);
    if (p === null) {
      return { state: "refused", reason: `${incidentId} already has thread ${cur}` };
    }
    if (p.gen !== gen) {
      return { state: "refused", reason: `claim for ${incidentId} was superseded (gen ${gen} is not ${p.gen})` };
    }

    // Our generation holds the slot. Reserve the ts — one incident per ts.
    let reserved: boolean;
    try {
      reserved = await this.#store.putIfAbsent(tsKey(ts), incidentId);
    } catch (e) {
      return { state: "refused", reason: msg(e) };
    }
    if (!reserved) {
      let owner: string | null;
      try {
        owner = await this.#store.get(tsKey(ts));
      } catch (e) {
        return { state: "refused", reason: msg(e) };
      }
      if (owner !== incidentId) {
        return { state: "refused", reason: `${ts} already belongs to ${owner}` };
      }
      // our own reservation from a retry; fall through to move the slot
    }

    // Move the slot from this exact pending marker to the ts. If it fails, the
    // slot was reclaimed in the window between the read and here — refuse and undo
    // our reservation, which is safe because no other current-gen caller exists.
    let moved: boolean;
    try {
      moved = await this.#store.compareAndSwap(key, cur, ts);
    } catch (e) {
      await this.#rollback(ts, incidentId);
      return { state: "refused", reason: msg(e) };
    }
    if (moved) return { state: "bound" };
    await this.#rollback(ts, incidentId);
    return { state: "refused", reason: `claim for ${incidentId} was reclaimed during bind` };
  }

  async #rollback(ts: string, incidentId: string): Promise<void> {
    try {
      await this.#store.compareAndDelete(tsKey(ts), incidentId);
    } catch {
      // Best effort. A stranded ts->incident row points at an incident that did
      // try to own the ts; it is inconsistent, not a cross-incident leak.
    }
  }

  /** Which incident owns this Slack thread? An unregistered ts is unknown, never
   *  a guess. */
  async resolve(ts: string): Promise<Resolve> {
    try {
      const incidentId = await this.#store.get(tsKey(ts));
      if (incidentId === null) return { state: "unknown", reason: `${ts} is not a registered thread` };
      return { state: "found", incidentId };
    } catch (e) {
      return { state: "unknown", reason: msg(e) };
    }
  }

  /** The thread already open for this incident, if any. A pending or absent slot
   *  returns null — the caller must not read that as "a thread exists". */
  async tsForIncident(incidentId: string): Promise<string | null> {
    const cur = await this.#store.get(incidentKey(incidentId));
    if (cur === null || parsePending(cur) !== null) return null;
    return cur;
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * An in-memory store for tests and single-process local runs. The conditional
 * methods are atomic only because JavaScript runs one turn at a time and none of
 * them awaits between reading and writing — the very property the first `bind`
 * broke. A Map dies with the process, so this is NOT the durability the deployed
 * workflow needs; the n8n Data Table adapter is, and it must offer the same
 * atomicity or the guarantees here are a fiction. This is its test double.
 */
export class MemoryStore implements AtomicStore {
  #m = new Map<string, string>();

  async putIfAbsent(key: string, value: string): Promise<boolean> {
    if (this.#m.has(key)) return false;
    this.#m.set(key, value);
    return true;
  }
  async compareAndSwap(key: string, expected: string, next: string): Promise<boolean> {
    if (this.#m.get(key) !== expected) return false;
    this.#m.set(key, next);
    return true;
  }
  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    if (this.#m.get(key) !== expected) return false;
    this.#m.delete(key);
    return true;
  }
  async get(key: string): Promise<string | null> {
    return this.#m.has(key) ? (this.#m.get(key) as string) : null;
  }
}
