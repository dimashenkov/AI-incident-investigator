/**
 * Build an incident from a scenario, without calling anything.
 *
 * This is the deterministic spine: everything that happens before a model is
 * asked anything, and everything that happens after it answers. Keeping it here
 * rather than inside an agent means the expensive part is only the reasoning,
 * and every rule about shape, evidence and isolation is checked for free.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { newCollectionRequest, readAlert, readScenario, toObservations, SLOTS, type CollectionRequest, type FailureKind, type Slot, type Observation } from "../providers/fixtures.js";
import { validate } from "../schema/validate.js";
import { recordAgentResult as mergeRecordAgentResult, concludeIncident as mergeConcludeIncident, type Validate } from "./merge.js";

export type Assembly =
  // The kind travels out of assembly too. It was dropped here while the local
  // copy kept it, so every caller saw three failures that all looked alike —
  // the same erasure that made the contradiction filter read a missing field.
  | { state: "assembled"; incident: Record<string, unknown>; failures: Array<{ slot: Slot; kind: FailureKind; reason: string }> }
  | { state: "refused"; reason: string; errors?: string[] };

/** The permanent scenario-to-number registry. Read, never computed. */
export type Registry = { next_free: number; numbers: Record<string, number> };

export function readRegistry(root: string = new URL("../../scenarios/", import.meta.url).pathname): Registry | null {
  const path = join(root, "registry.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Registry;
    if (typeof raw.next_free !== "number" || typeof raw.numbers !== "object" || raw.numbers === null) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * A stable incident id.
 *
 * Codex, chunk 2, three times. The scenario was ignored, then folded into a
 * hundred-value hash that could collide, then taken from sorted position —
 * "adding a new scenario that sorts before an existing one renumbers that
 * scenario's incident_id, and therefore its derived Slack thread ID."
 *
 * An id that changes when an unrelated file appears is not an id. The number
 * comes from a written registry that is appended to and never rewritten, so it
 * survives every scenario added afterwards. A scenario missing from the
 * registry is refused rather than numbered on the spot: a number invented at
 * call time is exactly the thing that moves later.
 */
export function incidentIdFor(scenario: string, sequence: number, registry: Registry | null = readRegistry()): string {
  if (typeof scenario !== "string" || scenario.length === 0) throw new Error("scenario must be a non-empty name");
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 99) {
    throw new Error(`sequence must be 1..99, got ${sequence}`);
  }
  if (registry === null) throw new Error("scenarios/registry.json is missing or unreadable; ids cannot be issued without it");

  const number = Object.prototype.hasOwnProperty.call(registry.numbers, scenario) ? registry.numbers[scenario] : undefined;
  if (number === undefined) {
    throw new Error(`scenario ${JSON.stringify(scenario)} has no number in scenarios/registry.json; add one at next_free`);
  }
  if (!Number.isInteger(number) || number < 1 || number > 98) {
    throw new Error(`scenario ${JSON.stringify(scenario)} has number ${number}, which the id format cannot carry`);
  }

  return `INC-2026-${String(number * 100 + sequence).padStart(4, "0")}`;
}

/**
 * Assemble one incident.
 *
 * A provider failure does NOT stop the assembly — an incident where one source
 * could not be read is a real incident, and refusing to build it would hide the
 * situation rather than report it. But the failure travels beside the incident,
 * because the schema writes an unreadable slot as null and null cannot say
 * could-not-read.
 */
export function assembleIncident(
  scenario: string,
  sequence: number,
  opts: { service?: string; namespace?: string; cluster?: string; root?: string; collectionId?: string } = {},
): Assembly {
  let incidentId: string;
  try {
    incidentId = incidentIdFor(scenario, sequence, opts.root === undefined ? readRegistry() : readRegistry(opts.root));
  } catch (e) {
    return { state: "refused", reason: e instanceof Error ? e.message : String(e) };
  }
  const alert = opts.root === undefined ? readAlert(scenario) : readAlert(scenario, opts.root);
  if (alert === null) return { state: "refused", reason: `scenario ${scenario} has no readable alert.json` };

  // The request is made before anything is gathered, and the observations are
  // stamped with it. Nothing is read back out of a provider's answer.
  const cluster = opts.cluster ?? "prod-eu";
  const namespace = opts.namespace ?? "production";
  let request: CollectionRequest;
  try {
    request = newCollectionRequest(incidentId, cluster, namespace,
      opts.collectionId ?? deterministicCollectionId(incidentId, scenario));
  } catch (e) {
    return { state: "refused", reason: e instanceof Error ? e.message : String(e) };
  }

  const obs = opts.root === undefined
    ? readScenario(scenario, undefined, request)
    : readScenario(scenario, opts.root, request);
  const { observations, failures } = toObservations(obs);

  // Every slot failing is not an incident with three empty observations — it is
  // a scenario that could not be read at all, and building one would produce a
  // document asserting three absences that were never established.
  if (failures.length === SLOTS.length) {
    return { state: "refused", reason: `every observation failed for ${scenario}: ${failures.map((f) => f.reason).join("; ")}` };
  }

  // A slot that contradicts the request does not get to be one absence among
  // three. Two healthy slots would otherwise carry the incident while the
  // answer that named another tenant was filed under "we did not get that one".
  const contradictions = failures.filter((f) => f.kind === "contradiction");
  if (contradictions.length > 0) {
    return { state: "refused",
      reason: `an observation contradicts the request it was gathered under: ${contradictions.map((f) => f.reason).join("; ")}` };
  }

  // Nothing is merged before its provenance is checked. Codex, 2026-09-05: this
  // is the question no content check can answer, and by the time foreign data
  // reaches an observation slot it is indistinguishable from legitimate data.
  //
  // And, from the same review: with the fixture provider this is the second
  // line and today it cannot fire. Every collected result has just been stamped
  // from this exact request, so a disagreement has already become a failure
  // above. Its refusal branches are reached by its own tests and by nothing
  // else. It is kept, not deleted, because the reachable guard is the provider
  // and there will be more than one provider — the first one that returns a
  // collected observation without going through readSlot arrives here instead.
  // Said out loud rather than left to look like defence that is doing work.
  const provenance = checkProvenance(obs, request);
  if (provenance !== null) return { state: "refused", reason: provenance };

  const alertObj = alert as Record<string, unknown>;
  const incident = {
    incident_id: incidentId,
    status: "investigating",
    service: opts.service ?? serviceFromTags(alertObj) ?? "unknown-service",
    namespace,
    cluster,
    started_at: alertObj["triggered_at"],
    scenario,
    source: { provider: "fake-datadog", alert },
    observations,
    // Three answers, written down. Codex, 2026-09-05: this used to be handed
    // back beside the incident, so anything that read the document alone saw
    // null and could not tell an established absence from a slot nobody could
    // read. An unchecked source is not a clean source.
    collection: Object.fromEntries(SLOTS.map((slot) => {
      const o = obs[slot];
      if (o.state === "failed") return [slot, { state: "failed", kind: o.kind, reason: o.reason }];
      return [slot, { state: o.state }];
    })),
    analysis: { agents: [], root_cause_code: null, root_cause: null, confidence: null, evidence: [] },
    remediation: { recommended_actions: [] },
    conversation: {
      provider: "fake-slack",
      channel_id: "fake-prod-incidents",
      thread_id: `thread-${incidentId}`,
      incident_id: incidentId,
      messages: [],
    },
  };

  // Built here, validated here. An assembler that emits an invalid incident and
  // leaves the checking to somebody downstream is how a bad shape travels.
  const r = validate("incident", incident);
  if (r.state === "invalid") return { state: "refused", reason: "the assembled incident does not validate", errors: r.errors };
  if (r.state === "unchecked") return { state: "refused", reason: `could not validate the assembled incident: ${r.reason}` };

  return { state: "assembled", incident, failures };
}

/**
 * Does every collected observation carry the request we issued?
 *
 * Returns null when it does, and the reason when it does not.
 *
 * What changed on 2026-09-05, after two reviewers said the same thing: this
 * used to compare fields the observations supplied against each other. A
 * foreign record only had to name the right incident and cluster to pass, and
 * three slots agreeing on one invented id counted as one moment. The comparison
 * is against the ISSUED request now — a value the caller minted and a provider
 * never saw until it was asked.
 *
 * What it establishes: the data arrived under a request we made, for this
 * incident, from the cluster and namespace we asked about, in one collection.
 * What it does not: that the provider answered honestly. That is recorded among
 * the things this repository cannot check.
 */
export function checkProvenance(
  obs: Record<Slot, Observation>,
  request: CollectionRequest,
): string | null {
  let collected = 0;

  for (const slot of SLOTS) {
    const o = obs[slot];
    if (o.state !== "collected") continue;
    collected += 1;

    const data = o.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return `the ${slot} observation is not an object`;
    }
    const p = (data as Record<string, unknown>)["provenance"];
    // Null and undefined are both "no stamp"; the first used to throw here.
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      return `the ${slot} observation carries no provenance; it cannot be trusted into this incident`;
    }
    const prov = p as Record<string, unknown>;

    if (prov["collection_id"] !== request.collection_id) {
      return `the ${slot} observation carries collection ${String(prov["collection_id"])}, not the ${request.collection_id} we asked under`;
    }
    if (prov["requested_for"] !== request.incident_id) {
      return `the ${slot} observation was gathered for ${String(prov["requested_for"])}, not for ${request.incident_id}`;
    }
    if (prov["cluster"] !== request.cluster) {
      return `the ${slot} observation came from cluster ${String(prov["cluster"])}, not from ${request.cluster}`;
    }
    if (prov["namespace"] !== request.namespace) {
      // The field that actually partitions tenant data, and it was required by
      // the schema and read by nothing until Grok pointed it out.
      return `the ${slot} observation came from namespace ${String(prov["namespace"])}, not from ${request.namespace}`;
    }
    if (typeof prov["provider"] !== "string" || prov["provider"].length === 0) {
      return `the ${slot} observation does not say which provider produced it`;
    }
  }

  if (collected === 0) return "no observation was collected; there is nothing whose provenance could be established";
  return null;
}

/** One collection per incident and scenario, so a rerun collides rather than multiplies. */
export function deterministicCollectionId(incidentId: string, scenario: string): string {
  const h = createHash("sha256").update(`${incidentId}|${scenario}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** `service:name` out of the alert tags, or null when the alert does not say. */
export function serviceFromTags(alert: Record<string, unknown>): string | null {
  const tags = alert["tags"];
  if (!Array.isArray(tags)) return null;
  for (const t of tags) {
    if (typeof t === "string" && t.startsWith("service:")) return t.slice("service:".length);
  }
  return null;
}

/*
 * The pure half lives in merge.ts and is transpiled into the n8n Code node.
 *
 * These wrappers keep the signatures every caller already uses while binding
 * the ajv-backed validator. Without them the split would have rippled through
 * every test, and a refactor that rewrites its own callers is a refactor whose
 * tests were rewritten with it.
 */
export function recordAgentResult(
  incident: Record<string, unknown>,
  result: unknown,
  /*
   * Who was asked, when the caller knows. The wrapper used to drop this on the
   * floor by not having it, so the deployed node could not have passed it even
   * if it wanted to — the parameter has to exist all the way down or the check
   * is unreachable from the only place it matters.
   */
  expected?: string,
): { state: "recorded"; incident: Record<string, unknown>; normalised: number }
  | { state: "refused"; reason: string; errors?: string[] } {
  return mergeRecordAgentResult(validate as Validate, incident, result, expected);
}

export function concludeIncident(
  incident: Record<string, unknown>,
): { state: "concluded"; incident: Record<string, unknown> } | { state: "refused"; reason: string; errors?: string[] } {
  return mergeConcludeIncident(validate as Validate, incident);
}

export { resultBelongsHere, resolveRef, runnableAgents, normaliseRef, withResolvedRefs } from "./merge.js";
