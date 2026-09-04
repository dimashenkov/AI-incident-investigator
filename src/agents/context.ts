/**
 * Assembling what an agent is given.
 *
 * This is where cross-incident leakage would happen, and Codex said in the very
 * first review of the plan that testing the model's answer is not enough:
 *
 *   "Model-output assertions alone are insufficient because a model may ignore
 *    leaked data."
 *
 * A model that received another incident's data and happened not to mention it
 * would pass an output test while the leak sat there. So the thing under test
 * is the assembled context itself, before any model sees it, and these
 * functions exist to be testable without spending anything.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type AgentName = "kubernetes" | "logs" | "metrics" | "root-cause";
export const OBSERVING_AGENTS: readonly AgentName[] = ["kubernetes", "logs", "metrics"];

const PROMPT_ROOT = new URL("../../prompts/", import.meta.url).pathname;

/** Which observation slot each observing agent reads. Root cause reads none. */
export const AGENT_SLOT: Record<AgentName, string | null> = {
  kubernetes: "kubernetes",
  logs: "logs",
  metrics: "metrics",
  "root-cause": null,
};

/**
 * Read an own property only.
 *
 * Codex, chunk 2: indexed access accepts an inherited slot or a getter, so a
 * prototype could supply an "observation" nobody put in the incident.
 */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** Copy through the same serialisation the model call will cross. */
function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type ContextResult =
  | { state: "assembled"; agent: AgentName; prompt: string; payload: Record<string, unknown> }
  | { state: "unavailable"; agent: AgentName; reason: string };

export function readPrompt(agent: AgentName, root: string = PROMPT_ROOT): string | null {
  const path = join(root, `${agent}-agent.md`);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Build the payload for one observing agent, from one incident.
 *
 * It copies the single slot this agent reads and the incident id, and nothing
 * else. Not "everything except the other incidents" — only what was asked for.
 * A deny-list would have to anticipate every field that might one day carry
 * another incident's data; an allow-list cannot be surprised by a field nobody
 * thought of, because it never copies one.
 */
export function assembleObservingContext(
  agent: AgentName,
  incident: Record<string, unknown>,
  root: string = PROMPT_ROOT,
): ContextResult {
  const slot = AGENT_SLOT[agent];
  if (slot === null) {
    return { state: "unavailable", agent, reason: `${agent} does not read an observation slot` };
  }

  const prompt = readPrompt(agent, root);
  if (prompt === null) return { state: "unavailable", agent, reason: `no prompt file for ${agent}` };

  const incidentId = own(incident, "incident_id");
  if (typeof incidentId !== "string") {
    // Without an id there is nothing to stamp the context with, and nothing to
    // check a leak against afterwards. Refusing is the only honest answer.
    return { state: "unavailable", agent, reason: "the incident carries no incident_id" };
  }

  const observations = own(incident, "observations");
  const observation = typeof observations === "object" && observations !== null
    ? own(observations as Record<string, unknown>, slot)
    : undefined;

  if (observation === undefined) {
    return { state: "unavailable", agent, reason: `the incident has no ${slot} observation slot` };
  }
  if (observation === null) {
    return { state: "unavailable", agent, reason: `nothing was collected for ${slot}` };
  }

  return {
    state: "assembled",
    agent,
    prompt,
    // Cloned through JSON, which is the boundary the model call will cross
    // anyway. Codex, chunk 2: the payload used to hold a live reference into the
    // incident, so mutating the source afterwards changed a context that had
    // already been checked — data travelling after the check that was meant to
    // stop it.
    payload: { incident_id: incidentId, observation: snapshot(observation) },
  };
}

/**
 * Build the payload for the root cause agent.
 *
 * It receives the agent results and the incident id — never the raw
 * observations. Every claim it makes must rest on something an agent reported,
 * and handing it the observations would let it introduce a fact with nothing
 * behind it for a human to trace.
 */
export function assembleRootCauseContext(
  incident: Record<string, unknown>,
  root: string = PROMPT_ROOT,
): ContextResult {
  const prompt = readPrompt("root-cause", root);
  if (prompt === null) return { state: "unavailable", agent: "root-cause", reason: "no prompt file for root-cause" };

  const incidentId = own(incident, "incident_id");
  if (typeof incidentId !== "string") {
    return { state: "unavailable", agent: "root-cause", reason: "the incident carries no incident_id" };
  }

  const analysis = own(incident, "analysis");
  const agents = typeof analysis === "object" && analysis !== null
    ? own(analysis as Record<string, unknown>, "agents")
    : undefined;

  if (!Array.isArray(agents)) {
    return { state: "unavailable", agent: "root-cause", reason: "the incident carries no agent results" };
  }
  if (agents.length === 0) {
    // No agent ran, so there is nothing to weigh. Asking anyway would produce a
    // conclusion resting on nothing, which is the failure this system is for.
    return { state: "unavailable", agent: "root-cause", reason: "no agent results to weigh" };
  }

  return { state: "assembled", agent: "root-cause", prompt, payload: { incident_id: incidentId, agent_results: snapshot(agents) } };
}

/**
 * Does this context contain anything that did not come from this incident?
 *
 * This is the real isolation check, and it works by PROVENANCE rather than by
 * recognising anything. The context was assembled by copying named parts of one
 * incident; so the test is whether the payload still equals exactly those parts.
 * Anything else — a foreign observation, a customer record, a secret, an id in
 * a format nobody anticipated — makes the payload differ from what it should be,
 * whether or not it looks like anything we know.
 *
 * Codex, chunk 2, on the previous version: "This function checks 'recognized
 * incident IDs', not isolation." It reported clean for a copied log line
 * carrying another customer's password, because no INC-pattern appeared in it.
 * A check named for a property must test the property, not a proxy for it.
 */
export function checkProvenance(
  result: ContextResult,
  incident: Record<string, unknown>,
): { state: "clean" } | { state: "foreign"; paths: string[] } | { state: "unchecked"; reason: string } {
  if (result.state !== "assembled") return { state: "unchecked", reason: result.reason };

  const expected = expectedPayload(result.agent, incident);
  if (expected === null) return { state: "unchecked", reason: `cannot derive the expected payload for ${result.agent}` };

  const paths = deepDiffPaths(expected, result.payload);
  if (paths.length > 0) return { state: "foreign", paths };
  return { state: "clean" };
}

/** What the payload for this agent must contain, derived from the incident itself. */
function expectedPayload(agent: AgentName, incident: Record<string, unknown>): Record<string, unknown> | null {
  const incidentId = own(incident, "incident_id");
  if (typeof incidentId !== "string") return null;

  if (agent === "root-cause") {
    const analysis = own(incident, "analysis");
    const agents = typeof analysis === "object" && analysis !== null ? own(analysis as Record<string, unknown>, "agents") : undefined;
    if (!Array.isArray(agents)) return null;
    return { incident_id: incidentId, agent_results: snapshot(agents) };
  }

  const slot = AGENT_SLOT[agent];
  if (slot === null) return null;
  const observations = own(incident, "observations");
  const observation = typeof observations === "object" && observations !== null
    ? own(observations as Record<string, unknown>, slot)
    : undefined;
  if (observation === undefined || observation === null) return null;
  return { incident_id: incidentId, observation: snapshot(observation) };
}

/** Every path where the actual payload departs from the expected one. */
export function deepDiffPaths(expected: unknown, actual: unknown, path = ""): string[] {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return [path || "(root)"];
    const out: string[] = [];
    if (expected.length !== actual.length) out.push(`${path}/(length)`);
    for (let i = 0; i < Math.max(expected.length, actual.length); i += 1) {
      out.push(...deepDiffPaths(expected[i], actual[i], `${path}/${i}`));
    }
    return out;
  }

  const bothObjects =
    typeof expected === "object" && expected !== null && typeof actual === "object" && actual !== null;
  if (bothObjects) {
    const out: string[] = [];
    const keys = new Set([...Object.keys(expected as object), ...Object.keys(actual as object)]);
    for (const k of keys) {
      out.push(...deepDiffPaths((expected as Record<string, unknown>)[k], (actual as Record<string, unknown>)[k], `${path}/${k}`));
    }
    return out;
  }

  return Object.is(expected, actual) ? [] : [path || "(root)"];
}

/**
 * Every incident id mentioned anywhere in a value.
 *
 * Kept as a SECOND, weaker check beside the provenance one, and named for what
 * it does. It catches a specific mistake — this incident's context naming
 * another incident — quickly and legibly. It is not evidence of isolation, and
 * nothing in this file treats it as such.
 */
export function foreignIncidentIds(payload: unknown, ownId: string): string[] {
  const PATTERN = /INC-\d{4}-\d{4}/g;
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(PATTERN)) found.add(m[0]);
      return;
    }
    if (Array.isArray(v)) return void v.forEach(walk);
    if (typeof v === "object" && v !== null) {
      for (const [k, val] of Object.entries(v)) {
        walk(k);
        walk(val);
      }
    }
  };
  walk(payload);
  return [...found].filter((id) => id !== ownId);
}
