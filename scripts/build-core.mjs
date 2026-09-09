/**
 * Assemble the deterministic core into one self-contained JavaScript file.
 *
 * The n8n Code node cannot import anything: `require` exists but only for an
 * allowlist that does not include ajv (measured 2026-09-04, docs/n8n-spike.md).
 * So the validator has to arrive as text, and the whole risk of this file is
 * that the text stops meaning what the local validator means.
 *
 * Three things are therefore build FAILURES rather than notes, each one a defect
 * this project already produced once:
 *
 *  1. Every inlined dependency is substituted exactly the expected number of
 *     times — not zero, not twice.
 *  2. Zero `require` calls remain. A missed substitution must not ship.
 *  3. The date-time format is not reimplemented. ajv-formats' own source is
 *     embedded — wrapped so it evaluates without a module system, and with its
 *     `.code` metadata stripped, but not rewritten — because a hand-written
 *     regex disagreed with it on 7 of 20 strings in both directions, accepting
 *     month 13 and February 30th while refusing a space separator.
 */
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "out/core.js");
const MANIFEST = resolve(ROOT, "out/core.manifest.json");

/** The validatable schemas, plus `common`, which is registered but not validated against. */
export const SCHEMA_FILES = ["common", "observations", "incident", "agent-result", "conversation", "remediation", "verdict-review"];
export const VALIDATABLE = ["incident", "agent-result", "conversation", "remediation", "verdict-review"];

/**
 * What gets inlined, and how many times each must be replaced.
 *
 * `expected` is not documentation. A count that comes out different means the
 * generated code changed shape — an ajv upgrade, a new format, a new schema —
 * and the safe response is to stop, not to ship whatever came out.
 */
export const INLINED = [
  {
    id: "ucs2length",
    from: 'require("ajv/dist/runtime/ucs2length").default',
    module: "ajv/dist/runtime/ucs2length.js",
    pick: "exports.default",
    expected: 1,
    // ucs2length.js assigns `.code` holding its own require as a string.
    stripsMetadata: 1,
  },
  {
    id: "ajv-formats",
    from: 'require("ajv-formats/dist/formats")',
    module: "ajv-formats/dist/formats.js",
    pick: "exports",
    expected: 1,
    stripsMetadata: 0,
  },
];

/**
 * Strip the `.code` metadata ajv attaches to its runtime helpers.
 *
 * Found while building this the first time: ucs2length.js ends with
 * `ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default'` — the
 * file quotes its own require inside a string literal. It is never executed,
 * but the zero-require check cannot tell a string from a call, and the right
 * response is to remove the metadata rather than teach the check to look away.
 * A check that learns to ignore one thing will ignore the next one too.
 *
 * The removal is itself asserted: exactly the expected count, or the build stops.
 */
export function stripCodeMetadata(source, id) {
  const re = /^\s*\w+\.code\s*=\s*(["']).*?\1;?\s*$/gm;
  const found = source.match(re)?.length ?? 0;
  return { source: source.replace(re, ""), stripped: found };
}

/** Wrap a CommonJS file so it evaluates to its own exports, with no module system present. */
export function wrapCjs(source, pick) {
  const body = `(function(){const module={exports:{}};const exports=module.exports;${source}\nreturn module.${pick === "exports" ? "exports" : "exports.default"};})()`;
  return body;
}

export function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

export { remainingRequires } from "./requires.mjs";
import { remainingRequires } from "./requires.mjs";

export function buildCore({ read = (p) => readFileSync(resolve(ROOT, "node_modules", p), "utf8") } = {}) {
  const load = (n) => JSON.parse(readFileSync(resolve(ROOT, "schemas", `${n}.schema.json`), "utf8"));

  const ajv = new Ajv2020({ allErrors: true, strict: true, code: { source: true, esm: false } });
  // The same addFormats the local validator uses — same package, same default
  // mode. One carrier for what a date-time is, rather than two that agree until
  // they do not.
  addFormats(ajv);
  for (const n of SCHEMA_FILES) ajv.addSchema(load(n));

  const refs = {};
  for (const n of VALIDATABLE) refs[exportName(n)] = load(n).$id;

  let code = standaloneCode(ajv, refs);
  const substitutions = [];

  for (const dep of INLINED) {
    const found = countOccurrences(code, dep.from);
    if (found !== dep.expected) {
      throw new Error(
        `inlining ${dep.id}: expected ${dep.expected} occurrence(s) of the require expression, found ${found}. ` +
          `The generated code changed shape — do not ship this artifact until the substitution is understood.`,
      );
    }
    const raw = read(dep.module);
    if (raw.length === 0) throw new Error(`inlining ${dep.id}: ${dep.module} is empty`);
    // Codex, chunk 1 part 1: a count proves only that the search string occurred.
    // A wrong module path, a wrong pick, or a broken wrapper produces the same
    // count and a record that reads as success. So what went in is recorded by
    // hash, and the test asserts the binding it produced actually works.
    const sourceSha = createHash("sha256").update(raw).digest("hex");
    const { source, stripped } = stripCodeMetadata(raw, dep.id);
    if (stripped !== dep.stripsMetadata) {
      throw new Error(
        `inlining ${dep.id}: expected to strip ${dep.stripsMetadata} '.code' metadata assignment(s), stripped ${stripped}. ` +
          `The dependency changed shape — do not ship this artifact until it is understood.`,
      );
    }
    code = code.split(dep.from).join(wrapCjs(source, dep.pick));
    substitutions.push({ id: dep.id, replaced: found, metadataStripped: stripped, module: dep.module, sourceSha, sourceBytes: raw.length });
  }

  const leftover = remainingRequires(code);
  if (leftover.length > 0) {
    throw new Error(
      `${leftover.length} require call(s) remain in the artifact: ${[...new Set(leftover)].join(", ")}. ` +
        `The Code node cannot load them, so this artifact would fail at runtime rather than at build time.`,
    );
  }

  return { code, substitutions };
}

export function exportName(schemaName) {
  return `validate_${schemaName.replace(/-/g, "_")}`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { code, substitutions } = buildCore();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, code);

  const manifest = {
    bytes: code.length,
    sha256: createHash("sha256").update(code).digest("hex"),
    schemas: SCHEMA_FILES,
    exports: VALIDATABLE.map(exportName),
    substitutions,
    /*
     * COUNTED from the artifact, not written as the literal `0`.
     *
     * The constant was true only because buildCore throws first — so the gate
     * line that read it back and printed "0 requires" was reporting a number
     * the builder had asserted about itself. Weaken the builder's detector and
     * the artifact ships a live require while every reader still says zero.
     * A subagent found it on 2026-09-09 under the mandate "the same rule in
     * two places".
     */
    requiresRemaining: remainingRequires(code).length,
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(
    `core.js ${manifest.bytes} bytes, sha256 ${manifest.sha256.slice(0, 12)}…\n` +
      substitutions.map((s) => `  inlined ${s.id} (${s.replaced}×)\n`).join("") +
      `  ${manifest.requiresRemaining} require calls remain\n`,
  );
}
