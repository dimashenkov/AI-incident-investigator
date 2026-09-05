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
 * Three reviewers on 2026-09-05 found four ways this went wrong, and all four
 * were the same shape: a path that ends somewhere other than a stated outcome.
 *
 *  - it read `incident.analysis` behind a type assertion and indexed it, so a
 *    missing analysis threw instead of being refused. A crash is not a refusal:
 *    no reason, no errors, nothing a human can read.
 *  - it rejected `invalid` and `unchecked` by name and fell through otherwise,
 *    so any other state was treated as recorded success — success that was
 *    never established.
 *  - when the post-attach check came back `unchecked`, it still said the reply
 *    made the incident invalid, blaming the model for a validator that could
 *    not run or an incident that was already broken.
 *  - it accepted any schema-valid result, including one belonging to another
 *    incident, and never checked that a finding's `source_ref` resolves in the
 *    observation that agent was actually given.
 */
export function recordAgentResult(
  incident: Record<string, unknown>,
  result: unknown,
): { state: "recorded"; incident: Record<string, unknown> } | { state: "refused"; reason: string; errors?: string[] } {
  // The incident is checked first, so a pre-existing problem is not reported as
  // something the reply did.
  const before = validate("incident", incident);
  if (before.state === "invalid") {
    return { state: "refused", reason: "the incident was already invalid before the result arrived", errors: before.errors };
  }
  if (before.state === "unchecked") {
    return { state: "refused", reason: `could not validate the incident: ${before.reason}` };
  }

  const r = validate("agent-result", result);
  if (r.state !== "valid") {
    return {
      state: "refused",
      reason: r.state === "invalid" ? "the agent result does not validate" : `could not validate the agent result: ${r.reason}`,
      errors: r.state === "invalid" ? r.errors : [r.reason],
    };
  }

  const bound = resultBelongsHere(incident, result as Record<string, unknown>);
  if (bound !== null) return { state: "refused", reason: bound };

  const analysis = incident["analysis"];
  if (typeof analysis !== "object" || analysis === null) {
    return { state: "refused", reason: "the incident has no analysis to record into" };
  }
  const existing = (analysis as Record<string, unknown>)["agents"];
  if (existing !== undefined && !Array.isArray(existing)) {
    // Replacing it would silently discard whatever turns were already there.
    return { state: "refused", reason: "analysis.agents is present but is not a list; refusing rather than replacing it" };
  }

  const next = {
    ...incident,
    analysis: { ...(analysis as Record<string, unknown>), agents: [...((existing as unknown[]) ?? []), result] },
  };

  const whole = validate("incident", next);
  if (whole.state === "invalid") {
    return { state: "refused", reason: "attaching the result made the incident invalid", errors: whole.errors };
  }
  if (whole.state === "unchecked") {
    return { state: "refused", reason: `could not validate the incident after attaching: ${whole.reason}` };
  }
  return { state: "recorded", incident: next };
}

/**
 * Does this result belong to this incident, and to an agent that could have run?
 *
 * Returns null when it does, and the reason when it does not.
 *
 * Codex, 2026-09-05: "accepted specialist results contain neither incident_id
 * nor a binding to the requested agent/scenario… consequently accepts any
 * schema-valid result — including a reply from another call — and does not
 * verify that source_ref resolves in that agent's observation."
 *
 * Verified before accepting: a reply citing `nowhere_at_all` was recorded.
 */
export function resultBelongsHere(incident: Record<string, unknown>, result: Record<string, unknown>): string | null {
  const agent = result["agent"];
  if (typeof agent !== "string") return "the result names no agent";

  // The root cause agent reads the other agents' results, not an observation,
  // so there is no slot to resolve its citations against here.
  if (agent === "root_cause") {
    const agents = (incident["analysis"] as Record<string, unknown> | undefined)?.["agents"];
    if (!Array.isArray(agents) || agents.length === 0) {
      return "a root cause result cannot be recorded before any agent has reported";
    }
    return null;
  }

  const observations = incident["observations"];
  const observation = typeof observations === "object" && observations !== null
    ? (observations as Record<string, unknown>)[agent]
    : undefined;
  if (observation === undefined) return `the incident has no ${agent} observation slot`;
  if (observation === null) return `${agent} reported on a slot where nothing was collected`;

  const findings = result["findings"];
  if (!Array.isArray(findings)) return "the result carries no findings list";
  for (const f of findings) {
    const ref = typeof f === "object" && f !== null ? (f as Record<string, unknown>)["source_ref"] : undefined;
    if (typeof ref !== "string") return "a finding carries no source_ref";
    if (resolveRef(observation, ref) === undefined) {
      return `a finding cites ${ref}, which resolves to nothing in the ${agent} observation`;
    }
  }
  return null;
}

/** Follow a path like `pods[0].containers[0].limits.memory` into an observation. */
export function resolveRef(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Which observation slots actually hold data. Used to decide which agents can run at all. */
export function runnableAgents(incident: Record<string, unknown>): Slot[] {
  const observations = incident["observations"];
  if (typeof observations !== "object" || observations === null) return [];
  const o = observations as Record<string, unknown>;
  return SLOTS.filter((s) => o[s] !== null && o[s] !== undefined);
}

export type { Observation };

/**
 * Promote the root cause agent's hypothesis into the incident's verdict.
 *
 * Codex, 2026-09-05: "nothing updates incident status or its root-cause
 * fields." The root cause agent's answer could be recorded as one more agent
 * result and then sat there — the incident stayed `investigating` with a null
 * cause, and the one answer the whole system exists to produce had no way to
 * become the incident's own.
 *
 * The promotion is deterministic on purpose. The model proposes; this decides
 * what the incident says, using rules a human can check without rerunning
 * anything:
 *
 *  - no hypothesis at all means the evidence did not support one, which is
 *    recorded as insufficient_evidence rather than left as still-investigating;
 *  - a hypothesis becomes the cause, and its supporting citations become the
 *    incident's evidence;
 *  - more than one hypothesis is refused, because choosing between them is a
 *    judgement nobody made.
 */
export function concludeIncident(
  incident: Record<string, unknown>,
): { state: "concluded"; incident: Record<string, unknown> } | { state: "refused"; reason: string; errors?: string[] } {
  const analysis = incident["analysis"];
  if (typeof analysis !== "object" || analysis === null) return { state: "refused", reason: "the incident has no analysis" };
  const agents = (analysis as Record<string, unknown>)["agents"];
  if (!Array.isArray(agents)) return { state: "refused", reason: "the incident carries no agent results" };

  const verdicts = agents.filter((a) => typeof a === "object" && a !== null && (a as Record<string, unknown>)["agent"] === "root_cause");
  if (verdicts.length === 0) return { state: "refused", reason: "the root cause agent has not reported" };
  if (verdicts.length > 1) return { state: "refused", reason: `${verdicts.length} root cause results; which one is the verdict is nobody's decision to guess` };

  const verdict = verdicts[0] as Record<string, unknown>;
  const hypotheses = verdict["hypotheses"];
  if (!Array.isArray(hypotheses)) return { state: "refused", reason: "the root cause result carries no hypotheses list" };
  if (hypotheses.length > 1) {
    return { state: "refused", reason: `the root cause agent proposed ${hypotheses.length} causes; picking one is a judgement it did not make` };
  }

  const findings = Array.isArray(verdict["findings"]) ? (verdict["findings"] as Array<Record<string, unknown>>) : [];
  const confidence = typeof verdict["confidence"] === "number" ? verdict["confidence"] : 0;

  if (hypotheses.length === 0) {
    // `evidence` stays empty on purpose, and the facts are not lost by it.
    //
    // Every entry must state whether it supports or contradicts the conclusion,
    // and there is no conclusion here — calling a fact "against" a cause nobody
    // named would be an invented stance. The findings remain where they were
    // reported, in analysis.agents, which is the record of what was actually
    // seen; `evidence` is the record of what a diagnosis rests on, and this
    // incident has no diagnosis to rest anything on.
    return finish({
      ...incident,
      status: "insufficient_evidence",
      analysis: { ...(analysis as Record<string, unknown>), root_cause_code: "INSUFFICIENT_EVIDENCE",
        root_cause: "The evidence collected does not support naming a cause.",
        confidence, evidence: [] },
    });
  }

  const h = hypotheses[0] as Record<string, unknown>;
  const supported = Array.isArray(h["supported_by"]) ? (h["supported_by"] as string[]) : [];
  const evidence = findings
    .filter((f) => supported.includes(String(f["source_ref"])))
    .map((f) => ({ ...asEvidence(f), supports: "for" as const }));

  if (evidence.length === 0) {
    // The schema demands it, and so does the point: a diagnosis whose cited
    // support is not among the findings rests on nothing recorded.
    return { state: "refused", reason: "the hypothesis cites no finding the root cause agent reported" };
  }

  const against = findings
    .filter((f) => !supported.includes(String(f["source_ref"])))
    .map((f) => ({ ...asEvidence(f), supports: "against" as const }));

  return finish({
    ...incident,
    status: "diagnosed",
    analysis: { ...(analysis as Record<string, unknown>), root_cause_code: h["code"],
      root_cause: h["statement"], confidence, evidence: [...evidence, ...against] },
  });
}

function asEvidence(finding: Record<string, unknown>): { source: string; fact: string } {
  // The evidence source names where the fact came from. A root cause finding
  // cites another agent, so the source is that agent's own slot when the
  // citation says so, and `datadog` otherwise — never invented.
  const ref = String(finding["source_ref"] ?? "");
  const source = ref.startsWith("pods") || ref.startsWith("events") || ref.startsWith("deployment")
    ? "kubernetes"
    : ref.startsWith("lines") || ref.startsWith("truncated") || ref.startsWith("window")
      ? "logs"
      : ref.startsWith("series")
        ? "metrics"
        : "datadog";
  return { source, fact: String(finding["fact"] ?? "") };
}

function finish(next: Record<string, unknown>): { state: "concluded"; incident: Record<string, unknown> } | { state: "refused"; reason: string; errors?: string[] } {
  const r = validate("incident", next);
  if (r.state === "valid") return { state: "concluded", incident: next };
  return {
    state: "refused",
    reason: r.state === "invalid" ? "the concluded incident does not validate" : `could not validate the conclusion: ${r.reason}`,
    errors: r.state === "invalid" ? r.errors : [r.reason],
  };
}
