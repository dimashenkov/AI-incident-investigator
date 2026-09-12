/**
 * The SIMULATED Datadog incident record. Grok (2026-09-12) rejected the first
 * shape — a ready-to-POST API body with the live ingest URL — as a blob that an
 * HTTP node would send for real. These tests hold the corrected shape: a plain
 * mock record that cannot be mistaken for a sendable request, marked not-sent, and
 * leaking nothing.
 */
import { describe, it, expect } from "vitest";
import { datadogMockRecord, datadogIncidentId } from "../src/core/datadog.js";

// The alert is nested under `source`, the shape a real assembled incident has —
// the trace viewer caught (2026-09-12) that reading a top-level `alert` always
// missed, so every severity defaulted. The test now uses the real shape.
const INCIDENT = {
  incident_id: "INC-2026-1001",
  service: "media-archiver",
  namespace: "production",
  cluster: "prod-eu",
  source: { provider: "fake-datadog", alert: { severity: "critical" } },
  observations: { kubernetes: { pods: [{ secret_token: "xoxb-should-not-leak" }] } },
};

describe("datadogIncidentId", () => {
  it("is deterministic and clearly a mock id", () => {
    expect(datadogIncidentId("INC-2026-1001")).toBe("dd-mock-INC-2026-1001");
    expect(datadogIncidentId("INC-2026-1001")).toBe(datadogIncidentId("INC-2026-1001"));
  });
});

describe("datadogMockRecord", () => {
  const r = datadogMockRecord(INCIDENT, "VOLUME_FULL", 0.95, "media-archiver-7c5f8d6b94-nz4tp");

  it("is marked simulated and not sent — as FIELDS, not wrapper decoration", () => {
    expect(r.provider).toBe("mock-datadog");
    expect(r.simulated).toBe(true);
    expect(r.sent).toBe(false);
    expect(String(r.note)).toMatch(/simulated/i);
  });

  it("is NOT a sendable Datadog API request — no URL, no api envelope", () => {
    // Grok's flaw: a POST-shaped body + live URL is a real call waiting to happen.
    const t = JSON.stringify(r);
    // Strengthened after the audit: not just two hostnames — NO url scheme and NO
    // api path anywhere, so an EU/other ingest url under any field name is caught.
    expect(t).not.toMatch(/https?:\/\//);
    expect(t).not.toContain("/api/");
    expect(t).not.toContain("would_post_to");
    expect(r.data).toBeUndefined();           // no {data:{type:"incidents"}} envelope
  });

  it("captures the curated incident fields", () => {
    expect(r.datadog_incident_id).toBe("dd-mock-INC-2026-1001");
    expect(r.title).toContain("VOLUME_FULL");
    expect(r.service).toBe("media-archiver");
    expect(r.root_cause).toBe("VOLUME_FULL");
    expect(r.cluster).toBe("prod-eu");
    expect(r.pod).toBe("media-archiver-7c5f8d6b94-nz4tp");
    expect(r.severity).toBe("SEV-1");
  });

  it("maps severity FROM source.alert, and marks whether it was recognised", () => {
    // The bug the trace viewer found: severity was read from incident.alert, but
    // the alert lives at incident.source.alert — so it ALWAYS defaulted to SEV-3
    // with severity_from_signal:false, even for a critical alert.
    expect(r.severity).toBe("SEV-1");            // source.alert.severity = critical
    expect(r.severity_from_signal).toBe(true);   // recognised, not a default
    const none = datadogMockRecord({ ...INCIDENT, source: { provider: "x" } }, "X", 0.5);
    expect(none.severity, "no severity → default").toBe("SEV-3");
    expect(none.severity_from_signal, "and marked as a default, not the signal").toBe(false);
  });

  it("does NOT leak the raw observations", () => {
    const t = JSON.stringify(r);
    expect(t).not.toContain("xoxb-should-not-leak");
    expect(t).not.toContain("observations");
  });

  it("omits the pod field when there is no pod", () => {
    expect(datadogMockRecord(INCIDENT, "DNS_RESOLUTION_FAILURE", 0.8).pod).toBeUndefined();
  });
});
