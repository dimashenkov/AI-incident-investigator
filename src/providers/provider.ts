/**
 * The one question every provider answers, and the only thing the rest of the
 * system knows about where observations come from.
 *
 * Definition of Done item 8 asks for provider substitutability to be PROVEN.
 * That proof is not "a provider talks to a real cluster" — it is that more than
 * one implementation satisfies the same contract and the caller cannot tell
 * which one it holds. So the contract lives here, alone, and the caller depends
 * on this file rather than on any implementation.
 *
 * What a provider is NOT allowed to do is as much of the contract as what it
 * must: it does not decide what it was asked for. The collection request is
 * minted by the caller before anything is gathered, and an answer is stamped
 * from it. A provider that stamps its own answer is making a claim, and the
 * claim is checked in full rather than believed — see readSlot in fixtures.ts,
 * which is where that check lives for every implementation that reuses it.
 */
import type { CollectionRequest, Observation, Slot } from "./fixtures.js";

export type Provider = {
  /**
   * What this implementation calls itself. It appears in no observation: the
   * stamp's `provider` field comes from the request path, never from here, so
   * a provider cannot name itself into an answer.
   */
  readonly name: string;

   /**
   * Whether this implementation has ever run against the system it is written
   * for — NOT whether a test ever calls it.
   *
   * Codex, 2026-09-05, named the difference: the tests construct the Kubernetes
   * provider and call it, so "exercised by the suite" was already false as
   * written. What matters is narrower, and it is the thing that cannot be
   * checked from inside: a provider written against an API server nobody here
   * can reach.
   *
   * A provider written against a system nobody here can reach — a real
   * Kubernetes API, with no cluster to point it at — is not a tested provider,
   * and counting it as one would be the defect this repository keeps finding:
   * the appearance of a thing with nothing exercising it. So each says which it
   * is, the gate prints the unexercised ones every run, and nobody has to
   * remember.
   */
  readonly exercised: boolean;

  /** Why an unexercised provider cannot be exercised here. Empty when it is. */
  readonly unexercisedBecause: string;

  /** Answer for one slot, under the request the caller issued. */
  read(scenario: string, slot: Slot, request: CollectionRequest): Observation;
};
