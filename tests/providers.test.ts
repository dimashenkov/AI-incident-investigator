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
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "../src/schema/validate.js";
import { listScenarios, newCollectionRequest, readSlot, readScenario, toObservations, readAlert, SLOTS, NOTHING_SENTINEL } from "../src/providers/fixtures.js";

/**
 * The request every read in this file is made under.
 *
 * A provider is asked for something; it does not decide what it was asked for.
 * Reading without a request returns the raw fixture, which is how the schema
 * comes to refuse it — the stamp is applied by the collection, not by the file.
 */
/*
 * The SAME incident id BASE_INCIDENT carries.
 *
 * It was INC-2026-0101 against a base of INC-2026-0001, and the test below
 * asserted the result was valid — observations gathered for one incident,
 * placed into another, and called well formed. Nothing objected until the
 * provenance rule moved into invariants.ts on 2026-09-07, because
 * common.schema.json states the rule in prose ("An observation asked for
 * elsewhere is not this incident's") and nothing enforced it after collection.
 */
const REQUEST = newCollectionRequest("INC-2026-0001", "prod-eu", "production", "aaaaaaaa-0000-4000-8000-000000000000");

const ROOT = new URL("../scenarios/", import.meta.url).pathname;

const BASE_INCIDENT = {
  incident_id: "INC-2026-0001", status: "investigating", service: "payment-api",
  namespace: "production", cluster: "prod-eu", started_at: "2026-09-04T10:30:00Z",
  source: { provider: "fake-datadog", alert: { id: "a", title: "t", triggered_at: "2026-09-04T10:29:00Z" } },
  observations: { kubernetes: null, logs: null, metrics: null },
  // Three answers per slot, recorded in the document. Everything here is a
  // deliberate "the provider said there was nothing", not a slot nobody read.
  collection: { kubernetes: { state: "nothing" }, logs: { state: "nothing" }, metrics: { state: "nothing" } },
  analysis: { agents: [], root_cause_code: null, root_cause: null, confidence: null, evidence: [] },
  remediation: { recommended_actions: [] },
  conversation: { provider: "fake-slack", channel_id: "c", thread_id: "thread-INC-2026-0001", incident_id: "INC-2026-0001", messages: [] },
};

/*
 * The slot goes in stamped, and the refusal has to name the broken field.
 *
 * Both halves were missing, and together they emptied this whole file. A raw
 * fixture carries no provenance, so once the incident schema required one every
 * expectSlotInvalid was invalid before the test broke anything — eleven
 * contract tests passing on an error none of them was about. Found by a
 * mutation that removed "reason" from the termination contract and changed
 * nothing. So: stamp it the way a collection would, and require the error to
 * mention the field, which is what makes the assertion about this test.
 */
const stampOf = (slot: string) => ({
  collection_id: "aaaaaaaa-0000-4000-8000-000000000000",
  requested_for: BASE_INCIDENT.incident_id,
  cluster: BASE_INCIDENT.cluster,
  namespace: BASE_INCIDENT.namespace,
  provider: `fake-${slot}`,
});

const withSlot = (slot: string, data: unknown) => ({
  ...BASE_INCIDENT,
  // The record has to agree with the slot beside it, which is the whole point
  // of it existing — a record nothing cross-checks drifts into decoration.
  collection: { ...BASE_INCIDENT.collection, [slot]: { state: "collected" } },
  observations: {
    ...BASE_INCIDENT.observations,
    [slot]: typeof data === "object" && data !== null && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), provenance: stampOf(slot) }
      : data,
  },
});

const expectSlotInvalid = (slot: string, data: unknown, why: string, names: string) => {
  const r = validate("incident", withSlot(slot, data));
  expect(r.state, `${why}: ${JSON.stringify(r)}`).toBe("invalid");
  if (r.state !== "invalid") return;
  const said = r.errors.join("; ");
  expect(said, `${why}: refused, but for something other than ${names}: ${said}`).toContain(names);
};

describe("every fixture satisfies its own contract", () => {
  it("finds at least one scenario, so these tests are not passing on nothing", () => {
    expect(listScenarios(ROOT).length).toBeGreaterThan(0);
  });

  it("validates every slot of every scenario as part of a whole incident", () => {
    for (const scenario of listScenarios(ROOT)) {
      const obs = readScenario(scenario, ROOT, REQUEST);
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

  it("accepts a well-formed slot, so the refusals below are about what they say", () => {
    // The precondition the refusals rest on. Without it they would all still
    // pass against a slot that can never validate for any reason at all.
    const r = validate("incident", withSlot("kubernetes", K8S));
    expect(r.state, `a stamped fixture must validate: ${JSON.stringify(r)}`).toBe("valid");
  });
  const LOGS = JSON.parse(readFileSync(`${ROOT}container-oom/logs.json`, "utf8"));
  const METRICS = JSON.parse(readFileSync(`${ROOT}container-oom/metrics.json`, "utf8"));

  it("refuses an observation that omits when it was collected", () => {
    const { collected_at, ...rest } = K8S;
    expectSlotInvalid("kubernetes", rest, "an observation with no timestamp cannot be placed in time", "collected_at");
  });

  it("refuses a termination that does not say why", () => {
    // The whole scenario turns on OOMKilled. A terminated container with no
    // reason is the silence this project refuses everywhere else.
    const broken = structuredClone(K8S);
    delete broken.pods[0].containers[0].last_state.terminated.reason;
    expectSlotInvalid("kubernetes", broken, "termination without a reason", "reason");
  });

  it("refuses a container with no limits, since the whole diagnosis compares against them", () => {
    const broken = structuredClone(K8S);
    delete broken.pods[0].containers[0].limits;
    expectSlotInvalid("kubernetes", broken, "container with no limits", "limits");
  });

  it("refuses an invented key, so a typo cannot ride along unread", () => {
    expectSlotInvalid("kubernetes", { ...K8S, podz: [] }, "typo'd top-level key", "must NOT have additional properties");
  });

  it("refuses a pod phase the cluster cannot produce", () => {
    const broken = structuredClone(K8S);
    broken.pods[0].phase = "Rebooting";
    expectSlotInvalid("kubernetes", broken, "invented pod phase", "phase");
  });

  it("refuses logs that do not say whether they were truncated", () => {
    // A truncated read that does not announce itself makes an incomplete look
    // complete, and an agent then reasons from an absence never established.
    const { truncated, ...rest } = LOGS;
    expectSlotInvalid("logs", rest, "logs with no truncation flag", "truncated");
  });

  it("refuses logs with no window, since finding nothing must be placed in time", () => {
    const { window, ...rest } = LOGS;
    expectSlotInvalid("logs", rest, "logs with no window", "window");
  });

  it("refuses a log level nobody emits", () => {
    const broken = structuredClone(LOGS);
    broken.lines[0].level = "verbose";
    expectSlotInvalid("logs", broken, "invented log level", "level");
  });

  it("refuses a metric series with no points", () => {
    const broken = structuredClone(METRICS);
    broken.series[0].points = [];
    expectSlotInvalid("metrics", broken, "a series with no points is not a series", "points");
  });

  it("refuses a metric with no unit, so a number cannot be compared to nothing", () => {
    const broken = structuredClone(METRICS);
    delete broken.series[0].unit;
    expectSlotInvalid("metrics", broken, "metric without a unit", "unit");
  });

  it("still refuses an empty object in any slot", () => {
    for (const slot of SLOTS) expectSlotInvalid(slot, {}, `${slot} empty object`, "required property");
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

  it("reports nothing under a request too, not only when read raw", () => {
    // The sentinel is read twice — once on the stamped path and once on the raw
    // one — and only the raw one had a test. Codex, 2026-09-05: the stamped
    // path is the one production uses, and it is where the sentinel was being
    // believed before the stamp had been looked at.
    const r = readSlot("container-oom", "metrics", new URL("./fixtures/partial/", import.meta.url).pathname, REQUEST);
    expect(r.state, JSON.stringify(r)).toBe("nothing");
  });

  it("refuses a nothing that does not say why it is nothing", () => {
    // Codex, 2026-09-05: { "__nothing": false } was an established absence.
    const dir = mkdtempSync(join(tmpdir(), "sentinel-"));
    mkdirSync(join(dir, "container-oom"), { recursive: true });
    writeFileSync(join(dir, "container-oom", "metrics.json"), JSON.stringify({ [NOTHING_SENTINEL]: false }));
    const r = readSlot("container-oom", "metrics", `${dir}/`, REQUEST);
    expect(r.state, JSON.stringify(r)).toBe("failed");
    if (r.state !== "failed") return;
    expect(r.reason).toContain("does not say why");
  });

  it("refuses a nothing that arrives carrying an observation as well", () => {
    // An absence and an observation are different answers, and an answer that
    // makes both was being believed as the one nothing re-examines.
    const dir = mkdtempSync(join(tmpdir(), "sentinel-"));
    mkdirSync(join(dir, "container-oom"), { recursive: true });
    writeFileSync(join(dir, "container-oom", "metrics.json"),
      JSON.stringify({ [NOTHING_SENTINEL]: "nothing to report", series: [{ name: "x" }] }));
    const r = readSlot("container-oom", "metrics", `${dir}/`, REQUEST);
    expect(r.state, JSON.stringify(r)).toBe("failed");
    if (r.state !== "failed") return;
    expect(r.kind).toBe("contradiction");
    expect(r.reason).toContain("series");
  });

  it("refuses a nothing that hides an observation inside its provenance", () => {
    // Codex, 2026-09-05: provenance was exempted wholesale from the "no real
    // data" check, so a correctly stamped absence could carry the observation
    // in the one place nothing looked.
    const dir = mkdtempSync(join(tmpdir(), "sentinel-"));
    mkdirSync(join(dir, "container-oom"), { recursive: true });
    writeFileSync(join(dir, "container-oom", "metrics.json"), JSON.stringify({
      [NOTHING_SENTINEL]: "none found",
      provenance: { collection_id: REQUEST.collection_id, requested_for: REQUEST.incident_id,
        cluster: REQUEST.cluster, namespace: REQUEST.namespace, provider: "fake-metrics",
        series: [{ name: "real-data" }] },
    }));
    const r = readSlot("container-oom", "metrics", `${dir}/`, REQUEST);
    expect(r.state, JSON.stringify(r)).toBe("failed");
    if (r.state !== "failed") return;
    expect(r.kind).toBe("contradiction");
    expect(r.reason).toContain("series");
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
    const { observations, failures } = toObservations(readScenario("container-oom", ROOT, REQUEST));
    expect(failures).toEqual([]);
    for (const slot of SLOTS) expect(observations[slot], `${slot} came back null`).not.toBeNull();
    const collection = Object.fromEntries(SLOTS.map((slot) => [slot, { state: "collected" }]));
    const r = validate("incident", { ...BASE_INCIDENT, observations, collection });
    expect(r.state, JSON.stringify(r)).toBe("valid");
  });

  it("reports a failed slot separately, because null cannot say could-not-read", () => {
    // Returned alongside, and since 2026-09-05 also written into the document
    // as collection[slot] = { state: "failed", kind, reason }. Before that, a
    // failure written as null was a failure nobody could see afterwards.
    const obs = { kubernetes: { state: "failed" as const, slot: "kubernetes" as const, kind: "unreadable" as const, reason: "disk on fire" },
      logs: { state: "nothing" as const, slot: "logs" as const },
      metrics: { state: "nothing" as const, slot: "metrics" as const } };
    const { observations, failures } = toObservations(obs);
    expect(observations.kubernetes).toBeNull();
    expect(failures).toEqual([{ slot: "kubernetes", kind: "unreadable", reason: "disk on fire" }]);
  });
});
