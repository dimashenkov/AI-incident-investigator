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
        /*
         * And not the SAME reference in both lists.
         *
         * Each rule above reads its own list, and nothing looked at the
         * intersection — so one fact could support a hypothesis and contradict
         * it at once. The first version of this comment said merge.ts then
         * counted the fact twice in opposite directions; it does not, and never
         * did — nothing computes a confidence from either list. What the
         * overlap actually produces is a document asserting that one fact both
         * supports and contradicts one conclusion, which is not two pieces of
         * evidence and is not a claim anything can act on. Found by a
         * subagent on 2026-09-07, measured through the real validator.
         */
        const forRefs = (h as Record<string, unknown>)["supported_by"];
        const againstRefs = (h as Record<string, unknown>)["contradicted_by"];
        if (Array.isArray(forRefs) && Array.isArray(againstRefs)) {
          const both = forRefs.filter((r) => typeof r === "string" && againstRefs.includes(r));
          for (const ref of both) {
            errs.push(`/hypotheses/${i} cites ${String(ref)} as both supporting and contradicting it, `
              + "which is not two pieces of evidence");
          }
        }
      });
    }
  }

  /*
   * Every slot of one incident must have been gathered under ONE request.
   *
   * common.schema.json says exactly that about provenance — "An observation
   * asked for elsewhere is not this incident's" — and nothing checked it here.
   * The only check was checkProvenance in assemble.ts, against the request
   * being issued, at collection time. A subagent built an incident on
   * 2026-09-07 whose three slots carried three different collection_ids and two
   * foreign incident ids, and validate() called it valid; merge.ts re-validates
   * the whole incident after every merge and nothing there asked again.
   */
  if (name === "incident") {
    const observations = obj["observations"];
    if (typeof observations === "object" && observations !== null) {
      const seen = new Map<string, string[]>();
      for (const [slot, ob] of Object.entries(observations as Record<string, unknown>)) {
        if (typeof ob !== "object" || ob === null) continue;
        const prov = (ob as Record<string, unknown>)["provenance"];
        if (typeof prov !== "object" || prov === null) continue;
        const p = prov as Record<string, unknown>;
        const requested = p["requested_for"];
        const incidentId = obj["incident_id"];
        if (typeof requested === "string" && typeof incidentId === "string" && requested !== incidentId) {
          errs.push(`/observations/${slot}/provenance/requested_for is ${requested}, `
            + `but this incident is ${incidentId}`);
        }
        for (const field of ["collection_id", "cluster", "namespace"]) {
          const v = p[field];
          if (typeof v !== "string") continue;
          const key = `${field}:${v}`;
          const already = seen.get(field);
          if (already === undefined) seen.set(field, [slot, v]);
          else if (already[1] !== v) {
            errs.push(`/observations/${slot}/provenance/${field} is ${v}, `
              + `but ${already[0]} was gathered with ${already[1]}`);
          }
          void key;
        }
      }
      // And the incident's own cluster and namespace are what was asked for.
      for (const [slot, ob] of Object.entries(observations as Record<string, unknown>)) {
        if (typeof ob !== "object" || ob === null) continue;
        const prov = (ob as Record<string, unknown>)["provenance"];
        if (typeof prov !== "object" || prov === null) continue;
        for (const field of ["cluster", "namespace"] as const) {
          const got = (prov as Record<string, unknown>)[field];
          const want = obj[field];
          if (typeof got === "string" && typeof want === "string" && got !== want) {
            errs.push(`/observations/${slot}/provenance/${field} is ${got}, `
              + `but this incident is about ${want}`);
          }
        }
      }
    }
  }

  /*
   * A review that calls the verdict WRONG must name a DIFFERENT cause.
   *
   * `actual_code` equal to `proposed_code` says the system was wrong and the
   * true cause is exactly what it said. That is not a coherent review, and it
   * entered summarise's confusion matrix as a correct-looking pair — in the
   * file whose header calls itself the only signal that can say whether the
   * system was right.
   *
   * The test named for this refusal built only the empty-string half; a
   * subagent measured the other on 2026-09-07. Draft 2020-12 cannot compare two
   * fields, which is why it is here and not in the schema.
   */
  if (name === "verdict-review" && obj["verdict_was"] === "wrong") {
    const actual = obj["actual_code"];
    const proposed = obj["proposed_code"];
    if (typeof actual === "string" && typeof proposed === "string" && actual === proposed) {
      errs.push(`/actual_code is ${actual}, the same as /proposed_code, so this review calls the verdict `
        + "wrong and names the cause it already gave");
    }
  }

  return errs;
}
