/**
 * The fake providers and the fixture contracts they must satisfy.
 *
 * The contracts were derived from these very fixtures, which is exactly the
 * weakness Codex named when the chunk was scoped: a schema inferred from a
 * sample will always fit the sample. So the tests here spend most of their
 * effort on the opposite question — what the contract REFUSES — because that is
 * the part the fixtures cannot flatter.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validate } from "../src/schema/validate.js";
import { listScenarios, readSlot, readScenario, toObservations, readAlert, SLOTS, NOTHING_SENTINEL } from "../src/providers/fixtures.js";

const ROOT = new URL("../scenarios/", import.meta.url).pathname;

const BASE_INCIDENT = {
  incident_id: "INC-2026-0001", status: "investigating", service: "payment-api",
  namespace: "production", cluster: "prod-eu", started_at: "2026-09-04T10:30:00Z",
  source: { provider: "fake-datadog", alert: { id: "a", title: "t", triggered_at: "2026-09-04T10:29:00Z" } },
  observations: { kubernetes: null, logs: null, metrics: null },
  analysis: { agents: [], root_cause_code: null, root_cause: null, confidence: null, evidence: [] },
  remediation: { recommended_actions: [] },
  conversation: { provider: "fake-slack", channel_id: "c", thread_id: "thread-INC-2026-0001", incident_id: "INC-2026-0001", messages: [] },
};

const withSlot = (slot: string, data: unknown) => ({
  ...BASE_INCIDENT,
  observations: { ...BASE_INCIDENT.observations, [slot]: data },
});

const expectSlotInvalid = (slot: string, data: unknown, why: string) => {
  const r = validate("incident", withSlot(slot, data));
  expect(r.state, `${why}: ${JSON.stringify(r)}`).toBe("invalid");
};

describe("every fixture satisfies its own contract", () => {
  it("finds at least one scenario, so these tests are not passing on nothing", () => {
    expect(listScenarios(ROOT).length).toBeGreaterThan(0);
  });

  it("validates every slot of every scenario as part of a whole incident", () => {
    for (const scenario of listScenarios(ROOT)) {
      const obs = readScenario(scenario, ROOT);
      for (const slot of SLOTS) {
        const o = obs[slot];
        expect(o.state, `${scenario}/${slot} failed to read`).not.toBe("failed");
        if (o.state !== "collected") continue;
        const r = validate("incident", withSlot(slot, o.data));
        expect(r.state, `${scenario}/${slot}: ${JSON.stringify(r)}`).toBe("valid");
      }
    }
  });

  it("carries an alert that the incident schema accepts", () => {
    for (const scenario of listScenarios(ROOT)) {
      const alert = readAlert(scenario, ROOT);
      expect(alert, `${scenario} has no alert.json`).not.toBeNull();
      const r = validate("incident", { ...BASE_INCIDENT, source: { provider: "fake-datadog", alert } });
      expect(r.state, `${scenario}/alert: ${JSON.stringify(r)}`).toBe("valid");
    }
  });
});

describe("the contract refuses what a broken provider would send", () => {
  const K8S = JSON.parse(readFileSync(`${ROOT}container-oom/kubernetes.json`, "utf8"));
  const LOGS = JSON.parse(readFileSync(`${ROOT}container-oom/logs.json`, "utf8"));
  const METRICS = JSON.parse(readFileSync(`${ROOT}container-oom/metrics.json`, "utf8"));

  it("refuses an observation that omits when it was collected", () => {
    const { collected_at, ...rest } = K8S;
    expectSlotInvalid("kubernetes", rest, "an observation with no timestamp cannot be placed in time");
  });

  it("refuses a termination that does not say why", () => {
    // The whole scenario turns on OOMKilled. A terminated container with no
    // reason is the silence this project refuses everywhere else.
    const broken = structuredClone(K8S);
    delete broken.pods[0].containers[0].last_state.terminated.reason;
    expectSlotInvalid("kubernetes", broken, "termination without a reason");
  });

  it("refuses a container with no limits, since the whole diagnosis compares against them", () => {
    const broken = structuredClone(K8S);
    delete broken.pods[0].containers[0].limits;
    expectSlotInvalid("kubernetes", broken, "container with no limits");
  });

  it("refuses an invented key, so a typo cannot ride along unread", () => {
    expectSlotInvalid("kubernetes", { ...K8S, podz: [] }, "typo'd top-level key");
  });

  it("refuses a pod phase the cluster cannot produce", () => {
    const broken = structuredClone(K8S);
    broken.pods[0].phase = "Rebooting";
    expectSlotInvalid("kubernetes", broken, "invented pod phase");
  });

  it("refuses logs that do not say whether they were truncated", () => {
    // A truncated read that does not announce itself makes an incomplete look
    // complete, and an agent then reasons from an absence never established.
    const { truncated, ...rest } = LOGS;
    expectSlotInvalid("logs", rest, "logs with no truncation flag");
  });

  it("refuses logs with no window, since finding nothing must be placed in time", () => {
    const { window, ...rest } = LOGS;
    expectSlotInvalid("logs", rest, "logs with no window");
  });

  it("refuses a log level nobody emits", () => {
    const broken = structuredClone(LOGS);
    broken.lines[0].level = "verbose";
    expectSlotInvalid("logs", broken, "invented log level");
  });

  it("refuses a metric series with no points", () => {
    const broken = structuredClone(METRICS);
    broken.series[0].points = [];
    expectSlotInvalid("metrics", broken, "a series with no points is not a series");
  });

  it("refuses a metric with no unit, so a number cannot be compared to nothing", () => {
    const broken = structuredClone(METRICS);
    delete broken.series[0].unit;
    expectSlotInvalid("metrics", broken, "metric without a unit");
  });

  it("still refuses an empty object in any slot", () => {
    for (const slot of SLOTS) expectSlotInvalid(slot, {}, `${slot} empty object`);
  });
});

describe("reading keeps three outcomes apart", () => {
  it("reports failure, not nothing, when the scenario root does not exist", () => {
    // Codex, chunk 1 part 4: this used to report "nothing" — a misspelled
    // scenario, a wrong root and a deliberately empty slot all arrived as the
    // same answer, and that answer became a valid null observation nobody could
    // tell from a provider that genuinely looked.
    const r = readSlot("container-oom", "kubernetes", "/nonexistent/");
    expect(r.state).toBe("failed");
    expect(r.state === "failed" && r.reason).toContain("no scenario root");
  });

  it("reports failure for a scenario name that does not exist", () => {
    const r = readSlot("continer-oom", "kubernetes", ROOT);
    expect(r.state).toBe("failed");
    expect(r.state === "failed" && r.reason).toContain("no such scenario");
  });

  it("reports failure for a slot file missing from a real scenario", () => {
    // An incomplete fixture is a broken fixture. Passing it off as an empty
    // observation is how a deleted file becomes a finding.
    const r = readSlot("container-oom", "logs", new URL("./fixtures/partial/", import.meta.url).pathname);
    expect(r.state).toBe("failed");
    expect(r.state === "failed" && r.reason).toContain("has no logs.json");
  });

  it("reports nothing only when a file says so explicitly", () => {
    const r = readSlot("container-oom", "metrics", new URL("./fixtures/partial/", import.meta.url).pathname);
    expect(r.state).toBe("nothing");
  });

  it("reports failure, not nothing, for a file that is not JSON", () => {
    // Named for failure and asserting failure. The previous version accepted
    // failed-or-nothing, so it would have kept passing if the malformed fixture
    // disappeared — the exact regression this file is about.
    const r = readSlot("container-oom", "kubernetes", new URL("./fixtures/broken/", import.meta.url).pathname);
    expect(r.state).toBe("failed");
    expect(r.state === "failed" && r.reason).toContain("not JSON");
  });

  it("turns collected observations into the incident shape", () => {
    const { observations, failures } = toObservations(readScenario("container-oom", ROOT));
    expect(failures).toEqual([]);
    for (const slot of SLOTS) expect(observations[slot], `${slot} came back null`).not.toBeNull();
    expect(validate("incident", { ...BASE_INCIDENT, observations }).state).toBe("valid");
  });

  it("reports a failed slot separately, because null cannot say could-not-read", () => {
    // The incident schema has no room for "could not read": a failure written as
    // null is a failure nobody can see afterwards. It is returned alongside.
    const obs = { kubernetes: { state: "failed" as const, slot: "kubernetes" as const, reason: "disk on fire" },
      logs: { state: "nothing" as const, slot: "logs" as const },
      metrics: { state: "nothing" as const, slot: "metrics" as const } };
    const { observations, failures } = toObservations(obs);
    expect(observations.kubernetes).toBeNull();
    expect(failures).toEqual([{ slot: "kubernetes", reason: "disk on fire" }]);
  });
});
