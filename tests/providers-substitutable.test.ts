/**
 * Definition of Done item 8: a provider can be replaced.
 *
 * The proof is not that one of them reads a real cluster. It is that more than
 * one implementation satisfies the same contract, that the caller cannot tell
 * which it holds, and that the system's refusals do not depend on WHICH
 * provider misbehaved — only on what the answer claims.
 *
 * Owner, 2026-09-05: the prototype is the priority, and a real environment is
 * for whoever continues. So the implementation that reads a cluster is written,
 * never run, and says so; these tests are about the ones that do run.
 */
import { describe, it, expect } from "vitest";
import { allProviders, unexercised } from "../src/providers/registry.js";
import { ROGUE_BEHAVIOURS, rogueProvider } from "../src/providers/rogue.js";
import { fixtureProvider, newCollectionRequest, SLOTS } from "../src/providers/fixtures.js";
import { kubernetesProvider, SLOT_PATHS } from "../src/providers/kubernetes.js";

const ROOT = new URL("../scenarios/", import.meta.url).pathname;
const REQUEST = newCollectionRequest("INC-2026-0101", "prod-eu", "production", "aaaaaaaa-0000-4000-8000-000000000000");

describe("more than one implementation answers the same question", () => {
  it("holds every implementation in one enumerated list, so deleting one is visible", () => {
    // Enumerated rather than read off the directory: a discovered list shrinks
    // silently, and every test that iterates it then passes on fewer things.
    const names = allProviders(ROOT).map((p) => p.name);
    expect(names).toEqual([
      "fixtures",
      "rogue-another-tenant",
      "rogue-another-incident",
      "rogue-unstamped-foreign",
      "kubernetes",
    ]);
  });

  it("gives the honest provider a collected observation for every slot", () => {
    // The precondition. Without it the refusals below would pass against a
    // provider that can never return anything at all.
    const p = fixtureProvider(ROOT);
    for (const slot of SLOTS) {
      const o = p.read("container-oom", slot, REQUEST);
      expect(o.state, `${slot}: ${o.state === "failed" ? o.reason : ""}`).toBe("collected");
    }
  });

  it("refuses every rogue behaviour that claims something about itself", () => {
    // Two of the three lie in their stamp and are refused for it. The third is
    // the one provenance cannot catch, and it has its own test below.
    for (const behaviour of ROGUE_BEHAVIOURS) {
      if (behaviour === "unstamped-foreign") continue;
      const o = rogueProvider(behaviour, ROOT).read("container-oom", "kubernetes", REQUEST);
      expect(o.state, `${behaviour} was not refused`).toBe("failed");
      if (o.state !== "failed") continue;
      expect(o.kind, `${behaviour} is a lie, not a gap`).toBe("contradiction");
    }
  });

  it("accepts another customer's workload when it arrives with no claim on it", () => {
    /*
     * The limitation, demonstrated rather than asserted.
     *
     * Codex, 2026-09-05, critical: this used to read the SAME fixture the
     * request asked for, so it proved only that ordinary fixture data is
     * accepted — the interesting half of the sentence was never exercised, and
     * a Definition-of-Done item was marked covered by it.
     *
     * It now reads another customer's namespace and workload, unstamped. It
     * gets our stamp applied, because there is nothing to disagree with:
     * provenance answers "was this asked for", never "is this ours". The gate
     * prints that as a limitation every run, and this is what stops the
     * sentence from being a guess about our own code.
     */
    const o = rogueProvider("unstamped-foreign", ROOT).read("container-oom", "kubernetes", REQUEST);
    expect(o.state, "if this ever starts refusing, the limitation is stale and must be rewritten").toBe("collected");
    if (o.state !== "collected") return;

    // The payload really is somebody else's, and it really did get through.
    const text = JSON.stringify(o.data);
    expect(text, "the foreign fixture is not foreign, so this test proves nothing").toContain("acme-bank");
    expect(text, "and it carries our stamp, which is the whole problem").toContain(REQUEST.collection_id);
  });

  it("says which implementations have never been run, rather than counting them as working", () => {
    const never = unexercised(ROOT);
    expect(never.map((p) => p.name)).toEqual(["kubernetes"]);
    expect(never[0]?.because, "an unexercised provider must say why it cannot be exercised here")
      .toContain("no cluster");
  });

  it("makes the unrun provider refuse rather than return something that looks like an observation", () => {
    // The dangerous shape is a declared implementation that quietly returns an
    // empty answer. This one refuses, and names the reason it cannot comply.
    const o = kubernetesProvider({ apiServer: "https://cluster.invalid", token: "",
      fetchJson: () => Promise.reject(new Error("no cluster")) }).read("container-oom", "kubernetes", REQUEST);
    expect(o.state).toBe("failed");
    if (o.state !== "failed") return;
    expect(o.reason).toContain("never run");
  });

  it("keeps the cluster paths namespaced, so one tenant's request cannot read another's", () => {
    // Reviewable without executing anything, which is the only review this file
    // can receive. The namespace is encoded, so a crafted namespace cannot walk
    // out of its path.
    for (const slot of SLOTS) {
      const path = SLOT_PATHS[slot]("prod/../kube-system");
      // The slashes are what would walk out of the path, and they are encoded.
      // The dots survive as literal text inside one segment, which is harmless
      // and is what a correct encoding looks like — asserting their absence was
      // my own check being wrong about what it was checking.
      expect(path, `${slot} interpolates a namespace unencoded`).not.toContain("/../");
      expect(path).toContain("prod%2F..%2Fkube-system");
    }
  });
});
