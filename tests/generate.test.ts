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
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
// @ts-expect-error — plain .mjs, the same file node runs.
import { buildWorkflow, serialise, generate, WEBHOOK_PATH, MODEL, OPENAI_CREDENTIAL } from "../scripts/generate-workflow.mjs";
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

  it("is byte-identical across two REAL generations", async () => {
    /*
     * Two calls to `generate()`, which reads the disk, the environment, the
     * schemas, the prompts and the TypeScript compiler.
     *
     * It used to be two calls to `buildWorkflow(RUNTIME)` on a literal declared
     * at the top of this file — a pure function on a hard-coded object, which
     * cannot observe any of the things its own comment names. A subagent proved
     * it on 2026-09-07 by putting `// built at ${Date.now()}` into the real
     * prelude: the real generation differed and this test stayed green.
     *
     * Any instability — a timestamp, a random id, unordered keys, a variable in
     * somebody's shell — makes every drift comparison report a difference that
     * means nothing.
     */
    const a = await generate();
    const b = await generate();
    expect(a.text).toBe(b.text);
  });

  it("generates the same bytes whatever the shell happens to hold", () => {
    /*
     * In a CHILD PROCESS, because the constant is read at module load.
     *
     * The first version of this test set process.env and called generate()
     * again in the same process — which cannot work, and the gate said so: the
     * mutation reintroducing the environment read survived it. A test that
     * cannot observe the thing it names is the defect it was written against.
     *
     * The generator read N8N_OPENAI_CREDENTIAL_ID and _NAME until 2026-09-07,
     * so a developer with either exported committed a workflow that was green
     * on their machine and permanently red everywhere else — and the id
     * variable is masked by drift detection, so the failure had no diagnostic
     * pointing anywhere near its cause.
     */
    const hash = (env: Record<string, string>) => execFileSync(
      "node",
      ["--import", "./scripts/ts-from-js.mjs", "-e",
        'import("./scripts/generate-workflow.mjs").then(async (m) => {'
        + " const { workflow } = await m.generate();"
        + ' process.stdout.write(require("crypto").createHash("sha256")'
        + ".update(m.serialise(workflow)).digest(\"hex\")); })"],
      { encoding: "utf8", env: { ...process.env, ...env } },
    ).trim();

    const plain = hash({});
    expect(plain, "the child produced no hash; the probe is broken").toMatch(/^[0-9a-f]{64}$/);
    expect(hash({ N8N_OPENAI_CREDENTIAL_ID: "some-other-credential" }),
      "a variable in the shell changed the artifact").toBe(plain);
    expect(hash({ N8N_OPENAI_CREDENTIAL_NAME: "Someone else's account" })).toBe(plain);
  }, 120_000);

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
    for (let i = 0; i < 60 && WF.connections[at] !== undefined; i += 1) {
      at = WF.connections[at].main[0][0].node;
      visited.push(at);
    }
    /*
     * The chain ends at Report, not at Conclude.
     *
     * Until 2026-09-07 it ended at Conclude and the deployed workflow produced
     * an answer object and no thread — src/core/thread.ts was called only by
     * tests, so every caveat it writes existed nowhere a live run could show
     * it. Report is free and deterministic: it reads the incident and asks no
     * model.
     */
    expect(visited[visited.length - 1], `the chain ends at ${at}`).toBe("Report");
    expect(visited, "Conclude must still be on the line, immediately before it")
      .toContain("Conclude");
    expect(visited[visited.length - 2]).toBe("Conclude");
    expect(visited).toHaveLength(2 + AGENT_ORDER.length * 4 + 2);
  });

  it("routes every gate's refusal past the paid call, and eventually to Conclude", () => {
    /*
     * Measured on the first live run, 2026-09-05, and it cost money: a refused
     * item flowed into the next HTTP node, which built a request with an
     * undefined prompt and was charged for the agents before it. Every false
     * branch must reach Conclude without passing an Ask node.
     */
    for (const agent of AGENT_ORDER) {
      const gate = WF.connections[`Ask ${agent}?`];
      expect(gate, `no gate before Ask ${agent}`).toBeDefined();
      expect(gate.main[0][0].node, "the true branch must ask").toBe(`Ask ${agent}`);

      let at = gate.main[1][0].node;
      const seen = [at];
      for (let i = 0; i < 20 && at !== "Conclude"; i += 1) {
        const c = WF.connections[at];
        expect(c, `the false branch from ${agent} dead-ends at ${at}`).toBeDefined();
        at = c.main[1] !== undefined && c.main[1].length > 0 ? c.main[1][0].node : c.main[0][0].node;
        seen.push(at);
      }
      expect(at, `the false branch from ${agent} never reaches Conclude`).toBe("Conclude");
      for (const n of seen) {
        expect(n.startsWith("Ask ") && !n.endsWith("?"), `a refusal passes through ${n}, which spends`).toBe(false);
      }
    }
  });

  it("declares node types and versions the instance actually has", () => {
    const types = [...new Set(WF.nodes.map((n: { type: string; typeVersion: number }) => `${n.type}@${n.typeVersion}`))];
    expect(types.sort()).toEqual([
      "n8n-nodes-base.code@2",
      "n8n-nodes-base.httpRequest@4.2",
      "n8n-nodes-base.if@2.2",
      "n8n-nodes-base.set@3.4",
      "n8n-nodes-base.webhook@2",
    ]);
  });

  it("carries a credential reference and no credential material", () => {
    /*
     * Measured on the first live run, 2026-09-05: naming only the type gets
     * "Credentials not found" and the run stops before any model call. So the
     * node names the stored credential by id and name.
     *
     * The id is a pointer, not a secret — the key never leaves n8n, and drift
     * masks this field because it differs per instance. What must never appear
     * is key-shaped material, and that is what this asserts.
     */
    const text = JSON.stringify(WF);
    expect(text).toContain("openAiApi");
    expect(text, "the node must name the stored credential, not merely its type").toContain(OPENAI_CREDENTIAL.name);
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
