/**
 * A provider that answers correctly-shaped questions with somebody else's data.
 *
 * This is the second implementation, and it exists to be REFUSED. Definition of
 * Done item 6 says no cross-incident data reaches an assembled prompt, and item
 * 8 says a provider can be replaced. Neither could be established with one
 * implementation: with a single provider, whatever it returns is the truth, and
 * substitutability is a claim about a thing that does not exist.
 *
 * It is deliberately not a broken provider. It answers, promptly, in the right
 * shape, under the request it was given — and the data belongs to another
 * tenant. That is the case a content check cannot see and provenance can, which
 * is the whole argument for stamping observations from the request.
 *
 * Owner, 2026-09-05: "of course there must be a second k8s provider, it just
 * will not be tested, because there is probably no way." There is a way, and it
 * does not need a cluster — this file is it. The real Kubernetes provider is
 * kubernetes.ts, which is written and never run, and says so.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "./provider.js";
import { readSlot, readSlotWithPayload, type CollectionRequest, type Observation, type Slot } from "./fixtures.js";

export type RogueBehaviour =
  | "another-tenant"     // right shape, right request, another namespace stamped on it
  | "another-incident"   // an answer gathered for a different incident entirely
  | "unstamped-foreign"; // no stamp at all, so ours is applied to data that is not ours

/**
 * The behaviours, listed once so a test cannot silently cover fewer than exist.
 *
 * Enumerated rather than discovered: a list built by reading the type at
 * runtime is not available in JavaScript, and a test that iterates whatever it
 * happens to find passes when the set shrinks.
 */
export const ROGUE_BEHAVIOURS: readonly RogueBehaviour[] = [
  "another-tenant",
  "another-incident",
  "unstamped-foreign",
];

/**
 * Where the foreign answer comes from.
 *
 * Codex, 2026-09-05, critical: the foreign behaviour used to read the SAME
 * fixture the request asked for, through the honest reader. So the test named
 * "a foreign answer with no claim gets through" proved only that ordinary
 * fixture data gets through — the interesting half of the sentence was not
 * being exercised at all, while an item of the Definition of Done was marked
 * covered by it.
 *
 * It now reads a directory holding another customer's workload in another
 * customer's namespace, with no stamp on it.
 */
const FOREIGN_ROOT = new URL("../../tests/fixtures/another-tenant/", import.meta.url).pathname;

export function rogueProvider(behaviour: RogueBehaviour, root: string): Provider {
  return {
    name: `rogue-${behaviour}`,
    exercised: true,
    unexercisedBecause: "",

    read(scenario: string, slot: Slot, request: CollectionRequest): Observation {
      if (behaviour === "unstamped-foreign") {
        // The uncomfortable one, and the only one that gets through. Nothing in
        // the payload says it is foreign, so it is accepted and stamped as
        // ours. That is not a hole in the check — it is the boundary of what
        // provenance can answer, and the gate DOES print that boundary as a
        // limitation every run — that one is real, and it is a line in
        // LIMITATIONS, not a provider list. This behaviour is what makes that
        // sentence a demonstration
        // rather than a guess about our own code.
        return readSlot(scenario, slot, FOREIGN_ROOT, request);
      }

      const path = join(root, scenario, `${slot}.json`);
      if (!existsSync(path)) {
        return { state: "failed", slot, kind: "absent", reason: `${scenario} has no ${slot}.json` };
      }
      let data: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return { state: "failed", slot, kind: "unreadable", reason: `${slot} is not an object` };
        }
        data = parsed as Record<string, unknown>;
      } catch (e) {
        return { state: "failed", slot, kind: "unreadable", reason: e instanceof Error ? e.message : String(e) };
      }

      const stamp = behaviour === "another-tenant"
        ? { ...requestStamp(request, slot), namespace: "another-tenant" }
        : { ...requestStamp(request, slot), requested_for: "INC-2026-9999" };

      // Written back through the same reader production uses, from a directory
      // of this provider's own making. Codex, 2026-09-05: exporting the
      // stamping helper so a provider could call it directly turned possession
      // of a request into the power to manufacture a trusted-looking
      // observation. Providers go through readSlot like everyone else.
      return readSlotWithPayload({ ...data, provenance: stamp }, slot, request);
    },
  };
}

function requestStamp(request: CollectionRequest, slot: Slot): Record<string, unknown> {
  return {
    collection_id: request.collection_id,
    requested_for: request.incident_id,
    cluster: request.cluster,
    namespace: request.namespace,
    provider: `fake-${slot}`,
  };
}
