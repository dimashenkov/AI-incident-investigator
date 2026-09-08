/**
 * The live deployment check.
 *
 * It talks to a running instance, so what can be tested here is the part that
 * decides — which workflow to compare, and what each answer means. The network
 * half was exercised for real on 2026-09-04 against the Cloud instance: an
 * empty instance reported unchecked, an untouched deployment reported same, and
 * a deployment whose code was edited THROUGH THE API reported drifted with both
 * differing paths. That run is recorded in PROGRESS.md; these tests hold the
 * decision logic that made those answers possible.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs, the same file node runs.
import { pickDeployed } from "../scripts/verify-deployment.mjs";

const NAME = "AI SRE — incident validation";

describe("choosing which deployment to compare against", () => {
  it("finds the one workflow carrying the generated name", () => {
    const r = pickDeployed([{ id: "a", name: "something else" }, { id: "b", name: NAME }], NAME);
    expect(r.state).toBe("found");
    expect(r.id).toBe("b");
  });

  it("prefers a configured id, which a UI rename cannot break", () => {
    // Codex, chunk 2 debt: matching by name alone meant renaming the live
    // workflow reported "nothing deployed" and exit 2 — a rename would hide
    // drift behind could-not-establish.
    const r = pickDeployed([{ id: "w1", name: NAME }, { id: "w2", name: NAME }], NAME, "w2");
    expect(r.state).toBe("found");
    expect(r.id).toBe("w2");
    expect(r.by).toBe("id");
  });

  it("reports a renamed deployment as drift, not as missing", () => {
    // The id found it, so this is not could-not-establish. Somebody changed the
    // deployment, and a changed deployment is the finding.
    const r = pickDeployed([{ id: "w1", name: "renamed in the UI" }], NAME, "w1");
    expect(r.state).toBe("renamed");
    expect(r.deployedName).toBe("renamed in the UI");
  });

  it("reports absent when the configured id is not there at all", () => {
    const r = pickDeployed([{ id: "other", name: NAME }], NAME, "w1");
    expect(r.state).toBe("absent");
    expect(r.by).toBe("id");
  });

  it("says when it fell back to matching by name", () => {
    // A weaker check that looks like the strong one is how the weaker one gets
    // trusted. The result carries which way it matched.
    expect(pickDeployed([{ id: "a", name: NAME }], NAME).by).toBe("name");
    expect(pickDeployed([{ id: "a", name: NAME }], NAME, "a").by).toBe("id");
  });

  it("reports absent rather than clean when nothing is deployed", () => {
    // The dangerous answer here is "same". Nothing deployed is not a matching
    // deployment; it is no deployment, and the exit code says could-not-establish.
    expect(pickDeployed([], NAME).state).toBe("absent");
    expect(pickDeployed([{ id: "a", name: "other" }], NAME).state).toBe("absent");
  });

  it("treats two workflows sharing the name as drift, not as a choice to make", () => {
    // Picking either one would produce a verdict about a workflow that may not
    // be the one serving traffic. Nobody can say which is live, so the
    // deployment itself is the problem and it is reported as such.
    const r = pickDeployed([{ id: "a", name: NAME }, { id: "b", name: NAME }], NAME);
    expect(r.state).toBe("ambiguous");
    expect(r.ids).toEqual(["a", "b"]);
  });

  it("keeps a listing it could not read apart from an instance with nothing on it", () => {
    /*
     * This test asserted the collapse its own comment forbids.
     *
     * It said "a listing that could not be read must not resolve to nothing
     * deployed, which would read as a clean instance" — and then expected
     * exactly `absent`, the same value an empty instance produces. `list ?? []`
     * made them one answer, and the test named for the distinction blessed it.
     * A subagent found the pair on 2026-09-07.
     *
     * `absent` is a positive claim: I looked and there is nothing of this name.
     * `unreadable` is the other answer, and they are not interchangeable.
     */
    for (const bad of [undefined, null, "nope", 7, { data: [] }]) {
      const r = pickDeployed(bad as never, NAME);
      expect(r.state, `${JSON.stringify(bad)} is not a listing`).toBe("unreadable");
      expect(String(r.reason)).toMatch(/unestablished/);
    }
    // And a real empty listing still says absent, or this refuses everything.
    expect(pickDeployed([], NAME).state).toBe("absent");
  });

  it("matches on the exact name, not a prefix", () => {
    expect(pickDeployed([{ id: "a", name: `${NAME} (copy)` }], NAME).state).toBe("absent");
  });
});
