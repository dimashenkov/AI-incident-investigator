/**
 * A human judging whether the cause was right.
 *
 * The only signal here that distinguishes a right answer from a well-formed
 * one — so a weak test means the project cannot tell improvement from
 * regression. A triple review on 2026-09-05 found most of the first version's
 * tests weaker than their names, and one design defect worse than any of them:
 * the instrument paid the reviewer for the wrong label.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reviewVerdict, summarise, versionStamp, reviewId, citedRefs, readLog, appendToLog,
  type Review, type Judgement,
} from "../src/core/review.js";
import { assembleIncident, concludeIncident, recordAgentResult } from "../src/core/assemble.js";
import { validate } from "../src/schema/validate.js";

const SC = new URL("../scenarios/", import.meta.url).pathname;
const MODEL = { name: "gpt-4o-mini", temperature: 0 };
const V = versionStamp(MODEL)!;
const AT = "2026-09-05T14:20:00Z";

function diagnosed() {
  const a = assembleIncident("container-oom", 1, { root: SC });
  if (a.state !== "assembled") throw new Error("x");
  const k = recordAgentResult(a.incident, { agent: "kubernetes", status: "ok",
    findings: [{ fact: "OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
    hypotheses: [], confidence: 0.8 });
  if (k.state !== "recorded") throw new Error(k.reason);
  const v = recordAgentResult(k.incident, { agent: "root_cause", status: "ok",
    findings: [{ fact: "OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
    hypotheses: [{ code: "CONTAINER_OOM", statement: "memory", supported_by: ["pods[0].containers[0].last_state.terminated.reason"] }],
    confidence: 0.9 });
  if (v.state !== "recorded") throw new Error(v.reason);
  const c = concludeIncident(v.incident);
  if (c.state !== "concluded") throw new Error(c.reason);
  return c.incident;
}

const judge = (over: Partial<Judgement> = {}): Judgement => ({
  incident_id: "INC-2026-0101", reviewed_at: AT, reviewer: "dimitar",
  verdict_was: "correct", proposed_code: "CONTAINER_OOM", proposed_confidence: 0.9, ...over,
});

/** Record through the real path, keeping what was written. */
const record = (incident: Record<string, unknown>, j: Judgement, stamp = V) => {
  const lines: string[] = [];
  const out = reviewVerdict(incident, j, (l) => lines.push(l), stamp);
  return { out, lines };
};

/** A stored review, for feeding the summary rows that really could exist. */
const stored = (over: Partial<Review> = {}): Review => {
  const base = { ...judge(), ...V, ...over } as Omit<Review, "review_id">;
  return { ...base, review_id: over.review_id ?? reviewId(base) } as Review;
};

describe("a review judges what was actually shown", () => {
  it("writes exactly what it recorded, not merely a line", () => {
    // The first version asserted lines.length === 1 and never read the line.
    const { out, lines } = record(diagnosed(), judge());
    expect(out.state, out.state === "refused" ? `${out.reason} ${JSON.stringify(out.errors)}` : "").toBe("recorded");
    if (out.state !== "recorded") return;
    expect(lines).toHaveLength(1);
    const written = JSON.parse(lines[0]!) as Review;
    expect(written).toEqual(out.review);
    expect(written.incident_id).toBe("INC-2026-0101");
    expect(written.proposed_code).toBe("CONTAINER_OOM");
    expect(written.reviewer).toBe("dimitar");
    expect(written.prompt_sha).toBe(V.prompt_sha);
    expect(written.review_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("round-trips through a real log file", () => {
    // readLog was only ever called on a missing path, so an always-empty reader
    // would have passed. This is the only persistence of the only signal.
    const dir = mkdtempSync(join(tmpdir(), "reviews-"));
    const path = join(dir, "reviews.jsonl");
    const out = reviewVerdict(diagnosed(), judge(), appendToLog(path), V);
    expect(out.state).toBe("recorded");
    const back = readLog(path);
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(out.state === "recorded" ? out.review : null);
  });

  it("writes nothing at all when it refuses", () => {
    // Refusal exists so a bad review never becomes a measurement. A recorder
    // that appended first and rejected after would have passed before.
    for (const bad of [
      judge({ incident_id: "INC-2026-0999" }),
      judge({ proposed_code: "CPU_THROTTLING" }),
      judge({ verdict_was: "wrong" }),
    ]) {
      const { out, lines } = record(diagnosed(), bad);
      expect(out.state, `${JSON.stringify(bad)} was recorded`).toBe("refused");
      expect(lines, "a refused review reached the log").toEqual([]);
    }
  });

  it("refuses a review of an investigation that reached no verdict", () => {
    const a = assembleIncident("container-oom", 1, { root: SC });
    if (a.state !== "assembled") throw new Error("x");
    const { out } = record(a.incident, judge({ proposed_code: null }));
    expect(out.state).toBe("refused");
    if (out.state !== "refused") return;
    expect(out.reason).toContain("no verdict to review yet");
  });

  it("refuses a review that disagrees about what the system proposed", () => {
    const { out } = record(diagnosed(), judge({ proposed_code: "CPU_THROTTLING" }));
    expect(out.state).toBe("refused");
    if (out.state !== "refused") return;
    expect(out.reason).toContain("the incident says");
  });

  it("names the reason it refuses a different incident", () => {
    const { out } = record(diagnosed(), judge({ incident_id: "INC-2026-0999" }));
    expect(out.state).toBe("refused");
    if (out.state !== "refused") return;
    expect(out.reason).toContain("INC-2026-0999");
  });

  it("refuses to store anything when the version cannot be determined", () => {
    // A review of an unidentified system measures nothing.
    const { out, lines } = record(diagnosed(), judge(), null as never);
    expect(out.state).toBe("refused");
    expect(lines).toEqual([]);
  });
});

describe("the instrument must not pay the reviewer for the wrong label", () => {
  it("accepts a wrong verdict settled by evidence learned after the fact", () => {
    // Grok, 2026-09-05, on the design rather than the code: requiring the
    // decisive evidence to resolve inside the original observations refused
    // exactly the reviews worth having. The true cause is usually learned while
    // fixing, from data the incident never collected — so an honest reviewer
    // was left with "unverifiable" or "correct", and accuracy would climb as
    // the hard cases vanished.
    const { out } = record(diagnosed(), judge({
      verdict_was: "wrong", actual_code: "CPU_THROTTLING",
      evidence_source: "learned_after",
      what_settled_it: "the throttling only showed in the node-level metrics nobody collected here",
    }));
    expect(out.state, out.state === "refused" ? `${out.reason} ${JSON.stringify(out.errors)}` : "").toBe("recorded");
  });

  it("still requires a description when the evidence was learned afterwards", () => {
    // Neither a traceable path nor words is not a measurement.
    const { out } = record(diagnosed(), judge({
      verdict_was: "wrong", actual_code: "CPU_THROTTLING", evidence_source: "learned_after" }));
    expect(out.state).toBe("refused");
  });

  it("still requires the path when the evidence is claimed to be in the observations", () => {
    const { out } = record(diagnosed(), judge({
      verdict_was: "wrong", actual_code: "CPU_THROTTLING", evidence_source: "in_observations" }));
    expect(out.state).toBe("refused");
  });

  it("does not check a path against the observations when the evidence came from outside", () => {
    // A reviewer may name where they looked afterwards — a dashboard, a node
    // metric, a ticket — and that path has no reason to resolve inside this
    // incident's observations. Checking it anyway is what refused the honest
    // late review in the first place.
    const { out } = record(diagnosed(), judge({
      verdict_was: "wrong", actual_code: "CPU_THROTTLING", evidence_source: "learned_after",
      what_settled_it: "node-level throttling on the dashboard, which this incident never collected",
      decisive_ref: "node.throttled_seconds" }));
    expect(out.state, out.state === "refused" ? out.reason : "").toBe("recorded");
    if (out.state !== "recorded") return;
    expect(out.review.decisive_was_cited, "nothing was checked, so nothing is claimed").toBeUndefined();
  });

  it("refuses an in-observations path that resolves to nothing", () => {
    const { out } = record(diagnosed(), judge({
      verdict_was: "wrong", actual_code: "CPU_THROTTLING",
      evidence_source: "in_observations", decisive_ref: "series[99].nowhere" }));
    expect(out.state).toBe("refused");
    if (out.state !== "refused") return;
    expect(out.reason).toContain("resolves to nothing");
  });

  it("refuses a wrong verdict whose true cause is empty or the same as proposed", () => {
    expect(validate("verdict-review", stored({ verdict_was: "wrong", actual_code: "",
      evidence_source: "learned_after", what_settled_it: "something happened" })).state).toBe("invalid");
  });
});

describe("what separates never-looked from looked-and-reasoned-badly", () => {
  it("records whether the deciding evidence was among what the agents cited", () => {
    const incident = diagnosed();
    // deployment.image exists in the container-oom observation and was NOT cited.
    expect(citedRefs(incident)).not.toContain("deployment.image");
    const missed = record(incident, judge({ verdict_was: "wrong", actual_code: "CPU_THROTTLING",
      evidence_source: "in_observations", decisive_ref: "deployment.image" }));
    if (missed.out.state !== "recorded") throw new Error(`${missed.out.reason} ${JSON.stringify(missed.out.errors)}`);
    expect(missed.out.review.decisive_was_cited).toBe(false);

    const seen = record(incident, judge({ verdict_was: "wrong", actual_code: "CPU_THROTTLING",
      evidence_source: "in_observations", decisive_ref: "pods[0].containers[0].last_state.terminated.reason" }));
    if (seen.out.state !== "recorded") throw new Error(seen.out.reason);
    expect(seen.out.review.decisive_was_cited).toBe(true);
  });

  it("lists what the agents cited, not every path in the incident", () => {
    // If citedRefs returned every ref present, every path would look cited and
    // decisive_was_cited would be a constant true.
    const cited = citedRefs(diagnosed());
    expect(cited).toContain("pods[0].containers[0].last_state.terminated.reason");
    expect(cited, "an uncited path that exists in the observation must not appear").not.toContain("deployment.image");
    expect(citedRefs({})).toEqual([]);
  });
});

describe("the score cannot rise without the system improving", () => {
  // Distinct incidents, and deliberately not starting at 0101 — the first
  // version of this helper collided with the incident used in the supersession
  // test, and the collision looked like a bug in the summary.
  const many = (n: number, over: Partial<Review> = {}) =>
    Array.from({ length: n }, (_, i) => stored({ incident_id: `INC-2026-05${String(i).padStart(2, "0")}`, ...over }));

  it("counts one incident once, however many times it is reviewed", () => {
    // Codex, 2026-09-05: five duplicate reviews of one incident satisfied the
    // minimum and reported 100%.
    const five = Array.from({ length: 5 }, (_, i) =>
      stored({ reviewed_at: `2026-09-05T1${i}:00:00Z`, review_id: `aaaaaaaaaaaaaa0${i}` }));
    const [s] = summarise(five);
    expect(s!.incidents, "one incident five times is one incident").toBe(1);
    expect(s!.accuracy, "and one incident is below any honest minimum").toBeNull();
  });

  it("drops a superseded review even when the correction is older by the clock", () => {
    // Taking the latest by timestamp is not the same as honouring supersession,
    // and the difference shows exactly when a clock disagrees with the order
    // things were actually decided — a corrected review filed with an earlier
    // reviewed_at, or two systems writing the log.
    const mistake = stored({ reviewed_at: "2026-09-05T18:00:00Z", verdict_was: "wrong", actual_code: "CPU_THROTTLING",
      evidence_source: "learned_after", what_settled_it: "misread the graph", review_id: "1111111111111111" });
    const fix = stored({ reviewed_at: "2026-09-05T09:00:00Z", supersedes: "1111111111111111", review_id: "2222222222222222" });
    const [s] = summarise([mistake, fix, ...many(4, { verdict_was: "correct" })]);
    expect(s!.wrong, "the superseded mistake still counted").toBe(0);
    expect(s!.correct).toBe(5);
  });

  it("keeps unverifiable out of the denominator and says so in the counts", () => {
    // Passing this must not also pass if unverifiable were counted as correct,
    // so the row carries a wrong verdict too.
    const rows = [...many(4, { verdict_was: "correct" }),
      stored({ incident_id: "INC-2026-0199", verdict_was: "wrong", actual_code: "X",
        evidence_source: "learned_after", what_settled_it: "found out later" }),
      ...Array.from({ length: 6 }, (_, i) => stored({ incident_id: `INC-2026-02${i}0`, verdict_was: "unverifiable" }))];
    const [s] = summarise(rows);
    expect(s!.gradable).toBe(5);
    expect(s!.incidents).toBe(11);
    expect(s!.accuracy).toBeCloseTo(4 / 5);
    expect(s!.unverifiable).toBe(6);
  });

  it("reports no accuracy when too few incidents are gradable, however many rows exist", () => {
    const rows = [...many(3, { verdict_was: "correct" }),
      ...Array.from({ length: 20 }, (_, i) => stored({ incident_id: `INC-2026-03${String(i).padStart(2, "0")}`, verdict_was: "unverifiable" }))];
    const [s] = summarise(rows);
    expect(s!.accuracy).toBeNull();
    expect(s!.belowMinimum).toBe(true);
    expect(s!.incidents).toBe(23);
  });

  it("keeps versions apart, since a score mixed across them answers nothing", () => {
    const other = { prompt_sha: "ffffffffffffffff", core_sha: "eeeeeeeeeeeeeeee" };
    const all = summarise([...many(5, { verdict_was: "correct" }), ...many(5, { verdict_was: "correct", ...other })]);
    expect(all).toHaveLength(2);
  });

  it("names which cause is mistaken for which", () => {
    const rows = many(3, { verdict_was: "wrong", actual_code: "CPU_THROTTLING",
      evidence_source: "learned_after", what_settled_it: "the node was throttling" });
    const [s] = summarise(rows);
    expect(s!.confusions[0]).toEqual({ proposed: "CONTAINER_OOM", actual: "CPU_THROTTLING", times: 3 });
  });

  it("counts how often the deciding evidence was never cited, and says nothing when unrecorded", () => {
    expect(summarise(many(2, { verdict_was: "wrong", actual_code: "X",
      evidence_source: "learned_after", what_settled_it: "later" }))[0]!.missedTheEvidence).toBeNull();

    const [s] = summarise([
      stored({ incident_id: "INC-2026-0101", verdict_was: "wrong", actual_code: "X",
        evidence_source: "in_observations", decisive_ref: "a", decisive_was_cited: false }),
      stored({ incident_id: "INC-2026-0102", verdict_was: "wrong", actual_code: "X",
        evidence_source: "in_observations", decisive_ref: "b", decisive_was_cited: true }),
    ]);
    expect(s!.missedTheEvidence).toEqual({ of: 2, times: 1 });
  });

  it("counts how often the truth came from outside the observations", () => {
    // A high number is not a fault in the agents. It says the observations do
    // not carry what decides these incidents — a different fix entirely.
    const [s] = summarise(many(3, { verdict_was: "wrong", actual_code: "X",
      evidence_source: "learned_after", what_settled_it: "learned while fixing it" }));
    expect(s!.learnedAfterwards).toBe(3);
  });
});

describe("the version stamp identifies the system that answered", () => {
  it("moves when a prompt changes", () => {
    const a = versionStamp(MODEL)!;
    const b = versionStamp(MODEL, new URL("./fixtures/other-prompts/", import.meta.url).pathname)!;
    expect(b.prompt_sha, "two different prompt trees produced one hash").not.toBe(a.prompt_sha);
  });

  it("moves when the model or its temperature changes", () => {
    // Codex, 2026-09-05: the old stamp hashed a build artifact made from
    // schemas, so changing the model changed the answer and not the stamp.
    const a = versionStamp(MODEL)!;
    expect(versionStamp({ name: "gpt-4o", temperature: 0 })!.core_sha).not.toBe(a.core_sha);
    expect(versionStamp({ name: "gpt-4o-mini", temperature: 0.7 })!.core_sha).not.toBe(a.core_sha);
  });

  it("refuses to stamp at all when the model is unknown", () => {
    expect(versionStamp(undefined)).toBeNull();
    expect(versionStamp(MODEL, "/nonexistent/")).toBeNull();
  });

  it("gives the same stamp twice for the same system", () => {
    expect(versionStamp(MODEL)).toEqual(versionStamp(MODEL));
  });
});
