/**
 * What an agent is given, before any model sees it.
 *
 * Codex, first review of the plan: "Model-output assertions alone are
 * insufficient because a model may ignore leaked data." A model handed another
 * incident's data that happened not to mention it would pass an output test
 * while the leak sat there in the prompt. So the assembled context is the thing
 * under test, and none of this costs anything to run.
 */
import { describe, it, expect } from "vitest";
import { resolveRef } from "../src/core/assemble.js";
import { listScenarios, readSlot } from "../src/providers/fixtures.js";
import { readFileSync } from "node:fs";
import { validate } from "../src/schema/validate.js";
import agentResultSchema from "../schemas/agent-result.schema.json" with { type: "json" };
import incidentSchema from "../schemas/incident.schema.json" with { type: "json" };
import commonSchema from "../schemas/common.schema.json" with { type: "json" };
// @ts-expect-error — plain .mjs; the debt list the gate reads.
import { LIMITATIONS } from "../scripts/acceptance-gate.mjs";

/** The one list both schemas point at. */
const CAUSE_CODES: string[] = commonSchema.$defs.causeCode.enum;
import {
  assembleObservingContext, assembleRootCauseContext, assembleCheckedContext, checkPayloadIsExactlyTheSlice, checkSourceForForeignIncidents,
  foreignIncidentIds, deepDiffPaths, readPrompt, OBSERVING_AGENTS, AGENT_SLOT, type AgentName,
} from "../src/agents/context.js";

const SCENARIOS = new URL("../scenarios/", import.meta.url).pathname;

/**
 * Citations a prompt shows as general guidance, excluding worked examples that
 * announce which incident they belong to.
 *
 * Codex, 2026-09-06: the marker used to live inside the `source_ref` string, so
 * the example demonstrated a citation this system would refuse and a model
 * copying it literally would lose its whole answer. The label belongs around
 * the example. A fenced block introduced by EXAMPLE FOR ONE INCIDENT is that
 * scope, and it is a line the model reads too.
 */
function citationsOutsideScopedExamples(text: string): string[] {
  const scoped = [...text.matchAll(/EXAMPLE FOR ONE INCIDENT[\s\S]*?```json[\s\S]*?```/g)].map((m) => m[0]);
  let rest = text;
  for (const block of scoped) rest = rest.replace(block, "");
  return [
    ...rest.matchAll(/"source_ref":\s*"([^"]*)"/g),
    ...rest.matchAll(/"supported_by":\s*\[\s*"([^"]*)"/g),
  ].map((m) => m[1]!);
}
const K8S = JSON.parse(readFileSync(`${SCENARIOS}container-oom/kubernetes.json`, "utf8"));
const LOGS = JSON.parse(readFileSync(`${SCENARIOS}container-oom/logs.json`, "utf8"));
const METRICS = JSON.parse(readFileSync(`${SCENARIOS}container-oom/metrics.json`, "utf8"));

const AGENT_RESULT = {
  agent: "kubernetes", status: "ok",
  findings: [{ fact: "OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
  hypotheses: [{ code: "CONTAINER_OOM", statement: "memory limit exceeded", supported_by: ["pods[0].containers[0].last_state.terminated.reason"] }],
  confidence: 0.9,
};

const incident = (id: string, over: Record<string, unknown> = {}) => ({
  incident_id: id,
  observations: { kubernetes: K8S, logs: LOGS, metrics: METRICS },
  analysis: { agents: [AGENT_RESULT] },
  ...over,
});

/**
 * What each prompt must instruct.
 *
 * Codex, chunk 2: asserting that a word appears in a file establishes nothing —
 * "findings do not need a source_ref" would satisfy a substring check for
 * source_ref. Each prompt therefore declares its rules as ids, and the test
 * requires both the id and the prose that carries it. Removing an instruction
 * means removing its id, and the test fails; leaving the id while deleting the
 * prose fails too.
 */
const REQUIRED_RULES: Record<string, Array<{ id: string; prose: RegExp }>> = {
  kubernetes: [
    // Codex, Grok and Grok agreed on 2026-09-05 that this is the likeliest way
    // a real model's first answer is refused: the payload visibly wraps the
    // observation, so a path beginning `observation.` is the natural thing to
    // write, resolves to nothing, and the whole result is thrown away.
    // Was a prohibition until 2026-09-06. The checker normalises the prefix
    // now, and a prompt still forbidding it would be a rule nothing enforces —
    // which is the defect this repository exists to catch.
    { id: "source-ref-is-a-path-inside-the-observation", prose: /a path inside the observation you were given/ },
    // Measured live on 2026-09-06: a container reported as OOMKilled without
    // the memory limit it exceeded, and an image that could not be pulled
    // without the image. The right code on ground the scenario was not built on.
    // Measured live twice in one run on 2026-09-06: the metrics agent reported
    // throttled time and nobody cited the CPU limit, because the limit is not
    // in the metrics slot. The rule belonged to the agent that can obey it.
    { id: "report-the-configuration-the-incident-turns-on", prose: /You hold the configuration, and the other agents do not/ },
    { id: "finding-needs-source-ref", prose: /Every finding needs a `source_ref`/ },
    { id: "every-answer-carries-five-fields", prose: /All five, always|all five, always/ },
    { id: "hypothesis-code-from-the-list", prose: /A hypothesis `code` must be one of these, exactly/ },
    { id: "no-data-is-an-answer", prose: /status: "no_data"/ },
    { id: "error-is-not-no-data", prose: /must not arrive as the same one|different answers/ },
    { id: "do-not-diagnose", prose: /Do not diagnose/ },
    { id: "hypothesis-cites-own-findings", prose: /Every hypothesis needs `supported_by`/ },
  ],
  logs: [
    // Codex, Grok and Grok agreed on 2026-09-05 that this is the likeliest way
    // a real model's first answer is refused: the payload visibly wraps the
    // observation, so a path beginning `observation.` is the natural thing to
    // write, resolves to nothing, and the whole result is thrown away.
    // Was a prohibition until 2026-09-06. The checker normalises the prefix
    // now, and a prompt still forbidding it would be a rule nothing enforces —
    // which is the defect this repository exists to catch.
    { id: "configuration-is-not-in-your-slot", prose: /You cannot see the configuration, and you are not asked to/ },
    { id: "source-ref-is-a-path-inside-the-observation", prose: /a path inside the observation you were given/ },
    // Measured live on 2026-09-06: a container reported as OOMKilled without
    // the memory limit it exceeded, and an image that could not be pulled
    // without the image. The right code on ground the scenario was not built on.
    // Measured live twice in one run on 2026-09-06: the metrics agent reported
    // throttled time and nobody cited the CPU limit, because the limit is not
    // in the metrics slot. The rule belonged to the agent that can obey it.
    { id: "finding-needs-source-ref", prose: /Every finding needs a `source_ref`/ },
    { id: "every-answer-carries-five-fields", prose: /All five, always|all five, always/ },
    { id: "hypothesis-code-from-the-list", prose: /A hypothesis `code` must be one of these, exactly/ },
    { id: "no-data-is-an-answer", prose: /status: "no_data"/ },
    { id: "error-is-not-no-data", prose: /Could-not-read and found-nothing|different answers|must not arrive as the same/ },
    { id: "do-not-diagnose", prose: /Do not diagnose/ },
    { id: "truncation-limits-conclusions", prose: /truncated/ },
    { id: "window-limits-conclusions", prose: /`window`/ },
  ],
  metrics: [
    // Codex, Grok and Grok agreed on 2026-09-05 that this is the likeliest way
    // a real model's first answer is refused: the payload visibly wraps the
    // observation, so a path beginning `observation.` is the natural thing to
    // write, resolves to nothing, and the whole result is thrown away.
    // Was a prohibition until 2026-09-06. The checker normalises the prefix
    // now, and a prompt still forbidding it would be a rule nothing enforces —
    // which is the defect this repository exists to catch.
    { id: "configuration-is-not-in-your-slot", prose: /You cannot see the configuration, and you are not asked to/ },
    { id: "source-ref-is-a-path-inside-the-observation", prose: /a path inside the observation you were given/ },
    // Measured live on 2026-09-06: a container reported as OOMKilled without
    // the memory limit it exceeded, and an image that could not be pulled
    // without the image. The right code on ground the scenario was not built on.
    // Measured live twice in one run on 2026-09-06: the metrics agent reported
    // throttled time and nobody cited the CPU limit, because the limit is not
    // in the metrics slot. The rule belonged to the agent that can obey it.
    { id: "finding-needs-source-ref", prose: /Every finding needs a `source_ref`/ },
    { id: "every-answer-carries-five-fields", prose: /All five, always|all five, always/ },
    { id: "hypothesis-code-from-the-list", prose: /A hypothesis `code` must be one of these, exactly/ },
    { id: "no-data-is-an-answer", prose: /status: "no_data"/ },
    { id: "error-is-not-no-data", prose: /Could-not-read and found-nothing/ },
    { id: "do-not-diagnose", prose: /Do not diagnose/ },
    { id: "state-the-unit", prose: /Always state the unit, inside the `fact` text/ },
    { id: "finding-has-three-fields", prose: /exactly three fields/ },
  ],
  "root-cause": [
    { id: "source-ref-copied-verbatim-from-agent-results", prose: /Copy a `source_ref` verbatim/ },
    // Measured on the first live run: nine agreeing findings produced 0.6,
    // because every rule about confidence pointed downwards and none said what
    // earns a high one. A scale that only descends is read as "stay low".
    { id: "confidence-reads-both-directions", prose: /0\.8 to 0\.95/ },
    { id: "insufficient-evidence-is-an-answer", prose: /Not enough to tell is a real answer/ },
    // Measured live on 2026-09-06: the metrics agent found the throttling, this
    // agent cited it, and then said there was not enough evidence — because no
    // agent had named a cause, and none of them is allowed to.
    { id: "naming-the-cause-is-this-agents-job", prose: /forbidden\*\* to diagnose|are \*\*forbidden\*\*/ },
    { id: "every-answer-carries-five-fields", prose: /All five fields, always/ },
    { id: "cause-code-from-the-list", prose: /The `root_cause_code` must be one of these, exactly/ },
    { id: "record-contradicting-evidence", prose: /Contradicting evidence is recorded, not dropped/ },
    { id: "lower-confidence-on-conflict", prose: /Lower the confidence when evidence conflicts/ },
    { id: "cite-only-what-agents-reported", prose: /Only cite what the agents reported/ },
    { id: "error-is-not-no-data", prose: /is not an agent that found nothing/ },
  ],
};

describe("every prompt carries the rules its schema will enforce", () => {
  it("finds a prompt file for every agent", () => {
    for (const agent of [...OBSERVING_AGENTS, "root-cause"] as AgentName[]) {
      expect(readPrompt(agent), `no prompt for ${agent}`).toBeTruthy();
    }
  });

  for (const [agent, rules] of Object.entries(REQUIRED_RULES)) {
    it(`states every required rule in the ${agent} prompt, in both id and prose`, () => {
      const p = readPrompt(agent as AgentName)!;
      for (const rule of rules) {
        expect(p, `${agent}: rule id ${rule.id} is not declared`).toContain(`\`${rule.id}\``);
        expect(rule.prose.test(p), `${agent}: rule ${rule.id} has no prose behind its id`).toBe(true);
      }
    });
  }

  it("shows no citation a model could copy into a refusal", () => {
    /*
     * Grok, 2026-09-05, before the first paid run: the kubernetes example wrote
     * `"source_ref": "..."`. A model copying it produces something the schema
     * accepts — minLength is 1 — and recordAgentResult then refuses, because
     * the path resolves to nothing. The answer is thrown away for the shape of
     * an example rather than for anything the model got wrong.
     *
     * So every citation shown in a prompt must look like a path. This is a
     * check on the EXAMPLES, which are the part of a prompt a model copies
     * most literally.
     */
    for (const agent of ["kubernetes", "logs", "metrics", "root-cause"] as AgentName[]) {
      const text = readPrompt(agent)!;
      const cited = [
        ...text.matchAll(/"source_ref":\s*"([^"]*)"/g),
        ...text.matchAll(/"supported_by":\s*\[\s*"([^"]*)"/g),
      ].map((m) => m[1]!);
      expect(cited.length, `${agent} shows no citation at all; this test would pass on nothing`).toBeGreaterThan(0);
      for (const ref of cited) {
        expect(ref, `${agent} shows a placeholder where a model expects a path`).not.toMatch(/^\.*$/);
        expect(ref, `${agent} shows a citation that is not a path`).toMatch(/^[a-z_]+(\[\d+\])?(\.[a-z_]+(\[\d+\])?)*$/i);
      }
    }
  });

  it("shows only citations that resolve in every scenario, not merely in one", () => {
    /*
     * Grok, 2026-09-05, third round, on the fix for its own second-round
     * finding: "the same defect one level up". A placeholder was replaced with
     * a realistic path, and a realistic path resolves only where that thing
     * happened. For an image-pull failure or a probe failure, the example in
     * the prompt IS an answer that would be thrown away — so a model copying it
     * is punished for following the instructions.
     *
     * The examples now cite `collected_at`, which every observation carries.
     * This is what holds that: each shown citation is resolved against every
     * scenario's real fixture for that agent's slot.
     */
    const slots: Record<string, string> = { kubernetes: "kubernetes", logs: "logs", metrics: "metrics" };
    const scenarios = listScenarios(SCENARIOS);
    expect(scenarios.length, "no scenarios; this test would pass on nothing").toBeGreaterThan(0);

    for (const [agent, slot] of Object.entries(slots)) {
      /*
       * A citation marked SCENARIO-SPECIFIC is exempt, and that marker is the
       * whole point of it. Codex, 2026-09-06, asked for a worked example whose
       * first finding is the event that names the cause — and this very test,
       * added after Grok found the same defect one level up, refuses a path
       * that resolves only where that thing happened.
       *
       * Both are right. The way out is not to weaken either: an example
       * labelled for one kind of incident is not a template, and the label is
       * in the text the model reads, not only in this test.
       */
      const cited = citationsOutsideScopedExamples(readPrompt(agent as AgentName)!);
      expect(cited.length, `${agent} shows no citation`).toBeGreaterThan(0);

      for (const scenario of scenarios) {
        const o = readSlot(scenario, slot as never, SCENARIOS);
        if (o.state !== "collected") continue;
        for (const ref of cited) {
          expect(resolveRef(o.data, ref), `${agent}'s example cites ${ref}, which does not resolve in ${scenario}`)
            .not.toBeUndefined();
        }
      }
    }
  });

  it("shows no example whose hypothesis cites something its own findings do not", () => {
    /*
     * Grok, 2026-09-05, fourth round: the kubernetes example paired a finding
     * with a hypothesis citing it, and the natural way to answer is to rewrite
     * the finding and leave the hypothesis alone — after which supported_by
     * names a citation that is no longer in findings, and the answer is
     * refused for a coupling the example created.
     *
     * The kubernetes example now shows an empty hypotheses list. Where an
     * example does show one, as root-cause must, the two halves have to agree —
     * otherwise the prompt ships an answer its own rules reject.
     */
    for (const agent of ["kubernetes", "logs", "metrics", "root-cause"] as AgentName[]) {
      const text = readPrompt(agent)!;
      const refs = new Set([...text.matchAll(/"source_ref":\s*"([^"]*)"/g)].map((m) => m[1]!));
      const supported = [...text.matchAll(/"supported_by":\s*\[\s*"([^"]*)"/g)].map((m) => m[1]!);
      for (const one of supported) {
        expect(refs.has(one), `${agent}'s example supports a hypothesis with ${one}, which its findings never cite`)
          .toBe(true);
      }
    }
  });

  it("names, for every allowed cause code, what observes it", () => {
    /*
     * Grok, 2026-09-06: three of the six codes had a sentence saying what points
     * at them and three had none, while the only worked example was
     * CONTAINER_OOM. A model that does emit a code maps whatever it has onto
     * the example it was shown.
     */
    const text = readPrompt("root-cause")!;
    const codes = ["CONTAINER_OOM", "CPU_THROTTLING", "IMAGE_PULL_FAILURE",
      "READINESS_PROBE_FAILURE", "APPLICATION_STARTUP_FAILURE", "DEPLOYMENT_REGRESSION"];
    for (const code of codes) {
      const row = text.split("\n").find((l) => l.startsWith(`| \`${code}\``));
      expect(row, `${code} has no row saying what observes it`).toBeDefined();
      expect(row!.split("|")[2]!.trim().length, `${code}'s row says nothing`).toBeGreaterThan(20);
    }
  });

  it("offers no confidence band for naming a cause on circumstantial evidence", () => {
    /*
     * Grok, 2026-09-06: a band of 0.4 to 0.6 for "circumstantial evidence only"
     * sat one line from the rule that circumstantial findings do not settle
     * anything. A number available for the nearest code at half confidence is
     * an invitation to name it.
     */
    const text = readPrompt("root-cause")!;
    const row = text.split("\n").find((l) => l.includes("circumstantial evidence only"));
    expect(row, "the row is gone; this test no longer checks anything").toBeDefined();
    expect(row, "circumstantial evidence has a band again").not.toMatch(/0\.\d\s*to\s*0\.\d/);
    expect(row).toContain("INSUFFICIENT_EVIDENCE");
  });

  it("does not both require and forbid naming a cause from one finding", () => {
    /*
     * Codex and Grok, independently, 2026-09-06: the prompt said a finding
     * pointing at a code makes that code the hypothesis, AND that naming a
     * cause because one finding points at it is the failure this agent exists
     * to avoid. A model obeying the second returned nothing, which is exactly
     * what the live run did. The distinction is directness, not count.
     */
    const text = readPrompt("root-cause")!;
    expect(text, "the old count-based prohibition is back")
      .not.toMatch(/Naming a cause because one finding points at it is the failure/);
    expect(text).toMatch(/observes the cause itself/);
    expect(text).toMatch(/circumstantial/);
  });

  it("asks each agent only for what its own slot can answer", () => {
    /*
     * Measured live twice in one run, 2026-09-06. The rule "cite the limit a
     * fact is measured against" was in all three specialist prompts, and two of
     * the three cannot obey it: the limits, the image and the replica count are
     * in the Kubernetes observation, and the logs and metrics agents are handed
     * a different slot. So the metrics agent reported throttled time and nobody
     * cited the CPU limit — not disobedience, an impossible instruction.
     *
     * A prompt that asks for what its slot does not contain produces either a
     * refusal or an invented path. Both were seen.
     */
    for (const agent of ["logs", "metrics"] as AgentName[]) {
      const text = readPrompt(agent)!;
      expect(text, `${agent} is asked for configuration it was not given`)
        .not.toMatch(/report the value it was measured against|cite the limit/i);
      expect(text, `${agent} should say the configuration is not its to report`)
        .toMatch(/cannot see the configuration/);
    }
    // And the one that CAN see it is told to report it even when nothing looks
    // wrong, because that is the case where nobody thought to.
    const kube = readPrompt("kubernetes")!;
    expect(kube, "the kubernetes prompt must ask for it when the cluster looks healthy")
      .toMatch(/nothing wrong at all/);

    /*
     * And the two rules must not fight. Grok, 2026-09-06: the configuration row
     * collided with "if the observation shows nothing relevant, return no_data
     * — inventing a finding to avoid an empty list is not an answer", and a
     * model reading both returns no_data for a healthy cluster. That is exactly
     * the CPU-throttling case. The distinction is symptom versus emptiness.
     */
    expect(kube, "the old wording makes a healthy cluster report nothing")
      .not.toMatch(/If the observation shows nothing relevant/);
    expect(kube).toMatch(/No symptom is not the same as nothing/);
    expect(kube, "and reporting a real limit must be named as not inventing")
      .toMatch(/is not inventing a finding/);

    /*
     * Measured live on 2026-09-06, in the run immediately after the rule was
     * added: for an image-pull failure the agent reported three configuration
     * findings and not the event saying the image could not be pulled, which
     * it had cited the run before. A new duty displaced the one that mattered,
     * and the scenario went from right-code to wrong.
     */
    /*
     * Rewritten on 2026-09-07. Grok read the whole file and showed four rules
     * added in two days each undoing the last: the configuration duty
     * displaced the event, the symptom-first correction displaced the
     * configuration duty, "do not diagnose" displaced the event again because
     * the example's own words were a conclusion, and the healthy-cluster row
     * displaced no_data. A fifth patch was not the answer.
     *
     * What holds now is the shape: one section saying what to report, symptom
     * before configuration, with the event as a first-class output rather than
     * something the tables never mention.
     */
    /*
     * Measured 2026-09-07, three runs out of three: the agent cited three
     * symptoms and no configuration at all. Ranking the two made the lower one
     * vanish, for the fifth time in three days. So the prompt states a
     * completeness requirement rather than a priority — priorities compete,
     * and something always loses.
     */
    expect(kube, "the answer must be stated as two required parts, not two priorities")
      .toMatch(/Your answer has two parts, and it is incomplete without either/);
    expect(kube, "and the configuration half must be named as the one that gets dropped")
      .toMatch(/it is the half most often\s*\n?dropped/);
    expect(kube, "and the event must be named as an output, not left to inference")
      .toMatch(/\| `events` \| every event that shows something wrong/);
    // And "do not diagnose" must not forbid quoting what an event says, which
    // is what made a model drop the one finding that named the cause.
    expect(kube, "quoting an event must be distinguished from diagnosing")
      .toMatch(/Reporting what an event says is not\s*\n?diagnosing/);

    /*
     * Grok, 2026-09-07, on the rewrite: the file said naming the cause is
     * another agent's work and then handed over a list of cause codes. A model
     * resolves that whichever way the shape in front of it suggests.
     */
    expect(kube, "the code list must say why it is there, not invite filling it in")
      .toMatch(/Usually you return no hypotheses at all/);
    /*
     * And deduplication read loosely drops the finding that names the cause: an
     * event and a pod state are different sources, not two spellings of one.
     */
    expect(kube, "an event and a pod state must not be deduplicated into one")
      .toMatch(/Two things are equivalent only when they say the same thing/);

    // Codex, 2026-09-06: ordering words is weak; a worked example whose first
    // finding is the event guides the answer without rejecting it afterwards.
    expect(kube, "the prompt must show what an answer looks like, not only order it")
      .toMatch(/EXAMPLE FOR ONE INCIDENT[\s\S]*?"source_ref": "events\[0\]\.message"/);
    // And the label must be around the example, not inside a citation: a marker
    // in the source_ref demonstrates a path this system would refuse.
    expect(kube, "a scoped label must not sit inside a shown citation")
      .not.toMatch(/"source_ref":\s*"[A-Z-]+ /);
    // And "report every one that shows something wrong" invites a padded list
    // that buries the finding naming the cause.
    expect(kube).toMatch(/Report every distinct symptom; report each one once/);
  });

  it("declares no rule id that no test knows about", () => {
    // A prompt could otherwise grow an id that looks checked and is not.
    for (const [agent, rules] of Object.entries(REQUIRED_RULES)) {
      const declared = [...readPrompt(agent as AgentName)!.matchAll(/^- `([a-z-]+)`$/gm)].map((m) => m[1]);
      expect(declared.sort(), `${agent} declares ids no test covers`).toEqual(rules.map((r) => r.id).sort());
    }
  });

  it("states the code rule in the kubernetes prompt, in both id and prose", () => {
    // Named statically because a mutation points at it. The generated per-agent
    // test cannot be a mutation target: a name built inside a loop is not
    // findable in the source, and the mutation would report as surviving.
    const p = readPrompt("kubernetes")!;
    expect(p, "the rule id is not declared").toContain("`hypothesis-code-from-the-list`");
    expect(/A hypothesis `code` must be one of these, exactly/.test(p), "the id is declared but the prose is gone").toBe(true);
  });

  it("lists every allowed code in the root cause prompt, including its own verdict", () => {
    // Also asserts the prose, so removing the heading fails here rather than
    // leaving a bare list nobody introduced.
    const heading = readPrompt("root-cause")!;
    expect(/The `root_cause_code` must be one of these, exactly/.test(heading), "the heading that introduces the list is gone").toBe(true);
    // Codex, 2026-09-05: the fix covered the observing agents and left the final
    // step — the one whose answer the incident actually carries — able to invent
    // an identifier exactly as the first real call did.
    const p = readPrompt("root-cause")!;
    for (const code of CAUSE_CODES) expect(p, `root-cause prompt does not list ${code}`).toContain(`\`${code}\``);
    // The verdict is no longer a value it may return: an empty hypothesis list
    // is how insufficient evidence is expressed, because the shared code list
    // does not contain it and the schema refuses anything outside that list.
    expect(p, "root-cause prompt does not say how to express insufficient evidence")
      .toContain("return **no hypotheses at all**");
  });

  it("never mentions INSUFFICIENT_EVIDENCE in an observing prompt at all", () => {
    // It names no cause. An observing agent holding it as a hypothesis would be
    // asserting the absence of an explanation from one slot of evidence.
    //
    // Codex, 2026-09-05: this used to split on a heading and search what came
    // after, which missed the value appearing BEFORE the heading, missed a
    // changed heading entirely because the fallback was an empty string that
    // contains nothing, and missed anything after a second occurrence. There is
    // no legitimate reason for these prompts to mention the verdict anywhere,
    // so the whole file is checked and the special case disappears.
    for (const agent of OBSERVING_AGENTS) {
      expect(readPrompt(agent)!, `${agent} mentions INSUFFICIENT_EVIDENCE, which is the root cause agent's alone`)
        .not.toContain("INSUFFICIENT_EVIDENCE");
    }
  });

  it("lists every allowed hypothesis code in every prompt that may propose one", () => {
    // Measured 2026-09-05, on the first real model call: the answer used "H1",
    // an identifier it invented, because the prompt showed the field and never
    // said what may go in it. The schema refused the whole result. A prompt that
    // omits the allowed values is asking for a guess.
    const allowed = CAUSE_CODES;
    // Grok, 2026-09-05: a double loop with the non-empty guard living in
    // another it() passes vacuously if the shared enum is ever emptied, while
    // still looking like coverage of the invented-identifier failure.
    expect(allowed.length, "the shared code list is empty; this test would pass on nothing").toBeGreaterThan(0);
    expect(OBSERVING_AGENTS.length).toBeGreaterThan(0);
    for (const agent of OBSERVING_AGENTS) {
      const p = readPrompt(agent)!;
      for (const code of allowed) {
        expect(p, `${agent} prompt does not list ${code}`).toContain(`\`${code}\``);
      }
    }
  });

  it("keeps one carrier for the cause codes, referenced rather than repeated", () => {
    // Codex, 2026-09-05: two enums that a test compares can still be written
    // apart and only caught afterwards — and one such drift had already made a
    // scenario unsolvable. They are one list now, and both schemas point at it.
    const hypothesisRef = agentResultSchema.properties.hypotheses.items.properties.code.$ref;
    const anyOf = incidentSchema.properties.analysis.properties.root_cause_code.anyOf as Array<{ $ref?: string }>;
    const causeRef = anyOf[0]?.$ref;
    expect(hypothesisRef, "the hypothesis code is not a reference").toContain("common.schema.json#/$defs/causeCode");
    expect(causeRef, "the root cause code is not a reference").toBe(hypothesisRef);
    expect(CAUSE_CODES.length).toBeGreaterThan(0);
    expect(CAUSE_CODES, "the shared list must not offer the verdict as a cause").not.toContain("INSUFFICIENT_EVIDENCE");
  });

  it("requires the root cause agent to cite only what agents reported", () => {
    // The rule Codex found missing from the tests entirely. Named statically
    // because a mutation points at it, and a name built inside a loop cannot be
    // found in the source by that check.
    const p = readPrompt("root-cause")!;
    const rule = REQUIRED_RULES["root-cause"]!.find((r) => r.id === "cite-only-what-agents-reported")!;
    expect(p, "the rule id is not declared").toContain("`cite-only-what-agents-reported`");
    expect(rule.prose.test(p), "the rule id is declared but its prose is gone").toBe(true);
  });
});

describe("an agent receives one incident and one slot", () => {
  it("gives every observing agent only the slot it reads, by exact shape", () => {
    // Grok, 2026-09-05: this asserted the absence of two distinctive strings,
    // so an empty sibling slot, or one whose values happened to lack those
    // words, would have passed as isolation. And only kubernetes was ever asked
    // for exact keys; metrics never was.
    const inc = incident("INC-2026-0101");
    const expected: Record<string, unknown> = { kubernetes: K8S, logs: LOGS, metrics: METRICS };
    for (const slot of OBSERVING_AGENTS) {
      const r = assembleObservingContext(slot, inc);
      expect(r.state, `${slot} did not assemble`).toBe("assembled");
      if (r.state !== "assembled") continue;
      expect(Object.keys(r.payload).sort(), `${slot} payload keys`).toEqual(["incident_id", "observation"]);
      expect(r.payload.observation, `${slot} got the wrong slot`).toEqual(expected[slot]);
      for (const other of OBSERVING_AGENTS) {
        if (other === slot) continue;
        expect(deepDiffPaths(r.payload.observation, expected[other]).length,
          `${slot} received something equal to the ${other} slot`).toBeGreaterThan(0);
      }
    }
  });

  it("copies only what was asked for, so an unknown field cannot ride along", () => {
    // An allow-list cannot be surprised by a field nobody thought of, because it
    // never copies one. A deny-list would have to anticipate every one of them.
    const withExtra = incident("INC-2026-0101", { secret_notes: "INC-2026-0909 was worse" });
    const r = assembleObservingContext("kubernetes", withExtra);
    expect(r.state).toBe("assembled");
    if (r.state !== "assembled") return;
    expect(Object.keys(r.payload).sort()).toEqual(["incident_id", "observation"]);
    expect(JSON.stringify(r.payload)).not.toContain("INC-2026-0909");
  });

  it("refuses rather than guessing when the slot was never collected", () => {
    const r = assembleObservingContext("metrics", incident("INC-2026-0101", {
      observations: { kubernetes: K8S, logs: LOGS, metrics: null },
    }));
    expect(r.state).toBe("unavailable");
    if (r.state !== "unavailable") return;
    expect(r.reason).toContain("nothing was collected");
  });

  it("refuses an incident with no id, since nothing could be checked afterwards", () => {
    const { incident_id, ...rest } = incident("INC-2026-0101");
    const r = assembleObservingContext("logs", rest as Record<string, unknown>);
    expect(r.state).toBe("unavailable");
  });

  it("gives the root cause agent the agent results and NOT the observations", () => {
    // It must weigh what the agents reported. Handing it the raw observations
    // would let it introduce a fact with nothing behind it to trace.
    const r = assembleRootCauseContext(incident("INC-2026-0101"));
    expect(r.state).toBe("assembled");
    if (r.state !== "assembled") return;
    expect(Object.keys(r.payload).sort()).toEqual(["agent_results", "incident_id"]);
    expect(JSON.stringify(r.payload)).not.toContain("container_memory_working_set_bytes");
  });

  it("refuses to ask for a conclusion when no agent ran", () => {
    const r = assembleRootCauseContext(incident("INC-2026-0101", { analysis: { agents: [] } }));
    expect(r.state).toBe("unavailable");
    if (r.state !== "unavailable") return;
    expect(r.reason).toContain("no agent results");
  });
});

describe("the example in a prompt is the shape a model copies", () => {
  /** The first fenced JSON block in a prompt, which is what a model imitates. */
  const exampleIn = (agent: AgentName): unknown => {
    const m = readPrompt(agent)!.match(/```json\n([\s\S]*?)```/);
    if (m === null) return null;
    try {
      return JSON.parse(m[1]!.replace(/"\.\.\."/g, '"placeholder"').replace(/\[\s*"placeholder"\s*\]/g, '["placeholder"]'));
    } catch {
      return null;
    }
  };

  it("tells the metrics agent where the unit goes, not merely that it must appear", () => {
    // Measured on 2026-09-05, on a real call: the model answered with `value`
    // and `unit` as separate fields and no `fact`, refused twice over. The
    // instruction said to state the unit and never said where, so the model put
    // it where a schema would naturally have it — and this schema does not.
    const p = readPrompt("metrics")!;
    expect(p, "the prompt does not say the unit belongs in the fact text").toContain("inside the `fact` text");
    expect(p, "the prompt does not say which fields a finding has").toMatch(/exactly three fields/);
  });

  it("shows the root cause agent an example the validator would accept", () => {
    // Named statically because a mutation points at it. Grok and Codex, both on
    // 2026-09-05: this prompt showed an object with root_cause_code at the top
    // level, which agent-result refuses — the call was guaranteed wasted
    // whatever the model answered. The example is the shape a model copies, and
    // nothing checked it.
    const example = exampleIn("root-cause");
    expect(example, "root-cause has no parsable JSON example").not.toBeNull();
    const r = validate("agent-result", example);
    expect(r.state, `root-cause example: ${JSON.stringify(r)}`).not.toBe("invalid");
  });

  for (const agent of ["kubernetes"] as AgentName[]) {
    it(`shows ${agent} an example the validator would accept`, () => {
      // Grok and Codex, independently on 2026-09-05: the root-cause prompt
      // showed an object with root_cause_code and evidence at the top level,
      // which agent-result refuses outright — so that call was guaranteed
      // wasted whatever the model answered. The example is the shape a model
      // copies, and nothing checked it.
      const example = exampleIn(agent);
      expect(example, `${agent} has no parsable JSON example`).not.toBeNull();
      const r = validate("agent-result", example);
      expect(r.state, `${agent} example: ${JSON.stringify(r)}`).not.toBe("invalid");
    });
  }

  it("names the agent in its own example, so a copied reply is not attributed elsewhere", () => {
    expect((exampleIn("kubernetes") as { agent?: string }).agent).toBe("kubernetes");
    expect((exampleIn("root-cause") as { agent?: string }).agent).toBe("root_cause");
  });
});

describe("nothing reaches a model except through the checked path", () => {
  it("refuses a contaminated incident rather than assembling from it", () => {
    // Codex, 2026-09-05: both checks existed and neither was called anywhere but
    // in tests — "the appearance of a two-stage guard without wiring either
    // stage into the boundary". A check nobody calls is a comment.
    const contaminated = incident("INC-2026-0101", {
      observations: { kubernetes: K8S, metrics: METRICS,
        logs: { ...LOGS, lines: [...LOGS.lines, { ts: "2026-09-04T10:00:00Z", level: "info", container: "c", message: "see INC-2026-0909" }] } },
    });
    // The unchecked path still builds it — that is what makes the checked one worth having.
    expect(assembleObservingContext("logs", contaminated).state).toBe("assembled");
    const r = assembleCheckedContext("logs", contaminated);
    expect(r.state).toBe("unavailable");
    if (r.state !== "unavailable") return;
    expect(r.reason).toContain("INC-2026-0909");
  });

  it("assembles a clean incident through the checked path", () => {
    const r = assembleCheckedContext("kubernetes", incident("INC-2026-0101"));
    expect(r.state).toBe("assembled");
  });

  it("checks the root cause context too, not only the observing ones", () => {
    const contaminated = incident("INC-2026-0101", {
      analysis: { agents: [{ ...AGENT_RESULT, findings: [{ fact: "from INC-2026-0909", source_ref: "r" }] }] },
    });
    expect(assembleCheckedContext("root-cause", contaminated).state).toBe("unavailable");
  });

  it("refuses when the source cannot be checked at all", () => {
    // No id means nothing can be compared against anything. Not clean.
    expect(assembleCheckedContext("logs", { observations: { logs: LOGS } }).state).toBe("unavailable");
  });
});

describe("two separate questions: did the assembler add anything, and is the source clean", () => {
  it("passes a context that is exactly the slice it was supposed to be", () => {
    const inc = incident("INC-2026-0101");
    expect(checkPayloadIsExactlyTheSlice(assembleObservingContext("kubernetes", inc), inc)).toEqual({ state: "clean" });
  });

  it("catches content added to the payload after assembly", () => {
    // Note what this does and does not say. It adds the line AFTER assembling,
    // so the payload departs from the slice and the difference is visible.
    const inc = incident("INC-2026-0101");
    const leaked = assembleObservingContext("logs", inc);
    expect(leaked.state).toBe("assembled");
    if (leaked.state !== "assembled") return;
    (leaked.payload.observation as { lines: unknown[] }).lines.push({
      ts: "2026-09-04T10:00:00Z", level: "info", container: "other",
      message: "customer B database password is hunter2",
    });
    const r = checkPayloadIsExactlyTheSlice(leaked, inc);
    expect(r.state).toBe("foreign");
    if (r.state !== "foreign") return;
    expect(r.paths.some((p) => p.includes("lines")), "the report must name where it departed").toBe(true);
  });

  it("does NOT catch the same content when it is already in the slice", () => {
    // Grok, 2026-09-05, and verified before accepting: a payload compared
    // against a re-copy of its own source cannot see contamination that was in
    // the source. This test exists so the limit is stated rather than
    // discovered — a green suite must not read as "no leak can get through".
    const contaminated = incident("INC-2026-0101", {
      observations: { ...incident("INC-2026-0101").observations,
        logs: { ...LOGS, lines: [...LOGS.lines, {
          ts: "2026-09-04T10:00:00Z", level: "info", container: "other",
          message: "customer B database password is hunter2" }] } },
    });
    const ctx = assembleObservingContext("logs", contaminated);
    expect(checkPayloadIsExactlyTheSlice(ctx, contaminated).state,
      "if this ever returns foreign, the check has grown a power its name does not claim").toBe("clean");
  });

  it("catches a named property hung on an array, which indices alone would miss", () => {
    // Grok, 2026-09-05, twice: only indices and length were compared, so
    // lines.smuggled = "…" produced no path while an extra key on a plain
    // object did. And then this test drove only the helper, so the check could
    // have stopped using it and stayed green. It goes through the check now,
    // and names the path rather than counting.
    const withProp: unknown[] = [1, 2];
    (withProp as unknown as Record<string, unknown>).smuggled = "hunter2";
    expect(deepDiffPaths([1, 2], withProp)).toContain("/smuggled");

    const inc = incident("INC-2026-0101");
    const ctx = assembleObservingContext("logs", inc);
    if (ctx.state !== "assembled") throw new Error("not assembled");
    ((ctx.payload.observation as { lines: unknown[] }).lines as unknown as Record<string, unknown>).smuggled = "hunter2";
    const r = checkPayloadIsExactlyTheSlice(ctx, inc);
    expect(r.state, "a property hung on an array inside the payload must be caught by the check itself").toBe("foreign");
  });

  it("asks the source about foreign incidents, which comparing to the source cannot", () => {
    // The question the previous names claimed and never asked. It recognises
    // ids and nothing more, which is stated where it is defined.
    const clean = incident("INC-2026-0101");
    expect(checkSourceForForeignIncidents(clean)).toEqual({ state: "clean" });

    // Grok, 2026-09-05: this used to put the foreign id on a top-level `note`,
    // a field the assembler drops anyway — so the test never asked about the
    // path the model actually receives. It goes in the observation now.
    const contaminated = incident("INC-2026-0101", {
      observations: { kubernetes: K8S, metrics: METRICS,
        logs: { ...LOGS, lines: [...LOGS.lines, { ts: "2026-09-04T10:00:00Z", level: "info", container: "c", message: "see INC-2026-0909" }] } },
    });
    const r = checkSourceForForeignIncidents(contaminated);
    expect(r.state).toBe("contaminated");
    if (r.state !== "contaminated") return;
    expect(r.foreign).toEqual(["INC-2026-0909"]);

    // ...and the id really is on the path the agent is handed, so this is a
    // check about what the model sees rather than about a discarded field.
    const ctx = assembleObservingContext("logs", contaminated);
    expect(ctx.state).toBe("assembled");
    if (ctx.state !== "assembled") return;
    expect(JSON.stringify(ctx.payload)).toContain("INC-2026-0909");
    expect(checkPayloadIsExactlyTheSlice(ctx, contaminated).state,
      "the slice check cannot see in-slice contamination — that is why the source check exists").toBe("clean");
  });

  it("records the content-level gap where a thing nothing can check belongs", () => {
    // It began as a test requiring the password to pass, which would have failed
    // the day detection improved — entrenching a weakness rather than recording
    // it. Then it required a debt entry. Provenance has since closed the half
    // that was checkable: whether the observation was asked for, for this
    // incident, from this cluster, in one collection.
    //
    // What remains cannot be checked by this repository at all. A provider can
    // hand back a legitimately requested observation with somebody else's line
    // inside it, and nothing downstream can tell. So it sits among the things
    // the gate prints and cannot decide, rather than a debt that will come due.
    const entry = (LIMITATIONS as string[]).find((l) => l.includes("belonging to anyone else"));
    expect(entry, "the content-level gap is recorded nowhere").toBeDefined();
  });

  it("reports unchecked, not clean, for a source with no id of its own", () => {
    expect(checkSourceForForeignIncidents({}).state).toBe("unchecked");
  });

  it("catches a foreign incident id too, since that also departs from the slice", () => {
    const inc = incident("INC-2026-0101");
    const ctx = assembleObservingContext("kubernetes", inc);
    if (ctx.state !== "assembled") throw new Error("not assembled");
    (ctx.payload as Record<string, unknown>).also = "see INC-2026-0909";
    const r = checkPayloadIsExactlyTheSlice(ctx, inc);
    expect(r.state).toBe("foreign");
    // Grok, 2026-09-05: asserting only the state meant any extra property
    // satisfied a test named for catching a foreign incident id.
    if (r.state !== "foreign") return;
    expect(r.paths, "the report must name where the id appeared").toContain("/also");
  });

  it("names where the payload departed, not merely that it did", () => {
    const inc = incident("INC-2026-0101");
    const ctx = assembleObservingContext("metrics", inc);
    if (ctx.state !== "assembled") throw new Error("not assembled");
    (ctx.payload.observation as { series: Array<{ unit: string }> }).series[0]!.unit = "furlongs";
    const r = checkPayloadIsExactlyTheSlice(ctx, inc);
    expect(r.state).toBe("foreign");
    if (r.state !== "foreign") return;
    expect(r.paths[0]).toContain("/observation/series/0/unit");
  });

  it("reports unchecked, not clean, when the context could not be assembled", () => {
    // Nothing to inspect is not the absence of a leak. Reporting clean here
    // would mean a context that was never built passes the isolation check.
    const inc = incident("INC-2026-0101", { observations: { kubernetes: K8S, logs: LOGS, metrics: null } });
    expect(checkPayloadIsExactlyTheSlice(assembleObservingContext("metrics", inc), inc).state).toBe("unchecked");
  });

  it("does not let a later mutation of the incident change a checked context", () => {
    // Codex, chunk 2: the payload used to hold a live reference into the
    // incident, so data could travel after the check that was meant to stop it.
    //
    // Grok, 2026-09-05: the assertion was the absence of one INC string — the
    // recognised-id proxy this file says is not evidence. It compares the whole
    // payload against a snapshot taken before the mutation now, so ANY change
    // fails, not only one carrying that substring.
    const inc = incident("INC-2026-0101");
    const ctx = assembleObservingContext("logs", inc);
    if (ctx.state !== "assembled") throw new Error("not assembled");
    // Grok, 2026-09-05: it never called the check, so deleting the check
    // entirely left this green. It establishes copy-versus-alias only if the
    // check is what declared the context sound in the first place.
    expect(checkPayloadIsExactlyTheSlice(ctx, inc).state, "the context was not sound to begin with").toBe("clean");
    const before = JSON.parse(JSON.stringify(ctx.payload));
    (inc.observations.logs as { lines: unknown[] }).lines.push({ ts: "x", level: "info", container: "c", message: "anything at all" });
    expect(deepDiffPaths(before, ctx.payload), "the payload moved after it was checked").toEqual([]);
  });

  it("ignores an inherited slot, which no one put in the incident", () => {
    const base = { observations: { kubernetes: { poisoned: true } } };
    const inc = Object.create(base) as Record<string, unknown>;
    inc.incident_id = "INC-2026-0101";
    const r = assembleObservingContext("kubernetes", inc);
    expect(r.state).toBe("unavailable");
  });

  it("keeps the id scan as a separate, weaker check that says what it is", () => {
    // It catches one specific mistake quickly. It is not evidence of isolation,
    // and the name says so.
    expect(foreignIncidentIds({ a: "INC-2026-0909" }, "INC-2026-0101")).toEqual(["INC-2026-0909"]);
    expect(foreignIncidentIds({ "INC-2026-0007": 1 }, "INC-2026-0101")).toEqual(["INC-2026-0007"]);
    expect(foreignIncidentIds({ a: [[["INC-2026-0101"]]] }, "INC-2026-0101")).toEqual([]);
    // ...and it cannot see this at all, which is why it is not the main check.
    expect(foreignIncidentIds({ a: "customer B password hunter2" }, "INC-2026-0101")).toEqual([]);
  });

  it("reports a length change in an array rather than only element differences", () => {
    expect(deepDiffPaths([1, 2], [1, 2, 3])).toContain("/(length)");
  });

  it("maps every observing agent to a distinct slot, and root cause to none", () => {
    const slots = OBSERVING_AGENTS.map((a) => AGENT_SLOT[a]);
    expect(new Set(slots).size).toBe(OBSERVING_AGENTS.length);
    expect(AGENT_SLOT["root-cause"]).toBeNull();
  });
});
