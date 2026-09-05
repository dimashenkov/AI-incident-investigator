/**
 * A provider that reads from a real Kubernetes API server.
 *
 * It is written and it is never run. There is no cluster to point it at, and
 * the owner decided on 2026-09-05 that this prototype will not talk to one.
 *
 * That makes it the most dangerous file in the repository, because an
 * unexercised implementation looks exactly like a working one. So it says what
 * it is in `exercised: false`, the gate prints every unexercised provider on
 * every run, and a test holds that the list is not empty for as long as this
 * file exists. Nobody has to remember.
 *
 * What it does NOT claim: that it works. Nothing here has been executed against
 * an API server, the response shapes are taken from the Kubernetes API
 * reference rather than from a live answer, and the mapping into our slot
 * contracts is unverified. It exists to show that the contract in provider.ts
 * admits an implementation that is not fixture-backed — which is the half of
 * substitutability the rogue provider cannot demonstrate.
 */
import type { Provider } from "./provider.js";
import { readSlotWithPayload, type CollectionRequest, type Observation, type Slot } from "./fixtures.js";

export type ClusterAccess = {
  /** e.g. https://10.0.0.1:6443 — no default, because a wrong default is a silent wrong cluster. */
  readonly apiServer: string;
  /** Bearer token. Never logged, never echoed, never written to an artifact. */
  readonly token: string;
  /** Called for each request. Injected so this file makes no network call by itself. */
  readonly fetchJson: (url: string, token: string) => Promise<unknown>;
};

/**
 * The paths each slot would read. Listed here rather than built inline so the
 * set is readable without executing anything — the only kind of review this
 * file can receive.
 */
export const SLOT_PATHS: Readonly<Record<Slot, (namespace: string) => string>> = {
  kubernetes: (ns) => `/api/v1/namespaces/${encodeURIComponent(ns)}/pods`,
  logs: (ns) => `/api/v1/namespaces/${encodeURIComponent(ns)}/pods?fieldSelector=status.phase!=Succeeded`,
  metrics: (ns) => `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(ns)}/pods`,
};

export function kubernetesProvider(access: ClusterAccess): Provider {
  return {
    name: "kubernetes",
    // Codex, 2026-09-05: "exercised" was a self-reported constant, and already
    // semantically false — the tests construct this provider and call it. What
    // is true is narrower and is what the name now says: nothing here has run
    // against the system it is written for.
    exercised: false,
    unexercisedBecause:
      "no cluster is reachable from this prototype, so nothing here has run against an API server; " +
      "the refusal below is tested, the reading is not, and the response shapes come from the " +
      "Kubernetes API reference rather than from a live answer",

    read(): Observation {
      /*
       * Synchronous by contract, and a cluster read is not.
       *
       * This is not a detail to paper over with a blocking call: the contract
       * in provider.ts was written around a provider that reads files, and a
       * real one cannot satisfy it. Saying so is the honest answer. Returning a
       * plausible empty observation would be the defect this repository keeps
       * finding — an implementation that looks like it works.
       *
       * Making the contract asynchronous is real work that touches every
       * caller, and it is not done while no cluster exists to justify it. When
       * one does, this refusal is where the change starts.
       */
      return {
        state: "failed",
        slot: "kubernetes",
        kind: "unreadable",
        reason:
          "the kubernetes provider cannot answer synchronously; a cluster read is asynchronous and the " +
          "provider contract is not. This implementation is declared, never run, and refuses rather than " +
          "returning something that looks like an observation",
      };
    },
  };
}

/**
 * The read this provider WOULD do, kept separate and asynchronous.
 *
 * Not wired into the contract, and deliberately not pretending to be. It is
 * here so the shape of a real read is reviewable — and so that whoever makes
 * the contract asynchronous has the body already written rather than inventing
 * it under time pressure.
 */
export async function readFromCluster(
  access: ClusterAccess, slot: Slot, request: CollectionRequest,
): Promise<Observation> {
  const url = `${access.apiServer.replace(/\/+$/, "")}${SLOT_PATHS[slot](request.namespace)}`;
  let body: unknown;
  try {
    body = await access.fetchJson(url, access.token);
  } catch (e) {
    // The cluster not answering is not the cluster saying there is nothing.
    return { state: "failed", slot, kind: "unreadable",
      reason: `the cluster did not answer for ${slot}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { state: "failed", slot, kind: "unreadable", reason: `the cluster returned a non-object for ${slot}` };
  }
  // Stamped by the same checker every other provider uses, so an answer from a
  // cluster is trusted exactly as far as an answer from a file: not at all
  // until it agrees with the request it was gathered under.
  return readSlotWithPayload(body, slot, request);
}
