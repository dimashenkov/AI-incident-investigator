/**
 * The fake providers.
 *
 * Everything external is simulated in this MVP, and these read the scenario
 * fixtures from disk. The point is not realism — it is that the shapes are
 * fixed, so the rest of the system can be tested without a cluster.
 *
 * What these are NOT: a description of what a real Datadog, Kubernetes or log
 * backend returns. Codex was explicit when this chunk was scoped — a schema
 * inferred from today's fixtures would claim to describe a provider while
 * covering only the sample. The schemas they validate against are called
 * fixture contracts for that reason, and when a real provider arrives its
 * responses get recorded first and the contracts widen to match.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Reading does not validate. The fixture contracts are checked where the
 * observation is assembled into an incident, because that is where a bad shape
 * would do damage, and because a reader that silently validated would give two
 * different answers to "did this file load".
 */

export type Slot = "kubernetes" | "logs" | "metrics";
export const SLOTS: readonly Slot[] = ["kubernetes", "logs", "metrics"];

const SCENARIO_ROOT = new URL("../../scenarios/", import.meta.url).pathname;

/**
 * Three outcomes, never two.
 *
 * `collected` — the provider read something and here it is.
 * `nothing`   — the provider ran and found nothing to report. Distinct from
 *               never having run, which is why the incident schema separates
 *               null from a missing key.
 * `failed`    — the provider could not read. Not an empty observation: an
 *               unreadable source and an empty one lead to opposite conclusions.
 */
export type Observation =
  | { state: "collected"; slot: Slot; data: unknown }
  | { state: "nothing"; slot: Slot }
  | { state: "failed"; slot: Slot; reason: string };

export function listScenarios(root: string = SCENARIO_ROOT): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * How a scenario says "this provider found nothing".
 *
 * It says it in a file, on purpose. Codex, chunk 1 part 4: treating a MISSING
 * file as `nothing` made a misspelled scenario name, a wrong root, a deleted
 * fixture and a deliberately empty slot all arrive as the same answer — and
 * that answer then becomes a valid `null` observation which nobody can
 * distinguish from a provider that genuinely looked. Absence read as consent,
 * inside the very function written to keep three outcomes apart.
 *
 * Nothing is now a claim someone made, in a file that exists.
 */
export const NOTHING_SENTINEL = "__nothing";

/**
 * Read one slot for one scenario.
 *
 * A missing root or scenario directory is `failed`: it means the caller asked
 * for something that is not there, which is not a fact about any provider.
 * A missing slot file inside a real scenario is also `failed` — an incomplete
 * fixture is a broken fixture, and it must not pass as an empty observation.
 * Unreadable or malformed content is `failed` too.
 *
 * Only a present file carrying the sentinel is `nothing`.
 */
export function readSlot(scenario: string, slot: Slot, root: string = SCENARIO_ROOT): Observation {
  if (!existsSync(root)) return { state: "failed", slot, reason: `no scenario root at ${root}` };

  const dir = join(root, scenario);
  if (!existsSync(dir)) return { state: "failed", slot, reason: `no such scenario: ${scenario}` };

  const path = join(root, scenario, `${slot}.json`);
  if (!existsSync(path)) {
    return { state: "failed", slot, reason: `${scenario} has no ${slot}.json; a scenario that means "nothing here" says so with { "${NOTHING_SENTINEL}": "reason" }` };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { state: "failed", slot, reason: `unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { state: "failed", slot, reason: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (typeof data === "object" && data !== null && NOTHING_SENTINEL in (data as Record<string, unknown>)) {
    return { state: "nothing", slot };
  }

  return { state: "collected", slot, data };
}

/** Read every slot for a scenario, keeping each outcome distinct. */
export function readScenario(scenario: string, root: string = SCENARIO_ROOT): Record<Slot, Observation> {
  return Object.fromEntries(SLOTS.map((s) => [s, readSlot(scenario, s, root)])) as Record<Slot, Observation>;
}

/**
 * Turn observations into the shape the incident schema wants.
 *
 * `collected` becomes the data. `nothing` becomes null — the schema's way of
 * saying a slot was looked at and held nothing. `failed` ALSO becomes null in
 * the observation itself, and that is a loss the caller must record elsewhere:
 * the incident schema has no room for "could not read", so a failure that is
 * silently written as null is a failure nobody can see afterwards.
 */
export function toObservations(obs: Record<Slot, Observation>): {
  observations: Record<Slot, unknown>;
  failures: Array<{ slot: Slot; reason: string }>;
} {
  const observations = {} as Record<Slot, unknown>;
  const failures: Array<{ slot: Slot; reason: string }> = [];
  for (const slot of SLOTS) {
    const o = obs[slot];
    if (o.state === "collected") observations[slot] = o.data;
    else observations[slot] = null;
    if (o.state === "failed") failures.push({ slot, reason: o.reason });
  }
  return { observations, failures };
}

/** The alert a scenario starts from, or null when it declares none. */
export function readAlert(scenario: string, root: string = SCENARIO_ROOT): unknown | null {
  const path = join(root, scenario, "alert.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
