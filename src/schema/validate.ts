/**
 * One validator, used by local tests and by n8n Code nodes alike.
 *
 * The point of this file is not convenience. It is that "valid" must mean the
 * same thing in a unit test and in production. Two validators with slightly
 * different draft support is the second-carrier defect: a payload passes here
 * and fails there, and nobody can tell which one was right.
 */
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import incidentSchema from "../../schemas/incident.schema.json" with { type: "json" };
import agentResultSchema from "../../schemas/agent-result.schema.json" with { type: "json" };
import conversationSchema from "../../schemas/conversation.schema.json" with { type: "json" };
import remediationSchema from "../../schemas/remediation.schema.json" with { type: "json" };
import commonSchema from "../../schemas/common.schema.json" with { type: "json" };
import observationsSchema from "../../schemas/observations.schema.json" with { type: "json" };

export type SchemaName = "incident" | "agent-result" | "conversation" | "remediation";

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
  remediationSchema.$id, commonSchema.$id, observationsSchema.$id,
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

/**
 * Constraints JSON Schema cannot state, checked in the same call so that "valid"
 * means one thing.
 *
 * A subagent review on 2026-09-04 found the hole: every id in the system is
 * pattern-checked and none is checked against any other. An incident could
 * carry a conversation whose thread belonged to a different incident, whose
 * messages named a third, and all four schemas were satisfied — every field had
 * the right shape and no field had the right value. Shape is not identity, and
 * cross-incident mixing is exactly the defect these ids exist to catch.
 *
 * Draft 2020-12 has no way to say "this field must equal that one", so it is
 * done here rather than left as a comment nobody runs.
 */
function invariantErrors(name: SchemaName, data: unknown): string[] {
  if (typeof data !== "object" || data === null) return [];
  const errs: string[] = [];
  const obj = data as Record<string, unknown>;

  const checkConversation = (c: Record<string, unknown>, where: string): void => {
    const incidentId = c["incident_id"];
    if (typeof incidentId !== "string") return;

    const threadId = c["thread_id"];
    if (typeof threadId === "string" && threadId !== `thread-${incidentId}`) {
      errs.push(`${where}/thread_id ${threadId} is not derived from incident ${incidentId}`);
    }

    const messages = c["messages"];
    if (Array.isArray(messages)) {
      messages.forEach((m, i) => {
        if (typeof m !== "object" || m === null) return;
        const mid = (m as Record<string, unknown>)["incident_id"];
        if (typeof mid === "string" && mid !== incidentId) {
          errs.push(`${where}/messages/${i}/incident_id ${mid} belongs to another incident than ${incidentId}`);
        }
      });
    }
  };

  if (name === "conversation") checkConversation(obj, "(root)");

  if (name === "incident") {
    const conv = obj["conversation"];
    if (typeof conv === "object" && conv !== null) {
      const c = conv as Record<string, unknown>;
      checkConversation(c, "/conversation");
      const incidentId = obj["incident_id"];
      if (typeof incidentId === "string" && typeof c["incident_id"] === "string" && c["incident_id"] !== incidentId) {
        errs.push(`/conversation/incident_id ${String(c["incident_id"])} does not match the incident it is attached to (${incidentId})`);
      }
    }

    /*
     * An incident embeds whole documents, and each one must mean the same thing
     * inside as it does alone.
     *
     * A subagent review on 2026-09-04 found that only `conversation` was being
     * checked. An agent result whose hypothesis cited a finding nobody reported
     * was refused on its own and accepted the moment it was placed in
     * `analysis.agents[]` — precisely the "passes here, fails there" split this
     * file opens by saying it exists to prevent.
     */
    const agents = (obj["analysis"] as Record<string, unknown> | undefined)?.["agents"];
    if (Array.isArray(agents)) {
      agents.forEach((a, i) => {
        for (const e of invariantErrors("agent-result", a)) {
          errs.push(`/analysis/agents/${i}${e.startsWith("/") ? e : ` ${e}`}`);
        }
      });
    }
  }

  if (name === "agent-result") {
    const findings = obj["findings"];
    const refs = new Set(
      Array.isArray(findings)
        ? findings
            .map((f) => (typeof f === "object" && f !== null ? (f as Record<string, unknown>)["source_ref"] : undefined))
            .filter((r): r is string => typeof r === "string")
        : [],
    );
    // Both directions, not one. Codex, chunk 0 round 11: only supported_by was
    // traced back to a finding, so a hypothesis could be weakened by
    // contradictions that no finding reports. A rule about evidence references
    // holds for every list of evidence references, not for the flattering one.
    const EVIDENCE_LISTS = ["supported_by", "contradicted_by"] as const;
    const hypotheses = obj["hypotheses"];
    if (Array.isArray(hypotheses)) {
      hypotheses.forEach((h, i) => {
        if (typeof h !== "object" || h === null) return;
        for (const field of EVIDENCE_LISTS) {
          const by = (h as Record<string, unknown>)[field];
          if (!Array.isArray(by)) continue;
          for (const ref of by) {
            if (typeof ref === "string" && !refs.has(ref)) {
              errs.push(`/hypotheses/${i}/${field} cites ${ref}, which no finding in this result reports`);
            }
          }
        }
      });
    }
  }

  return errs;
}

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

/**
 * For call sites that must stop on anything other than a clean pass.
 * `unchecked` throws too — an unverified object is not an approved one.
 */
export function assertValid(name: SchemaName, data: unknown): void {
  const r = validate(name, data);
  if (r.state === "valid") return;
  const detail = r.state === "invalid" ? r.errors.join("; ") : r.reason;
  throw new Error(`${name} ${r.state}: ${detail}`);
}
