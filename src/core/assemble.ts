/**
 * Build an incident from a scenario, without calling anything.
 *
 * This is the deterministic spine: everything that happens before a model is
 * asked anything, and everything that happens after it answers. Keeping it here
 * rather than inside an agent means the expensive part is only the reasoning,
 * and every rule about shape, evidence and isolation is checked for free.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readAlert, readScenario, toObservations, SLOTS, type Slot, type Observation } from "../providers/fixtures.js";
import { validate } from "../schema/validate.js";

export type Assembly =
  | { state: "assembled"; incident: Record<string, unknown>; failures: Array<{ slot: Slot; reason: string }> }
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
  opts: { service?: string; namespace?: string; cluster?: string; root?: string } = {},
): Assembly {
  let incidentId: string;
  try {
    incidentId = incidentIdFor(scenario, sequence, opts.root === undefined ? readRegistry() : readRegistry(opts.root));
  } catch (e) {
    return { state: "refused", reason: e instanceof Error ? e.message : String(e) };
  }
  const alert = opts.root === undefined ? readAlert(scenario) : readAlert(scenario, opts.root);
  if (alert === null) return { state: "refused", reason: `scenario ${scenario} has no readable alert.json` };

  const obs = opts.root === undefined ? readScenario(scenario) : readScenario(scenario, opts.root);
  const { observations, failures } = toObservations(obs);

  // Every slot failing is not an incident with three empty observations — it is
  // a scenario that could not be read at all, and building one would produce a
  // document asserting three absences that were never established.
  if (failures.length === SLOTS.length) {
    return { state: "refused", reason: `every observation failed for ${scenario}: ${failures.map((f) => f.reason).join("; ")}` };
  }

  const alertObj = alert as Record<string, unknown>;
  const incident = {
    incident_id: incidentId,
    status: "investigating",
    service: opts.service ?? serviceFromTags(alertObj) ?? "unknown-service",
    namespace: opts.namespace ?? "production",
    cluster: opts.cluster ?? "prod-eu",
    started_at: alertObj["triggered_at"],
    scenario,
    source: { provider: "fake-datadog", alert },
    observations,
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

/** `service:name` out of the alert tags, or null when the alert does not say. */
export function serviceFromTags(alert: Record<string, unknown>): string | null {
  const tags = alert["tags"];
  if (!Array.isArray(tags)) return null;
  for (const t of tags) {
    if (typeof t === "string" && t.startsWith("service:")) return t.slice("service:".length);
  }
  return null;
}

/**
 * Record an agent's result on the incident.
 *
 * Validated before it is attached, because an invalid result inside a valid
 * incident is exactly the shape that passes the incident check and poisons
 * everything downstream of it.
 */
export function recordAgentResult(
  incident: Record<string, unknown>,
  result: unknown,
): { state: "recorded"; incident: Record<string, unknown> } | { state: "refused"; reason: string; errors?: string[] } {
  const r = validate("agent-result", result);
  if (r.state === "invalid") return { state: "refused", reason: "the agent result does not validate", errors: r.errors };
  if (r.state === "unchecked") return { state: "refused", reason: `could not validate the agent result: ${r.reason}` };

  const analysis = incident["analysis"] as Record<string, unknown>;
  const agents = Array.isArray(analysis["agents"]) ? [...(analysis["agents"] as unknown[])] : [];
  const next = {
    ...incident,
    analysis: { ...analysis, agents: [...agents, result] },
  };

  const whole = validate("incident", next);
  if (whole.state !== "valid") {
    return { state: "refused", reason: "attaching the result made the incident invalid", errors: whole.state === "invalid" ? whole.errors : [whole.reason] };
  }
  return { state: "recorded", incident: next };
}

/** Which observation slots actually hold data. Used to decide which agents can run at all. */
export function runnableAgents(incident: Record<string, unknown>): Slot[] {
  const observations = incident["observations"];
  if (typeof observations !== "object" || observations === null) return [];
  const o = observations as Record<string, unknown>;
  return SLOTS.filter((s) => o[s] !== null && o[s] !== undefined);
}

export type { Observation };
