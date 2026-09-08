/**
 * The thread is the only part a person reads.
 *
 * Everything before it produces a document nobody opens. So the tests here are
 * about what a reader would be misled by: a conclusion with nothing behind it,
 * an agent that could not read passed off as one that found nothing, and
 * contradicting evidence quietly absent from the sentence that cites the rest.
 */
import { describe, it, expect } from "vitest";
import { reportIncident, asPercent } from "../src/core/report.js";
import { assembleIncident, concludeIncident, recordAgentResult } from "../src/core/assemble.js";
import { validate } from "../src/schema/validate.js";

const SC = new URL("../scenarios/", import.meta.url).pathname;
const AT = "2026-09-05T10:00:00Z";

/*
 * Two findings, and the second is not decoration: the root cause replies below
 * cite `deployment.image` as their contradicting evidence, and a verdict may
 * only cite what an agent actually reported. Nothing checked that until
 * 2026-09-07, so this fixture handed the verdict a path no agent had mentioned
 * — the shape of the defect it was written to catch, one level up.
 */
const K8S_REPLY = {
  agent: "kubernetes", status: "ok",
  findings: [{ fact: "container terminated OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" },
             { fact: "the deployment image", source_ref: "deployment.image" }],
  hypotheses: [], confidence: 0.5,
};

function incidentWith(...replies: unknown[]) {
  const a = assembleIncident("container-oom", 1, { root: SC });
  if (a.state !== "assembled") throw new Error("not assembled");
  let inc = a.incident;
  for (const r of replies) {
    const rec = recordAgentResult(inc, r);
    if (rec.state !== "recorded") throw new Error(`${rec.reason} ${JSON.stringify(rec.errors)}`);
    inc = rec.incident;
  }
  return inc;
}

const texts = (c: Record<string, unknown>) => (c.messages as Array<{ text: string }>).map((m) => m.text);

describe("the thread says what happened, and only that", () => {
  it("posts a valid conversation for a diagnosed incident", () => {
    const withRc = incidentWith(K8S_REPLY, {
      agent: "root_cause", status: "ok",
      findings: [{ fact: "container terminated OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
      hypotheses: [{ code: "CONTAINER_OOM", statement: "the container exceeded its memory limit",
        supported_by: ["pods[0].containers[0].last_state.terminated.reason"] }],
      confidence: 0.9,
    });
    const done = concludeIncident(withRc);
    if (done.state !== "concluded") throw new Error(done.reason);

    const r = reportIncident(done.incident, AT);
    expect(r.state, r.state === "refused" ? r.reason : "").toBe("reported");
    if (r.state !== "reported") return;
    expect(validate("conversation", r.conversation).state).toBe("valid");
    expect(texts(r.conversation).join(" ")).toContain("CONTAINER_OOM");
  });

  it("keeps could-not-read distinct from found-nothing, in the words a reader sees", () => {
    // These lead to opposite conclusions. A thread that renders them the same
    // way undoes the distinction the schema spent three states preserving.
    const errored = incidentWith({ agent: "logs", status: "error", error: "the log backend timed out", findings: [], hypotheses: [], confidence: 0 });
    const empty = incidentWith({ agent: "logs", status: "no_data", findings: [], hypotheses: [], confidence: 0 });

    const a = reportIncident(errored, AT);
    const b = reportIncident(empty, AT);
    if (a.state !== "reported" || b.state !== "reported") throw new Error("not reported");
    /*
     * Asserted on the AGENT'S OWN line, not on the whole thread.
     *
     * On 2026-09-07 the closing sentence added for a chain that reached no
     * conclusion also says "could not read their source" — so joining every
     * message and searching for the phrase found it even with the agent branch
     * deleted, and the mutation guarding that branch survived. Two carriers of
     * one phrase, and the test was reading the wrong one.
     */
    const line = (r: typeof a) => texts(r.conversation).find((t: string) => t.startsWith("logs:"));
    expect(line(a), "the logs agent has no line at all").toBeDefined();
    expect(line(a)).toContain("could not read its source");
    expect(line(b)).toContain("found nothing");
    expect(texts(a.conversation)).not.toEqual(texts(b.conversation));
  });

  it("says the evidence does not support a cause, rather than staying silent", () => {
    const withRc = incidentWith(K8S_REPLY, {
      agent: "root_cause", status: "ok",
      findings: [{ fact: "container terminated OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
      hypotheses: [], confidence: 0.2,
    });
    const done = concludeIncident(withRc);
    if (done.state !== "concluded") throw new Error(done.reason);
    const r = reportIncident(done.incident, AT);
    if (r.state !== "reported") throw new Error(r.reason);
    // The wording is deliberately weaker than it was. Codex, 2026-09-05: saying
    // nothing pointed at one explanation more than another is not something the
    // incident establishes — the code can be INSUFFICIENT_EVIDENCE simply
    // because the root cause agent proposed nothing, with clear findings above.
    expect(texts(r.conversation).join(" ")).toContain("No cause was established from the recorded analysis");
  });

  it("tells the reader that contradicting evidence exists rather than omitting it", () => {
    // The evidence against is in the incident. A verdict sentence that cites
    // only what agrees, without saying the rest is there, reads as stronger
    // than the incident actually is.
    const withRc = incidentWith(K8S_REPLY, {
      agent: "root_cause", status: "ok",
      findings: [
        { fact: "container terminated OOMKilled", source_ref: "pods[0].containers[0].last_state.terminated.reason" },
        { fact: "the deployment image did not change", source_ref: "deployment.image" },
      ],
      hypotheses: [{ code: "CONTAINER_OOM", statement: "memory limit exceeded",
        supported_by: ["pods[0].containers[0].last_state.terminated.reason"] }],
      confidence: 0.7,
    });
    const done = concludeIncident(withRc);
    if (done.state !== "concluded") throw new Error(done.reason);
    const r = reportIncident(done.incident, AT);
    if (r.state !== "reported") throw new Error(r.reason);
    /*
     * The dissent must be SPELLED OUT, not counted. It read "1 finding(s) argue
     * against this; they are in the incident's evidence" — a number, and a
     * pointer at a JSON field that is not in the thread, while every supporting
     * fact was written out in full. A reader told there is one objection, and
     * not what it says, has been told the shape of the doubt and not the doubt.
     */
    const thread = texts(r.conversation).join(" ");
    expect(thread, "the objection must be named").toContain("Against it:");
    expect(thread, "and its own words must appear, not a count")
      .toContain("the deployment image did not change");
    expect(thread, "a bare count is not the objection").not.toMatch(/finding\(s\) argue against/);
  });

  it("stamps every message with this incident and no other", () => {
    const r = reportIncident(incidentWith(K8S_REPLY), AT);
    if (r.state !== "reported") throw new Error(r.reason);
    for (const m of r.conversation.messages as Array<{ incident_id: string }>) {
      expect(m.incident_id).toBe(r.conversation.incident_id);
    }
  });

  it("produces the same thread twice for the same incident and time", () => {
    // A report that differs run to run cannot be compared, and a reader cannot
    // tell a changed incident from a changed renderer.
    const inc = incidentWith(K8S_REPLY);
    const a = reportIncident(inc, AT);
    const b = reportIncident(inc, AT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("refuses an incident with no conversation rather than inventing one", () => {
    expect(reportIncident({ incident_id: "INC-2026-0101" }, AT).state).toBe("refused");
  });

  it("posts the inconclusive verdict without citing anything, rather than inventing a citation", () => {
    // Grok and Codex, 2026-09-05: this was an agent message, and since the
    // schema requires an agent message to cite something, a fallback invented
    // "datadog: the alert that opened this incident" whenever nothing had been
    // found. Satisfying a schema by lying is the hole the schema exists to close.
    const bare = incidentWith({ agent: "logs", status: "no_data", findings: [], hypotheses: [], confidence: 0 });
    // Confidence 0, not 0.1: with no findings and no hypotheses there is
    // nothing for a tenth of certainty to be about, and since 2026-09-07 the
    // schema says so — an ok result carrying no findings may not claim any.
    const withRc = recordAgentResult(bare, { agent: "root_cause", status: "ok", findings: [], hypotheses: [], confidence: 0 });
    if (withRc.state !== "recorded") throw new Error(withRc.reason);
    const done = concludeIncident(withRc.incident);
    if (done.state !== "concluded") throw new Error(done.reason);

    const r = reportIncident(done.incident, AT);
    expect(r.state, r.state === "refused" ? r.reason : "").toBe("reported");
    if (r.state !== "reported") return;
    const messages = r.conversation.messages as Array<{ role: string; text: string; cited_evidence?: unknown[] }>;
    const verdict = messages.find((m) => m.text.includes("No cause was established"));
    expect(verdict, "the verdict was never posted").toBeDefined();
    expect(verdict!.role, "an inconclusive verdict is not an agent's claim").toBe("system");
    expect(JSON.stringify(r.conversation)).not.toContain("the alert that opened this incident");
  });

  it("refuses to name a cause the incident records no support for", () => {
    // The sentence a reader would most reasonably believe and least ought to.
    const inc = incidentWith(K8S_REPLY);
    const named = { ...inc, status: "diagnosed",
      analysis: { ...(inc.analysis as object), root_cause_code: "CONTAINER_OOM",
        root_cause: "memory", confidence: 0.9,
        evidence: [{ source: "kubernetes", fact: "the image did not change", supports: "against" }] } };
    const r = reportIncident(named, AT);
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("records no evidence supporting it");
  });

  it("says so when confidence was never recorded, instead of omitting it", () => {
    const inc = incidentWith(K8S_REPLY);
    const named = { ...inc, status: "diagnosed",
      analysis: { ...(inc.analysis as object), root_cause_code: "CONTAINER_OOM", root_cause: "memory",
        confidence: null, evidence: [{ source: "kubernetes", fact: "OOMKilled", supports: "for" }] } };
    const r = reportIncident(named, AT);
    if (r.state !== "reported") throw new Error(r.reason);
    expect(texts(r.conversation).join(" ")).toContain("Confidence was not recorded");
  });

  it("refuses a conversation belonging to another incident", () => {
    // Every message is stamped, but nothing checked the thread itself — so a
    // thread belonging elsewhere would receive messages labelled with this id.
    const inc = incidentWith(K8S_REPLY);
    const swapped = { ...inc, conversation: { ...(inc.conversation as object), incident_id: "INC-2026-0999", thread_id: "thread-INC-2026-0999" } };
    const r = reportIncident(swapped, AT);
    expect(r.state).toBe("refused");
    if (r.state !== "refused") return;
    expect(r.reason).toContain("belongs to INC-2026-0999");
  });

  it("does not render an unrecognised status as either of the two it knows", () => {
    // Only the exact string "error" used to mean could-not-read; everything
    // else fell into "found nothing".
    const odd = incidentWith(K8S_REPLY);
    const withOdd = { ...odd, analysis: { ...(odd.analysis as { agents: unknown[] }),
      agents: [...(odd.analysis as { agents: unknown[] }).agents, { agent: "logs", status: "timeout", findings: [], hypotheses: [], confidence: 0 }] } };
    const r = reportIncident(withOdd, AT);
    if (r.state !== "reported") throw new Error(r.reason);
    const said = texts(r.conversation).join(" ");
    expect(said).toContain("does not recognise");
    expect(said).not.toContain("logs: read its source and found nothing");
  });
});

/*
 * Three defects a subagent found on 2026-09-07 by running the real reporter and
 * printing what it produced, rather than by reading it.
 */
describe("the thread does not say more, or less, than the incident holds", () => {
  it("never prints a confidence as an endpoint it has not reached", () => {
    // Math.round collapsed 0.9951, 0.996 and 0.999 into "100%", so a model that
    // deliberately withheld certainty was reported as certain; and it printed
    // "0%" for 0.004, a figure the incident schema refuses outright.
    for (const v of [0.9951, 0.996, 0.999, 0.99999]) {
      expect(asPercent(v), `${v} must not read as certainty`).not.toBe("100%");
    }
    for (const v of [0.004, 0.0001, 1e-9]) {
      expect(asPercent(v), `${v} must not read as nothing`).not.toBe("0%");
    }
    // The endpoints belong to the endpoints, and the ordinary case is plain.
    expect(asPercent(1)).toBe("100%");
    expect(asPercent(0)).toBe("0%");
    expect(asPercent(0.6)).toBe("60%");
    expect(asPercent(Number.NaN)).toMatch(/unreadable/);
  });

  it("says the investigation reached no conclusion, rather than stopping mid-sentence", () => {
    // A chain that stopped after the specialists: root_cause_code is null, and
    // the reporter used to write the agent lines, say nothing about the
    // outcome, and return "reported". The last word was a bare positive
    // finding, which reads as the answer.
    const stopped = incidentWith(K8S_REPLY);
    const r = reportIncident(stopped, AT);
    if (r.state !== "reported") throw new Error(r.reason);
    const thread = texts(r.conversation).join(" ");
    expect(thread, "silence at the end of a thread reads as the answer")
      .toContain("reached no conclusion");
    expect(thread).toContain("Nothing above is a verdict");
    expect(thread, "and it must say WHY it did not finish")
      .toContain("never asked");
  });

  it("traces a root cause citation to the agent that reported it", () => {
    /*
     * sourceOf returned "datadog" for anything that is not one of the three
     * slots — always, for the root cause agent. So one fact appeared twice in
     * one thread with two different sources: analysis.evidence said kubernetes
     * and the root cause message said datadog, about the same sentence.
     */
    const withRc = incidentWith(K8S_REPLY, {
      agent: "root_cause", status: "ok",
      findings: [{ fact: "container terminated OOMKilled",
        source_ref: "pods[0].containers[0].last_state.terminated.reason" }],
      hypotheses: [{ code: "CONTAINER_OOM", statement: "s",
        supported_by: ["pods[0].containers[0].last_state.terminated.reason"] }],
      confidence: 0.7,
    });
    const r = reportIncident(withRc, AT);
    if (r.state !== "reported") throw new Error(r.reason);
    const messages = (r.conversation.messages as Array<Record<string, unknown>>);
    const cited = messages.flatMap((m) =>
      (m.cited_evidence as Array<{ source: string }> | undefined) ?? []);
    expect(cited.length, "nothing was cited; this would pass on an empty set").toBeGreaterThan(0);
    expect(cited.map((c) => c.source), "no citation may name a provider that never held the fact")
      .not.toContain("datadog");
    expect(cited.map((c) => c.source)).toContain("kubernetes");
  });
});
