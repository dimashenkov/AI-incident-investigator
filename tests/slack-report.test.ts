/**
 * The Block Kit view of the report, for the real #incidents post.
 *
 * The owner asked for the message to NAME the cluster, namespace and the pod
 * that is actually failing — the plain thread said only "container payment-api".
 * These tests are about two things a reader would be misled by, and one thing a
 * foreign disk must never receive:
 *
 *  - the pod named must be the one that is failing, not the first pod listed;
 *  - the cluster/namespace/pod must come from THIS incident's own fields;
 *  - the observation blob must NOT ride along inside the blocks — the leak the
 *    plain post refuses by sending only the thread.
 */
import { describe, it, expect } from "vitest";
import { slackReport, problemPod } from "../src/core/thread.js";

const INCIDENT = {
  incident_id: "INC-2026-0101",
  service: "payment-api",
  namespace: "production",
  cluster: "prod-eu",
  observations: {
    kubernetes: {
      collected_at: "2026-09-04T10:30:12Z",
      pods: [
        // a healthy pod first, to prove the failing one is chosen — not pods[0]
        { name: "payment-api-HEALTHY", namespace: "production",
          containers: [{ name: "payment-api", ready: true, last_state: {} }] },
        { name: "payment-api-7d4b8c9f5-x2mnq", namespace: "production",
          containers: [{ name: "payment-api", ready: false, restart_count: 7,
            limits: { memory: "512Mi" },
            last_state: { terminated: { reason: "OOMKilled", exit_code: 137 } } }] },
      ],
      provenance: { cluster: "prod-eu", provider: "fake-kubernetes" },
    },
  },
};

const THREAD = [
  "INC-2026-0101: payment-api in production — investigating.",
  "kubernetes: container payment-api terminated OOMKilled after 7 restarts.",
  "logs: OutOfMemory before each restart.",
  "metrics: memory pinned at its configured limit.",
  "root_cause: the container is being OOM-killed.",
];

describe("problemPod", () => {
  it("picks the failing pod, not the first one listed", () => {
    const pod = problemPod(INCIDENT.observations, "production");
    expect(pod?.name).toBe("payment-api-7d4b8c9f5-x2mnq");
    expect(pod?.namespace).toBe("production");
  });

  it("returns null when every pod is healthy, rather than guessing one", () => {
    const healthy = { kubernetes: { pods: [
      { name: "a", namespace: "production", containers: [{ name: "c", ready: true, last_state: {} }] },
    ] } };
    expect(problemPod(healthy, "production")).toBeNull();
  });

  it("does NOT name a pod that has recovered (ready now, terminated in the past)", () => {
    // A prior OOM kill on a container that is ready again is history, not the
    // current fault. Naming it would point the reader at a pod that is fine.
    const recovered = { kubernetes: { pods: [
      { name: "recovered-pod", namespace: "production",
        containers: [{ name: "c", ready: true, last_state: { terminated: { reason: "OOMKilled" } } }] },
    ] } };
    expect(problemPod(recovered, "production")).toBeNull();
  });

  it("does NOT name a failing pod from another namespace — that is contamination", () => {
    // Grok, 2026-09-12: slackReport shows the incident's namespace beside the
    // pod name. A pod from a different namespace would be attributed to the
    // wrong one, so it must be skipped, not named.
    const foreign = { kubernetes: { pods: [
      { name: "other-tenant-pod", namespace: "staging",
        containers: [{ name: "c", ready: false, last_state: {} }] },
    ] } };
    expect(problemPod(foreign, "production")).toBeNull();
  });

  it("reads ONLY observations.kubernetes.pods, not a nested pods[] in another slot", () => {
    // The whole-tree walk (the first version) would have named a pod from a
    // contaminated slot. A pods array anywhere but the kubernetes slot must be
    // invisible.
    const nestedElsewhere = { logs: { entries: [{ pods: [
      { name: "smuggled-pod", namespace: "production",
        containers: [{ name: "c", ready: false, last_state: {} }] },
    ] }] } };
    expect(problemPod(nestedElsewhere, "production")).toBeNull();
  });
});

describe("slackReport", () => {
  const out = slackReport(INCIDENT, THREAD, "CONTAINER_OOM", 0.9);
  const asText = JSON.stringify(out.blocks);

  it("names the cluster, namespace and the failing pod", () => {
    expect(asText).toContain("prod-eu");
    expect(asText).toContain("production");
    expect(asText).toContain("payment-api-7d4b8c9f5-x2mnq");
  });

  it("shows the root cause code and the confidence as a percent", () => {
    expect(asText).toContain("CONTAINER_OOM");
    expect(asText).toContain("90%");
  });

  it("carries the plain thread as the text fallback", () => {
    expect(out.text).toBe(THREAD.join("\n\n"));
  });

  it("does NOT leak the observation blob into the blocks", () => {
    // The leak guard: the message is built from curated fields, never from the
    // observations. A field that only exists inside the observation blob must
    // not appear in what is sent to Slack.
    expect(asText).not.toContain("provenance");
    expect(asText).not.toContain("fake-kubernetes");
    expect(asText).not.toContain("collected_at");
    expect(asText).not.toContain("512Mi");
    expect(asText).not.toContain("exit_code");
    expect(asText).not.toContain("payment-api-HEALTHY");
  });

  it("still posts when the incident carries no pod — the header and thread hold", () => {
    const noPod = { ...INCIDENT, observations: {} };
    const o = slackReport(noPod, THREAD, "CONTAINER_OOM", 0.9);
    const t = JSON.stringify(o.blocks);
    expect(t).toContain("INC-2026-0101");
    expect(t).toContain("prod-eu");
    expect(t).not.toContain("payment-api-7d4b8c9f5-x2mnq");
  });
});
