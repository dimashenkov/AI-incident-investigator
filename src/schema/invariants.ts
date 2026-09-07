/**
 * The constraints JSON Schema cannot state, in a file the n8n node can carry.
 *
 * These lived inside src/schema/validate.ts until 2026-09-07, and a subagent
 * measured what that cost. `scripts/build-core.mjs` generates ONLY the ajv
 * validators from schemas/, so the deployed Code node ran the schemas and never
 * these — and `valid` meant two different things in a unit test and in
 * production, which is the exact promise the top of validate.ts makes.
 *
 * Measured through the real generated core, not read:
 *
 *   collection says "collected" while the observation slot is null  -> VALID in n8n
 *   a conversation thread id naming another incident                -> VALID in n8n
 *   a message stamped with a foreign incident id                    -> VALID in n8n
 *   a hypothesis citing a source_ref no finding reports             -> VALID in n8n
 *
 * The first three had no compensating check anywhere; the fourth was partly
 * covered by merge.ts resolving refs against the observation.
 *
 * So the rule is the same one this project applies to merge.ts and slice.ts:
 * anything the deployed node must enforce lives in a file with no imports, and
 * is transpiled into the node from the same source the tests run.
 *
 * NOTHING may be imported here. scripts/workflow-runtime.mjs refuses an import,
 * a require, a re-export and `import.meta` before it will compile this.
 */
export type InvariantSchemaName =
  | "incident" | "agent-result" | "conversation" | "remediation" | "verdict-review"
  | "common" | "observations";

export function invariantErrors(name: InvariantSchemaName, data: unknown): string[] {
  if (typeof data !== "object" || data === null) return [];
  const errs: string[] = [];
  const obj = data as Record<string, unknown>;

  const checkConversation = (c: Record<string, unknown>, where: string): void => {
    const incidentId = c["incident_id"];
    if (typeof incidentId !== "string") return;

    const threadId = c["thread_id"];
    if (typeof threadId === "string" && threadId !== `thread-${incidentId}`) {
      errs.push(`${where}/thread_id ${threadId} is not derived from incident ${incidentId}`);
    }

    const messages = c["messages"];
    if (Array.isArray(messages)) {
      messages.forEach((m, i) => {
        if (typeof m !== "object" || m === null) return;
        const mid = (m as Record<string, unknown>)["incident_id"];
        if (typeof mid === "string" && mid !== incidentId) {
          errs.push(`${where}/messages/${i}/incident_id ${mid} belongs to another incident than ${incidentId}`);
        }
      });
    }
  };

  if (name === "conversation") checkConversation(obj, "(root)");

  if (name === "incident") {
    const conv = obj["conversation"];
    if (typeof conv === "object" && conv !== null) {
      const c = conv as Record<string, unknown>;
      checkConversation(c, "/conversation");
      const incidentId = obj["incident_id"];
      if (typeof incidentId === "string" && typeof c["incident_id"] === "string" && c["incident_id"] !== incidentId) {
        errs.push(`/conversation/incident_id ${String(c["incident_id"])} does not match the incident it is attached to (${incidentId})`);
      }
    }

    /*
     * An incident embeds whole documents, and each one must mean the same thing
     * inside as it does alone.
     *
     * A subagent review on 2026-09-04 found that only `conversation` was being
     * checked. An agent result whose hypothesis cited a finding nobody reported
     * was refused on its own and accepted the moment it was placed in
     * `analysis.agents[]` — precisely the "passes here, fails there" split this
     * file opens by saying it exists to prevent.
     */
    /*
     * The observation and the record of collecting it must say the same thing.
     *
     * Codex, 2026-09-05: null in an observation slot meant both "the provider
     * looked and there was nothing" and "nobody could look", and the failure
     * lived outside the document, so serialising it lost even the fact that a
     * slot had failed. The `collection` record carries the three answers; this
     * is what keeps it from disagreeing with the observation beside it, because
     * a record nothing cross-checks would drift into decoration.
     */
    const collection = obj["collection"];
    const observations = obj["observations"];
    if (typeof collection === "object" && collection !== null
        && typeof observations === "object" && observations !== null) {
      const c = collection as Record<string, unknown>;
      const o = observations as Record<string, unknown>;
      for (const slot of ["kubernetes", "logs", "metrics"]) {
        const entry = c[slot];
        if (typeof entry !== "object" || entry === null) continue;
        const state = (entry as Record<string, unknown>)["state"];
        const present = o[slot] !== null && o[slot] !== undefined;
        if (present && state !== "collected") {
          errs.push(`/collection/${slot}/state says ${String(state)} while /observations/${slot} carries an observation`);
        }
        if (!present && state === "collected") {
          errs.push(`/collection/${slot}/state says collected while /observations/${slot} is null`);
        }
      }
    }

    const agents = (obj["analysis"] as Record<string, unknown> | undefined)?.["agents"];
    if (Array.isArray(agents)) {
      agents.forEach((a, i) => {
        for (const e of invariantErrors("agent-result", a)) {
          errs.push(`/analysis/agents/${i}${e.startsWith("/") ? e : ` ${e}`}`);
        }
      });
    }
  }

  if (name === "agent-result") {
    const findings = obj["findings"];
    const refs = new Set(
      Array.isArray(findings)
        ? findings
            .map((f) => (typeof f === "object" && f !== null ? (f as Record<string, unknown>)["source_ref"] : undefined))
            .filter((r): r is string => typeof r === "string")
        : [],
    );
    // Both directions, not one. Codex, chunk 0 round 11: only supported_by was
    // traced back to a finding, so a hypothesis could be weakened by
    // contradictions that no finding reports. A rule about evidence references
    // holds for every list of evidence references, not for the flattering one.
    const EVIDENCE_LISTS = ["supported_by", "contradicted_by"] as const;
    const hypotheses = obj["hypotheses"];
    if (Array.isArray(hypotheses)) {
      hypotheses.forEach((h, i) => {
        if (typeof h !== "object" || h === null) return;
        for (const field of EVIDENCE_LISTS) {
          const by = (h as Record<string, unknown>)[field];
          if (!Array.isArray(by)) continue;
          for (const ref of by) {
            if (typeof ref === "string" && !refs.has(ref)) {
              errs.push(`/hypotheses/${i}/${field} cites ${ref}, which no finding in this result reports`);
            }
          }
        }
      });
    }
  }

  return errs;
}
