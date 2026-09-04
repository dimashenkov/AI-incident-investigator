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
