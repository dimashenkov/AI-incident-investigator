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
  const answer = (evidence: unknown, confidence: unknown = 0.9) => ({
    incident: { analysis: { confidence, evidence } },
  });

  it("counts the sides separately, by what each entry says it does", () => {
    const stands = whatTheFigureStandsOn(answer([
      { source: "kubernetes", supports: "for" },
      { source: "logs", supports: "for" },
      { source: "metrics", supports: "against" },
    ]));
    expect(stands).toMatchObject({ confidence: 0.9, for: 2, against: 1, unstated: 0 });
    expect(stands.sources).toEqual(["kubernetes", "logs", "metrics"]);
  });

  it("counts an entry that takes no side as neither, not as support", () => {
    // Folding it into "for" would inflate the very number this exists to make
    // readable.
    const stands = whatTheFigureStandsOn(answer([{ source: "logs" }, { source: "logs", supports: "sideways" }]));
    expect(stands).toMatchObject({ for: 0, against: 0, unstated: 2 });
  });

  it("says plainly when a figure stands on nothing at all", () => {
    expect(figureLine(whatTheFigureStandsOn(answer([])))).toContain("standing on no cited evidence at all");
  });

  it("has nothing to say when there is no figure", () => {
    /*
     * Not "0%" — absent is not zero, and this line must not invent one.
     *
     * Built inline rather than through the helper: a default parameter fires
     * on `undefined`, so passing it explicitly would have handed 0.9 back and
     * the test would have been asserting the opposite of its own name. The
     * first version of this did exactly that and failed, which is the outcome
     * to prefer over passing quietly.
     */
    expect(whatTheFigureStandsOn({ incident: { analysis: { evidence: [{ supports: "for" }] } } })).toBeNull();
    expect(whatTheFigureStandsOn(answer([{ supports: "for" }], "high"))).toBeNull();
    expect(whatTheFigureStandsOn(answer([{ supports: "for" }], Number.NaN)),
      "not a finite number is not a figure").toBeNull();
    expect(whatTheFigureStandsOn({})).toBeNull();
    expect(figureLine(null)).toBeNull();
  });

  it("reads the figure as a percentage, the way the owner asked for it", () => {
    const line = figureLine(whatTheFigureStandsOn(answer([
      { source: "kubernetes", supports: "for" }, { source: "logs", supports: "for" },
    ], 0.8)));
    expect(line).toContain("80%, standing on 2 for, from kubernetes and logs");
  });

  it("names the contradiction when there is one", () => {
    const line = figureLine(whatTheFigureStandsOn(answer([
      { source: "logs", supports: "for" }, { source: "metrics", supports: "against" },
    ], 0.5)));
    expect(line).toContain("1 against");
  });
});

describe("whether the concluder gave a reason at all", () => {
  const withRaw = (raw: unknown) => ({
    incident: { analysis: { confidence: 0.9, evidence: [{ source: "logs", supports: "for" }] } },
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
