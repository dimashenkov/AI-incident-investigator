/**
 * "valid" must mean the same thing in a unit test and in the deployed node.
 *
 * src/schema/validate.ts opens with exactly that promise. On 2026-09-07 a
 * subagent measured it and it was false: `scripts/build-core.mjs` generates
 * ONLY the ajv validators from `schemas/`, and the cross-field constraints were
 * hand-written TypeScript that the generated core never carried. So the n8n
 * Code node ran the schemas and nothing else.
 *
 * Four documents, measured through the real generated core before the fix:
 *
 *   collection says "collected" while the observation slot is null   VALID in n8n
 *   a conversation thread id naming another incident                 VALID in n8n
 *   a message stamped with a foreign incident id                     VALID in n8n
 *   a hypothesis citing a source_ref no finding reports              VALID in n8n
 *
 * Every one of them is invalid locally. This file is the join: the same objects
 * go through both validators and the verdicts must agree. It is deliberately
 * not a test of either validator's rules — it is a test that there is one set
 * of rules.
 */
import { describe, it, expect } from "vitest";
import { validate } from "../src/schema/validate.js";
// @ts-expect-error - plain .mjs script, no types
import { buildRuntime } from "../scripts/workflow-runtime.mjs";

/** The deployed validator, lifted out of the node prelude and called directly. */
async function deployedValidate(): Promise<(name: string, data: unknown) => { state: string }> {
  const { prelude } = await buildRuntime();
  const fn = new Function(`${prelude}\nreturn validate;`);
  return fn() as (name: string, data: unknown) => { state: string };
}

const ALERT = { id: "a-1", title: "t", triggered_at: "2026-09-04T10:29:00Z" };
const base = () => ({
  incident_id: "INC-2026-0001", status: "investigating", service: "payment-api",
  namespace: "production", cluster: "prod-eu", started_at: "2026-09-04T10:30:00Z",
  source: { provider: "fake-datadog", alert: ALERT },
  observations: { kubernetes: null, logs: null, metrics: null },
  collection: { kubernetes: { state: "nothing", __nothing: "the provider read it and found nothing" },
                logs: { state: "nothing", __nothing: "the provider read it and found nothing" },
                metrics: { state: "nothing", __nothing: "the provider read it and found nothing" } },
  analysis: { agents: [], root_cause_code: null, root_cause: null, confidence: null, evidence: [] },
  remediation: { recommended_actions: [] },
  conversation: { provider: "fake-slack", channel_id: "fake-prod-incidents",
    thread_id: "thread-INC-2026-0001", incident_id: "INC-2026-0001", messages: [] },
});

/** Each case is a document and the schema it is checked against. */
const CASES: Array<[string, string, () => unknown]> = [
  ["a clean incident", "incident", base],
  ["collected claimed over a null observation", "incident", () => {
    const i = base(); i.collection.kubernetes = { state: "collected" } as never; return i;
  }],
  ["a thread id naming another incident", "incident", () => {
    const i = base(); i.conversation.thread_id = "thread-INC-2026-9999"; return i;
  }],
  ["a message stamped with a foreign incident id", "incident", () => {
    const i = base();
    (i.conversation.messages as unknown[]).push({ role: "agent", text: "x",
      ts: "2026-09-04T10:40:00Z", incident_id: "INC-2026-0003" });
    return i;
  }],
  ["a hypothesis citing what no finding reports", "agent-result", () => ({
    agent: "kubernetes", status: "ok",
    findings: [{ fact: "f", source_ref: "pods[0].phase" }],
    hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: ["events[9].message"] }],
    confidence: 0.7,
  })],
  ["three slots gathered under three different requests", "incident", () => {
    const i = base();
    const stamp = (cid: string, forInc: string) => ({
      collection_id: cid, requested_for: forInc, cluster: "prod-eu",
      namespace: "production", provider: "fake-kubernetes",
    });
    (i.observations as Record<string, unknown>).kubernetes = {
      provenance: stamp("11111111-0000-4000-8000-000000000000", "INC-2026-9999"),
      collected_at: "2026-09-04T10:31:00Z", pods: [], events: [],
      deployment: { name: "d", namespace: "production", image: "i",
        replicas: { desired: 1, ready: 1, available: 1 } },
    };
    i.collection.kubernetes = { state: "collected" } as never;
    return i;
  }],
  ["a clean agent result", "agent-result", () => ({
    agent: "kubernetes", status: "ok",
    findings: [{ fact: "f", source_ref: "pods[0].phase" }],
    hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: ["pods[0].phase"] }],
    confidence: 0.7,
  })],
];

describe("one validator, not two", () => {
  it("gives the same verdict locally and in the deployed node, case by case", async () => {
    const deployed = await deployedValidate();
    expect(CASES.length, "no cases; this would pass on an empty set").toBeGreaterThan(4);
    for (const [what, schema, build] of CASES) {
      const doc = build();
      const local = validate(schema as never, doc).state;
      const node = deployed(schema, doc).state;
      expect(node, `${what}: local says ${local}, the deployed node says ${node}`).toBe(local);
    }
  });

  /*
   * And the cases must not all be one verdict. A run where everything is
   * invalid, or everything valid, agrees for a reason that is not the one this
   * file is about.
   */
  it("covers both verdicts, or agreement proves nothing", () => {
    const states = CASES.map(([, schema, build]) => validate(schema as never, build()).state);
    expect(states, "every case is valid; nothing here tests a refusal").toContain("invalid");
    expect(states, "every case is invalid; nothing here tests an acceptance").toContain("valid");
  });
});
