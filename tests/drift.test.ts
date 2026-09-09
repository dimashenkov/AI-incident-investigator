/**
 * Drift detection is the part Codex named as most likely to fail, and the
 * failure he named is the one this project keeps producing: a rule over a
 * category enforced through a partial list.
 *
 * So every test here is an attempt to make normalisation erase something it
 * should have reported, or report something it should have ignored.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
// @ts-expect-error - plain .mjs script, no types
import { recordFrom } from "../scripts/record-baseline.mjs";
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
  it("reports same when the deployment carries the digest of what we generated", async () => {
    /*
     * This used to compare the generated workflow against the CURRENT recorded
     * baseline, and so it failed the moment the repository moved ahead of the
     * deployment — which is true of every change worth releasing.
     *
     * That question belongs to the gate's no-drift-from-baseline check, which
     * asks it once. Asked here as well it was a second carrier of one rule, and
     * it deadlocked the release: the gate may be walked past on drift alone,
     * but a failing test suite stops the chain outright.
     *
     * What is left here is what this file can prove without the environment:
     * that a deployment running exactly our code compares equal. The real
     * n8n export supplies the instance fields, which is why it is still read.
     */
    /*
     * And a second time on 2026-09-05, when the workflow grew from two nodes to
     * fifteen: substituting one node's digest into a two-node export compared a
     * shape against a different shape. The recorded export is read for the
     * fields the INSTANCE adds — that is the only thing it can honestly supply
     * here — and the deployed side is otherwise built from what we generated.
     */
    const { workflow } = await generate();
    const recorded = deployedExport();
    const deployed = digestCode(workflow) as Record<string, unknown>;
    for (const key of Object.keys(recorded)) {
      if (key === "nodes" || key === "connections" || key === "name" || key === "_fixture_note") continue;
      deployed[key] = recorded[key];
    }
    const r = compareWorkflows(workflow, deployed);
    expect(r.state, JSON.stringify(r.differences?.slice(0, 4))).toBe("same");
  });

  it("reports drift when the deployed code differs by one character", async () => {
    // The digest comes from the deployment. Changing it stands for a deployment
    // running code we did not generate — the case the old fixture could not
    // express, because it was handed the generated code before comparing.
    const { workflow } = await generate();
    const deployed = deployedExport();
    deployed.nodes[1].parameters.jsCode.__sha256 = "0".repeat(64);
    expect(compareWorkflows(workflow, deployed).state).toBe("drifted");
  });

  it("reports drift when the deployed code is merely a different length", async () => {
    const { workflow } = await generate();
    const deployed = deployedExport();
    deployed.nodes[1].parameters.jsCode.__bytes += 1;
    expect(compareWorkflows(workflow, deployed).state).toBe("drifted");
  });

  it("takes the digest from what the deployment returned, not from what we generated", async () => {
    // The property, asked of the recorder rather than of today's deployment.
    // Handed an export whose code is nothing like ours, the baseline must carry
    // THAT code's digest — if it ever borrowed the generated side again, drift
    // detection would report "same" for any deployment at all.
    const FOREIGN_CODE = "// a deployment running something else\n";
    const foreign = { nodes: [{ parameters: { jsCode: FOREIGN_CODE } }] };
    const recorded = recordFrom(foreign, { note: "t" }) as { nodes: Array<{ parameters: { jsCode: { __sha256: string; __bytes: number } } }> };
    const stamped = recorded.nodes[0]?.parameters.jsCode;
    expect(stamped, "the recorder returned no node at all").toBeDefined();
    if (stamped === undefined) return;
    expect(stamped.__sha256).toBe(createHash("sha256").update(FOREIGN_CODE, "utf8").digest("hex"));
    expect(stamped.__bytes).toBe(Buffer.byteLength(FOREIGN_CODE, "utf8"));

    const { workflow } = await generate();
    const ours = digestCode(workflow).nodes[1].parameters.jsCode.__sha256;
    expect(stamped.__sha256, "the recorder borrowed the generated code").not.toBe(ours);
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

  it("keeps every field that decides what the deployment does", () => {
    /*
     * The test above builds its input FROM the list it checks, so the list can
     * grow and it still passes — add `connections` to INSTANCE_FIELDS and drift
     * goes blind to a deployment rewired in the n8n UI, which is the one thing
     * drift detection exists for. A subagent found it on 2026-09-09.
     *
     * This names the fields that must NEVER be dropped, independently of the
     * list, so growing the list past them fails here.
     */
    const behaviour: Record<string, unknown> = {
      nodes: [{ name: "Ask kubernetes", type: "n8n-nodes-base.httpRequest", parameters: { url: "x" } }],
      connections: { "Ask kubernetes": { main: [[{ node: "Collect kubernetes", type: "main", index: 0 }]] } },
      settings: { executionOrder: "v1" },
      name: "AI SRE — incident investigation",
    };
    const out = normalise(behaviour) as Record<string, unknown>;
    for (const key of ["nodes", "connections", "settings", "name"]) {
      expect(out, `${key} decides what the deployment does and must survive normalisation`)
        .toHaveProperty(key);
    }
    expect(out.connections, "the wiring itself, not just the key").toEqual(behaviour.connections);
    expect(out.nodes, "and the nodes with their parameters").toEqual(behaviour.nodes);
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

/*
 * The baseline is the artifact every later drift comparison is measured
 * against. An error body written over it makes every subsequent answer about
 * the deployment meaningless, and the script printed "baseline recorded".
 * Found by a subagent on 2026-09-07 — and it is the path the FIRST release
 * takes, before N8N_WORKFLOW_ID exists.
 */
describe("a baseline is only a baseline if it describes a workflow", () => {
  it("refuses to record a baseline from a body that carries no nodes", () => {
    for (const body of [{ message: "unauthorized" }, { nodes: [] }, {}, { nodes: "not a list" }]) {
      expect(() => recordFrom(body, { note: "t" }),
        `${JSON.stringify(body)} must not become a baseline`).toThrow(/no nodes/);
    }
  });

  it("still records a real export, or this refuses everything", () => {
    const real = { name: "w", nodes: [{ name: "n", type: "n8n-nodes-base.code",
      parameters: { jsCode: "return items;" } }], connections: {} };
    const out = recordFrom(real, { note: "t" }) as { nodes: unknown[] };
    expect(out.nodes).toHaveLength(1);
  });
});

/*
 * A release stopped on `settings.binaryMode` on 2026-09-07: n8n writes it
 * itself on save, and it decides where binary data is kept during an execution
 * — this chain passes only JSON, so it can neither change what the workflow
 * does nor be something anyone here chose.
 *
 * The listing is BY NAME, and these two tests are why. Dropping `settings`
 * wholesale would silence a real change to executionOrder in the same breath.
 */
describe("a field the instance writes itself is named, not a whole section dropped", () => {
  it("does not report a field n8n adds on save as drift", () => {
    const generated = { settings: { executionOrder: "v1" } };
    const deployed = { settings: { executionOrder: "v1", binaryMode: "separate" } };
    expect(differences(normalise(generated), normalise(deployed))).toEqual([]);
  });

  it("still reports a change to a setting that is ours", () => {
    const generated = { settings: { executionOrder: "v1" } };
    const deployed = { settings: { executionOrder: "v0", binaryMode: "separate" } };
    const d = differences(normalise(generated), normalise(deployed));
    expect(d, "executionOrder is ours; a change to it is real drift").toHaveLength(1);
    expect(d[0]!.path).toBe("/settings/executionOrder");
  });

  it("gives every instance-owned field a reason, so the list cannot grow silently", () => {
    expect(INSTANCE_FIELDS.length, "no fields; this would pass on an empty set").toBeGreaterThan(10);
    for (const f of INSTANCE_FIELDS) {
      expect(f.why, `${f.path} is dropped with no reason given`).toBeTruthy();
      /*
       * A reason must name WHO writes the field, not merely assert that it is
       * theirs. "instance bookkeeping" is a label; "changes on every save" is a
       * fact somebody can check. The bar is a word from that vocabulary rather
       * than a character count, which was the first version of this and cut off
       * a correct entry at exactly twenty.
       */
      expect(f.why, `${f.path} does not say who writes it or when`)
        .toMatch(/instance|save|create|runtime|UI|editor|accumulated|applied|operation|timestamp|counter/i);
    }
  });
});
