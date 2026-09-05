/**
 * The release chain exists to make the live check unavoidable.
 *
 * Codex, chunk 2 debt: "the live check is not part of any release/deployment
 * workflow… a deployment can drift indefinitely while every mandatory check
 * exits 0." So the test that matters is not that release works — it is that
 * release cannot be satisfied without verifying the deployment afterwards.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs, the same file node runs.
import { chooseSource } from "../scripts/record-baseline.mjs";
// @ts-expect-error - plain .mjs script, no types
import { releaseMayProceed, DRIFT_CHECK_ID } from "../scripts/release.mjs";

const SOURCE = readFileSync(new URL("../scripts/release.mjs", import.meta.url).pathname, "utf8");
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url).pathname, "utf8"));

describe("releasing cannot skip the live check", () => {
  it("runs verify-deployment as part of the chain", () => {
    expect(SOURCE).toContain("scripts/verify-deployment.mjs");
  });

  it("verifies AFTER deploying, not before", () => {
    // Verifying before deploying would check the previous deployment and call
    // the new one released — the check would run and establish nothing.
    expect(SOURCE.indexOf("await deploy()")).toBeLessThan(SOURCE.indexOf("scripts/verify-deployment.mjs"));
  });

  it("stops the chain on any non-zero step rather than carrying on", () => {
    expect(SOURCE).toContain("release stopped at");
    expect(SOURCE).toMatch(/process\.exit\(r\.status/);
  });

  it("runs the gate before deploying anything", () => {
    expect(SOURCE.indexOf("acceptance-gate.mjs")).toBeLessThan(SOURCE.indexOf("await deploy()"));
  });

  it("is reachable as a declared script", () => {
    expect(PKG.scripts.release).toBe("node scripts/release.mjs");
  });

  it("re-records the baseline after verifying, not before", () => {
    expect(SOURCE.indexOf("scripts/verify-deployment.mjs")).toBeLessThan(SOURCE.indexOf("scripts/record-baseline.mjs"));
  });
});

describe("the baseline comes from the deployment, not from a fresh copy", () => {
  it("reads the configured deployment when there is one", () => {
    // Codex, chunk 2 debt: recording always created a separate temporary
    // workflow and exported THAT, so a release claiming to re-record from the
    // deployment it had just verified recorded something else. The ordering
    // test could not have noticed, because ordering was all it checked.
    expect(chooseSource({ N8N_WORKFLOW_ID: "w1" })).toEqual({ mode: "existing", id: "w1" });
  });

  it("falls back to a temporary upload only when no deployment is configured", () => {
    const r = chooseSource({});
    expect(r.mode).toBe("temporary");
    expect(r.why, "the weaker source must say it is the weaker source").toContain("rather than from the deployment itself");
  });

  it("treats an empty id as no id rather than as a workflow named nothing", () => {
    expect(chooseSource({ N8N_WORKFLOW_ID: "" }).mode).toBe("temporary");
  });
});

describe("the one gate failure a release is allowed to walk past", () => {
  /*
   * Walked into on 2026-09-05: the gate refuses when the generated workflow
   * differs from the recorded deployment baseline, which is true of every
   * change worth releasing. The gate blocked the release and the release was
   * the only thing that could clear the gate. A deadlock whose only exit is
   * "stop running the chain" is the hole the chain exists to close.
   */
  const drift = { id: DRIFT_CHECK_ID, state: "fail" };
  const ok = (id: string) => ({ id, state: "pass" });

  it("proceeds when the drift check is the only thing not passing", () => {
    expect(releaseMayProceed({ results: [ok("tests"), ok("typecheck"), drift] })).toBeNull();
  });

  it("stops on anything else, even alongside the drift failure", () => {
    const stop = releaseMayProceed({ results: [ok("typecheck"), { id: "tests", state: "fail" }, drift] });
    expect(stop).toContain("tests");
  });

  it("stops on a check that could not be established, which is not a passing check", () => {
    const stop = releaseMayProceed({ results: [ok("tests"), { id: "mutations-still-caught", state: "unknown" }, drift] });
    expect(stop).toContain("mutations-still-caught");
  });

  it("stops when the report cannot be read, rather than reading absence as agreement", () => {
    // The defect this repository keeps finding: a missing answer treated as a
    // clean one. No report means no way to tell what failed.
    expect(releaseMayProceed(null)).toContain("could not be read");
    expect(releaseMayProceed({})).toContain("no results");
    expect(releaseMayProceed({ results: [] })).toContain("no results");
  });

  it("stops when the drift check could not be established, rather than reading it as merely behind", () => {
    // Codex, 2026-09-05: matching the id alone let the drift check through in
    // the unknown state. "The deployment is behind us" was established; "the
    // probe did not run" was not, and a release is when that difference bites.
    const stop = releaseMayProceed({ results: [ok("tests"), { id: DRIFT_CHECK_ID, state: "unknown" }] });
    expect(stop).toContain("not fail");
  });

  it("stops when the drift check appears more than once, since it is then unclear what failed", () => {
    const stop = releaseMayProceed({ results: [ok("tests"), drift, drift] });
    expect(stop).toContain("2 times");
  });

  it("stops when the gate failed while every check passed, because that disagreement is itself a defect", () => {
    const stop = releaseMayProceed({ results: [ok("tests"), ok("typecheck")] });
    expect(stop).toContain("disagreement");
  });
});
