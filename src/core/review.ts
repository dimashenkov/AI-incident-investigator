/**
 * Recording what a human said about a verdict.
 *
 * This is the only signal in the project that can tell a right answer from a
 * well-formed one. Everything else checks shape; a person checks truth.
 *
 * Two decisions the owner made on 2026-09-05 shape the whole file. The review
 * carries the true cause and the decisive evidence, not merely a thumbs up or
 * down — the extra thirty seconds buys the difference between knowing the score
 * fell and knowing why. And the reaction stays open rather than closing after a
 * window, because the true cause is usually understood hours later, once
 * somebody has fixed the thing, and those are the cases worth learning from.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

import { validate } from "../schema/validate.js";
import { resolveRef } from "./assemble.js";

export type Review = {
  review_id: string;
  incident_id: string; reviewed_at: string; reviewer: string;
  verdict_was: "correct" | "wrong" | "unverifiable";
  proposed_code: string | null; proposed_confidence?: number | null;
  actual_code?: string;
  evidence_source?: "in_observations" | "learned_after";
  decisive_ref?: string; what_settled_it?: string; decisive_was_cited?: boolean;
  note?: string;
  prompt_sha: string; core_sha: string; supersedes?: string;
};

/** What a reviewer writes. The id and the version stamp are not theirs to supply. */
export type Judgement = Omit<Review, "review_id" | "prompt_sha" | "core_sha" | "decisive_was_cited">;

export type Recorded =
  | { state: "recorded"; review: Review }
  | { state: "refused"; reason: string; errors?: string[] };

/**
 * Which system produced the verdict this review is about.
 *
 * Codex, 2026-09-05: the old stamp hashed the prompts and out/core.js, and
 * out/core.js is built from the schemas — "changing the model, version or
 * temperature, or changing assembly and promotion without rebuilding that
 * artifact, can change the answer while leaving both hashes unchanged."
 *
 * So the stamp covers what actually decides an answer: the prompts, the
 * deterministic source that assembles context and promotes verdicts, and the
 * model configuration. A stamp that misses any of them lets a changed system
 * report under an old version's score, which is the one thing these records
 * exist to prevent.
 *
 * `model` is passed in rather than read, because it lives in the workflow and
 * in whoever calls the API — not on this disk. A caller that does not know it
 * gets null and no review is stored, since a review of an unidentified system
 * measures nothing.
 */
export function versionStamp(
  model?: { name: string; temperature: number },
  promptDir = new URL("../../prompts/", import.meta.url).pathname,
  srcDir = new URL("../", import.meta.url).pathname,
): { prompt_sha: string; core_sha: string } | null {
  if (model === undefined) return null;
  if (!existsSync(promptDir) || !existsSync(srcDir)) return null;

  const files = readdirSync(promptDir).filter((f) => f.endsWith(".md")).sort();
  if (files.length === 0) return null;
  const prompts = createHash("sha256");
  for (const f of files) prompts.update(f).update(readFileSync(`${promptDir}${f}`, "utf8"));

  // Every .ts under src, plus the model configuration. Sorted so the hash does
  // not move with directory listing order.
  const core = createHash("sha256");
  for (const f of sourceFiles(srcDir).sort()) core.update(f).update(readFileSync(f, "utf8"));
  core.update(`model:${model.name}@${model.temperature}`);

  return { prompt_sha: prompts.digest("hex").slice(0, 16), core_sha: core.digest("hex").slice(0, 16) };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = `${dir}${e.name}${e.isDirectory() ? "/" : ""}`;
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Check a review against the incident it judges, then record it.
 *
 * A review is refused rather than stored when it cannot mean anything: about an
 * incident that reached no verdict, naming evidence that does not exist, or
 * disagreeing with itself about what the system proposed.
 */
export function reviewVerdict(
  incident: Record<string, unknown>,
  judgement: Judgement,
  append: (line: string) => void,
  stamp: { prompt_sha: string; core_sha: string } | null,
): Recorded {
  // Codex and Grok, 2026-09-05: the version was accepted from the caller and
  // never computed, so any matching hex was stored — and comparing versions is
  // the one question these records exist to answer.
  if (stamp === null) {
    return { state: "refused", reason: "cannot determine which version produced this verdict; refusing to guess" };
  }

  const withId = { ...judgement, ...stamp };
  const review: Review = { ...withId, review_id: reviewId(withId) };

  const r = validate("verdict-review", review);
  if (r.state !== "valid") {
    return { state: "refused",
      reason: r.state === "invalid" ? "the review does not validate" : `could not validate the review: ${r.reason}`,
      errors: r.state === "invalid" ? r.errors : [r.reason] };
  }

  if (incident["incident_id"] !== review.incident_id) {
    return { state: "refused", reason: `the review is for ${review.incident_id}, the incident is ${String(incident["incident_id"])}` };
  }

  // Judging an unfinished investigation judges nothing.
  const status = incident["status"];
  if (status !== "diagnosed" && status !== "insufficient_evidence") {
    return { state: "refused", reason: `the incident is ${String(status)}; there is no verdict to review yet` };
  }

  const analysis = (incident["analysis"] ?? {}) as Record<string, unknown>;
  const actuallyProposed = analysis["root_cause_code"] ?? null;
  if (review.proposed_code !== actuallyProposed) {
    // A review must judge what was shown. Recording a different code would make
    // every count built on these records describe something that never happened.
    return { state: "refused", reason: `the review says the system proposed ${String(review.proposed_code)}, the incident says ${String(actuallyProposed)}` };
  }

  let stored: Review = review;
  if (review.evidence_source === "in_observations" && review.decisive_ref !== undefined) {
    const observations = (incident["observations"] ?? {}) as Record<string, unknown>;
    const found = Object.values(observations).some((o) => o !== null && resolveRef(o, review.decisive_ref!) !== undefined);
    if (!found) {
      // The same rule the agents live under: evidence nobody can trace back to
      // an observation is an opinion. A reviewer is not exempt from it.
      return { state: "refused", reason: `the decisive evidence ${review.decisive_ref} resolves to nothing in this incident's observations` };
    }

    // Answered here, while the incident is at hand. It cannot be recovered
    // later from the review alone, and it separates two defects with opposite
    // fixes: an agent that never looked at the deciding evidence needs a
    // different prompt; one that cited it and reasoned wrongly does not.
    stored = { ...review, decisive_was_cited: citedRefs(incident).includes(review.decisive_ref) };
  }

  append(JSON.stringify(stored));
  return { state: "recorded", review: stored };
}

/**
 * A review's identity, computed from what it says.
 *
 * Two identical judgements are the same record rather than two samples, which
 * is what stopped five copies of one opinion from reporting as five reviews.
 */
export function reviewId(r: Omit<Review, "review_id" | "decisive_was_cited">): string {
  const canonical = JSON.stringify([r.incident_id, r.reviewer, r.verdict_was, r.proposed_code ?? null,
    r.actual_code ?? null, r.decisive_ref ?? null, r.what_settled_it ?? null, r.prompt_sha, r.core_sha, r.reviewed_at]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Every source_ref the agents cited on this incident. */
export function citedRefs(incident: Record<string, unknown>): string[] {
  const agents = (incident["analysis"] as Record<string, unknown> | undefined)?.["agents"];
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((a) => {
    const findings = (a as Record<string, unknown>)["findings"];
    if (!Array.isArray(findings)) return [];
    return findings.map((f) => String((f as Record<string, unknown>)["source_ref"]));
  });
}

/** Append one review to the log. Never rewrites: a correction is a new record. */
export function appendToLog(path: string): (line: string) => void {
  return (line) => appendFileSync(path, `${line}\n`);
}

/** Every review in a log, in the order they were made. */
export function readLog(path: string): Review[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Review);
}

/**
 * What the reviews say, once there are enough of them to say anything.
 *
 * Three things had to be fixed before this number meant anything, all found on
 * 2026-09-05 and each of which would have made accuracy rise without the system
 * improving:
 *
 *  - superseded reviews kept counting alongside their corrections, so one
 *    incident judged wrong and then corrected pulled toward the middle;
 *  - every record was an independent sample, so five copies of one opinion
 *    about one incident reported as five reviews and satisfied the minimum;
 *  - `reviewed` counted unverifiable rows, so a reader quoting accuracy beside
 *    it treated abstentions as part of the sample.
 *
 * An incident now contributes at most one judgement per version — the latest
 * one that nothing supersedes — and the counts say which number has which
 * denominator.
 */
export function summarise(reviews: Review[], minimum = 5): Array<{
  prompt_sha: string; core_sha: string;
  incidents: number; gradable: number;
  correct: number; wrong: number; unverifiable: number;
  accuracy: number | null; belowMinimum: boolean;
  confusions: Array<{ proposed: string; actual: string; times: number }>;
  missedTheEvidence: { of: number; times: number } | null;
  learnedAfterwards: number;
}> {
  const superseded = new Set(reviews.map((r) => r.supersedes).filter((x): x is string => typeof x === "string"));
  const live = reviews.filter((r) => !superseded.has(r.review_id));

  const byVersion = new Map<string, Review[]>();
  for (const r of live) {
    const key = `${r.prompt_sha}|${r.core_sha}`;
    byVersion.set(key, [...(byVersion.get(key) ?? []), r]);
  }

  return [...byVersion.entries()].map(([key, rs]) => {
    const [prompt_sha, core_sha] = key.split("|") as [string, string];

    // One judgement per incident: the latest. Two reviewers disagreeing is
    // worth knowing, but it is a fact about the review process, not two
    // independent measurements of the system.
    const latest = new Map<string, Review>();
    for (const r of rs) {
      const held = latest.get(r.incident_id);
      if (held === undefined || r.reviewed_at > held.reviewed_at) latest.set(r.incident_id, r);
    }
    const judged = [...latest.values()];

    const correct = judged.filter((r) => r.verdict_was === "correct").length;
    const wrong = judged.filter((r) => r.verdict_was === "wrong").length;
    const unverifiable = judged.filter((r) => r.verdict_was === "unverifiable").length;
    const gradable = correct + wrong;

    const pairs = new Map<string, number>();
    for (const r of judged) {
      if (r.verdict_was !== "wrong" || r.actual_code === undefined) continue;
      pairs.set(`${String(r.proposed_code)}→${r.actual_code}`, (pairs.get(`${String(r.proposed_code)}→${r.actual_code}`) ?? 0) + 1);
    }

    const known = judged.filter((r) => r.verdict_was === "wrong" && r.decisive_was_cited !== undefined);

    return {
      prompt_sha, core_sha,
      // `incidents` is how many the reviews are about; `gradable` is the
      // denominator accuracy actually uses. Reporting one number without the
      // other is how abstentions get read as part of the sample.
      incidents: judged.length, gradable,
      correct, wrong, unverifiable,
      accuracy: gradable >= minimum ? correct / gradable : null,
      belowMinimum: gradable < minimum,
      confusions: [...pairs.entries()]
        .map(([k, times]) => { const [proposed, actual] = k.split("→") as [string, string]; return { proposed, actual, times }; })
        .sort((a, b) => b.times - a.times),
      // Of the wrong verdicts where anyone recorded whether the deciding
      // evidence was cited, how often it was not. Null when nobody recorded it,
      // which is different from "it was always cited".
      missedTheEvidence: known.length === 0 ? null
        : { of: known.length, times: known.filter((r) => r.decisive_was_cited === false).length },
      // How many wrong verdicts were settled by evidence the incident never
      // held. A high number is not a fault in the agents — it says the
      // observations do not carry what decides these incidents.
      learnedAfterwards: judged.filter((r) => r.evidence_source === "learned_after").length,
    };
  });
}
