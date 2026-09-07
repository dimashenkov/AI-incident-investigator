/**
 * The half of assembly that does not touch the disk.
 *
 * Split out on 2026-09-05 so the same code runs in two places: here, and inside
 * the n8n Code node, which has no filesystem and no ajv. The generator
 * transpiles THIS file into the deployed workflow, so the rule that decides
 * whether a result may be attached is one carrier rather than two that agree
 * until they do not.
 *
 * The validator arrives as an argument. Locally it is the ajv-backed one from
 * schema/validate.ts; in the node it is the standalone core compiled from the
 * same schemas. Injecting it is what makes the file portable — an import of
 * ajv here would end the portability in one line.
 */
import type { Observation, Slot } from "../providers/fixtures.js";

/** Everything a caller must supply. Three states, never two. */
export type Validate = (name: string, data: unknown) =>
  | { state: "valid" }
  | { state: "invalid"; errors: string[] }
  | { state: "unchecked"; reason: string };

/** The three observation slots, repeated here so this file imports no runtime. */
export const MERGE_SLOTS: readonly Slot[] = ["kubernetes", "logs", "metrics"];

/**
 * Record an agent's result on the incident.
 *
 * Three reviewers on 2026-09-05 found four ways this went wrong, and all four
 * were the same shape: a path that ends somewhere other than a stated outcome.
 *
 *  - it read `incident.analysis` behind a type assertion and indexed it, so a
 *    missing analysis threw instead of being refused. A crash is not a refusal:
 *    no reason, no errors, nothing a human can read.
 *  - it rejected `invalid` and `unchecked` by name and fell through otherwise,
 *    so any other state was treated as recorded success — success that was
 *    never established.
 *  - when the post-attach check came back `unchecked`, it still said the reply
 *    made the incident invalid, blaming the model for a validator that could
 *    not run or an incident that was already broken.
 *  - it accepted any schema-valid result, including one belonging to another
 *    incident, and never checked that a finding's `source_ref` resolves in the
 *    observation that agent was actually given.
 */
export function recordAgentResult(
  validate: Validate,
  incident: Record<string, unknown>,
  result: unknown,
  /*
   * WHO WAS ASKED, when the caller knows — and the deployed chain always does.
   *
   * Until 2026-09-07 the identity came only from the model's own reply, and the
   * node that had just asked the logs agent did not pass what it asked. A
   * subagent ran it end to end: a logs answer labelled `"agent": "kubernetes"`,
   * citing a path that resolves in the kubernetes slot, was recorded, and the
   * chain concluded CONTAINER_OOM at 85% with TWO kubernetes entries and no
   * logs analysis at all. Conclude only counts root_cause results, so nothing
   * downstream noticed. A failure recorded as a successful step.
   *
   * Optional, because the tests that build an incident by hand legitimately do
   * not know — but a caller that knows and stays silent is the hole.
   */
  expected?: string,
): { state: "recorded"; incident: Record<string, unknown>; normalised: number }
  | { state: "refused"; reason: string; errors?: string[] } {
  if (expected !== undefined) {
    const said = typeof result === "object" && result !== null
      ? (result as Record<string, unknown>)["agent"] : undefined;
    if (said !== expected) {
      return { state: "refused",
        reason: `${expected} was asked and the answer says it is from ${JSON.stringify(said)}` };
    }
  }

  // The incident is checked first, so a pre-existing problem is not reported as
  // something the reply did.
  const before = validate("incident", incident);
  if (before.state === "invalid") {
    return { state: "refused", reason: "the incident was already invalid before the result arrived", errors: before.errors };
  }
  if (before.state === "unchecked") {
    return { state: "refused", reason: `could not validate the incident: ${before.reason}` };
  }

  const r = validate("agent-result", result);
  if (r.state !== "valid") {
    return {
      state: "refused",
      reason: r.state === "invalid" ? "the agent result does not validate" : `could not validate the agent result: ${r.reason}`,
      errors: r.state === "invalid" ? r.errors : [r.reason],
    };
  }

  const checked: { observation?: unknown } = {};
  const bound = resultBelongsHere(incident, result as Record<string, unknown>, checked);
  if (bound !== null) return { state: "refused", reason: bound };
  const checkedAgainst = checked.observation;

  const analysis = incident["analysis"];
  if (typeof analysis !== "object" || analysis === null) {
    return { state: "refused", reason: "the incident has no analysis to record into" };
  }
  const existing = (analysis as Record<string, unknown>)["agents"];
  if (existing !== undefined && !Array.isArray(existing)) {
    // Replacing it would silently discard whatever turns were already there.
    return { state: "refused", reason: "analysis.agents is present but is not a list; refusing rather than replacing it" };
  }

  // What goes into the incident is the result with its citations spelled the way
  // they resolve. The check above accepted them; storing the other spelling
  // would leave a human following a path that leads nowhere.
  /*
   * The same observation the citation check used, not a second reading of it.
   *
   * Codex, 2026-09-06: resultBelongsHere resolved against one read of
   * incident.observations[agent] and this read it again, so a getter or a
   * mutation between the two could make the rewrite disagree with the check
   * that passed. One lookup, used twice.
   */
  /*
   * Only a result checked against an observation is rewritten against one.
   *
   * The root cause agent reads no slot: resultBelongsHere hands back nothing
   * for it, because there is nothing its citations were resolved against. They
   * are copied from the other agents' findings and were already normalised
   * when those were recorded. Rewriting here would refuse every verdict.
   */
  let stored = result as Record<string, unknown>;
  let normalised = 0;
  if (checkedAgainst !== undefined) {
    const rewrite = withResolvedRefs(checkedAgainst, stored);
    if (rewrite.state === "refused") return { state: "refused", reason: rewrite.reason };
    stored = rewrite.result;
    normalised = rewrite.changed;
  }

  const next = {
    ...incident,
    analysis: { ...(analysis as Record<string, unknown>), agents: [...((existing as unknown[]) ?? []), stored] },
  };

  const whole = validate("incident", next);
  if (whole.state === "invalid") {
    return { state: "refused", reason: "attaching the result made the incident invalid", errors: whole.errors };
  }
  if (whole.state === "unchecked") {
    return { state: "refused", reason: `could not validate the incident after attaching: ${whole.reason}` };
  }
  /*
   * How many citations had to be rewritten, carried out with the result.
   *
   * Grok, 2026-09-06: a refused source_ref was the only evidence that a model
   * had ignored an instruction given twice in its own words. Normalising it
   * away makes obeyed and ignored produce the same stored finding — "two
   * refused scenarios look clean, and later prompt changes cannot be measured
   * against this failure."
   *
   * He is right, and the answer is not to go back to refusing: it is to keep
   * counting. A run where this is zero and a run where it is four are different
   * runs, and the number says which.
   */
  return { state: "recorded", incident: next, normalised };
}

/**
 * Does this result belong to this incident, and to an agent that could have run?
 *
 * Returns null when it does, and the reason when it does not.
 *
 * Codex, 2026-09-05: "accepted specialist results contain neither incident_id
 * nor a binding to the requested agent/scenario… consequently accepts any
 * schema-valid result — including a reply from another call — and does not
 * verify that source_ref resolves in that agent's observation."
 *
 * Verified before accepting: a reply citing `nowhere_at_all` was recorded.
 */
export function resultBelongsHere(
  incident: Record<string, unknown>,
  result: Record<string, unknown>,
  /**
   * Where the observation this result was checked against is handed back.
   *
   * An out-parameter rather than a changed return type, so every existing
   * caller keeps working — and rather than a module-level variable, which two
   * concurrent calls would share.
   */
  out: { observation?: unknown } = {},
): string | null {
  let checkedAgainst: unknown;
  const agent = result["agent"];
  if (typeof agent !== "string") return "the result names no agent";

  /*
   * The root cause agent reads the other agents' results rather than an
   * observation — which is not the same as having nothing to check against.
   *
   * Until 2026-09-07 this returned early and its citations were checked by
   * NOTHING. A subagent reading for one defect class showed what that buys: a
   * root cause result citing `series[0].points[3].value` on an incident whose
   * metrics slot is null was recorded, concluded, promoted into
   * `analysis.evidence` — and then scored CORRECT, because must_cite pools
   * source_refs from every agent including this one. The agent that invents a
   * path satisfies the requirement to cite it.
   *
   * What it may cite is exactly what the specialists already reported. That is
   * what "reads the other agents' results" means, and it is checkable here.
   */
  if (agent === "root_cause") {
    const agents = (incident["analysis"] as Record<string, unknown> | undefined)?.["agents"];
    if (!Array.isArray(agents) || agents.length === 0) {
      return "a root cause result cannot be recorded before any agent has reported";
    }
    const already = new Set<string>();
    for (const a of agents) {
      const fs = typeof a === "object" && a !== null ? (a as Record<string, unknown>)["findings"] : undefined;
      if (!Array.isArray(fs)) continue;
      for (const f of fs) {
        const r = typeof f === "object" && f !== null ? (f as Record<string, unknown>)["source_ref"] : undefined;
        if (typeof r === "string") already.add(r);
      }
    }
    /*
     * No guard on `already` being empty. A verdict that cites NOTHING is a real
     * answer — it is what INSUFFICIENT_EVIDENCE looks like when the specialists
     * found nothing to cite — and refusing it would turn "there was nothing to
     * point at" into a broken chain. The rule is per citation: whatever it does
     * cite must be something an agent reported.
     */
    const findings = result["findings"];
    if (!Array.isArray(findings)) return "the result carries no findings list";
    for (const f of findings) {
      const ref = typeof f === "object" && f !== null ? (f as Record<string, unknown>)["source_ref"] : undefined;
      if (typeof ref !== "string") return "a finding carries no source_ref";
      if (!already.has(ref)) {
        return `a root cause finding cites ${ref}, which no agent reported`;
      }
    }
    return null;
  }

  const observations = incident["observations"];
  const observation = typeof observations === "object" && observations !== null
    ? (observations as Record<string, unknown>)[agent]
    : undefined;
  if (observation === undefined) return `the incident has no ${agent} observation slot`;
  if (observation === null) return `${agent} reported on a slot where nothing was collected`;
  checkedAgainst = observation;
  out.observation = checkedAgainst;

  const findings = result["findings"];
  if (!Array.isArray(findings)) return "the result carries no findings list";
  for (const f of findings) {
    const ref = typeof f === "object" && f !== null ? (f as Record<string, unknown>)["source_ref"] : undefined;
    if (typeof ref !== "string") return "a finding carries no source_ref";
    if (normaliseRef(observation, ref) === null) {
      return `a finding cites ${ref}, which resolves to nothing in the ${agent} observation`;
    }
  }
  return null;
}

/**
 * Rewrite every citation to the spelling that resolves, in place of the one the
 * model wrote.
 *
 * Grok, 2026-09-06: accepting a spelling in the checker while storing another
 * leaves check and audit trail disagreeing — the machine approves a citation a
 * human then cannot follow. So the incident carries the working spelling, and
 * the two are the same thing again.
 *
 * `supported_by` travels with it: a hypothesis must cite a source_ref its own
 * findings report, and rewriting one without the other would break exactly that
 * rule while fixing a different one.
 */
export function withResolvedRefs(
  observation: unknown, result: Record<string, unknown>,
): { state: "rewritten"; result: Record<string, unknown>; changed: number } | { state: "refused"; reason: string } {
  const rewritten = new Map<string, string>();
  let changed = 0;

  const findings = Array.isArray(result["findings"]) ? (result["findings"] as unknown[]) : [];
  const nextFindings: unknown[] = [];
  for (const f of findings) {
    if (typeof f !== "object" || f === null) { nextFindings.push(f); continue; }
    const one = f as Record<string, unknown>;
    const ref = one["source_ref"];
    if (typeof ref !== "string") { nextFindings.push(f); continue; }
    const good = normaliseRef(observation, ref);
    if (good === null) {
      /*
       * Codex, 2026-09-06: this used to fail open — a citation that could not be
       * normalised was left as it was, and the incident then carried a path
       * nobody can follow. "Could not rewrite" is not "nothing to rewrite".
       *
       * It cannot normally happen, because resultBelongsHere already refused
       * such a result. It happens when this is handed the wrong observation,
       * and that is exactly when silence is worst.
       */
      return { state: "refused",
        reason: `a finding cites ${ref}, which resolves to nothing in the observation this result was recorded against` };
    }
    if (good === ref) { nextFindings.push(f); continue; }
    rewritten.set(ref, good);
    // Counted per FINDING, not per distinct spelling. Codex, 2026-09-06: two
    // findings carrying the same wrapper-prefixed citation are both rewritten
    // and `rewritten.size` reports one — the metric is how many citations the
    // model wrote wrong, and it must not shrink because it repeated itself.
    changed += 1;
    nextFindings.push({ ...one, source_ref: good });
  }

  if (changed === 0) return { state: "rewritten", result, changed: 0 };

  // Both lists travel with the rewrite. Codex, same review: the comment
  // promised both and the code moved one, so a normalised finding named in
  // `contradicted_by` made the incident invalid after attaching.
  const carry = (list: unknown) =>
    Array.isArray(list) ? list.map((r) => (typeof r === "string" ? rewritten.get(r) ?? r : r)) : list;

  const hypotheses = Array.isArray(result["hypotheses"]) ? (result["hypotheses"] as unknown[]) : [];
  const nextHypotheses = hypotheses.map((h) => {
    if (typeof h !== "object" || h === null) return h;
    const one = h as Record<string, unknown>;
    const next: Record<string, unknown> = { ...one };
    if (one["supported_by"] !== undefined) next["supported_by"] = carry(one["supported_by"]);
    if (one["contradicted_by"] !== undefined) next["contradicted_by"] = carry(one["contradicted_by"]);
    return next;
  });

  return { state: "rewritten", result: { ...result, findings: nextFindings, hypotheses: nextHypotheses }, changed };
}

/** Follow a path like `pods[0].containers[0].limits.memory` into an observation. */
export function resolveRef(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * The spelling of a citation that actually resolves, or null.
 *
 * Measured on the fourth live run, 2026-09-06: the model wrote
 * `observation.events[0].message`, prefixing the path with the wrapper its
 * payload arrives in. Every specialist prompt warns against that twice, and it
 * happened anyway, because the object the model is looking at is literally
 * called `observation`.
 *
 * The first fix stripped the prefix inside the resolver, and both reviewers
 * refused it for the same reason. Grok: "the stored source_ref remains a path a
 * human cannot follow — check and audit trail diverge." Codex: an empty
 * remainder must be rejected, and a prohibition the checker has retired is dead
 * text that has to go.
 *
 * So this returns the spelling that WORKS, and the caller writes that spelling
 * into the incident. Three things follow, and each was asked for:
 *
 *  - the literal path is tried FIRST, so an observation that genuinely holds a
 *    field called `observation` is never shadowed by the alias;
 *  - `observation.` alone resolves to the whole observation and is refused: a
 *    citation naming everything names nothing;
 *  - what is stored is what resolved, so following a citation by hand lands on
 *    the value the machine checked.
 */
export function normaliseRef(observation: unknown, ref: string): string | null {
  if (typeof ref !== "string" || ref.length === 0) return null;
  if (resolveRef(observation, ref) !== undefined) return ref;

  const prefix = "observation.";
  if (!ref.startsWith(prefix)) return null;
  const rest = ref.slice(prefix.length);
  if (rest.length === 0) return null;
  return resolveRef(observation, rest) !== undefined ? rest : null;
}

/** Which observation slots actually hold data. Used to decide which agents can run at all. */
export function runnableAgents(incident: Record<string, unknown>): Slot[] {
  const observations = incident["observations"];
  if (typeof observations !== "object" || observations === null) return [];
  const o = observations as Record<string, unknown>;
  return MERGE_SLOTS.filter((s) => o[s] !== null && o[s] !== undefined);
}


/**
 * Promote the root cause agent's hypothesis into the incident's verdict.
 *
 * Codex, 2026-09-05: "nothing updates incident status or its root-cause
 * fields." The root cause agent's answer could be recorded as one more agent
 * result and then sat there — the incident stayed `investigating` with a null
 * cause, and the one answer the whole system exists to produce had no way to
 * become the incident's own.
 *
 * The promotion is deterministic on purpose. The model proposes; this decides
 * what the incident says, using rules a human can check without rerunning
 * anything:
 *
 *  - no hypothesis at all means the evidence did not support one, which is
 *    recorded as insufficient_evidence rather than left as still-investigating;
 *  - a hypothesis becomes the cause, and its supporting citations become the
 *    incident's evidence;
 *  - more than one hypothesis is refused, because choosing between them is a
 *    judgement nobody made.
 */
export function concludeIncident(
  validate: Validate,
  incident: Record<string, unknown>,
): { state: "concluded"; incident: Record<string, unknown> } | { state: "refused"; reason: string; errors?: string[] } {
  const analysis = incident["analysis"];
  if (typeof analysis !== "object" || analysis === null) return { state: "refused", reason: "the incident has no analysis" };
  const agents = (analysis as Record<string, unknown>)["agents"];
  if (!Array.isArray(agents)) return { state: "refused", reason: "the incident carries no agent results" };

  const verdicts = agents.filter((a) => typeof a === "object" && a !== null && (a as Record<string, unknown>)["agent"] === "root_cause");
  if (verdicts.length === 0) return { state: "refused", reason: "the root cause agent has not reported" };
  if (verdicts.length > 1) return { state: "refused", reason: `${verdicts.length} root cause results; which one is the verdict is nobody's decision to guess` };

  const verdict = verdicts[0] as Record<string, unknown>;
  const hypotheses = verdict["hypotheses"];
  if (!Array.isArray(hypotheses)) return { state: "refused", reason: "the root cause result carries no hypotheses list" };
  if (hypotheses.length > 1) {
    return { state: "refused", reason: `the root cause agent proposed ${hypotheses.length} causes; picking one is a judgement it did not make` };
  }

  const findings = Array.isArray(verdict["findings"]) ? (verdict["findings"] as Array<Record<string, unknown>>) : [];
  const confidence = typeof verdict["confidence"] === "number" ? verdict["confidence"] : 0;

  if (hypotheses.length === 0) {
    // `evidence` stays empty on purpose, and the facts are not lost by it.
    //
    // Every entry must state whether it supports or contradicts the conclusion,
    // and there is no conclusion here — calling a fact "against" a cause nobody
    // named would be an invented stance. The findings remain where they were
    // reported, in analysis.agents, which is the record of what was actually
    // seen; `evidence` is the record of what a diagnosis rests on, and this
    // incident has no diagnosis to rest anything on.
    return finish(validate, {
      ...incident,
      status: "insufficient_evidence",
      analysis: { ...(analysis as Record<string, unknown>), root_cause_code: "INSUFFICIENT_EVIDENCE",
        root_cause: "The evidence collected does not support naming a cause.",
        confidence, evidence: [] },
    });
  }

  const h = hypotheses[0] as Record<string, unknown>;
  const supported = Array.isArray(h["supported_by"]) ? (h["supported_by"] as string[]) : [];
  const evidence = findings
    .filter((f) => supported.includes(String(f["source_ref"])))
    .map((f) => ({ ...asEvidence(f), supports: "for" as const }));

  if (evidence.length === 0) {
    // The schema demands it, and so does the point: a diagnosis whose cited
    // support is not among the findings rests on nothing recorded.
    return { state: "refused", reason: "the hypothesis cites no finding the root cause agent reported" };
  }

  const against = findings
    .filter((f) => !supported.includes(String(f["source_ref"])))
    .map((f) => ({ ...asEvidence(f), supports: "against" as const }));

  return finish(validate, {
    ...incident,
    status: "diagnosed",
    analysis: { ...(analysis as Record<string, unknown>), root_cause_code: h["code"],
      root_cause: h["statement"], confidence, evidence: [...evidence, ...against] },
  });
}

function asEvidence(finding: Record<string, unknown>): { source: string; fact: string } {
  // The evidence source names where the fact came from. A root cause finding
  // cites another agent, so the source is that agent's own slot when the
  // citation says so, and `datadog` otherwise — never invented.
  const ref = String(finding["source_ref"] ?? "");
  const source = ref.startsWith("pods") || ref.startsWith("events") || ref.startsWith("deployment")
    ? "kubernetes"
    : ref.startsWith("lines") || ref.startsWith("truncated") || ref.startsWith("window")
      ? "logs"
      : ref.startsWith("series")
        ? "metrics"
        : "datadog";
  return { source, fact: String(finding["fact"] ?? "") };
}

function finish(validate: Validate, next: Record<string, unknown>): { state: "concluded"; incident: Record<string, unknown> } | { state: "refused"; reason: string; errors?: string[] } {
  const r = validate("incident", next);
  if (r.state === "valid") return { state: "concluded", incident: next };
  return {
    state: "refused",
    reason: r.state === "invalid" ? "the concluded incident does not validate" : `could not validate the conclusion: ${r.reason}`,
    errors: r.state === "invalid" ? r.errors : [r.reason],
  };
}

