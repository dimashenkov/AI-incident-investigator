/**
 * The schemas are a package, not four independent files.
 *
 * Codex, chunk 0 round 6: shared enums were referenced across files by absolute
 * id, every reference resolved in production, and nothing said why. An absolute
 * $ref is only a name — nothing fetches the document it points at — so those
 * files had gained a dependency that was invisible until someone tried to
 * compile one alone.
 *
 * The contract is now explicit: nothing compiles standalone, everything is
 * registered together, and these tests refuse a reference to a document the
 * validator does not register.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { REGISTERED_IDS } from "../../src/schema/validate.js";
import { join } from "node:path";

const DIR = new URL("../../schemas/", import.meta.url).pathname;
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const docs = files.map((f) => ({ file: f, json: JSON.parse(readFileSync(join(DIR, f), "utf8")) }));

/** Every $ref value anywhere in a document, with the path it sits at. */
function refsIn(node: unknown, path = ""): Array<{ path: string; ref: string }> {
  if (Array.isArray(node)) return node.flatMap((v, i) => refsIn(v, `${path}/${i}`));
  if (typeof node !== "object" || node === null) return [];
  const out: Array<{ path: string; ref: string }> = [];
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "$ref" && typeof v === "string") out.push({ path, ref: v });
    else out.push(...refsIn(v, `${path}/${k}`));
  }
  return out;
}

/**
 * Resolve a JSON pointer taken from a $ref fragment.
 *
 * The fragment is a URI, so it may be percent-encoded before it is a pointer:
 * "%24defs" and "$defs" name the same key. Decoding comes first, then the
 * pointer's own escapes — ~1 for "/" and ~0 for "~" — in that order, because
 * reversing them would turn "~01" into "~" instead of "~1".
 */
function resolvePointer(doc: unknown, pointer: string): unknown {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pointer);
  } catch {
    decoded = pointer; // a malformed escape is not a reason to crash the suite
  }
  let cur: unknown = doc;
  for (const raw of decoded.split("/").filter(Boolean)) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * What the VALIDATOR registers — not what happens to be lying in the folder.
 *
 * A subagent review on 2026-09-04: this set was built by listing the schemas
 * directory, while the validator registers a hand-written list of imports. A new
 * schema file, referenced from another and never imported, would satisfy this
 * test — the file is on disk — while the validator could not resolve the
 * reference. The test is named after the validator, so it asks the validator.
 */
const registeredIds = new Set(REGISTERED_IDS);

describe("the schema package holds together", () => {
  it("has more than one schema, so these tests are not passing on an empty set", () => {
    expect(files.length).toBeGreaterThan(1);
    expect(registeredIds.size).toBe(files.length);
  });

  it("registers every schema file that exists, and every registered id has a file", () => {
    // The folder and the validator must describe the same set in both
    // directions. A file nobody imports is dead weight that still gets $ref'd;
    // an id with no file behind it is a reference into nothing.
    const onDisk = new Set(docs.map((d) => d.json.$id));
    for (const id of registeredIds) expect(onDisk.has(id), `${id} is registered but no file declares it`).toBe(true);
    for (const id of onDisk) expect(registeredIds.has(id), `${id} exists on disk but the validator never registers it`).toBe(true);
  });

  it("points every cross-file reference at a document the validator registers", () => {
    // This is the check that would have caught round 6: a $ref naming a file
    // nothing loads looks like a schema with no constraints, and then every
    // value passes it.
    for (const { file, json } of docs) {
      for (const { path, ref } of refsIn(json)) {
        if (ref.startsWith("#")) continue;
        // noUncheckedIndexedAccess: split() may in principle yield nothing, and
        // an undefined target must not quietly compare unequal to every id.
        const target = ref.split("#")[0] ?? "";
        expect(registeredIds.has(target), `${file}${path}: $ref points at ${target}, which the validator does not register`).toBe(true);
      }
    }
  });

  it("resolves every local reference to a definition that exists", () => {
    for (const { file, json } of docs) {
      for (const { path, ref } of refsIn(json)) {
        const [target, pointer] = ref.split("#");
        if (pointer === undefined || pointer === "") continue;
        const doc = target === "" ? json : docs.find((d) => d.json.$id === target)?.json;
        expect(doc, `${file}${path}: ${ref} names an unknown document`).toBeDefined();
        expect(resolvePointer(doc, pointer), `${file}${path}: ${ref} resolves to nothing`).toBeDefined();
      }
    }
  });

  it("decodes a pointer the way a validator does, so a legal ref is not called broken", () => {
    // Codex, chunk 0 round 7: the fragment is a URI, so "#/%24defs/severity" is
    // a legal spelling of "#/$defs/severity" and Ajv resolves it. A resolver
    // that looked for a literal "%24defs" key would report a working reference
    // as broken — the mirror of the failure this file exists to prevent.
    const doc = { $defs: { severity: { enum: ["info"] } }, "a/b": { deep: 1 }, "m~n": { x: 2 } };
    expect(resolvePointer(doc, "/%24defs/severity")).toEqual({ enum: ["info"] });
    expect(resolvePointer(doc, "/$defs/severity")).toEqual({ enum: ["info"] });
    expect(resolvePointer(doc, "/a~1b/deep")).toBe(1);
    expect(resolvePointer(doc, "/m~0n/x")).toBe(2);
    expect(resolvePointer(doc, "/$defs/missing")).toBeUndefined();
  });

  it("keeps common.schema.json free of anything anyone would validate against", () => {
    // Codex, chunk 0 round 7: this used to forbid `type` and `properties` by
    // name — a partial category, the defect this project keeps repeating. Any
    // other assertion (const, enum, required, allOf, not, or the schema `false`)
    // would have made common validate data while the test stayed green.
    //
    // So it requires what is allowed instead of forbidding what is not: the only
    // keys permitted are the ones that carry no assertion. A new keyword nobody
    // has thought of fails here by default, which is the right direction to fail in.
    const ALLOWED = new Set(["$schema", "$id", "title", "description", "$defs"]);
    const common = docs.find((d) => d.file === "common.schema.json");
    expect(common, "common.schema.json is missing").toBeDefined();

    const stray = Object.keys(common!.json).filter((k) => !ALLOWED.has(k));
    expect(stray, `common.schema.json carries keys that could assert something: ${stray.join(", ")}`).toEqual([]);
    expect(Object.keys(common!.json.$defs ?? {}).length).toBeGreaterThan(0);
  });
});
