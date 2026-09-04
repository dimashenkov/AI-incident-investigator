/**
 * The build produces an artifact that must mean exactly what the local
 * validator means. Everything here is written against a way it could stop.
 *
 * The date-time corpus is not decorative. On 2026-09-04 a hand-written regex
 * replaced ajv-formats to shed one require, and disagreed with it on 7 of 20
 * strings in both directions — accepting month 13, February 30th, September
 * 31st, hour 25 and minute 60, while refusing a space separator. Those exact
 * strings are below, because that is the disagreement that must never return.
 */
import { describe, it, expect } from "vitest";
import { validate } from "../src/schema/validate.js";
// @ts-expect-error — plain .mjs, the same file node runs in the build.
import { buildCore, exportName, wrapCjs, countOccurrences, remainingRequires, stripCodeMetadata, INLINED, VALIDATABLE } from "../scripts/build-core.mjs";

/** Evaluate the CommonJS artifact in memory — no file, no module system. */
function loadArtifact(code: string): Record<string, (data: unknown) => boolean> {
  const module = { exports: {} as Record<string, (d: unknown) => boolean> };
  new Function("module", "exports", code)(module, module.exports);
  return module.exports;
}

/**
 * Built lazily, inside the tests.
 *
 * Codex, chunk 1 part 1: calling buildCore() at module level meant a throwing
 * build registered no it() cases at all. Vitest then reported a suite-load
 * error, which hides WHICH invariant failed — and worse, the mutation gate
 * looks for a named test to have failed, finds no assertions at all, and
 * reports the mutation as having survived. A build that fails must fail as a
 * named test, not as an absent suite.
 */
type Built = { code: string; substitutions: Array<{ id: string; replaced: number; sourceSha?: string; sourceBytes?: number; module?: string }> };
let cache: Built | undefined;
function built(): Built {
  cache ??= buildCore() as Built;
  return cache;
}
function artifact(): Record<string, (data: unknown) => boolean> {
  return loadArtifact(built().code);
}

const CONV = { provider: "fake-slack", channel_id: "c", thread_id: "thread-INC-2026-0001", incident_id: "INC-2026-0001", messages: [] };
const AGENT = { agent: "kubernetes", status: "ok", findings: [{ fact: "f", source_ref: "r" }], hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: ["r"] }], confidence: 0.9 };
const INC = {
  incident_id: "INC-2026-0001", status: "investigating", service: "s", namespace: "n", cluster: "c",
  started_at: "2026-09-04T10:30:00Z",
  source: { provider: "fake-datadog", alert: { id: "a", title: "t", triggered_at: "2026-09-04T10:29:00Z" } },
  observations: { kubernetes: null, logs: null, metrics: null },
  analysis: { agents: [], root_cause_code: null, root_cause: null, confidence: null, evidence: [] },
  remediation: { recommended_actions: [] }, conversation: CONV,
};
const ACTION = { type: "restart_deployment", risk: "high", requires_approval: true, rationale: "r", executed: false, target: { kind: "Deployment", name: "p", namespace: "production" } };

/** The seven strings the hand-written regex got wrong, plus the ones it got right. */
const DATE_TIMES = [
  "2026-09-04T10:30:00Z", "2026-09-04t10:30:00z", "2026-09-04T10:30:00.123Z",
  "2026-09-04T10:30:00+02:00", "2026-09-04T10:30:00-05:30", "2026-09-04T10:30:00+0200",
  "2026-09-04 10:30:00Z", "2026-09-04T10:30:00", "2026-13-04T10:30:00Z",
  "2026-02-30T10:30:00Z", "2026-09-31T10:30:00Z", "2026-09-04T25:30:00Z",
  "2026-09-04T10:60:00Z", "2026-12-31T23:59:60Z", "2024-02-29T00:00:00Z",
  "2026-02-29T00:00:00Z", "not a date", "", "2026-9-4T10:30:00Z",
  "2026-09-04T10:30:00.000000009Z",
];

describe("the build refuses to ship a broken artifact", () => {
  it("assembles at all, as a named test rather than a suite-load error", () => {
    // This is the case that used to vanish: when the build threw during module
    // collection, no test existed to report it, and the mutation gate read the
    // silence as "the defect survived".
    expect(() => built()).not.toThrow();
    expect(built().code.length).toBeGreaterThan(1000);
  });

  it("leaves no require call behind", () => {
    // The Code node cannot load one. A missed substitution must fail here,
    // where it is visible, not at runtime in a workflow nobody is watching.
    expect(remainingRequires(built().code)).toEqual([]);
  });

  it("substitutes each dependency exactly the number of times declared", () => {
    for (const dep of INLINED as Array<{ id: string; expected: number }>) {
      const sub = built().substitutions.find((s) => s.id === dep.id);
      if (sub === undefined) throw new Error(`${dep.id} was never substituted`);
      expect(sub.replaced, `${dep.id} substitution count`).toBe(dep.expected);
    }
  });

  it("exports one validator per validatable schema, and no more", () => {
    expect(Object.keys(artifact()).sort()).toEqual(VALIDATABLE.map(exportName).sort());
  });

  it("counts occurrences honestly, including zero and many", () => {
    expect(countOccurrences("aXbXc", "X")).toBe(2);
    expect(countOccurrences("abc", "X")).toBe(0);
  });

  it("finds a require even when it is the only thing in the file", () => {
    expect(remainingRequires('const x = require("fs");')).toEqual(["fs"]);
    expect(remainingRequires("const x = 1;")).toEqual([]);
  });

  it("strips a .code metadata assignment and reports how many", () => {
    // ajv attaches the helper's own require to it as a string. Removing the
    // metadata is right; teaching the require check to ignore strings is not.
    const src = 'function f(){}\nexports.default = f;\nf.code = \'require("ajv/dist/runtime/ucs2length").default\';\n';
    const { source, stripped } = stripCodeMetadata(src, "test");
    expect(stripped).toBe(1);
    expect(remainingRequires(source)).toEqual([]);
  });

  it("wraps CommonJS so it evaluates without a module system", () => {
    const value = new Function(`return ${wrapCjs("exports.default = 42;", "exports.default")}`)();
    expect(value).toBe(42);
  });
});

describe("the artifact agrees with the local validator", () => {
  const differential = (name: string, data: unknown) => {
    const local = validate(name as never, data);
    const inlined = artifact()[exportName(name)]!(data);
    return { local: local.state, inlined, agree: (local.state === "valid") === inlined };
  };

  it("agrees on every date-time in the corpus that once split the two", () => {
    // This is the test that would have caught the regex divergence: each string
    // goes through both, and the answers must match, whatever they are.
    //
    // It establishes agreement on these twenty strings. It does not establish
    // that the two implementations agree in general — only that the twenty that
    // once split them no longer do.
    for (const dt of DATE_TIMES) {
      const r = differential("incident", { ...INC, started_at: dt });
      expect(r.agree, `date-time ${JSON.stringify(dt)}: local=${r.local} inlined=${r.inlined}`).toBe(true);
    }
  });

  it("agrees across a corpus of valid and invalid objects in all four schemas", () => {
    const corpus: Array<[string, unknown]> = [
      ["incident", INC],
      ["incident", { ...INC, observations: { kubernetes: {}, logs: null, metrics: null } }],
      ["incident", { ...INC, source: { provider: "fake-datadog", alert: {} } }],
      ["incident", { ...INC, status: "diagnosed" }],
      ["incident", { ...INC, rootcause: "typo" }],
      ["incident", { ...INC, analysis: { ...INC.analysis, confidence: 1.4 } }],
      ["conversation", CONV],
      ["conversation", { ...CONV, thread_id: "thread-42" }],
      ["conversation", { ...CONV, incident_id: null }],
      ["conversation", { ...CONV, messages: [{ role: "agent", text: "x", ts: "2026-01-01T00:00:00Z", incident_id: "INC-2026-0001", cited_evidence: [{ source: "invented", fact: "f" }] }] }],
      ["agent-result", AGENT],
      ["agent-result", { ...AGENT, status: "error", error: "e" }],
      ["agent-result", { ...AGENT, status: "ok", error: "e" }],
      ["agent-result", { ...AGENT, hypotheses: [{ code: "CONTAINER_OOM", statement: "s", supported_by: [""] }] }],
      ["remediation", ACTION],
      ["remediation", { ...ACTION, target: {} }],
      ["remediation", { ...ACTION, requires_approval: false }],
      ["remediation", { ...ACTION, executed: true }],
      ["remediation", { ...ACTION, type: "drop_database" }],
    ];
    const disagreements = corpus
      .map(([name, data]) => ({ name, ...differential(name, data), data: JSON.stringify(data).slice(0, 70) }))
      .filter((r) => !r.agree);
    expect(disagreements, `${disagreements.length} of ${corpus.length} disagree`).toEqual([]);
  });

  it("counts unicode length the same way, which is what the inlined helper does", () => {
    // ucs2length is inlined by string replacement; if ajv ever changes it, this
    // is the input that notices. Surrogate pairs count as one, not two.
    for (const s of ["", "a", "ab", "é", "😀", "a😀b", "👩‍💻"]) {
      const r = differential("incident", { ...INC, service: s });
      expect(r.agree, `service ${JSON.stringify(s)}: local=${r.local} inlined=${r.inlined}`).toBe(true);
    }
  });

  it("records what it embedded, not merely how often", () => {
    // Codex, chunk 1 part 1: a substitution count proves only that the search
    // string occurred. A wrong module, pick or wrapper yields the same count and
    // a record that reads as success. So the record carries the source hash and
    // size, and the binding below proves the embedding actually works.
    for (const sub of built().substitutions) {
      expect(sub.sourceSha, `${sub.id} recorded no source hash`).toMatch(/^[0-9a-f]{64}$/);
      expect(sub.sourceBytes, `${sub.id} recorded no source size`).toBeGreaterThan(0);
      expect(sub.module, `${sub.id} recorded no module path`).toBeTruthy();
    }
  });

  it("produces a working date-time binding, not merely a substituted string", () => {
    // The count cannot tell a correct embedding from a wrapper that evaluates to
    // undefined. A format that silently vanished would accept everything, so the
    // proof is a value the format must reject.
    const bad = { ...INC, started_at: "2026-02-30T10:30:00Z" };
    expect(artifact()[exportName("incident")]!(bad), "February 30th passed: the embedded format is not bound").toBe(false);
  });

  it("catches a require call however it is spaced or commented", () => {
    expect(remainingRequires('require("fs")')).toEqual(["fs"]);
    expect(remainingRequires('require ("fs")')).toEqual(["fs"]);
    expect(remainingRequires("require(`fs`)")).toEqual(["fs"]);
    // ...and does not fire on the English word, which a schema description uses.
    expect(remainingRequires("and then require neither approval nor a target")).toEqual([]);
    expect(remainingRequires('"required": ["a"]')).toEqual([]);
  });
});
