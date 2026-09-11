/**
 * The one expression that builds a paid request, executed rather than matched.
 *
 * `tests/generate.test.ts` checked that the string CONTAINS `$json.prompt` and
 * `$json.payload`, and the run harness replaces every httpRequest node with a
 * stub — so nothing in the suite has ever evaluated the body that goes to
 * OpenAI. A subagent measured that on 2026-09-09, and named the failure it
 * would have caught: on 2026-09-05 an undefined prompt produced a 400 AFTER two
 * agents had already been paid.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error - plain .mjs script, no types
import { generate, MODEL, COLLECTION_MODEL } from "../scripts/generate-workflow.mjs";

type Node = { name: string; type: string; parameters: Record<string, any> };

/** Evaluate an httpRequest node's jsonBody the way n8n does, on one item. */
function runBodyExpression(node: Node, item: Record<string, unknown>): unknown {
  const raw = node?.parameters?.jsonBody;
  if (typeof raw !== "string" || !raw.startsWith("={{") || !raw.trimEnd().endsWith("}}")) {
    throw new Error("the request node no longer carries an n8n expression; this harness is testing nothing");
  }
  const body = raw.slice(raw.indexOf("{{") + 2, raw.lastIndexOf("}}"));
  const out = (new Function("$json", `"use strict"; return (${body});`) as (j: unknown) => unknown)(item);
  return out;
}

describe("the request that spends the money, evaluated rather than matched", () => {
  const ASKERS = ["Ask kubernetes", "Ask logs", "Ask metrics", "Ask root-cause"];

  it("builds a body OpenAI would accept, for every agent", async () => {
    const { workflow } = await generate();
    const byName = new Map((workflow.nodes as Node[]).map((n) => [n.name, n]));
    for (const name of ASKERS) {
      const node = byName.get(name);
      expect(node, `${name} is not in the generated workflow`).toBeDefined();
      const text = runBodyExpression(node!, {
        prompt: "you are an agent",
        payload: { incident_id: "INC-2026-0001", observation: { pods: [] } },
      });
      expect(typeof text, `${name} must send a JSON string`).toBe("string");
      const body = JSON.parse(text as string);
      /*
       * TWO pinned models since 2026-09-11, and which one is not decoration.
       *
       * `gpt-5` produced the dissent that thirty hypotheses on smaller models
       * never did, so the concluding agent keeps it. Four sequential gpt-5 calls
       * took 183 seconds against a gateway that cuts at 100, and the three
       * collection agents spent 6272 of the 9152 reasoning tokens on work that
       * is extraction. They ask the smaller one.
       */
      const expected = name === "Ask root-cause" ? MODEL : COLLECTION_MODEL;
      expect(body.model, `${name} asks the model pinned for its job`).toBe(expected);
      /*
       * The sentence that stood here — „a run that cannot be repeated is not a
       * measurement" — is still true, and since 2026-09-11 this project cannot
       * have it. `gpt-5` refuses `temperature: 0` with HTTP 400, so the field is
       * not sent and the default of 1 applies.
       *
       * What is asserted now is the only thing that remains checkable: the
       * refused parameter is ABSENT, not present with some other value. The
       * loss of repeatability is in LIMITATIONS, where a reader of the number
       * will see it.
       */
      expect(body.temperature, "the parameter gpt-5 refuses is not sent at all").toBeUndefined();
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[0].content, "the prompt comes from the item").toBe("you are an agent");
      expect(body.messages[1].role).toBe("user");
      expect(JSON.parse(body.messages[1].content).incident_id).toBe("INC-2026-0001");
    }
  });

  it("produces a body with a null message rather than a valid one when the prompt is missing", async () => {
    /*
     * The measured failure: an item with no prompt produced a request OpenAI
     * refused with a 400, after two agents had been paid. The expression cannot
     * refuse — an n8n expression has no way to stop the node — so what this
     * pins is that the damage is VISIBLE in the body rather than hidden by a
     * default. A body that quietly substituted an empty string would send a
     * paid request with no instructions at all, which is worse than a 400.
     */
    const { workflow } = await generate();
    const node = (workflow.nodes as Node[]).find((n) => n.name === "Ask kubernetes")!;
    const body = JSON.parse(runBodyExpression(node, { payload: { x: 1 } }) as string);
    expect(body.messages[0].content, "a missing prompt must not become an empty instruction").toBeUndefined();
  });

  it("sends the payload as a string, not as an object", async () => {
    // `content` must be a string; an object here is a 400 after the call is made.
    const { workflow } = await generate();
    const node = (workflow.nodes as Node[]).find((n) => n.name === "Ask logs")!;
    const body = JSON.parse(runBodyExpression(node, {
      prompt: "p", payload: { deep: { nested: [1, 2, 3] } },
    }) as string);
    expect(typeof body.messages[1].content).toBe("string");
    expect(JSON.parse(body.messages[1].content)).toEqual({ deep: { nested: [1, 2, 3] } });
  });
});

/*
 * The OTHER paid request: the one this repository posts to the webhook.
 *
 * The file above covers the body that goes to OpenAI. Nothing covered the body
 * that starts the chain — the harness builds its own item, and the generate
 * tests read the workflow as text. So the one field a real call must carry was
 * the one field nothing checked, and three paid executions on 2026-09-07 came
 * back "no such scenario: undefined", refused at the first node.
 *
 * Nothing was spent on models: the refusal is before the first Ask. What was
 * spent is the run.
 */
describe("the body this repository posts to the webhook", () => {
  it("carries the scenario the Assemble node asks for", async () => {
    // @ts-expect-error - plain .mjs script, no types
    const { planFor } = await import("../scripts/run-scenarios.mjs");
    const plan = planFor(["container-oom", "image-pull-failure#2"]);
    expect(plan, "no plan; this would pass on an empty set").toHaveLength(2);
    expect(plan[0]!.alert.scenario, "Assemble reads body.scenario").toBe("container-oom");
    expect(plan[1]!.alert.scenario, "an attempt suffix is ours, not the chain's")
      .toBe("image-pull-failure");
    // And the alert's own fields survive: it is what a provider handed over.
    expect(plan[0]!.alert.id).toBeTruthy();
    expect(plan[0]!.alert.title).toBeTruthy();
  });

  it("names a scenario the deployed workflow actually carries", async () => {
    /*
     * The refusal message lists what the workflow holds. Comparing the two
     * lists here means a scenario added to disk and not regenerated into the
     * workflow fails before a call is bought, rather than after.
     */
    // @ts-expect-error - plain .mjs script, no types
    const { planFor } = await import("../scripts/run-scenarios.mjs");
    const { workflow } = await generate();
    const assemble = (workflow.nodes as Node[]).find((n) => n.name === "Assemble")!;
    const code = assemble.parameters.jsCode as string;
    for (const p of planFor(["container-oom", "conflicting-evidence"])) {
      expect(code, `the workflow does not carry ${p.alert.scenario}`)
        .toContain(`"${p.alert.scenario}"`);
    }
  });
});
