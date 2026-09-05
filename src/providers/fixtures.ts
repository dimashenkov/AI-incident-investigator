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

/**
 * A collection request, issued BEFORE anything is gathered.
 *
 * Grok and Codex, independently, 2026-09-05, on the version this replaces:
 * "provenance-as-payload is still content scanning — the foreign record that
 * carried no incident id now carries a forged stamp instead", and "it
 * establishes only internal consistency among assertions carried by the
 * observations."
 *
 * They were right, and it was the same mistake a third time: checking fields
 * inside the record being admitted. The id is ours now. We mint it, we hand it
 * to a provider, and an observation is stamped with the request it was gathered
 * under rather than with whatever it claims about itself.
 *
 * What this establishes, exactly: that this data arrived under a request WE
 * made, for this incident, in one collection. What it does not, and cannot from
 * here: that the provider returned the right data. A provider handing back
 * another tenant's pods under a correct request is invisible to us, and that
 * is recorded where things nothing can check are recorded.
 */
export type CollectionRequest = {
  collection_id: string;
  incident_id: string;
  cluster: string;
  namespace: string;
};

/** A request id nobody but the caller could have supplied. */
export function newCollectionRequest(
  incident_id: string, cluster: string, namespace: string, id: string,
): CollectionRequest {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new Error(`a collection id must be a uuid, got ${JSON.stringify(id)}`);
  }
  return { collection_id: id, incident_id, cluster, namespace };
}
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
  | { state: "failed"; slot: Slot; kind: FailureKind; reason: string };

/*
 * Why a failed slot is not one thing.
 *
 * "The file is not there" and "the answer names another tenant's namespace" are
 * both failures of the slot, and merging them makes the second as survivable as
 * the first: two good slots would carry the incident and the contradiction
 * would be recorded as one absence among three. So the kind is required rather
 * than defaulted — a new failure site has to say which it is, and a site that
 * forgets does not silently become the survivable one.
 */
export type FailureKind =
  | "absent"        // nothing was there to read
  | "unreadable"    // something was there and could not be understood
  | "contradiction" // something was there, was understood, and disagrees with the request

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

/** Everything a stamp is allowed to carry, so nothing can hide beside it. */
export const STAMP_FIELDS = ["collection_id", "requested_for", "cluster", "namespace", "provider"];

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
export function readSlot(
  scenario: string, slot: Slot, root: string = SCENARIO_ROOT, request?: CollectionRequest,
): Observation {
  if (!existsSync(root)) return { state: "failed", slot, kind: "absent", reason: `no scenario root at ${root}` };

  const dir = join(root, scenario);
  if (!existsSync(dir)) return { state: "failed", slot, kind: "absent", reason: `no such scenario: ${scenario}` };

  const path = join(root, scenario, `${slot}.json`);
  if (!existsSync(path)) {
    return { state: "failed", slot, kind: "absent", reason: `${scenario} has no ${slot}.json; a scenario that means "nothing here" says so with { "${NOTHING_SENTINEL}": "reason" }` };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { state: "failed", slot, kind: "unreadable", reason: `unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { state: "failed", slot, kind: "unreadable", reason: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (request !== undefined) return stampOrRefuse(data, slot, request);

  if (typeof data === "object" && data !== null) {
    // The unstamped path — used by tests that read a fixture raw. Same
    // classifier, deliberately a different variable name so the two call sites
    // stay distinguishable to the mutation anchors.
    const rawSaid = readSentinel(data as Record<string, unknown>, slot);
    if (rawSaid !== null) return rawSaid;
  }

  return { state: "collected", slot, data };
}

/**
 * Classify a payload that may be claiming "there was nothing here".
 *
 * Returns null when no claim is being made, so the caller carries on.
 *
 * Codex, 2026-09-05, two findings in one: the sentinel was recognised in two
 * places whose surrounding checks had already drifted apart, and neither looked
 * at what the sentinel actually said. `{ "__nothing": false }`, a null, and an
 * object carrying real observation data alongside the key all became an
 * established absence. "Nothing here" is the one answer nothing downstream
 * re-examines, so it is the one that has to say why, and say only that.
 */
function readSentinel(data: Record<string, unknown>, slot: Slot): Observation | null {
  if (!(NOTHING_SENTINEL in data)) return null;
  const why = data[NOTHING_SENTINEL];
  if (typeof why !== "string" || why.trim().length === 0) {
    return { state: "failed", slot, kind: "unreadable",
      reason: `the ${slot} response claims nothing was there but does not say why: ${NOTHING_SENTINEL} is ${JSON.stringify(why)}, and it has to be a non-empty reason` };
  }
  // Codex, 2026-09-05: exempting `provenance` wholesale left a pocket. A
  // correctly stamped payload could carry `series` INSIDE the provenance object
  // and be classified as an established absence, because nothing looked in
  // there. The stamp is a closed shape, so it is checked as one.
  const prov = data["provenance"];
  if (prov !== undefined) {
    if (typeof prov !== "object" || prov === null || Array.isArray(prov)) {
      return { state: "failed", slot, kind: "unreadable",
        reason: `the ${slot} response claims nothing was there and carries a provenance that is not an object` };
    }
    const strays = Object.keys(prov as Record<string, unknown>).filter((k) => !STAMP_FIELDS.includes(k));
    if (strays.length > 0) {
      return { state: "failed", slot, kind: "contradiction",
        reason: `the ${slot} response claims nothing was there and hides ${strays.join(", ")} inside its provenance` };
    }
  }
  const extra = Object.keys(data).filter((k) => k !== NOTHING_SENTINEL && k !== "provenance");
  if (extra.length > 0) {
    return { state: "failed", slot, kind: "contradiction",
      reason: `the ${slot} response claims nothing was there and carries ${extra.join(", ")} as well; an absence and an observation are different answers` };
  }
  return { state: "nothing", slot };
}

/** Read every slot for a scenario, keeping each outcome distinct. */
export function readScenario(
  scenario: string, root: string = SCENARIO_ROOT, request?: CollectionRequest,
): Record<Slot, Observation> {
  return Object.fromEntries(SLOTS.map((s) => [s, readSlot(scenario, s, root, request)])) as Record<Slot, Observation>;
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
  // The kind travels with the failure. It used to be dropped here, and the
  // caller's "refuse on a contradiction" then read a field that no longer
  // existed — a check that was written, typed away, and silently never true.
  failures: Array<{ slot: Slot; kind: FailureKind; reason: string }>;
} {
  const observations = {} as Record<Slot, unknown>;
  const failures: Array<{ slot: Slot; kind: FailureKind; reason: string }> = [];
  for (const slot of SLOTS) {
    const o = obs[slot];
    if (o.state === "collected") observations[slot] = o.data;
    else observations[slot] = null;
    if (o.state === "failed") failures.push({ slot, kind: o.kind, reason: o.reason });
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

/**
 * Check what an answer claims about itself, then stamp it from the request.
 *
 * Extracted on 2026-09-05 so more than one provider routes through the same
 * check rather than reimplementing it. Deliberately NOT exported: Codex, the
 * same day, "extraction made request possession sufficient to manufacture
 * trusted-looking observations". Providers reach it through readSlotWithPayload
 * below, which is a named door rather than the whole wall.
 */
function stampOrRefuse(data: unknown, slot: Slot, request: CollectionRequest): Observation {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { state: "failed", slot, kind: "unreadable", reason: "the observation is not an object and cannot be stamped" };
  }
  const claimed = (data as Record<string, unknown>)["provenance"];
  if (claimed !== undefined) {
    // A provider that stamps its own answer is making a claim, and the claim
    // is checked in full rather than overwritten. Overwriting would erase
    // exactly the disagreement worth knowing about — an answer that agrees
    // about the collection and names another tenant's namespace would have
    // been silently normalised into ours.
    if (typeof claimed !== "object" || claimed === null || Array.isArray(claimed)) {
      return { state: "failed", slot, kind: "unreadable", reason: `the ${slot} response carries a provenance that is not an object` };
    }
    const c = claimed as Record<string, unknown>;
    const disagreements = ([
      ["collection_id", request.collection_id],
      ["requested_for", request.incident_id],
      ["cluster", request.cluster],
      ["namespace", request.namespace],
      // Codex, 2026-09-05: the fifth field was neither compared nor kept —
      // whatever the answer called itself was overwritten with fake-slot, so
      // an answer claiming to come from somewhere else said so and was
      // silently renamed into one of ours.
      //
      // And, from the next round: this compares an untrusted claim against a
      // predictable literal, so it establishes consistency, not authenticity.
      // Anything can call itself fake-kubernetes. It catches a provider that
      // says out loud that it is somebody else, and it is worth nothing
      // against one that lies. Named here so nobody reads it as proof of who
      // answered.
      ["provider", `fake-${slot}`],
    ] as const).filter(([k, want]) => c[k] !== want);
    if (disagreements.length > 0) {
      return { state: "failed", slot, kind: "contradiction",
        reason: `the ${slot} response disagrees with the request it was gathered under: ` +
          disagreements.map(([k, want]) => `${k} is ${String(c[k])}, not ${String(want)}`).join("; ") };
    }
  }
  // The sentinel is read only after the stamp has been checked. Codex,
  // 2026-09-05: it used to be recognised first, so an answer carrying both
  // the sentinel and a foreign stamp became a trusted "nothing" — the one
  // state that is believed without ever being looked at.
  const said = readSentinel(data as Record<string, unknown>, slot);
  if (said !== null) return said;

  // Stamped by us, from the request we issued — never read back from the answer.
  return { state: "collected", slot,
    data: { ...(data as Record<string, unknown>),
      provenance: { collection_id: request.collection_id, requested_for: request.incident_id,
        cluster: request.cluster, namespace: request.namespace, provider: `fake-${slot}` } } };
}

/**
 * The fixture-backed provider, as a Provider.
 *
 * The functions above are kept as they are — the gate, the tests and the
 * assembler all call readSlot directly — and this wraps them so the same
 * implementation can be held through the contract in provider.ts. Item 8 asks
 * whether another implementation could take its place; that question is only
 * answerable if this one is reachable the same way.
 */
export function fixtureProvider(root: string = SCENARIO_ROOT): import("./provider.js").Provider {
  return {
    name: "fixtures",
    exercised: true,
    unexercisedBecause: "",
    read: (scenario: string, slot: Slot, request: CollectionRequest): Observation =>
      readSlot(scenario, slot, root, request),
  };
}

/**
 * Admit a payload a provider already holds, through the same check as a file.
 *
 * The one door for an implementation that does not read from this repository's
 * scenario directories. It exists so a second provider cannot become a second
 * carrier of the stamping rule — and it grants nothing readSlot does not: the
 * payload is checked against the request, and refused when it disagrees.
 */
export function readSlotWithPayload(data: unknown, slot: Slot, request: CollectionRequest): Observation {
  return stampOrRefuse(data, slot, request);
}
