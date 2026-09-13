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
import { buildWorkflow, serialise, generate, WEBHOOK_PATH, MODEL, OPENAI_CREDENTIAL, SLACK_CREDENTIAL } from "../scripts/generate-workflow.mjs";
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
     * The investigation ends at Report; the real Slack delivery follows it.
     *
     * Until 2026-09-07 the line ended at Conclude (no thread); then at Report
     * (the thread a person reads). Since 2026-09-12 (decision B) Report feeds the
     * real Slack post — Slack gate -> Slack lookup -> Slack post -> Slack took ->
     * Slack ok -> Slack record — so the main line now ends at the record, with
     * Conclude and Report still on it in order. The delivery's false branches
     * (refused item, empty ts) end deliberately and are checked elsewhere.
     */
    expect(visited[visited.length - 1], `the chain ends at ${at}`).toBe("Slack record");
    const ri = visited.indexOf("Report");
    expect(ri, "Report must be on the line").toBeGreaterThan(-1);
    expect(visited[ri - 1], "Conclude immediately before Report").toBe("Conclude");
    expect(visited.slice(ri), "Report, the Reported gate, then the Slack delivery chain, in order").toEqual([
      "Report", "Reported", "Slack gate", "Slack lookup", "Slack post", "Slack took", "Slack ok", "Slack record",
    ]);
    expect(visited).toHaveLength(2 + AGENT_ORDER.length * 4 + 2 + 7);
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
      "n8n-nodes-base.dataTable@1.1",
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

  it("wires the real Slack delivery: dedup by rowNotExists, post the thread only, record only on ok", () => {
    /*
     * Decision B, proven live in a scratch workflow before it was generated. This
     * asserts the shape that keeps it honest — not that it posts (that is the live
     * run), but that it cannot leak, cannot double-post sequentially, and cannot
     * record a thread that was never opened.
     */
    const node = (name: string) => WF.nodes.find((n: { name: string }) => n.name === name);

    // Lookup is rowNotExists — the dedup — NOT get, which errors on a miss and
    // would kill the chain (measured 2026-09-12).
    const lookup = node("Slack lookup") as { type: string; parameters: { operation: string } };
    expect(lookup?.type).toBe("n8n-nodes-base.dataTable");
    expect(lookup.parameters.operation, "get errors on a miss; rowNotExists branches").toBe("rowNotExists");

    // Post names the credential by id+name, uses genericCredentialType, and its
    // body is the THREAD and nothing else — never the incident or the
    // observations, which would leak to a foreign disk.
    const post = node("Slack post") as {
      credentials: { httpHeaderAuth: { id: string; name: string } };
      parameters: { authentication: string; genericAuthType: string; jsonBody: string };
    };
    expect(post.parameters.authentication).toBe("genericCredentialType");
    expect(post.parameters.genericAuthType).toBe("httpHeaderAuth");
    expect(post.credentials.httpHeaderAuth).toEqual({ id: SLACK_CREDENTIAL.id, name: SLACK_CREDENTIAL.name });
    // The visible message is the Block Kit view (slackReport), with the plain
    // thread as the text fallback. Both are curated fields — never the incident
    // object or the observation blob, which would leak to a foreign disk.
    expect(post.parameters.jsonBody, "sends the Block Kit blocks").toContain("$json.slack_blocks");
    expect(post.parameters.jsonBody, "and the plain thread as the fallback").toContain("$json.thread");
    expect(post.parameters.jsonBody, "never the whole incident").not.toContain("incident");
    expect(post.parameters.jsonBody, "never the observations").not.toContain("observations");

    // The ts is taken only when ok is true; an empty ts is never recorded.
    const took = node("Slack took") as { parameters: { jsonOutput: string } };
    expect(took.parameters.jsonOutput, "ts only when Slack said ok").toContain("$json.ok === true");

    // Record runs only on the ok branch: main[0] -> record, main[1] -> nothing.
    const okOut = WF.connections["Slack ok"].main;
    expect(okOut[0][0].node, "ok true records").toBe("Slack record");
    expect(okOut[1] ?? [], "ok false records nothing — never an empty ts").toEqual([]);

    // And no token material anywhere in the workflow.
    const text = JSON.stringify(WF);
    expect(text).not.toContain("xoxb");
    expect(text).not.toContain("Bearer");
  });

  it("stores the full observations for the two-way bot, on a branch, never into Slack", () => {
    // The owner asked (2026-09-12) for the bot to answer detailed questions from
    // the FULL data. Report fans to TWO branches: the Slack post (curated) and a
    // data store (raw observations, keyed by incident_id). The store is an
    // INDEPENDENT branch so it runs regardless of Slack dedup, and the raw data
    // goes to a private table, NEVER into the Slack body.
    const node = (name: string) => WF.nodes.find((n: { name: string }) => n.name === name);
    // Report fans out only AFTER the Reported gate (a refused report reaches no
    // branch). The gate checks slack_text, present only on a successful report.
    expect(WF.connections["Report"].main[0][0].node, "Report goes through the gate").toBe("Reported");
    const gate = node("Reported") as { parameters: { conditions: { conditions: Array<{ leftValue: string; operator: { operation: string } }> } } };
    expect(gate.parameters.conditions.conditions[0]!.leftValue, "gates on a successful report").toContain("slack_text");
    expect(gate.parameters.conditions.conditions[0]!.operator.operation).toBe("notEmpty");
    expect(WF.connections["Reported"].main[1] ?? [], "a refused report reaches no branch").toEqual([]);
    const fans = WF.connections["Reported"].main[0].map((c: { node: string }) => c.node);
    expect(fans, "the gate fans to Slack AND the store").toContain("Slack gate");
    expect(fans, "the gate fans to Slack AND the store").toContain("Record incident data");
    const store = node("Record incident data") as {
      type: string; parameters: { operation: string; columns: { value: Record<string, string> } };
    };
    expect(store.type).toBe("n8n-nodes-base.dataTable");
    expect(store.parameters.operation, "upsert so a re-run refreshes").toBe("upsert");
    expect(store.parameters.columns.value.data, "stores the observations").toContain("observations");
    // The store's data must NOT be in the Slack post body (leak guard).
    const post = node("Slack post") as { parameters: { jsonBody: string } };
    expect(post.parameters.jsonBody, "observations never reach Slack").not.toContain("observations");
  });

  it("registers the incident in Datadog — SIMULATED: builds a record, stores it, sends nothing", () => {
    // Owner, 2026-09-12: register in Datadog, but Datadog is paid, so mock it.
    // Grok reviewed the approach: it must NOT be a sendable API body, and the
    // Slack line must not claim a real registration. Report builds the mock record
    // and fans a third branch to store it; no node calls Datadog.
    const node = (name: string) => WF.nodes.find((n: { name: string }) => n.name === name);
    const fans = WF.connections["Reported"].main[0].map((c: { node: string }) => c.node);
    expect(fans, "the gate also fans to the Datadog store").toContain("Record Datadog");
    const store = node("Record Datadog") as {
      type: string; parameters: { operation: string; columns: { value: Record<string, string> } };
    };
    expect(store.type).toBe("n8n-nodes-base.dataTable");
    expect(store.parameters.operation, "upsert — one row per incident, idempotent on re-run").toBe("upsert");
    expect(store.parameters.columns.value.record, "stores the mock record").toContain("datadog_record");
    // No node anywhere calls Datadog — the whole point of the mock.
    const text = JSON.stringify(WF);
    expect(text, "no real Datadog endpoint is ever called").not.toContain("api.datadoghq.com");
    expect(text, "no Datadog ingest either").not.toContain("datadoghq.com");
    // The report's Datadog line is honest — simulated/not-sent, never "registered".
    const report = node("Report") as { parameters: { jsCode: string } };
    expect(report.parameters.jsCode, "the report builds the mock record").toContain("datadogMockRecord");
  });

  it("stamps each run with the prompt versions that produced it (eval-loop provenance)", () => {
    // Grok, 2026-09-13: without the prompt hash on the record, a failure blames
    // "the agent", not an editable prompt version. Report embeds a hash per prompt
    // and outputs prompt_versions; the model is already on each answer.
    // The output wiring is in reportNodeCode (visible with the toy prelude);
    // the embedded const is in the real prelude, so read the committed workflow.
    const report = WF.nodes.find((n: { name: string }) => n.name === "Report") as { parameters: { jsCode: string } };
    expect(report.parameters.jsCode, "Report outputs prompt_versions").toContain("prompt_versions: PROMPT_VERSIONS");
    const realWf = JSON.parse(readFileSync(COMMITTED, "utf8"));
    const realReport = realWf.nodes.find((n: { name: string }) => n.name === "Report");
    const m = realReport.parameters.jsCode.match(/const PROMPT_VERSIONS = (\{[^}]*\})/);
    expect(m, "PROMPT_VERSIONS must be embedded in the real workflow").not.toBeNull();
    const versions = JSON.parse(m![1]);
    for (const agent of ["kubernetes", "logs", "metrics", "root-cause"]) {
      expect(versions[agent], `${agent} must have a version hash`).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it("gates Slack and the stores on a successful report, not merely on an incident id", () => {
    // Subagent audit 2026-09-12: a report-refused item still carries
    // incident.incident_id, so gating on the id let a failed report write an empty
    // store row and try to post. The gate must check slack_text — present only when
    // reportIncident succeeded.
    const gate = WF.nodes.find((n: { name: string }) => n.name === "Reported") as {
      parameters: { conditions: { conditions: Array<{ leftValue: string }> } };
    };
    expect(gate.parameters.conditions.conditions[0]!.leftValue).toContain("slack_text");
    expect(gate.parameters.conditions.conditions[0]!.leftValue).not.toContain("incident_id");
  });

  it("pins the model and the temperature, so two runs can be compared", () => {
    /*
     * The literal, not the constant.
     *
     * This compared the generated body against `MODEL` — which the body is
     * BUILT from — so the two could never disagree, and `/^gpt-/` accepts any
     * name. Changing the model to a different price and a different answer left
     * the test green, and two runs measured against each other would not have
     * been the same measurement. A subagent found it on 2026-09-09.
     *
     * If the model is deliberately changed, this line changes with it, and the
     * change is then visible in the diff rather than only in the bill.
     */
    /*
     * `gpt-4o` since 2026-09-10, by the owner's decision after a comparison.
     *
     * Everything measured before that day was the behaviour of `gpt-4o-mini`.
     * The owner's local n8n agent established that the same credential reaches
     * `gpt-4o`, which made the model the one explanation for three identical
     * results that nobody had excluded. Six scenarios were bought on each, on
     * one frozen revision, changing only this string:
     *
     *   gpt-4o-mini   2 correct, 2 right code without its evidence, 1 wrong
     *   gpt-4o        5 correct, 0, 0
     *   citation recall  7 of 11 against 10 of 11
     *
     * The owner decided to keep it. Recorded in
     * docs/runs/2026-09-10-model-comparison.json, which also says what the
     * comparison does NOT establish: reliability, from one execution each.
     *
     * And what this test does NOT establish, because Astra pointed out that
     * the first version of this comment claimed it: a pinning test ENFORCES a
     * decision. It cannot establish that the decision was earned. The evidence
     * for that is the recorded comparison, not this assertion.
     */
    /*
     * `gpt-5` since 2026-09-11, by the owner's decision, and the first attempt
     * failed for a reason worth keeping.
     *
     * The question: thirty recorded hypotheses across two models and eight
     * rounds of prompts carry `contradicted_by` in none, while the contract
     * permits dissent and the prompt teaches where it goes. Capacity is the one
     * explanation left, and computing the contradiction in code is forbidden by
     * a rule already taken.
     *
     * The first run came back HTTP 400 — „Unsupported value: 'temperature' does
     * not support 0 with this model. Only the default (1) value is supported."
     * Read out of execution 296 by the owner's local n8n agent, who also
     * established it was NOT billed: OpenAI rejects at validation, before any
     * inference, so the runner's „may have been charged" resolved to nothing.
     */
    expect(MODEL, "the model this project measures against, spelled out once")
      .toBe("gpt-5");
    const ask = node("Ask kubernetes");
    expect(ask.parameters.jsonBody, "a collection agent asks the smaller model")
      .toContain("gpt-5-mini");
    /*
     * NO temperature, and this test says what that costs.
     *
     * It asserted `temperature: 0` so that two runs could be compared. `gpt-5`
     * refuses the value outright, so the field is gone and the model's default
     * of 1 applies. Runs on this model are therefore NOT repeatable, and a
     * difference between two of them can be the sampling rather than the
     * change. Stated in LIMITATIONS as well.
     */
    expect(ask.parameters.jsonBody, "the refused parameter is not sent at all")
      .not.toContain("temperature");
    /*
     * NOT the same model any more, and the split is the point.
     *
     * It said „every agent call is the same model, or the runs are not
     * comparable". Comparability was already lost the hour gpt-5 refused
     * temperature 0 — that is the thirteenth stated limitation. What is
     * asserted now is that each agent asks the model pinned for its JOB: the
     * three that extract ask the smaller one, and the one that concludes asks
     * the one that produced dissent where thirty hypotheses had none.
     */
    for (const name of ["Ask kubernetes", "Ask logs", "Ask metrics"]) {
      expect(node(name).parameters.jsonBody, `${name} extracts, so it asks the smaller model`)
        .toContain("gpt-5-mini");
    }
    expect(node("Ask root-cause").parameters.jsonBody, "and the one that judges asks gpt-5")
      .toMatch(/"gpt-5"/);
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
