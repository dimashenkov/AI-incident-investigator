/**
 * Say what happened, in the incident's own thread.
 *
 * Everything up to here produces a document. This is the only part a person
 * reads, and it is where the system either shows its reasoning or asks to be
 * trusted. The schema already forbids an agent message that cites nothing; this
 * builds messages that satisfy it from what was actually recorded, so a claim
 * with no evidence behind it cannot be written in the first place.
 *
 * It invents nothing. Every sentence is assembled from fields already on the
 * incident, which is why it is deterministic and free: the reasoning was bought
 * once, when the agents ran, and reporting it again costs nothing.
 */
import { appendMessage, type Message } from "../providers/slack.js";

export type Reported =
  | { state: "reported"; conversation: Record<string, unknown> }
  | { state: "refused"; reason: string; errors?: string[] };

type Finding = { fact: string; source_ref: string; severity?: string };
type AgentResult = { agent: string; status: string; findings?: Finding[]; hypotheses?: Array<{ code: string }>; confidence?: number; error?: string };
type Evidence = { source: string; fact: string; supports?: string };

/** A timestamp the caller supplies, so the same incident reports identically twice. */
export function reportIncident(incident: Record<string, unknown>, at: string): Reported {
  const conversation = incident["conversation"];
  if (typeof conversation !== "object" || conversation === null) {
    return { state: "refused", reason: "the incident has no conversation to report into" };
  }
  const incidentId = incident["incident_id"];
  if (typeof incidentId !== "string") return { state: "refused", reason: "the incident has no id" };

  // Grok, 2026-09-05: messages were stamped with the incident's id and appended
  // into whatever conversation object the incident carried, without checking
  // the two agree — so a thread belonging to another incident would receive
  // messages labelled with this one's id, which is the leak the schema stamps
  // every message to make visible.
  const threadIncident = (conversation as Record<string, unknown>)["incident_id"];
  if (threadIncident !== incidentId) {
    return { state: "refused", reason: `the conversation belongs to ${String(threadIncident)}, not to ${incidentId}` };
  }

  const analysis = (incident["analysis"] ?? {}) as Record<string, unknown>;
  const agents = Array.isArray(analysis["agents"]) ? (analysis["agents"] as AgentResult[]) : [];
  const evidence = Array.isArray(analysis["evidence"]) ? (analysis["evidence"] as Evidence[]) : [];
  const code = analysis["root_cause_code"];

  let current = conversation as Record<string, unknown>;
  const say = (message: Message): string | null => {
    const r = appendMessage(current, message);
    if (r.state === "refused") return r.reason;
    current = r.conversation;
    return null;
  };

  const opened = say({
    role: "system", text: `${incidentId}: ${String(incident["service"])} in ${String(incident["namespace"])} — investigating.`,
    ts: at, incident_id: incidentId,
  });
  if (opened !== null) return { state: "refused", reason: opened };

  for (const a of agents) {
    const failed = say(agentMessage(a, incidentId, at));
    if (failed !== null) return { state: "refused", reason: `${a.agent}: ${failed}` };
  }

  // The verdict, and only what stands behind it.
  //
  // An agent message must cite evidence, so a conclusion with nothing recorded
  // to cite cannot be posted at all — which is the right refusal rather than a
  // sentence claiming more than the incident holds.
  if (code === "INSUFFICIENT_EVIDENCE") {
    // Said as a system message, carrying no citations at all.
    //
    // Grok and Codex, 2026-09-05: this was an agent message, and because the
    // schema requires an agent message to cite something, a fallback INVENTED a
    // citation — "datadog: the alert that opened this incident" — whenever
    // nothing had been found. That satisfied the schema by lying, which is the
    // exact hole the schema exists to close. A verdict with nothing to cite is
    // not an agent's claim; it is a statement about the investigation.
    //
    // The wording is weaker too. It used to say nothing pointed at one
    // explanation more than another, which the incident does not establish: the
    // code can be INSUFFICIENT_EVIDENCE simply because the root cause agent
    // proposed nothing, with clear findings sitting above.
    const readable = agents.filter((a) => a.status === "error").length;
    const failed = say({
      role: "system", incident_id: incidentId, ts: at,
      text: `No cause was established from the recorded analysis.` +
        (readable === 0 ? "" : ` ${readable} agent(s) could not read their source, so less was collected than the thread above suggests.`),
    });
    if (failed !== null) return { state: "refused", reason: `verdict: ${failed}` };
  } else if (typeof code === "string") {
    const forIt = evidence.filter((e) => e.supports === "for");
    const against = evidence.filter((e) => e.supports === "against");
    const confidence = analysis["confidence"];

    if (forIt.length === 0) {
      // Naming a cause with nothing recorded to support it is the sentence a
      // reader would most reasonably believe and least ought to.
      return { state: "refused", reason: `the incident names ${code} but records no evidence supporting it` };
    }

    const text =
      `Root cause: ${code}. ${String(analysis["root_cause"] ?? "")}` +
      (typeof confidence === "number"
        ? ` Confidence ${confidence}.`
        : " Confidence was not recorded, so this rests on the evidence below and nothing more.") +
      (against.length === 0 ? "" : ` ${against.length} finding(s) argue against this; they are in the incident's evidence.`);
    const failed = say({ role: "agent", incident_id: incidentId, ts: at, text,
      cited_evidence: forIt.map((e) => ({ source: e.source, fact: e.fact })) });
    if (failed !== null) return { state: "refused", reason: `verdict: ${failed}` };
  }

  return { state: "reported", conversation: current };
}

/** What one agent said, in a message that carries its citations. */
function agentMessage(a: AgentResult, incidentId: string, at: string): Message {
  const findings = a.findings ?? [];
  const cited = findings.map((f) => ({ source: sourceOf(a.agent), fact: f.fact }));

  // Grok, 2026-09-05: `no_data || findings.length === 0` collapsed three
  // different situations into one sentence — no_data, an ok result with nothing
  // in it, and any status the schema might grow later. Only the exact string
  // "error" produced the could-not-read wording. A reader would treat a failed
  // read as a negative observation and trust everything after it.
  if (a.status === "error") {
    return { role: "system", incident_id: incidentId, ts: at,
      text: `${a.agent}: could not read its source — ${a.error ?? "no reason given"}. Nothing below rests on it.` };
  }
  if (a.status === "no_data") {
    return { role: "system", incident_id: incidentId, ts: at,
      text: `${a.agent}: read its source and found nothing to report.` };
  }
  if (a.status !== "ok") {
    // A state nobody here recognises is said as such rather than rendered as
    // one of the two above.
    return { role: "system", incident_id: incidentId, ts: at,
      text: `${a.agent}: returned a state this report does not recognise (${a.status}). Read the incident itself before relying on anything below.` };
  }
  if (findings.length === 0) {
    return { role: "system", incident_id: incidentId, ts: at,
      text: `${a.agent}: reported success but listed nothing. Treat that as unread rather than as an empty result.` };
  }
  return { role: "agent", incident_id: incidentId, ts: at, cited_evidence: cited,
    text: `${a.agent}: ${findings.map((f) => f.fact).join("; ")}.` };
}

function sourceOf(agent: string): string {
  return agent === "kubernetes" || agent === "logs" || agent === "metrics" ? agent : "datadog";
}
