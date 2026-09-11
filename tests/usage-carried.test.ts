/**
 * What the call cost, carried out of the chain.
 *
 * The expression that reads `usage` from the model's reply was added on
 * 2026-09-10 and had NO test, because the harness's envelope could not produce
 * the field. A live run then came back with `usage_by_agent` empty while the
 * expression sat in the deployed node looking correct. A helper that cannot
 * produce a field hides every defect in reading it.
 */
import { describe, it, expect } from "vitest";
import { runScenario, STUB_AGENTS, type Stub } from "./helpers/run-workflow.js";

const withUsage = (base: Record<string, Stub>): Record<string, Stub> => {
  const out: Record<string, Stub> = {};
  for (const [agent, stub] of Object.entries(base)) {
    out[agent] = (payload) => {
      const said = stub(payload);
      if (said === null) return said;
      return {
        ...said,
        __usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      };
    };
  }
  return out;
};

describe("the cost of each call leaves the chain with the answer", () => {
  it("records usage for every agent that answered", async () => {
    const out = await runScenario("container-oom", withUsage(STUB_AGENTS));
    const by = out["usage_by_agent"] as Record<string, { prompt_tokens?: number; cached_tokens?: number }>;
    expect(by, "the field must exist at all").toBeDefined();
    expect(Object.keys(by).sort(), "one entry per agent that answered")
      .toEqual(["kubernetes", "logs", "metrics", "root-cause"]);
    expect(by["root-cause"]!.prompt_tokens, "and it is the number the reply carried").toBe(11);
    expect(by["root-cause"]!.cached_tokens, "including the cached part, which is billed differently")
      .toBe(3);
  });

  it("leaves it empty when the reply carries no usage, rather than inventing zeros", async () => {
    const out = await runScenario("container-oom", STUB_AGENTS);
    expect(out["usage_by_agent"], "a call whose cost nobody reported is not a call that cost nothing")
      .toEqual({});
  });
});
