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
    const failed = say(agentMessage(a, incidentId, at, agents));
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
      // The full stop is not decoration: without it every verdict read
      // "...exceeded its memory limit The agent puts its confidence at...".
      `Root cause: ${code}. ${sentence(analysis["root_cause"])}` +
      /*
       * Said as what it is: a number the model gave, not one anything measured.
       *
       * Codex, 2026-09-05, after the first live run: nothing checks the figure
       * against the agreement count, the directness of the evidence, the
       * contradictions or the ceiling the prompt asks for. Printing it bare
       * reads as a measurement. Computing a second number here would be worse —
       * it would look enforced while measuring the arithmetic.
       *
       * The percentage is for the reader: the owner asked on 2026-09-05 for
       * confidence in percent, because a number between nought and one reads as
       * a share rather than a judgement.
       */
      (typeof confidence === "number"
        ? ` The agent puts its confidence at ${asPercent(confidence)}, which is its own estimate and nothing here checks it.`
        : " Confidence was not recorded, so this rests on the evidence below and nothing more.") +
      /*
       * The dissent, SPELLED OUT rather than counted.
       *
       * It used to read "1 finding(s) argue against this; they are in the
       * incident's evidence" — a number, and a pointer at a JSON field that is
       * not in the thread, while every supporting fact was written out in full.
       * A reader who is told there is one objection and not what it says has
       * been told the shape of the doubt and not the doubt.
       */
      (against.length === 0
        ? ""
        : ` Against it: ${against.map((e) => `${e.source} says ${e.fact}`).join("; ")}.`);
    const failed = say({ role: "agent", incident_id: incidentId, ts: at, text,
      cited_evidence: forIt.map((e) => ({ source: e.source, fact: e.fact })) });
    if (failed !== null) return { state: "refused", reason: `verdict: ${failed}` };
  } else {
    /*
     * The branch that was not there.
     *
     * With no root_cause_code the loop above wrote the agent lines and the
     * function returned "reported" having said nothing about the outcome. A
     * subagent printed two such threads on 2026-09-07: a chain that stopped
     * after the specialists, and one where every agent refused. Both ended on a
     * bare positive finding, or on three could-not-read lines, with no closing
     * sentence — and both were returned as a successful report.
     *
     * Silence at the end of a thread reads as "that is the answer". The last
     * line has to say the investigation did not reach one, and why, so the two
     * cases are not the same silence.
     */
    const errored = agents.filter((a) => a.status === "error").length;
    const asked = agents.filter((a) => a.agent === "root_cause").length;
    const why = asked === 0
      ? "the root cause agent was never asked, so this chain did not finish"
      : "no cause was recorded on the incident";
    const failed = say({
      role: "system", incident_id: incidentId, ts: at,
      text: `This investigation reached no conclusion: ${why}.`
        + (errored === 0 ? "" : ` ${errored} agent(s) could not read their source.`)
        + " Nothing above is a verdict.",
    });
    if (failed !== null) return { state: "refused", reason: `verdict: ${failed}` };
  }

  return { state: "reported", conversation: current };
}

/** A cause sentence that ends, so the next sentence does not run into it. */
function sentence(text: unknown): string {
  const t = String(text ?? "").trim();
  if (t.length === 0) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * A confidence as the reader should see it.
 *
 * Math.round printed 100% for 0.9951, 0.996 and 0.999 alike — so a model that
 * deliberately withheld certainty was reported as certain — and 0% for a
 * diagnosis at 0.004, a number the incident schema refuses outright. Measured
 * by a subagent on 2026-09-07 across seven stored values.
 *
 * So: 0% and 100% are reserved for exactly 0 and exactly 1. Anything strictly
 * between them prints a figure strictly between them, with a decimal place when
 * the whole number would round to an endpoint it has not reached. The owner
 * asked for percent on 2026-09-05 because a number between nought and one reads
 * as a share rather than a judgement; this keeps that and stops it lying at the
 * ends.
 */
export function asPercent(confidence: number): string {
  if (!Number.isFinite(confidence)) return "an unreadable number";
  if (confidence <= 0) return "0%";
  if (confidence >= 1) return "100%";
  const whole = Math.round(confidence * 100);
  if (whole > 0 && whole < 100) return `${whole}%`;
  // Below 0.5% or above 99.5%: one decimal rather than an endpoint the value
  // has not reached. And when even that reads as an endpoint — 0.0001 printed
  // "0.0%", which is 0% with a decoration — say the bound instead.
  const oneDecimal = (confidence * 100).toFixed(1);
  if (oneDecimal === "0.0") return "under 0.1%";
  if (oneDecimal === "100.0") return "over 99.9%";
  return `${oneDecimal}%`;
}

/** What one agent said, in a message that carries its citations. */
function agentMessage(a: AgentResult, incidentId: string, at: string, all: AgentResult[]): Message {
  const findings = a.findings ?? [];
  const cited = findings.map((f) => ({ source: sourceOf(a.agent, f.source_ref, all), fact: f.fact }));

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
    /*
     * The root cause agent is the exception, and the schema says so in its own
     * words since 2026-09-07: it holds no observation, reads the other agents'
     * results, and may legitimately reach no conclusion. Calling that "unread"
     * told the reader the opposite of what the document means. The two carriers
     * disagreed about one shape; a subagent found them side by side.
     */
    if (a.agent === "root_cause") {
      return { role: "system", incident_id: incidentId, ts: at,
        text: `${a.agent}: read the findings above and proposed no cause.` };
    }
    return { role: "system", incident_id: incidentId, ts: at,
      text: `${a.agent}: reported success but listed nothing. Treat that as unread rather than as an empty result.` };
  }
  return { role: "agent", incident_id: incidentId, ts: at, cited_evidence: cited,
    text: `${a.agent}: ${findings.map((f) => f.fact).join("; ")}.` };
}

/**
 * Which source a fact came from — traced, not guessed.
 *
 * This returned "datadog" for any agent that is not one of the three slots,
 * which in practice means always for the root cause agent. So a thread could
 * show one fact twice with two different sources: `analysis.evidence` said
 * kubernetes and the root cause message said datadog, about the same sentence.
 * Found by a subagent on 2026-09-07, printed side by side from a real run.
 *
 * The root cause agent holds no observation, so its citations are copies of
 * what a specialist reported — and since 2026-09-07 that is enforced, not
 * hoped: a verdict may only cite a source_ref some agent actually reported. So
 * the source is FINDABLE, and looking it up is the honest answer.
 *
 * When it cannot be found the answer is the agent's own name rather than a
 * provider that never held the fact. That reads oddly, which is correct: a
 * citation nobody reported should look wrong.
 */
function sourceOf(agent: string, ref: string | undefined, agents: AgentResult[]): string {
  if (agent === "kubernetes" || agent === "logs" || agent === "metrics") return agent;
  if (typeof ref === "string") {
    for (const other of agents) {
      if (other.agent === agent) continue;
      const reported = (other.findings ?? []).some((f) => f.source_ref === ref);
      if (reported && (other.agent === "kubernetes" || other.agent === "logs" || other.agent === "metrics")) {
        return other.agent;
      }
    }
  }
  return agent;
}
