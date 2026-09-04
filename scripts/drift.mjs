/**
 * Drift detection: is the deployed workflow the one we generated?
 *
 * Codex named this the part most likely to fail, and named why:
 *
 *   "Normalize instance-specific IDs and credential references is exactly a rule
 *    over a category likely to be enforced through a partial list. A newly
 *    introduced ID-bearing field, nested credential reference, node metadata
 *    field, or order-sensitive array will create either false drift or — worse —
 *    erase meaningful drift."
 *
 * So the rule here is inverted from the obvious one. Nothing is ignored because
 * it looks instance-generated; a field is ignored only if it appears BY PATH in
 * the list below, and every path carries the reason it is there. Anything else
 * that differs is drift, including a field nobody has seen before. The failure
 * direction is deliberate: an unknown field that appears in a future n8n version
 * makes this fail loudly rather than pass quietly.
 *
 * The paths were measured on 2026-09-04 by uploading the generated workflow and
 * exporting it back, not guessed from documentation.
 */

import { createHash } from "node:crypto";

/**
 * Fields n8n owns. Each is dropped from both sides before comparison.
 * `*` matches one path segment, so it covers array indices.
 */
export const INSTANCE_FIELDS = [
  { path: "id", why: "assigned by the instance on create" },
  { path: "versionId", why: "changes on every save" },
  { path: "versionCounter", why: "changes on every save" },
  { path: "activeVersion", why: "instance bookkeeping" },
  { path: "activeVersionId", why: "instance bookkeeping" },
  { path: "createdAt", why: "instance timestamp" },
  { path: "updatedAt", why: "instance timestamp" },
  { path: "triggerCount", why: "runtime counter, not configuration" },
  { path: "isArchived", why: "instance state, set through the UI" },
  { path: "shared", why: "project and ownership, belongs to the instance" },
  { path: "sourceWorkflowId", why: "provenance the instance records" },
  { path: "meta", why: "instance metadata" },
  { path: "pinData", why: "editor state, not deployed behaviour" },
  { path: "staticData", why: "runtime state accumulated by the workflow" },
  { path: "tags", why: "organisational, applied in the instance" },
  { path: "nodeGroups", why: "canvas grouping, cosmetic" },
  { path: "description", why: "editable in the UI without changing behaviour" },
  { path: "active", why: "activation is an operation, not part of the definition" },
  { path: "nodes/*/webhookId", why: "assigned by the instance when a webhook node is created" },
];

/**
 * Credential references are NOT dropped.
 *
 * Codex: "Do not remove credential references wholesale: normalize only their
 * opaque instance IDs while preserving credential type, presence, and
 * attachment location." Dropping them would erase exactly the difference this
 * check exists to catch — a node quietly rewired to another credential.
 */
export const CREDENTIAL_ID_PLACEHOLDER = "<instance-credential-id>";

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function matches(pathParts, patternParts) {
  if (pathParts.length !== patternParts.length) return false;
  return patternParts.every((p, i) => p === "*" || p === pathParts[i]);
}

/** Strip instance-owned fields and mask credential ids, leaving everything else. */
export function normalise(value, patterns = INSTANCE_FIELDS.map((f) => f.path.split("/")), path = []) {
  if (Array.isArray(value)) return value.map((v, i) => normalise(v, patterns, [...path, String(i)]));
  if (!isObject(value)) return value;

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    const here = [...path, key];
    if (patterns.some((p) => matches(here, p))) continue;

    // A credentials block: keep the type, the presence and the name; mask only
    // the opaque id, which is the one part that legitimately differs per instance.
    if (key === "credentials" && isObject(v)) {
      out[key] = Object.fromEntries(
        Object.entries(v).map(([type, ref]) => [
          type,
          isObject(ref) ? { ...ref, id: ref.id === undefined ? undefined : CREDENTIAL_ID_PLACEHOLDER } : ref,
        ]),
      );
      continue;
    }
    out[key] = normalise(v, patterns, here);
  }
  return out;
}

/**
 * Replace large code payloads with a digest, on BOTH sides.
 *
 * Codex, chunk 1 part 3: the baseline used to carry a marker that the test
 * substituted the generated code into. That made the comparison blind to the
 * one thing it exists to catch — a deployment running different code — because
 * the generated code was written into the deployed side before comparing.
 *
 * The baseline now records the sha256 of what the DEPLOYMENT returned, and this
 * function digests the generated side the same way. Neither side borrows from
 * the other, and the fixture stays small.
 */
export function digestCode(workflow) {
  // Codex, chunk 1 part 3: `s.length` counts UTF-16 units, not bytes. The code
  // carries non-ASCII characters in its comments, so the two differ, and a
  // field named __bytes that is not a byte count is a small lie that a later
  // reader would build on.
  const digest = (s) => ({
    __sha256: createHash("sha256").update(s, "utf8").digest("hex"),
    __bytes: Buffer.byteLength(s, "utf8"),
  });
  return {
    ...workflow,
    nodes: (workflow.nodes ?? []).map((n) => {
      const js = n?.parameters?.jsCode;
      if (typeof js !== "string") return n;
      return { ...n, parameters: { ...n.parameters, jsCode: digest(js) } };
    }),
  };
}

/**
 * Values JSON can carry. Anything else compares unreliably and must be refused
 * rather than silently equated.
 *
 * Codex, chunk 1 part 3: comparing with JSON.stringify made NaN and Infinity
 * equal to null, and made a present `undefined` equal to an absent key. The
 * deployed side arrives as JSON so it cannot hold those, but the generated side
 * is built in JavaScript and can.
 */
export function jsonUnsafePaths(value, path = "") {
  const out = [];
  if (typeof value === "number" && !Number.isFinite(value)) out.push({ path: path || "(root)", value: String(value) });
  else if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    out.push({ path: path || "(root)", value: typeof value });
  } else if (Array.isArray(value)) value.forEach((v, i) => out.push(...jsonUnsafePaths(v, `${path}/${i}`)));
  else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      // A key whose value is undefined disappears when the workflow is uploaded,
      // so the deployed side can never have it. Comparing then reports agreement
      // about a field that was never sent. Codex, chunk 1 part 3: the test that
      // claimed to keep these distinct asserted the opposite of its own name.
      // It is not a difference to report — it is a comparison not worth trusting.
      if (v === undefined) out.push({ path: `${path}/${k}` || "(root)", value: "undefined (would vanish on upload)" });
      else out.push(...jsonUnsafePaths(v, `${path}/${k}`));
    }
  }
  return out;
}

/** Every path where two normalised values differ, deepest first. */
export function differences(a, b, path = "") {
  const out = [];
  const bothObjects = isObject(a) && isObject(b);
  const bothArrays = Array.isArray(a) && Array.isArray(b);

  if (bothArrays) {
    if (a.length !== b.length) out.push({ path: path || "(root)", generated: `${a.length} items`, deployed: `${b.length} items` });
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) out.push(...differences(a[i], b[i], `${path}/${i}`));
    return out;
  }

  if (bothObjects) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      out.push(...differences(a[key], b[key], `${path}/${key}`));
    }
    return out;
  }

  // Primitives compared directly. `Object.is` keeps NaN distinct from null and
  // a present undefined distinct from an absent key, which stringify conflated.
  const sameShape = (Array.isArray(a) === Array.isArray(b)) && (isObject(a) === isObject(b));
  if (!sameShape || !Object.is(a, b)) {
    out.push({ path: path || "(root)", generated: preview(a), deployed: preview(b) });
  }
  return out;
}

function preview(v) {
  if (v === undefined) return "(absent)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

/**
 * Compare a generated workflow against a deployed export.
 *
 * Three states, as everywhere else: `same`, `drifted`, and `unchecked` for the
 * case where there is nothing to compare against — which is not agreement.
 */
export function compareWorkflows(generated, deployed) {
  if (generated === undefined || generated === null) return { state: "unchecked", reason: "no generated workflow" };
  if (deployed === undefined || deployed === null) return { state: "unchecked", reason: "no deployed export to compare against" };

  const unsafe = jsonUnsafePaths(generated);
  if (unsafe.length > 0) {
    return {
      state: "unchecked",
      reason: `the generated workflow holds values JSON cannot carry, so a comparison would be unreliable: ${unsafe
        .map((u) => `${u.path}=${u.value}`)
        .join(", ")}`,
    };
  }

  const diffs = differences(normalise(digestCode(generated)), normalise(digestCode(deployed)));
  if (diffs.length === 0) return { state: "same" };
  return { state: "drifted", differences: diffs };
}
