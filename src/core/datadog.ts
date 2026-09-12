/**
 * A SIMULATED Datadog incident record.
 *
 * The owner asked (2026-09-12) to register the incident in Datadog, but Datadog is
 * paid — so this MOCKS it inside n8n, like the simulated cluster. Grok reviewed the
 * approach the same day and rejected the first shape: it built a ready-to-POST
 * Datadog API body with the live ingest URL, so an HTTP node that took it would
 * make a real, paid call while the `simulated` marker (on the outer wrapper) got
 * dropped. This is the corrected shape:
 *
 *  - it is a PLAIN mock record, OUR fields — NOT a `POST /api/v2/incidents` body.
 *    There is no URL to post to and no API envelope, so nothing here can be sent
 *    by accident. A real Datadog integration is a separate adapter, validated
 *    against the real API — not this record.
 *  - `sent: false` and `provider: "mock-datadog"` are load-bearing FIELDS, not
 *    wrapper decoration, so any reader (human or node) sees them.
 *  - it never carries the raw observations — the same leak line the Slack report
 *    holds.
 *
 * No imports, so a Code node can carry it (like thread.ts / reply.ts).
 */

/** Datadog severities are SEV-1 (worst) .. SEV-5. Map from the alert's own
 *  severity, recognising the common synonyms for the top two so a severe alert is
 *  not softened by wording (subagent audit 2026-09-12: "fatal"/"p1"/"emergency"
 *  used to fall through to SEV-3). What is NOT recognised — a missing or genuinely
 *  unknown severity — defaults to SEV-3 and is labelled honestly by the caller as
 *  a default, NOT claimed to match the signal. */
// ONE list per level, used by both severityOf and severityKnown — Grok, 2026-09-12:
// two copies would drift. Add a synonym here and both stay in step.
const SEV1 = ["critical", "fatal", "emergency", "p1", "sev1", "sev-1"];
const SEV2 = ["high", "error", "p2", "sev2", "sev-2"];
const SEV3 = ["warning", "warn", "p3", "sev3", "sev-3"];

function severityOf(alertSeverity: unknown): string {
  const s = typeof alertSeverity === "string" ? alertSeverity.toLowerCase().trim() : "";
  if (SEV1.includes(s)) return "SEV-1";
  if (SEV2.includes(s)) return "SEV-2";
  return "SEV-3";
}

/** Whether the alert's severity was one we actually recognised. When false, the
 *  SEV-3 in the record is a DEFAULT, not a mapping — the caller says so, so an
 *  unknown severity is never read as an established mid-level one. */
function severityKnown(alertSeverity: unknown): boolean {
  const s = typeof alertSeverity === "string" ? alertSeverity.toLowerCase().trim() : "";
  return SEV1.includes(s) || SEV2.includes(s) || SEV3.includes(s);
}

/**
 * The synthetic mock incident id. Deterministic from the incident id, so a re-run
 * refers to the SAME mock incident rather than inventing a new one (the reason
 * collection ids are derived, not random). Clearly a mock id — never a real
 * Datadog id.
 */
export function datadogIncidentId(incidentId: string): string {
  const id = typeof incidentId === "string" && incidentId !== "" ? incidentId : "unknown";
  return `dd-mock-${id}`;
}

/**
 * The mock record we store for "the incident was registered in Datadog". It is
 * OUR shape, deliberately not the Datadog API request body — building the real
 * request belongs to a real adapter that validates field names against Datadog,
 * not to this mock. `pod` is the affected pod name, or "" if none.
 */
export function datadogMockRecord(
  incident: Record<string, unknown>,
  code: string,
  confidence: number,
  pod: string = "",
): Record<string, unknown> {
  const service = typeof incident["service"] === "string" ? (incident["service"] as string) : "incident";
  const incidentId = typeof incident["incident_id"] === "string" ? (incident["incident_id"] as string) : "";
  const cluster = typeof incident["cluster"] === "string" ? (incident["cluster"] as string) : "";
  const namespace = typeof incident["namespace"] === "string" ? (incident["namespace"] as string) : "";
  // The alert lives at incident.source.alert (the trace viewer surfaced this on
  // 2026-09-12: reading incident.alert always missed, so every severity defaulted
  // to SEV-3 with severity_from_signal:false). Fall back to a top-level alert just
  // in case, but the real shape is under source.
  const source = (incident["source"] ?? {}) as Record<string, unknown>;
  const alert = ((source["alert"] ?? incident["alert"]) ?? {}) as Record<string, unknown>;
  const pct = Math.round((typeof confidence === "number" ? confidence : 0) * 100);

  const record: Record<string, unknown> = {
    provider: "mock-datadog",
    simulated: true,
    sent: false,
    note: "SIMULATED — no Datadog call was made. A real integration needs its own adapter validated against the Datadog API.",
    datadog_incident_id: datadogIncidentId(incidentId),
    incident_id: incidentId,
    title: `${incidentId}: ${service} — ${code}`,
    severity: severityOf(alert["severity"]),
    // Honest about where the severity came from: a recognised signal, or a
    // default because the alert's severity was missing/unknown. Without this a
    // defaulted SEV-3 reads as an established one.
    severity_from_signal: severityKnown(alert["severity"]),
    service,
    root_cause: code,
    confidence_pct: pct,
  };
  if (cluster !== "") record["cluster"] = cluster;
  if (namespace !== "") record["namespace"] = namespace;
  if (pod !== "") record["pod"] = pod;
  return record;
}
