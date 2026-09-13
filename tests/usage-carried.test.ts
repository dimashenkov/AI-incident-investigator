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

// A stub wrapper that stamps which MODEL answered each agent — the fallback
// announcement (Grok, 2026-09-13). A run where root-cause was served by Grok must
// leave the chain saying so, or eval cannot tell a failover from a normal run.
const withModel = (base: Record<string, Stub>, models: Record<string, string>): Record<string, Stub> => {
  const out: Record<string, Stub> = {};
  for (const [agent, stub] of Object.entries(base)) {
    out[agent] = (payload) => {
      const said = stub(payload);
      if (said === null) return said;
      return { ...said, __model: models[agent] ?? "gpt-5" };
    };
  }
  return out;
};

describe("which model answered leaves the chain — the fallback announcement", () => {
  it("records model_by_agent, so a Grok failover is visible to the record and to eval", async () => {
    const out = await runScenario("container-oom",
      withModel(STUB_AGENTS, { "root-cause": "grok-4.3" }));
    const by = out["model_by_agent"] as Record<string, string>;
    expect(by, "the field must survive Record and Conclude, not be dropped").toBeDefined();
    expect(by["root-cause"], "root-cause was served by the fallback and the record says so").toBe("grok-4.3");
    expect(by["kubernetes"], "the others were the primary").toBe("gpt-5");
  });

  it("leaves model_by_agent empty when the reply names no model, rather than restating the pinned one", async () => {
    const out = await runScenario("container-oom", STUB_AGENTS);
    expect(out["model_by_agent"], "a reply that carried no model name is unestablished, not the pinned model")
      .toEqual({});
  });
});
