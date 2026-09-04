/**
 * The generated workflow is a derived artifact, and the risk is that it stops
 * being derived — that someone edits workflows/incident.json directly and the
 * file and the generator drift apart silently.
 *
 * Every test here is written against a way that drift could hide.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
// @ts-expect-error — plain .mjs, the same file node runs.
import { buildWorkflow, buildNodeCode, serialise, generate, WEBHOOK_PATH } from "../scripts/generate-workflow.mjs";

/**
 * Run the generated node code for real, with a fake $input.
 *
 * Codex, chunk 1 parts 1-2: the tests asserted substrings and static shape, so
 * nothing established what the node DOES with zero items or with several. A
 * test that reads code is not a test that runs it.
 */
function runNode(core: string, items: Array<{ json: unknown }>): Array<{ json: Record<string, unknown> }> {
  const $input = {
    all: () => items,
    first: () => items[0],
  };
  const fn = new Function("$input", `${buildNodeCode(core)}`);
  return fn($input);
}

/** A core exposing one validator that accepts only { ok: true }. */
const TOY_CORE = `
exports.validate_incident = function v(data) {
  const ok = Boolean(data && data.ok === true);
  v.errors = ok ? null : [{ instancePath: "/ok", message: "must be true" }];
  return ok;
};`;

const CORE_STUB = "exports.validate_incident = function () { return true; };";
const WF = buildWorkflow(CORE_STUB);
const COMMITTED = new URL("../workflows/incident.json", import.meta.url).pathname;

describe("the workflow is generated, not written", () => {
  it("matches the committed file exactly, so a hand edit fails here", () => {
    // The committed JSON exists to be compared against a deployment. If it can
    // be edited without anything noticing, the comparison proves nothing about
    // the generator — only that two files someone maintained by hand agree.
    expect(existsSync(COMMITTED), "workflows/incident.json is missing; run node scripts/generate-workflow.mjs").toBe(true);
    expect(readFileSync(COMMITTED, "utf8")).toBe(generate().text);
  });

  it("is byte-identical across two generations from the same input", () => {
    // Any instability — a timestamp, a random id, unordered keys — would make
    // every drift comparison report a difference that means nothing, and the
    // real differences would drown in the noise.
    expect(serialise(buildWorkflow(CORE_STUB))).toBe(serialise(buildWorkflow(CORE_STUB)));
  });

  it("uses a fixed webhook path rather than a generated one", () => {
    expect(WEBHOOK_PATH).toMatch(/^[a-z0-9-]+$/);
    expect(JSON.stringify(WF)).toContain(WEBHOOK_PATH);
  });

  it("changes when the core changes, so a stale artifact cannot pass unnoticed", () => {
    const other = serialise(buildWorkflow(CORE_STUB + "// one more line"));
    expect(other).not.toBe(serialise(WF));
  });
});

describe("the node the core runs in", () => {
  const code: string = buildNodeCode(CORE_STUB);

  it("carries the core inside it", () => {
    expect(code).toContain(CORE_STUB);
  });

  it("supplies the module system the Code node does not have", () => {
    // Measured: exports is undefined and module holds only an empty exports.
    expect(code).toContain("const module = { exports: {} }");
    expect(code).toContain("const exports = module.exports");
  });

  it("says it is generated, in the file a human would open first", () => {
    expect(code.split("\n")[0]).toContain("GENERATED");
  });

  it("reports unchecked, not invalid, for a schema it does not have", () => {
    // Three states, never two — the same rule the local validator follows.
    // A typo'd schema name must not come back as a clean rejection.
    expect(code).toContain('state: "unchecked"');
    expect(code).toContain("no such schema");
  });

  it("reads all items rather than only the first", () => {
    expect(code).toContain("$input.all()");
  });
});

describe("the generated workflow shape", () => {
  it("wires the webhook into the code node", () => {
    expect(WF.connections["Incident Webhook"].main[0][0].node).toBe("Validate");
  });

  it("declares node types and versions the instance actually has", () => {
    const types = WF.nodes.map((n: { type: string; typeVersion: number }) => `${n.type}@${n.typeVersion}`);
    expect(types).toEqual(["n8n-nodes-base.webhook@2", "n8n-nodes-base.code@2"]);
  });

  it("carries no credentials, because nothing here authenticates", () => {
    // A credential reference in a generated file is a credential reference in
    // git. If one ever appears, it must appear as a failing test first.
    expect(JSON.stringify(WF)).not.toContain("credentials");
  });

});

describe("what the node actually does when it runs", () => {
  it("returns one result per input item, not one for the first", () => {
    // Measured defect: $input.first() discarded every item after the first in a
    // node configured to run once for ALL items. Items vanished with no trace.
    const out = runNode(TOY_CORE, [
      { json: { body: { schema: "incident", data: { ok: true } } } },
      { json: { body: { schema: "incident", data: { ok: false } } } },
      { json: { body: { schema: "incident", data: { ok: true } } } },
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.json.state)).toEqual(["valid", "invalid", "valid"]);
    expect(out.map((r) => r.json.index)).toEqual([0, 1, 2]);
  });

  it("returns nothing for no items instead of throwing", () => {
    // An empty run is not an error and not a pass. It is nothing, and it says so.
    expect(runNode(TOY_CORE, [])).toEqual([]);
  });

  it("reports unchecked for a schema it does not have", () => {
    const out = runNode(TOY_CORE, [{ json: { body: { schema: "incidnet", data: {} } } }]);
    expect(out[0]!.json.state).toBe("unchecked");
    expect(String(out[0]!.json.reason)).toContain("incidnet");
  });

  it("reads the payload from body, where the webhook actually puts it", () => {
    // Measured 2026-09-04: the webhook wraps the request and the posted JSON
    // sits under `body`, not at the root. Reading the root would yield undefined
    // and every validation would fail for the right reason by accident.
    const atRoot = runNode(TOY_CORE, [{ json: { schema: "incident", data: { ok: true } } }]);
    expect(atRoot[0]!.json.state, "payload at the root must not validate").toBe("invalid");
    const inBody = runNode(TOY_CORE, [{ json: { body: { schema: "incident", data: { ok: true } } } }]);
    expect(inBody[0]!.json.state).toBe("valid");
  });

  it("survives an item with no body at all", () => {
    // The webhook always wraps, but a Code node upstream might not. A missing
    // body must produce a validation failure, not a crash that loses the batch.
    const out = runNode(TOY_CORE, [{ json: {} }]);
    expect(out[0]!.json.state).toBe("invalid");
  });

  it("carries the validator errors through, not just a boolean", () => {
    const out = runNode(TOY_CORE, [{ json: { body: { schema: "incident", data: { ok: false } } } }]);
    expect(out[0]!.json.errors).toEqual([{ where: "/ok", message: "must be true" }]);
  });

  it("keeps one failing item from hiding the others", () => {
    const out = runNode(TOY_CORE, [
      { json: { body: { schema: "nope", data: {} } } },
      { json: { body: { schema: "incident", data: { ok: true } } } },
    ]);
    expect(out.map((r) => r.json.state)).toEqual(["unchecked", "valid"]);
  });
});
