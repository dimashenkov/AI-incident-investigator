/**
 * Every provider implementation, in one list.
 *
 * Enumerated, not discovered. A list built by reading the directory would grow
 * silently and — worse — shrink silently: a provider deleted or renamed would
 * make every test that iterates the list pass on fewer things, which is the
 * "test that passes on an empty set" defect written at repository scale.
 *
 * The list is what `tests/providers-substitutable.test.ts` reads to hold that
 * the unexercised set is not empty. It is NOT read by the gate, which is a
 * plain .mjs program and cannot import TypeScript.
 */
import type { Provider } from "./provider.js";
import { fixtureProvider } from "./fixtures.js";
import { rogueProvider, ROGUE_BEHAVIOURS } from "./rogue.js";
import { kubernetesProvider } from "./kubernetes.js";

/**
 * Built for a given fixture root, because two of the three read files. The
 * cluster access handed to the Kubernetes provider is inert on purpose: it
 * makes no call, and the provider refuses before it could.
 */
export function allProviders(root: string): Provider[] {
  return [
    fixtureProvider(root),
    ...ROGUE_BEHAVIOURS.map((b) => rogueProvider(b, root)),
    kubernetesProvider({
      apiServer: "https://cluster.invalid",
      token: "",
      fetchJson: () => Promise.reject(new Error("this prototype has no cluster")),
    }),
  ];
}

/** The ones nobody has run, with the reason each gives. Read by a test, not the gate. */
export function unexercised(root: string): Array<{ name: string; because: string }> {
  return allProviders(root)
    .filter((p) => !p.exercised)
    .map((p) => ({ name: p.name, because: p.unexercisedBecause }));
}
