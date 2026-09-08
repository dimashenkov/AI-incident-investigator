/**
 * Building what an agent is given, with nothing that touches the disk.
 *
 * Split out of context.ts on 2026-09-05 for the same reason merge.ts was split
 * out of assemble.ts: this code has to run inside the n8n Code node, which has
 * no filesystem. The generator transpiles THIS file into the deployed workflow,
 * so the rule about what an agent may see is one carrier rather than two.
 *
 * The prompt arrives as an argument. Reading it is the only thing here that
 * needed a disk, and it is the one thing left behind in context.ts.
 */
export type AgentName = "kubernetes" | "logs" | "metrics" | "root-cause";
export const OBSERVING_AGENTS: readonly AgentName[] = ["kubernetes", "logs", "metrics"];


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

/**
 * Why a context could not be built, in a word a machine may branch on.
 *
 * `empty-slot` is the ONLY one a caller may turn into a skip: the provider ran
 * and reported an absence, so there is nothing to ask about. Every other value
 * means something went wrong, and the deployed node was branching on the
 * collection record alone — so a context refused for CONTAMINATION, the one
 * thing checkSourceForForeignIncidents exists to catch, was printed as "the
 * provider reported an established absence", the chain continued, and the run
 * scored correct. Measured by a subagent on 2026-09-07 against a real scenario.
 */
export type Unavailable = "empty-slot" | "no-slot" | "no-prompt" | "no-incident-id" | "no-such-slot" | "contaminated";

export type ContextResult =
  | { state: "assembled"; agent: AgentName; prompt: string; payload: Record<string, unknown> }
  | { state: "unavailable"; agent: AgentName; reason: string; why: Unavailable };


/**
 * Build the payload for one observing agent, from one incident.
 *
 * It copies the single slot this agent reads and the incident id, and nothing
 * else. Not "everything except the other incidents" — only what was asked for.
 * A deny-list would have to anticipate every field that might one day carry
 * another incident's data; an allow-list cannot be surprised by a field nobody
 * thought of, because it never copies one.
 */
export function buildObservingContext(
  agent: AgentName,
  incident: Record<string, unknown>,
  prompt: string | null,
): ContextResult {
  const slot = AGENT_SLOT[agent];
  if (slot === null) {
    return { state: "unavailable", agent, why: "no-slot", reason: `${agent} does not read an observation slot` };
  }

  /*
   * Not `=== null`. A prompt map built from a directory listing yields
   * UNDEFINED for a renamed or deleted file, and this guard let that through —
   * so the HTTP node built a request whose system prompt was `undefined` and
   * the call was paid for before the API said 400. The file already records
   * that failure costing money once; the guard was written for the other half.
   */
  if (typeof prompt !== "string" || prompt.length === 0) {
    return { state: "unavailable", agent, why: "no-prompt", reason: `no prompt for ${agent}` };
  }

  const incidentId = own(incident, "incident_id");
  if (typeof incidentId !== "string") {
    // Without an id there is nothing to stamp the context with, and nothing to
    // check a leak against afterwards. Refusing is the only honest answer.
    return { state: "unavailable", agent, why: "no-incident-id", reason: "the incident carries no incident_id" };
  }

  const observations = own(incident, "observations");
  const observation = typeof observations === "object" && observations !== null
    ? own(observations as Record<string, unknown>, slot)
    : undefined;

  if (observation === undefined) {
    return { state: "unavailable", agent, why: "no-such-slot", reason: `the incident has no ${slot} observation slot` };
  }
  if (observation === null) {
    return { state: "unavailable", agent, why: "empty-slot", reason: `nothing was collected for ${slot}` };
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
export function buildRootCauseContext(
  incident: Record<string, unknown>,
  prompt: string | null,
): ContextResult {
  if (typeof prompt !== "string" || prompt.length === 0) {
    return { state: "unavailable", agent: "root-cause", why: "no-prompt", reason: "no prompt for root-cause" };
  }

  const incidentId = own(incident, "incident_id");
  if (typeof incidentId !== "string") {
    return { state: "unavailable", agent: "root-cause", why: "no-incident-id", reason: "the incident carries no incident_id" };
  }

  const analysis = own(incident, "analysis");
  const agents = typeof analysis === "object" && analysis !== null
    ? own(analysis as Record<string, unknown>, "agents")
    : undefined;

  if (!Array.isArray(agents)) {
    return { state: "unavailable", agent: "root-cause", why: "empty-slot", reason: "the incident carries no agent results" };
  }
  if (agents.length === 0) {
    // No agent ran, so there is nothing to weigh. Asking anyway would produce a
    // conclusion resting on nothing, which is the failure this system is for.
    return { state: "unavailable", agent: "root-cause", why: "empty-slot", reason: "no agent results to weigh" };
  }

  return { state: "assembled", agent: "root-cause", prompt, payload: { incident_id: incidentId, agent_results: snapshot(agents) } };
}

/**
 * Does the assembler add anything to the payload beyond the slice it was told
 * to copy?
 *
 * This is what the function checks, and the name now says so. Grok, 2026-09-05,
 * on the previous version, which was called checkIsolation and then
 * checkProvenance:
 *
 *   "What it actually does is deep-diff the payload against expectedPayload(),
 *    which re-copies the same slot from the same incident with the same
 *    own/snapshot path as the assembler… the checker is a second copy of the
 *    copier, not an independent spec of what the agent may see."
 *
 * Verified before accepting: a log line carrying another customer's password,
 * placed in the observation ITSELF rather than added afterwards, returns clean.
 * It is on both sides of the comparison.
 *
 * So this establishes one real thing — the assembler copied the slice and
 * nothing else — and does NOT establish that the slice is free of foreign
 * material. That is a separate question with a separate check below, because
 * one name covering both is how the previous two versions came to claim more
 * than they tested.
 */
export function checkPayloadIsExactlyTheSlice(
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

/**
 * Does the incident itself carry another incident's identifier?
 *
 * The question the previous checks were named for and did not ask. An
 * observation contaminated at the source travels into the payload legitimately
 * — it IS the slice — so no comparison against the slice can see it. Only
 * looking at the content can.
 *
 * This is a weaker instrument than its name might suggest, and the limit is
 * stated rather than left to be discovered: it recognises incident ids. A
 * foreign log line with no id in it is invisible here, exactly as Grok pointed
 * out about the version this replaces. What makes it worth having anyway is
 * that it asks about the SOURCE, which nothing else did, and the source is
 * where contamination has to be caught — by the time it reaches the payload it
 * is indistinguishable from legitimate data.
 *
 * The honest scope: cross-incident ids, checked at the source, before assembly.
 */
export function checkSourceForForeignIncidents(
  incident: Record<string, unknown>,
): { state: "clean" } | { state: "contaminated"; foreign: string[] } | { state: "unchecked"; reason: string } {
  const ownId = own(incident, "incident_id");
  if (typeof ownId !== "string") return { state: "unchecked", reason: "the incident carries no incident_id" };

  const foreign = foreignIncidentIds(incident, ownId);
  if (foreign.length > 0) return { state: "contaminated", foreign };
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
    // Grok, 2026-09-05: only indices were compared, so a named property hung on
    // an array — lines.smuggled = "…" — produced no path at all, while extra
    // keys on a plain object did. An array is an object; its named keys are
    // compared like any other.
    const named = (v: unknown[]) => Object.keys(v).filter((k) => !/^\d+$/.test(k));
    for (const k of new Set([...named(expected), ...named(actual)])) {
      out.push(...deepDiffPaths(
        (expected as unknown as Record<string, unknown>)[k],
        (actual as unknown as Record<string, unknown>)[k],
        `${path}/${k}`,
      ));
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

/**
 * Build a context and refuse to hand it over unless both checks pass.
 *
 * Codex, 2026-09-05: "neither check is enforced in production… they are called
 * only by tests. Runtime callers can assemble and send a contaminated payload
 * without consulting either result… it created the appearance of a two-stage
 * guard without wiring either stage into the boundary."
 *
 * That was exactly right, and it is the same defect as all the others in
 * different clothing: a thing that looks like a guarantee while nothing makes
 * it one. A check that exists and is never called is worth precisely as much as
 * a comment saying the same words.
 *
 * This is the only function a caller should use. The two checks below it stay
 * exported because the tests examine them separately, but nothing sends a
 * payload to a model except through here.
 *
 * What it still does NOT establish is stated where each check is defined, and
 * repeated once here so a caller reading only this does not leave with more
 * confidence than the code earns: contamination already present in the
 * observation, carrying no incident id, passes both and reaches the agent.
 * Closing that needs trusted provenance at the ingestion boundary, which is
 * recorded as debt rather than pretended away.
 */
export function buildCheckedContext(
  agent: AgentName,
  incident: Record<string, unknown>,
  prompt: string | null,
): ContextResult {
  const source = checkSourceForForeignIncidents(incident);
  if (source.state === "contaminated") {
    return { state: "unavailable", agent, why: "contaminated", reason: `the incident carries another incident's data: ${source.foreign.join(", ")}` };
  }
  if (source.state === "unchecked") {
    return { state: "unavailable", agent, why: "contaminated", reason: `could not check the source: ${source.reason}` };
  }

  const built = agent === "root-cause"
    ? buildRootCauseContext(incident, prompt)
    : buildObservingContext(agent, incident, prompt);
  if (built.state !== "assembled") return built;

  const slice = checkPayloadIsExactlyTheSlice(built, incident);
  if (slice.state === "foreign") {
    return { state: "unavailable", agent, why: "contaminated", reason: `the payload holds something the slice does not: ${slice.paths.slice(0, 3).join(", ")}` };
  }
  if (slice.state === "unchecked") {
    return { state: "unavailable", agent, why: "contaminated", reason: `could not check the payload: ${slice.reason}` };
  }

  return built;
}
