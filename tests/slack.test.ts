/**
 * One thread, one incident, in both directions.
 *
 * Two of the ten uncovered items Codex listed on the plan live here: "Exact
 * one-to-one thread/incident invariants, including unknown and duplicate thread
 * IDs" and "The created Slack thread is durably linked, not merely returned."
 * Both describe the same failure — a thread that cannot be found again, or that
 * is found and belongs to somebody else.
 */
import { describe, it, expect } from "vitest";
import { ThreadIndex, openThread, appendMessage, threadIdFor } from "../src/providers/slack.js";

const A = "INC-2026-0001";
const B = "INC-2026-0002";
const msg = (incidentId: string, over: Partial<{ text: string; role: "user" | "agent" | "system" }> = {}) => ({
  role: over.role ?? ("user" as const), text: over.text ?? "why did it fail?",
  ts: "2026-09-04T10:31:00Z", incident_id: incidentId,
});

describe("a thread belongs to exactly one incident", () => {
  it("opens a thread and links it durably, not merely returns it", () => {
    // Returning a derived id proves nothing: it could be recomputed forever
    // without the thread ever having been recorded.
    const index = new ThreadIndex();
    const r = openThread(A, index);
    expect(r.state).toBe("ok");
    expect(index.resolve(threadIdFor(A))).toEqual({ state: "found", incidentId: A });
  });

  it("refuses a thread id that is not derived from the incident claiming it", () => {
    // With derivation injective this is the check that fires — two incidents
    // cannot produce one thread id, so the collision never reaches the index.
    const index = new ThreadIndex();
    openThread(A, index);
    const r = index.register(B, threadIdFor(A));
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("is not derived from");
  });

  it("still refuses a collision if the derivation ever stops being injective", () => {
    // The property that makes the check above sufficient lives in ANOTHER
    // function. If someone changes it so two incidents share a thread id, the
    // index must refuse rather than absorb the collision silently. Injecting a
    // colliding derivation is how that branch is reached at all.
    const collide = () => "thread-INC-2026-0001";
    const index = new ThreadIndex();
    expect(index.register(A, "thread-INC-2026-0001", collide).state).toBe("registered");
    const r = index.register(B, "thread-INC-2026-0001", collide);
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("already belongs to");
  });

  it("refuses a second thread for an incident that already has one", () => {
    // Checking one direction leaves the other free to break, so both are checked.
    const index = new ThreadIndex();
    openThread(A, index);
    const r = index.register(A, "thread-INC-2026-0009");
    expect(r.state).toBe("refused");
  });

  it("refuses the reverse collision too, under a derivation that allows it", () => {
    // Codex, chunk 2: the test above is rejected by the derivation check before
    // it reaches the reverse-index branch, so that direction was untested. A
    // derivation that hands one incident two different thread ids reaches it.
    const index = new ThreadIndex();
    let call = 0;
    const shifting = () => (call++ === 0 ? "thread-INC-2026-0001" : "thread-INC-2026-0002");
    expect(index.register(A, "thread-INC-2026-0001", shifting).state).toBe("registered");
    const r = index.register(A, "thread-INC-2026-0002", shifting);
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("already has thread");
  });

  it("is idempotent: opening the same thread twice is not a duplicate", () => {
    const index = new ThreadIndex();
    expect(openThread(A, index).state).toBe("ok");
    expect(openThread(A, index).state).toBe("ok");
    expect(index.size).toBe(1);
  });

  it("refuses a thread id not derived from its incident", () => {
    const index = new ThreadIndex();
    expect(index.register(A, "thread-42").state).toBe("refused");
  });
});

describe("an unknown thread is unknown, not assumed", () => {
  it("does not resolve a thread that was never registered, even though the id is derivable", () => {
    // The dangerous answer: computing the incident from the pattern. An unknown
    // thread would then resolve to an incident nobody ever opened.
    const index = new ThreadIndex();
    const r = index.resolve(threadIdFor(A));
    expect(r.state).toBe("unknown");
  });

  it("does not resolve a thread whose shape is right but which belongs to nobody", () => {
    const index = new ThreadIndex();
    openThread(A, index);
    expect(index.resolve("thread-INC-2026-0009").state).toBe("unknown");
  });

  it("keeps two incidents apart", () => {
    const index = new ThreadIndex();
    openThread(A, index);
    openThread(B, index);
    expect(index.resolve(threadIdFor(A))).toEqual({ state: "found", incidentId: A });
    expect(index.resolve(threadIdFor(B))).toEqual({ state: "found", incidentId: B });
    expect(index.size).toBe(2);
  });
});

describe("a message cannot carry another incident's id", () => {
  const conversation = () => {
    const r = openThread(A, new ThreadIndex());
    if (r.state !== "ok") throw new Error("thread did not open");
    return r.conversation;
  };

  it("appends a message stamped with its own incident", () => {
    const r = appendMessage(conversation(), msg(A));
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect((r.conversation.messages as unknown[])).toHaveLength(1);
  });

  it("refuses a message stamped with another incident", () => {
    // This is the leak, and it is visible without running a model.
    const r = appendMessage(conversation(), msg(B));
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("thread belongs to");
  });

  it("refuses an agent message that cites nothing", () => {
    // The schema requires cited_evidence on an agent message. An uncited answer
    // passing the citation check is the check meaning nothing.
    const r = appendMessage(conversation(), msg(A, { role: "agent", text: "it was OOM" }));
    expect(r.state).toBe("refused");
  });

  it("accepts an agent message that cites this incident's evidence", () => {
    const r = appendMessage(conversation(), { ...msg(A, { role: "agent", text: "it was OOM" }), cited_evidence: [{ source: "kubernetes", fact: "OOMKilled" }] });
    expect(r.state).toBe("ok");
  });

  it("does not mutate the conversation it was given", () => {
    const c = conversation();
    appendMessage(c, msg(A));
    expect((c.messages as unknown[])).toHaveLength(0);
  });
});
