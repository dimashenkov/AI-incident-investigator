/**
 * The generated workflow is a derived artifact, and the risk is that it stops
 * being derived — that someone edits workflows/incident.json directly and the
 * file and the generator drift apart silently.
 *
 * Rewritten on 2026-09-05, when the workflow grew from two nodes to fifteen.
 * The old tests exercised a single Validate node through buildNodeCode, which
 * no longer exists; what each one was FOR is kept, asked of the new shape.
 * Behaviour of the chain end to end lives in workflow-run.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
// @ts-expect-error — plain .mjs, the same file node runs.
import { buildWorkflow, serialise, generate, WEBHOOK_PATH, MODEL } from "../scripts/generate-workflow.mjs";
// @ts-expect-error — plain .mjs, the same file node runs.
import { transpile, AGENT_ORDER } from "../scripts/workflow-runtime.mjs";

/**
 * A runtime small enough to read, with the same shape the real one has.
 *
 * Using the real 350 KB prelude here would make every assertion below a
 * statement about ajv's output rather than about the generator.
 */
const RUNTIME = { prelude: "// toy prelude\nconst validators = {};\n" };
const WF = buildWorkflow(RUNTIME);
const COMMITTED = new URL("../workflows/incident.json", import.meta.url).pathname;

const node = (name: string) => WF.nodes.find((n: { name: string }) => n.name === name);

describe("the workflow is generated, not written", () => {
  it("matches the committed file exactly, so a hand edit fails here", async () => {
    // The committed JSON exists to be compared against a deployment. If it can
    // be edited without anything noticing, the comparison proves nothing about
    // the generator — only that two files someone maintained by hand agree.
    expect(existsSync(COMMITTED), "workflows/incident.json is missing; regenerate it").toBe(true);
    expect(readFileSync(COMMITTED, "utf8")).toBe((await generate()).text);
  });

  it("is byte-identical across two generations from the same input", () => {
    // Any instability — a timestamp, a random id, unordered keys — would make
    // every drift comparison report a difference that means nothing.
    expect(serialise(buildWorkflow(RUNTIME))).toBe(serialise(buildWorkflow(RUNTIME)));
  });

  it("uses a fixed webhook path rather than a generated one", () => {
    expect(WEBHOOK_PATH).toMatch(/^[a-z0-9-]+$/);
    expect(JSON.stringify(WF)).toContain(WEBHOOK_PATH);
  });

  it("changes when the runtime changes, so a stale artifact cannot pass unnoticed", () => {
    const other = serialise(buildWorkflow({ prelude: RUNTIME.prelude + "// one more line\n" }));
    expect(other).not.toBe(serialise(WF));
  });
});

describe("the shape of the deployed chain", () => {
  it("asks every agent, in the order that lets the last one weigh the others", () => {
    // Order is not incidental: the root cause agent receives the other results
    // and never the observations, so running it first would give it nothing.
    expect(AGENT_ORDER).toEqual(["kubernetes", "logs", "metrics", "root-cause"]);
    for (const agent of AGENT_ORDER) {
      expect(node(`Ask ${agent}`), `no node asks ${agent}`).toBeDefined();
      expect(node(`Record ${agent}`), `no node records ${agent}`).toBeDefined();
    }
  });

  it("runs one unbroken line from the webhook to the conclusion", () => {
    // A branch that quietly ends is a run that produces no answer and no error.
    let at = "Incident Webhook";
    const visited = [at];
    for (let i = 0; i < 40 && WF.connections[at] !== undefined; i += 1) {
      at = WF.connections[at].main[0][0].node;
      visited.push(at);
    }
    expect(visited[visited.length - 1], `the chain ends at ${at}`).toBe("Conclude");
    expect(visited).toHaveLength(2 + AGENT_ORDER.length * 3 + 1);
  });

  it("declares node types and versions the instance actually has", () => {
    const types = [...new Set(WF.nodes.map((n: { type: string; typeVersion: number }) => `${n.type}@${n.typeVersion}`))];
    expect(types.sort()).toEqual([
      "n8n-nodes-base.code@2",
      "n8n-nodes-base.httpRequest@4.2",
      "n8n-nodes-base.set@3.4",
      "n8n-nodes-base.webhook@2",
    ]);
  });

  it("carries no credential material, only the name of a credential to use", () => {
    // A credential reference in a generated file is a credential reference in
    // git. Naming the type is how n8n is told which stored credential to use;
    // anything key-shaped appearing here must fail as a test first.
    const text = JSON.stringify(WF);
    expect(text).toContain("openAiApi");
    // Anchored and long: the loose version matched the node id "ask-kubernetes",
    // which is the shape of check that reports a problem where none exists and
    // gets deleted the first time it is inconvenient.
    expect(text).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}/);
    expect(text).not.toContain("Authorization");
  });

  it("pins the model and the temperature, so two runs can be compared", () => {
    expect(MODEL).toMatch(/^gpt-/);
    const ask = node("Ask kubernetes");
    expect(ask.parameters.jsonBody).toContain(MODEL);
    expect(ask.parameters.jsonBody).toContain("temperature: 0");
  });

  it("sends the prompt and payload from the item, never from the node", () => {
    // A node carrying its own prompt would be a second copy of what the context
    // assembler produced, and the isolation checks would then be checking
    // something other than what was sent.
    const ask = node("Ask metrics");
    expect(ask.parameters.jsonBody).toContain("$json.prompt");
    expect(ask.parameters.jsonBody).toContain("$json.payload");
    expect(ask.parameters.jsonBody, "the prompt text must not be baked into the node").not.toContain("You are given");
  });

  it("puts every Code node's prelude in, so none runs without the validators", () => {
    for (const n of WF.nodes.filter((x: { type: string }) => x.type === "n8n-nodes-base.code")) {
      expect(n.parameters.jsCode, `${n.name} has no prelude`).toContain(RUNTIME.prelude);
    }
  });
});

describe("what the transpiler refuses to deploy", () => {
  it("refuses a source that cannot run in the Code node, rather than shipping it", () => {
    /*
     * Found by running the workflow locally on 2026-09-05: a stray
     * import.meta.url survived transpiling and every node threw before doing
     * anything. The generator had no opinion, so the workflow was produced and
     * committed. This is that opinion.
     */
    expect(() => transpile("tests/fixtures/not-node-safe.ts")).toThrow(/import\.meta/);
  });

  it("catches a dynamic import, which the static-import pattern does not match", () => {
    // Codex, 2026-09-05: import(...) is the same unavailable thing spelled
    // differently, and the pattern anchored to the start of a line missed it.
    expect(() => transpile("tests/fixtures/not-node-safe.ts")).toThrow(/dynamic import/);
  });

  it("catches a re-export, which is not a thing a script can do", () => {
    expect(() => transpile("tests/fixtures/re-export.ts")).toThrow(/re-export/);
  });

  it("accepts the sources it actually deploys", () => {
    // The precondition. Without it the refusal above would pass against a
    // transpiler that rejected everything.
    for (const f of ["src/core/merge.ts", "src/agents/slice.ts"]) {
      expect(() => transpile(f), `${f} can no longer be deployed`).not.toThrow();
    }
  });
});
