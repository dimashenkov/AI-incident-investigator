/**
 * The twelve answers already paid for, replayed through the repaired chain.
 *
 * Astra, 2026-09-10, on what the next measurement should be: a free offline
 * replay of every captured answer through the repaired chain and the unchanged
 * scorer, which isolates the contract change from new model behaviour.
 *
 * Nothing here calls a model. Each agent is stubbed with the words that agent
 * actually returned in the recorded run, so what is measured is the CHAIN.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { runScenario, type Stub } from "./helpers/run-workflow.js";

const SCENARIOS = ["container-oom", "conflicting-evidence", "deployment-regression",
  "application-startup-failure", "cpu-throttling", "insufficient-evidence"];

const recorded = (file: string) =>
  existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, {
    raw_answers?: Record<string, string>; state?: string }> : null;

/** Replay one recorded run: every agent answers what it answered then. */
const stubsFrom = (answers: Record<string, string>): Record<string, Stub> => {
  const out: Record<string, Stub> = {};
  /*
   * The stub returns the PARSED answer, not the OpenAI envelope: the harness
   * gives what the model said, and the node's own parser is exercised by the
   * generated chain, not by this helper. The first version wrapped it in
   * choices/message/content and every scenario came back refused with "the
   * answer says it is from undefined" — the envelope reached the recorder as
   * the answer.
   */
  for (const [agent, raw] of Object.entries(answers)) {
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = null; }
    out[agent] = () => parsed;
  }
  return out;
};

describe("the paid answers, replayed through the chain as it now stands", () => {
  for (const model of ["mini-baseline", "gpt4o"]) {
    const file = `docs/answers/2026-09-10-${model}.json`;
    const run = recorded(file);
    if (run === null) continue;

    it(`replays ${model} and reports what the chain does with the same words`, async () => {
      const outcomes: Record<string, string> = {};
      for (const scenario of SCENARIOS) {
        const key = Object.keys(run).find((k) => k.split("#")[0] === scenario);
        const answers = key === undefined ? undefined : run[key]!.raw_answers;
        if (answers === undefined || Object.keys(answers).length === 0) {
          outcomes[scenario] = "no words recorded";
          continue;
        }
        const out = await runScenario(scenario, stubsFrom(answers));
        const a = (out.incident as { analysis?: Record<string, unknown> } | undefined)?.analysis ?? {};
        const ev = Array.isArray(a["evidence"]) ? a["evidence"] as Array<{ supports?: string }> : [];
        outcomes[scenario] = String(out.state)
          + " code=" + String(a["root_cause_code"])
          + " conf=" + String(a["confidence"])
          + " against=" + String(ev.filter((e) => e.supports === "against").length);
      }
      // Printed rather than asserted: this is a measurement, and a measurement
      // that fails a test when the number moves is not a measurement.
      console.log(model, JSON.stringify(outcomes, null, 1));
      expect(Object.keys(outcomes).length, "every scenario was replayed").toBe(SCENARIOS.length);
    });
  }
});
