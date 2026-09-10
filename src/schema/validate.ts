/**
 * One validator, used by local tests and by n8n Code nodes alike.
 *
 * The point of this file is not convenience. It is that "valid" must mean the
 * same thing in a unit test and in production. Two validators with slightly
 * different draft support is the second-carrier defect: a payload passes here
 * and fails there, and nobody can tell which one was right.
 */
import { invariantErrors } from "./invariants.js";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import incidentSchema from "../../schemas/incident.schema.json" with { type: "json" };
import agentResultSchema from "../../schemas/agent-result.schema.json" with { type: "json" };
import conversationSchema from "../../schemas/conversation.schema.json" with { type: "json" };
import remediationSchema from "../../schemas/remediation.schema.json" with { type: "json" };
import verdictReviewSchema from "../../schemas/verdict-review.schema.json" with { type: "json" };
import commonSchema from "../../schemas/common.schema.json" with { type: "json" };
import observationsSchema from "../../schemas/observations.schema.json" with { type: "json" };

export type SchemaName = "incident" | "agent-result" | "conversation" | "remediation" | "verdict-review";

/**
 * Every $id this validator resolves, including `common`, which is registered
 * but is not itself validatable.
 *
 * Exported because tests/scenarios/refs.test.ts used to build this set by
 * listing the schemas directory instead — two carriers for one fact. A new
 * schema file added to the folder and referenced by another, but never imported
 * here, would have satisfied that test while the validator could not resolve
 * the reference at all.
 */
export const REGISTERED_IDS: readonly string[] = [
  incidentSchema.$id, agentResultSchema.$id, conversationSchema.$id,
  remediationSchema.$id, commonSchema.$id, observationsSchema.$id, verdictReviewSchema.$id,
];

/**
 * Three states, never two.
 *
 * `valid`   — checked, and it passed.
 * `invalid` — checked, and it failed; `errors` says where.
 * `unchecked` — could not check at all (no such schema, compiler blew up).
 *
 * Collapsing `unchecked` into `invalid` would be the safer-looking mistake, but
 * it hides a broken validator behind a stream of rejections. Collapsing it into
 * `valid` is worse: it reports "clean" for something nothing ever looked at.
 */
export type ValidationResult =
  | { state: "valid" }
  | { state: "invalid"; errors: string[] }
  | { state: "unchecked"; reason: string };

/**
 * The four validatable objects. `common` is registered alongside them but is not
 * one of them: it holds only shared $defs, so there is nothing to validate against it.
 *
 * These files are a package, not four independent documents. An absolute $ref is
 * a name, not a fetch — nothing loads the file it points at — so a schema pulled
 * out on its own does not compile. That is a deliberate contract, and
 * tests/scenarios/refs.test.ts holds it: every cross-file reference must point
 * at a schema registered here.
 */
const SCHEMAS = {
  incident: incidentSchema,
  "agent-result": agentResultSchema,
  conversation: conversationSchema,
  remediation: remediationSchema,
  "verdict-review": verdictReviewSchema,
} as const;

let compiled: Map<SchemaName, ValidateFunction> | null = null;
let compileFailure: string | null = null;

function compileAll(): void {
  if (compiled !== null || compileFailure !== null) return;
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    // Added by $id so the $ref between incident and its parts resolves.
    ajv.addSchema(commonSchema);
    ajv.addSchema(observationsSchema);
    for (const schema of Object.values(SCHEMAS)) ajv.addSchema(schema);

    const map = new Map<SchemaName, ValidateFunction>();
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      map.set(name as SchemaName, ajv.compile(schema));
    }
    compiled = map;
  } catch (e) {
    compileFailure = e instanceof Error ? e.message : String(e);
  }
}

function describe(err: ErrorObject): string {
  const where = err.instancePath === "" ? "(root)" : err.instancePath;
  return `${where} ${err.message ?? "failed"}`;
}

/*
 * The cross-field constraints now live in ./invariants.ts, unchanged.
 *
 * Moved on 2026-09-07 because scripts/build-core.mjs generates only the ajv
 * validators, so the deployed n8n node ran the schemas and never these — and
 * `valid` meant two different things in a unit test and in production, which
 * is the promise at the top of this file. A file with no imports can be
 * transpiled into the node from the same source the tests run, the way
 * merge.ts and slice.ts already are.
 */

export function validate(name: SchemaName, data: unknown): ValidationResult {
  compileAll();

  if (compileFailure !== null) {
    return { state: "unchecked", reason: `schema compilation failed: ${compileFailure}` };
  }

  const fn = compiled?.get(name);
  if (fn === undefined) {
    return { state: "unchecked", reason: `no such schema: ${name}` };
  }

  if (!fn(data)) return { state: "invalid", errors: (fn.errors ?? []).map(describe) };

  const crossField = invariantErrors(name, data);
  if (crossField.length > 0) return { state: "invalid", errors: crossField };
  return { state: "valid" };
}

/*
 * `assertValid` used to live here: a throwing boundary "for call sites that
 * must stop on anything other than a clean pass". It had no call site — not in
 * src, not in tests, not in the code transpiled into the n8n node — so the
 * promise it made was never kept by anything, and its rejection behaviour was
 * never exercised. Removed on 2026-09-10 on Codex's verdict. Callers here read
 * the three states and decide; nothing needs a throw, and if something ever
 * does, it will be written against a caller that exists.
 */
