/**
 * Drift detection is the part Codex named as most likely to fail, and the
 * failure he named is the one this project keeps producing: a rule over a
 * category enforced through a partial list.
 *
 * So every test here is an attempt to make normalisation erase something it
 * should have reported, or report something it should have ignored.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs, the same file node runs.
import { normalise, differences, compareWorkflows, digestCode, jsonUnsafePaths, INSTANCE_FIELDS, CREDENTIAL_ID_PLACEHOLDER } from "../scripts/drift.mjs";
// @ts-expect-error — plain .mjs
import { generate } from "../scripts/generate-workflow.mjs";

const FIXTURE = new URL("./fixtures/deployed-export.json", import.meta.url).pathname;

/**
 * The recorded export, exactly as the deployment returned it.
 *
 * Codex, chunk 1 part 3: this used to substitute the GENERATED code into the
 * deployed side before comparing, which made the check blind to the one thing
 * it exists to catch. The fixture now carries the sha256 of what the deployment
 * returned, and nothing is borrowed from the generated side.
 */
function deployedExport() {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  delete raw._fixture_note;
  return raw;
}

describe("a real deployment compares equal to what we generated", () => {
  it("reports same against the recorded export", () => {
    // The baseline is a genuine n8n Cloud export from 2026-09-04, not a
    // hand-written approximation of one. A hand-written baseline would only
    // prove that normalisation agrees with my idea of what n8n adds.
    const { workflow } = generate();
    const r = compareWorkflows(workflow, deployedExport());
    expect(r.state, JSON.stringify(r.differences?.slice(0, 4))).toBe("same");
  });

  it("reports drift when the deployed code differs by one character", () => {
    // The digest comes from the deployment. Changing it stands for a deployment
    // running code we did not generate — the case the old fixture could not
    // express, because it was handed the generated code before comparing.
    const { workflow } = generate();
    const deployed = deployedExport();
    deployed.nodes[1].parameters.jsCode.__sha256 = "0".repeat(64);
    expect(compareWorkflows(workflow, deployed).state).toBe("drifted");
  });

  it("reports drift when the deployed code is merely a different length", () => {
    const { workflow } = generate();
    const deployed = deployedExport();
    deployed.nodes[1].parameters.jsCode.__bytes += 1;
    expect(compareWorkflows(workflow, deployed).state).toBe("drifted");
  });

  it("does not take the digest from the generated side", () => {
    // If the baseline ever borrowed the generated code again, this would pass
    // for any deployment at all. It must be the recorded digest that decides.
    const recorded = deployedExport().nodes[1].parameters.jsCode.__sha256;
    expect(recorded).toMatch(/^[0-9a-f]{64}$/);
    const { workflow } = generate();
    const generatedDigest = digestCode(workflow).nodes[1].parameters.jsCode.__sha256;
    expect(generatedDigest).toBe(recorded);
  });
});

describe("normalisation removes what the instance owns, and nothing else", () => {
  it("drops every declared instance field", () => {
    const withAll: Record<string, unknown> = { nodes: [], connections: {} };
    for (const f of INSTANCE_FIELDS as Array<{ path: string }>) {
      if (!f.path.includes("/")) withAll[f.path] = "instance value";
    }
    const out = normalise(withAll) as Record<string, unknown>;
    for (const f of INSTANCE_FIELDS as Array<{ path: string }>) {
      if (!f.path.includes("/")) expect(out, `${f.path} survived normalisation`).not.toHaveProperty(f.path);
    }
  });

  it("gives a reason for every field it ignores", () => {
    // A path with no reason beside it is a field somebody silenced without
    // saying why, and the next person cannot tell it from a mistake.
    for (const f of INSTANCE_FIELDS as Array<{ path: string; why: string }>) {
      expect(f.why, `${f.path} has no reason recorded`).toBeTruthy();
      expect(f.why.length).toBeGreaterThan(10);
    }
  });

  it("drops webhookId only inside nodes, not a top-level field of that name", () => {
    // The pattern is a path, not a name. A field called webhookId somewhere
    // else is not the one the instance assigns, and must still be compared.
    const out = normalise({ webhookId: "mine", nodes: [{ webhookId: "theirs", name: "n" }] }) as Record<string, unknown>;
    expect(out.webhookId).toBe("mine");
    expect((out.nodes as Array<Record<string, unknown>>)[0]).not.toHaveProperty("webhookId");
  });

  it("does NOT drop a field merely because it looks instance-generated", () => {
    // The whole design: an unknown id-bearing field must produce drift, not
    // silence. This is the case that decides whether the check has teeth.
    const a = normalise({ nodes: [{ name: "n", someNewIdField: "aaa" }] });
    const b = normalise({ nodes: [{ name: "n", someNewIdField: "bbb" }] });
    expect(differences(a, b)).toHaveLength(1);
  });

  it("notices a field that exists on one side and not the other", () => {
    const diffs = differences(normalise({ nodes: [{ name: "n" }] }), normalise({ nodes: [{ name: "n", extra: 1 }] }));
    expect(diffs).toHaveLength(1);
    expect(diffs[0].generated).toBe("(absent)");
  });
});

describe("credential references are masked, never erased", () => {
  const node = (id: string) => ({ nodes: [{ name: "n", credentials: { slackApi: { id, name: "prod slack" } } }] });

  it("masks the opaque id so two instances can still compare equal", () => {
    expect(differences(normalise(node("aaa")), normalise(node("bbb")))).toEqual([]);
    const out = normalise(node("aaa")) as { nodes: Array<{ credentials: { slackApi: { id: string } } }> };
    expect(out.nodes[0]!.credentials.slackApi.id).toBe(CREDENTIAL_ID_PLACEHOLDER);
  });

  it("keeps the credential type, so a node rewired to another type is drift", () => {
    const other = { nodes: [{ name: "n", credentials: { githubApi: { id: "aaa", name: "prod slack" } } }] };
    expect(differences(normalise(node("aaa")), normalise(other)).length).toBeGreaterThan(0);
  });

  it("keeps the credential name, so a node pointed at a different account is drift", () => {
    const other = { nodes: [{ name: "n", credentials: { slackApi: { id: "aaa", name: "someone else's slack" } } }] };
    expect(differences(normalise(node("aaa")), normalise(other)).length).toBeGreaterThan(0);
  });

  it("keeps a credential that appears where none was generated", () => {
    // Dropping credentials wholesale would erase exactly this: a node that
    // acquired an attachment nobody put in the source.
    const bare = { nodes: [{ name: "n" }] };
    expect(differences(normalise(bare), normalise(node("aaa"))).length).toBeGreaterThan(0);
  });
});

describe("comparison keeps three states", () => {
  it("calls a missing deployment unchecked, not the same", () => {
    // Nothing to compare against is not agreement. Reporting "same" here would
    // mean a workflow that was never deployed passes the deployment check.
    expect(compareWorkflows({ a: 1 }, null).state).toBe("unchecked");
    expect(compareWorkflows(null, { a: 1 }).state).toBe("unchecked");
  });

  it("notices an array that changed length rather than only its items", () => {
    const diffs = differences(normalise({ nodes: [{ name: "a" }] }), normalise({ nodes: [{ name: "a" }, { name: "b" }] }));
    expect(diffs.length).toBeGreaterThan(0);
  });

  it("notices reordered nodes, because order is part of the definition", () => {
    const diffs = differences(normalise({ nodes: [{ name: "a" }, { name: "b" }] }), normalise({ nodes: [{ name: "b" }, { name: "a" }] }));
    expect(diffs.length).toBeGreaterThan(0);
  });

  it("refuses to compare values JSON cannot carry, instead of calling them equal", () => {
    // Codex, chunk 1 part 3: comparing with JSON.stringify made NaN equal null
    // and a present undefined equal to an absent key. The deployed side is JSON
    // and cannot hold those; the generated side is built in JavaScript and can.
    const r = compareWorkflows({ nodes: [], connections: {}, oops: Number.NaN }, { nodes: [], connections: {} });
    expect(r.state).toBe("unchecked");
    expect(r.reason).toContain("NaN");
  });

  it("finds every JSON-unsafe value, wherever it is nested", () => {
    const found = jsonUnsafePaths({ a: [1, { b: Number.POSITIVE_INFINITY }], c: 2 });
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe("/a/1/b");
  });

  it("keeps NaN distinct from null rather than equating them", () => {
    expect(differences({ x: Number.NaN }, { x: null }).length).toBe(1);
  });

  it("refuses to compare a workflow holding a key whose value is undefined", () => {
    // Codex, chunk 1 part 3: the test here used to be named for keeping present
    // undefined distinct from absent, and then asserted they were the same —
    // the assertion contradicted its own name. The honest answer is neither:
    // such a key vanishes on upload, so the deployed side can never carry it and
    // any verdict about it would be about a field that was never sent.
    const r = compareWorkflows({ nodes: [], connections: {}, ghost: undefined }, { nodes: [], connections: {} });
    expect(r.state).toBe("unchecked");
    expect(r.reason).toContain("vanish on upload");
  });

  it("still reports null against an absent key, which JSON does carry", () => {
    expect(differences({ x: null }, {}).length).toBe(1);
  });

  it("counts bytes, not UTF-16 units, in the code digest", () => {
    // "…" is one UTF-16 unit and three bytes. A field named __bytes that counts
    // units is a small lie a later reader would build on.
    const wf = { nodes: [{ parameters: { jsCode: "…" } }] };
    expect(digestCode(wf).nodes[0].parameters.jsCode.__bytes).toBe(3);
  });
});
