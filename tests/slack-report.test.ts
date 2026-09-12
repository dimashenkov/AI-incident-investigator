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

  it("names the first in-namespace pod when none is not-ready (the affected workload)", () => {
    // The owner asked (2026-09-12) for the affected pod to be named even when it
    // is still Running — cpu-throttling, dns, cert affect a pod that is ready. So
    // when no pod is not-ready, the first pod in this incident's namespace is
    // named rather than omitted.
    const healthy = { kubernetes: { pods: [
      { name: "the-workload-pod", namespace: "production", containers: [{ name: "c", ready: true, last_state: {} }] },
    ] } };
    expect(problemPod(healthy, "production")?.name).toBe("the-workload-pod");
  });

  it("names the incident's SERVICE pod, not the first, when a second service shares the namespace", () => {
    // Grok, 2026-09-12: a namespace can hold a second ready service (dns,
    // network-policy). First-in-namespace names the wrong pod if the array order
    // changes. Here the affected service's pod is listed SECOND and neither is
    // not-ready — the service match must still pick it.
    const twoServices = { kubernetes: { pods: [
      { name: "unrelated-cache-6d9f-aaaa", namespace: "production", containers: [{ name: "c", ready: true }] },
      { name: "webhook-dispatcher-5f7b-bbbb", namespace: "production", containers: [{ name: "c", ready: true }] },
    ] } };
    expect(problemPod(twoServices, "production", "webhook-dispatcher")?.name).toBe("webhook-dispatcher-5f7b-bbbb");
  });

  it("prefers a not-ready pod over an earlier healthy one", () => {
    const mixed = { kubernetes: { pods: [
      { name: "healthy", namespace: "production", containers: [{ name: "c", ready: true }] },
      { name: "broken", namespace: "production", containers: [{ name: "c", ready: false }] },
    ] } };
    expect(problemPod(mixed, "production")?.name).toBe("broken");
  });

  it("does NOT name a namespace-less pod for a namespace-less incident", () => {
    // Subagent audit 2026-09-12: `"" !== ""` is false, so absence matched absence
    // and a pod with no namespace was named for an incident with no namespace —
    // defeating the contamination guard. Absence is never a match.
    const noNs = { kubernetes: { pods: [
      { name: "someone-elses-pod", containers: [{ name: "c", ready: false }] },
    ] } };
    expect(problemPod(noNs, "")).toBeNull();
  });

  it("returns null only when there is no pod in this namespace at all", () => {
    const noKube = { logs: { entries: [] } };
    expect(problemPod(noKube, "production")).toBeNull();
    const emptyPods = { kubernetes: { pods: [] } };
    expect(problemPod(emptyPods, "production")).toBeNull();
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

  it("shows the root cause ONCE — not the agent line AND the conclusion", () => {
    // Owner, 2026-09-12: the report showed root cause twice — the root_cause AGENT
    // line (underscore) rendered as a section, plus the Root cause conclusion
    // block. Both must collapse into the single highlighted block.
    const withBoth = slackReport(INCIDENT, [
      "INC-2026-0101: payment-api in production — investigating.",
      "kubernetes: container OOMKilled.",
      "root_cause: AGENT_LINE_MARKER should not be rendered as its own section.",
      "Root cause: the container is being OOM-killed.",
    ], "CONTAINER_OOM", 0.9);
    const t = JSON.stringify(withBoth.blocks);
    expect(t, "the agent's root_cause line must not appear").not.toContain("AGENT_LINE_MARKER");
    const dartSections = (t.match(/:dart:/g) ?? []).length;
    expect(dartSections, "exactly one root-cause block").toBe(1);
    expect(t).toContain("CONTAINER_OOM");
  });

  it("shows an HONEST Datadog line when given an id — simulated, not sent, never 'registered'", () => {
    const withDd = slackReport(INCIDENT, THREAD, "CONTAINER_OOM", 0.9, "dd-mock-INC-2026-0101");
    const t = JSON.stringify(withDd.blocks);
    expect(t).toContain("dd-mock-INC-2026-0101");
    expect(t).toMatch(/simulated/i);
    expect(t).toMatch(/not sent/i);
    expect(t, "must not claim a real registration happened").not.toMatch(/registered/i);
  });

  it("shows NO Datadog line when no id is given", () => {
    const t = JSON.stringify(slackReport(INCIDENT, THREAD, "CONTAINER_OOM", 0.9).blocks);
    expect(t).not.toMatch(/datadog/i);
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
