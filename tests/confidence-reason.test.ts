/**
 * The figure has to say what it stands on.
 *
 * The owner asked why one answer said 90%, and nothing in the record could
 * say. Counted across all 49 recorded answers on 2026-09-11: every one carried
 * a figure, none carried a reason, and the hypothesis itself carried no figure
 * of its own in 40 of them.
 *
 * What the same count REFUTED, and it was my own claim: the figure is carried
 * faithfully — the report equals the concluding agent's own number in 47 of 49
 * — and it is not arbitrary at the coarsest grain, since insufficient-evidence
 * answered 0 six times out of six. It is arbitrary at the fine grain, which is
 * where a declared ceiling of 0.6 gets compared against it.
 */
import { describe, it, expect } from "vitest";
import { validate } from "../src/schema/validate.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// @ts-expect-error — plain .mjs, the same file node runs.
import { whatTheFigureStandsOn, figureLine } from "../scripts/score-run.mjs";

const conclusion = {
  agent: "root_cause", status: "ok",
  findings: [{ fact: "x", source_ref: "collected_at" }],
  hypotheses: [{ code: "CONTAINER_OOM", statement: "it ran out of memory", supported_by: ["collected_at"] }],
  confidence: 0.9,
  confidence_because: "nine findings from three agents agree and nothing contradicts",
};

describe("the schema knows the field and deliberately does not demand it", () => {
  it("asks it of the concluding agent, and not of the specialists", () => {
    /*
     * Narrowed the same hour it was written: requiring it of every agent broke
     * 66 tests, because every fixture builds hypotheses without it. The figure
     * a person reads is the report's, and the report's comes from root_cause.
     * Asking the specialists for prose about their own certainty is a larger
     * change and nothing has measured a need for it.
     */
    const specialist = { ...conclusion, agent: "kubernetes" };
    const { confidence_because: _dropped, ...without } = specialist;
    expect(validate("agent-result", without).state,
      "a specialist may still state a figure without prose").toBe("valid");
  });

  it("accepts a conclusion that says what its figure stands on", () => {
    expect(validate("agent-result", conclusion).state).toBe("valid");
  });

  it("does NOT refuse a conclusion that gives no reason, and that is a choice", () => {
    /*
     * Requiring it was written and withdrawn the same hour. A schema that
     * refuses an answer for a missing SENTENCE throws away a paid measurement
     * whose code and citations were both there — $0.01 discarded over prose.
     *
     * So the absence is reported by the scorer instead of being fatal: a model
     * that ignores the prompt is visible without a run being lost. If that
     * trade is ever reversed, this test is the one that has to change first.
     */
    const { confidence_because: _dropped, ...without } = conclusion;
    expect(validate("agent-result", without).state).toBe("valid");
  });

  it("still refuses a reason short enough to be a shrug, when one is given", () => {
    // Optional is not "anything goes": an empty string wearing the field's
    // name is absence, and absence has a field of its own — not writing it.
    const r = validate("agent-result", { ...conclusion, confidence_because: "" });
    expect(r.state).toBe("invalid");
    if (r.state !== "invalid") return;
    expect(r.errors.join("; ")).toContain("confidence_because");
  });

  it("does not demand a reason from a refusal, which has nothing to explain", () => {
    /*
     * Conditioned on hypotheses rather than on the figure: an agent that
     * reached no conclusion would otherwise have to write a sentence about
     * nothing, and a rule that buys prose for its own sake is the kind that
     * gets satisfied rather than followed.
     */
    expect(validate("agent-result", {
      agent: "root_cause", status: "ok",
      findings: [{ fact: "x", source_ref: "collected_at" }],
      hypotheses: [], confidence: 0,
    }).state).toBe("valid");
  });

  it("refuses a reason short enough to be a shrug", () => {
    // The shape of a reason cannot be validated. Its ABSENCE can, and an empty
    // string or a single word is absence wearing the field's name.
    expect(validate("agent-result", { ...conclusion, confidence_because: "" }).state).toBe("invalid");
    expect(validate("agent-result", { ...conclusion, confidence_because: "sure" }).state).toBe("invalid");
  });

  it("is asked for in the prompt, not only enforced by the schema", () => {
    /*
     * A field the validator demands and the prompt never mentions is a run
     * that fails for a reason the model was never told. Both halves, or
     * neither.
     */
    const prompt: string = readFileSync(resolve(ROOT, "prompts/root-cause-agent.md"), "utf8");
    expect(prompt).toContain("confidence_because");
    expect(prompt, "and it says what kind of sentence").toContain("a reader can check");
  });
});

describe("what the report says a figure stands on", () => {
  /*
   * The first version of this line counted: "90%, standing on 9 for, from
   * kubernetes and logs and metrics". The owner, immediately: that carries no
   * information. He was right twice — it says how many rather than what, and
   * the nine were about five distinct facts, two timestamps and two points of
   * one series, so the count overstated even what it counted.
   */
  const answer = (evidence: unknown, confidence: unknown = 0.9) => ({
    incident: { analysis: { confidence, evidence } },
  });
  const fact = (source: string, text: string, supports = "for") => ({ source, fact: text, supports });

  it("quotes the facts, in the order the conclusion cited them", () => {
    const line = figureLine(whatTheFigureStandsOn(answer([
      fact("kubernetes", "the deployment image is orders-api:5.4.0"),
      fact("logs", "POST /v2/orders 500: discount_code column is not present"),
    ], 0.9)));
    expect(line).toContain("90% · the deployment image is orders-api:5.4.0 "
      + "· POST /v2/orders 500: discount_code column is not present");
  });

  it("drops a citation that only says when something was seen", () => {
    /*
     * `events[0].last_seen is 2026-...` is provenance, not evidence for a
     * cause, and it was padding the number the owner was reading.
     */
    const stands = whatTheFigureStandsOn(answer([
      fact("kubernetes", "the deployment image is orders-api:5.4.0"),
      fact("kubernetes", "events[0] last_seen is 2026-09-07T09:38:02Z"),
      fact("logs", "logs line[3] timestamp is 2026-09-07T09:38:31Z"),
    ]));
    expect(stands.facts).toEqual(["the deployment image is orders-api:5.4.0"]);
    expect(stands.dropped, "and it knows how many it dropped").toBe(2);
  });

  it("separates three different silences rather than blaming one", () => {
    /*
     * Nothing cited; citations that were all timestamps; and citations with no
     * readable sentence. The first version called the third one "every
     * citation is a timestamp", which named the wrong cause — caught by a
     * fixture that simply had no `fact` field.
     */
    expect(figureLine(whatTheFigureStandsOn(answer([{ source: "logs", supports: "for" }]))))
      .toContain("its citations carry no readable statement");
  });

  it("says so when every citation it gave is a timestamp", () => {
    // Not "no evidence" — there were citations, and every one of them was
    // provenance. That is a different and more damning thing.
    const line = figureLine(whatTheFigureStandsOn(answer([
      fact("kubernetes", "events[0] last_seen is 2026-09-07T09:38:02Z"),
    ])));
    expect(line).toContain("every citation it gave is a timestamp; nothing states a cause");
  });

  it("shows what argued AGAINST separately, rather than folding it in", () => {
    const line = figureLine(whatTheFigureStandsOn(answer([
      fact("logs", "the pod restarted"),
      fact("metrics", "memory never rose above 40%", "against"),
    ], 0.5)));
    expect(line).toContain("50% · the pod restarted");
    expect(line).toContain("AGAINST: memory never rose above 40%");
  });

  it("does not quote an entry that takes no side as if it supported the answer", () => {
    /*
     * An entry with no `supports` is neither for nor against. Reading it as
     * support puts a sentence into the reason that the model never offered as
     * one.
     *
     * This property had a test, and I deleted it while rewriting the block
     * around it — the mutation that reintroduces the defect then survived a
     * whole gate run saying so. Rewriting a describe is how a test disappears
     * without anyone choosing to remove it.
     */
    const stands = whatTheFigureStandsOn(answer([
      fact("logs", "the read model is missing a column"),
      { source: "metrics", fact: "cpu was fine", supports: undefined },
      { source: "metrics", fact: "memory was fine" },
    ]));
    expect(stands.facts).toEqual(["the read model is missing a column"]);
    expect(figureLine(stands), "neither does the line").not.toContain("cpu was fine");
  });

  it("says plainly when a figure stands on nothing at all", () => {
    expect(figureLine(whatTheFigureStandsOn(answer([])))).toContain("standing on no cited evidence at all");
  });

  it("has nothing to say when there is no figure", () => {
    /*
     * Not "0%" — absent is not zero, and this line must not invent one.
     *
     * Built inline rather than through the helper: a default parameter fires
     * on `undefined`, so passing it explicitly would hand 0.9 back and the
     * test would assert the opposite of its own name.
     */
    expect(whatTheFigureStandsOn({ incident: { analysis: { evidence: [fact("logs", "x")] } } })).toBeNull();
    expect(whatTheFigureStandsOn(answer([fact("logs", "x")], "high"))).toBeNull();
    expect(whatTheFigureStandsOn(answer([fact("logs", "x")], Number.NaN))).toBeNull();
    expect(whatTheFigureStandsOn({})).toBeNull();
    expect(figureLine(null)).toBeNull();
  });

  it("ignores an entry with no readable fact rather than printing a blank", () => {
    const stands = whatTheFigureStandsOn(answer([fact("logs", "a real one"), { supports: "for" }, null]));
    expect(stands.facts).toEqual(["a real one"]);
  });
});

describe("whether the concluder gave a reason at all", () => {
  const withRaw = (raw: unknown) => ({
    incident: { analysis: { confidence: 0.9,
      evidence: [{ source: "logs", fact: "the read model is missing a column", supports: "for" }] } },
    raw_answers: { "root-cause": raw },
  });

  it("quotes the sentence when the model wrote one", () => {
    const line = figureLine(whatTheFigureStandsOn(
      withRaw({ confidence_because: "nine findings from three agents agree and nothing contradicts" })));
    expect(line).toContain("it says: nine findings from three agents agree");
  });

  it("reads it out of a raw answer that arrived as a string", () => {
    // The chain has returned the agent answers both ways. A reader that
    // handles one shape reports "no reason" for the other, which is a defect
    // wearing the model's name.
    const line = figureLine(whatTheFigureStandsOn(
      withRaw(JSON.stringify({ confidence_because: "three sources agree and none contradicts" }))));
    expect(line).toContain("it says: three sources agree");
  });

  it("says the reason is missing, naming whose job it was", () => {
    const line = figureLine(whatTheFigureStandsOn(withRaw({ confidence: 0.9 })));
    expect(line).toContain("the concluder gave no reason");
    expect(line, "and that the schema is not what let it through")
      .toContain("the schema does not enforce");
  });

  it("treats a shrug as no reason, the same as absence", () => {
    expect(figureLine(whatTheFigureStandsOn(withRaw({ confidence_because: "sure" }))))
      .toContain("gave no reason");
    expect(figureLine(whatTheFigureStandsOn(withRaw({ confidence_because: "   " }))))
      .toContain("gave no reason");
  });

  it("does not fall over on a raw answer that is not readable", () => {
    // Unreadable is not a reason, and it is not a crash either.
    expect(figureLine(whatTheFigureStandsOn(withRaw("{not json")))).toContain("gave no reason");
    expect(figureLine(whatTheFigureStandsOn(withRaw(null)))).toContain("gave no reason");
  });
});
