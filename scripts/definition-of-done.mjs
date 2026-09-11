/**
 * The ten items Codex listed on the plan as uncovered by the described tests.
 *
 * Plain .mjs, in one place, because both the test suite and the acceptance gate
 * read it. Counting them by grepping the test file gave twelve on its first
 * run — the pattern matched the tests that talk about the list as well as the
 * list itself. A list that cannot be counted reliably is a list nobody can
 * report on.
 *
 * `by` names tests that must exist. `needs` names what an uncovered item waits
 * for, and it must be something that does not exist yet rather than something
 * nobody got round to.
 */
export const DEFINITION_OF_DONE = [
  {
    n: 1, claim: "Every intermediate object validates against the canonical schema.", covered: true,
    by: [
      "assembles each one and validates it",
      "records a valid result",
      "keeps the incident valid after attaching",
      "says the result was invalid, not that attaching broke the incident",
    ],
  },
  {
    n: 2, claim: "Every scenario and INSUFFICIENT_EVIDENCE.", covered: true,
    by: ["every registered scenario has been measured against a model"],
    why: "Codex, chunk 2: the named tests establish that the fixtures exist, assemble, validate and declare expected causes — they never establish that the system PRODUCES those answers, and marking the item covered on that basis was the claim being larger than the evidence. Widened from FIVE to EVERY on 2026-09-07, when application-startup-failure and deployment-regression were added: five of the seven have been run against a model and two have not, so wording that says five would let the item read as nearly done while a third of it has never been asked",
  },
  {
    n: 3, claim: "Confidence reduction under conflicting evidence.", covered: false,
    needs: "a model call",
    why: "the schema permits a low confidence and requires evidence to state its direction, but whether a model actually lowers the number when findings conflict can only be seen by asking one. Codex and Grok, 2026-09-06, independently: NONE of the five scenarios poses conflicting evidence, so no run over them can close this — the only live movement was upward, from 0.6 to 0.8, after the prompt stopped pointing only downwards. Closing it needs a scenario built to conflict, and a comparable one that does not",
  },
  {
    n: 4, claim: "risk and requires_approval.", covered: true,
    by: [
      "refuses a state-changing action that claims it needs no approval",
      "refuses no_action that claims risk",
      "refuses no_action that demands approval",
      "accepts every state-changing action once it names a target and asks for approval",
      "leaves no action type outside a category, and none in both",
    ],
  },
  {
    n: 5, claim: "Exact one-to-one thread/incident invariants, including unknown and duplicate thread IDs.", covered: true,
    by: [
      "refuses a thread id that is not derived from the incident claiming it",
      "refuses a second thread for an incident that already has one",
      "still refuses a collision if the derivation ever stops being injective",
      "refuses the reverse collision too, under a derivation that allows it",
      "does not resolve a thread that was never registered, even though the id is derivable",
      "is idempotent: opening the same thread twice is not a duplicate",
    ],
  },
    {
    // Codex, 2026-09-05: "a direct coverage contradiction — this marks it
    // covered while its cited evidence includes a test proving in-slice
    // contamination passes and reaches the agent. That item must remain
    // uncovered until trusted source binding is implemented and enforced."
    //
    // He is right, and the contradiction was visible in the list itself: an
    // item cannot cite, as proof of coverage, a test that demonstrates the
    // hole. The checks that exist are real and are now enforced at the
    // boundary; they do not add up to this claim.
    // Codex, 2026-09-05: "item 6 is directly overclaimed — the evidence
    // supports 'rejects inconsistent provenance labels', not 'no cross-incident
    // data in assembled prompts'." Provenance establishes that the data arrived
    // under a request we made; it cannot establish that the provider answered
    // honestly. Both halves are needed for the claim as written.
    n: 6, claim: "No cross-incident data in assembled prompts.", covered: false,
    needs: "a way to tell whose data an unstamped answer is",
    /*
     * Grok, 2026-09-11, argued against closing this and was right (88%). Two
     * approaches were weighed and both buy a green test on a false signal:
     *   A. a namespace field on every log line / metric series — UNREALISTIC.
     *      `kubectl logs -n production` returns time, level, text; the namespace
     *      is on the QUERY, not the line. Loki is `{namespace="production"}` the
     *      same way. A per-line owner is invented data, and invented fixtures do
     *      not transfer to a real cluster — the defect this project refuses.
     *   B. tie each log/metric container to a namespace-checked pod — has a
     *      hole exactly where isolation matters: two tenants both name a
     *      container `payment-api`, so a foreign line passes on the name; and it
     *      refuses a legitimate logs-only incident when no pod anchors it.
     * The honest reading: ownership of logs and metrics IS the provenance stamp
     * (the query), not the content, so it cannot be content-checked the way
     * kubernetes pods[].namespace can. This stays a BOUNDARY, like
     * events[].involved_object — not pending work, and not coverable without
     * faking a field. The claim "No cross-incident data" is therefore true for
     * kubernetes content and is the stamp's word for logs and metrics, and the
     * item is left open rather than marked covered on a fake check.
     */
    /*
     * Marked covered on 2026-09-05 and reversed within the hour by Codex,
     * whose objection is the reason the claim is written out in full here:
     * "the named test expects an allegedly foreign answer to be ACCEPTED. No
     * cross-incident data remains unproved and demonstrably unenforced."
     *
     * He is right, and the test he objected to has since been made honest —
     * it now reads another customer's workload and shows it getting through.
     * That is a demonstration of the limitation, not coverage of the claim.
     * A test that proves the gap cannot also close it.
     */
    why: "an answer that carries no stamp is accepted and stamped as ours, because there is nothing to disagree with; a second provider proves the gap is real rather than theoretical, and proving a gap is the opposite of covering the item",
  },



  {
    n: 7, claim: "The created Slack thread is durably linked, not merely returned.", covered: true,
    by: [
      "opens a thread and links it durably, not merely returns it",
      "keeps two incidents apart",
      "refuses a message stamped with another incident",
    ],
  },
  {
    n: 8, claim: "Provider substitutability: observations are collected through the contract, and a substitute is held to it.",
    covered: true,
    by: [
      "refuses a provider that returns an observation with no provenance",
      "refuses a provider that answers about a different slot than the one asked for",
      "builds the same incident through the contract as it did through the implementation",
    ],
    /*
     * Closed on 2026-09-07, and worded narrowly on purpose.
     *
     * It says OBSERVATIONS. The alert and the scenario registry are still read
     * straight off the disk inside assembleIncident, so a claim that the
     * assembler collects EVERYTHING through the contract would be larger than
     * the code. This item has been reversed twice already for claiming more
     * than its evidence; a third time would be my own doing.
     *
     * What actually changed: checkProvenance's disagreement refusals could not
     * fire from assembleIncident at all, because every collected observation
     * arriving there had just been stamped from that same request. Injection is
     * the only thing that makes them reachable, and the tests named above reach
     * them. The deployed workflow is unaffected — incidents are assembled at
     * generate time and inlined, and this file cannot be transpiled into a Code
     * node in any case.
     */
    /*
     * Also reversed on 2026-09-05, and for the sharper reason: "production,
     * assembly and workflow code never consume Provider. Enumeration plus
     * compatible TypeScript shapes is smaller than provider substitutability."
     *
     * Three implementations satisfy the contract and the tests exercise them,
     * which is real and is why the contract exists. But nothing in the
     * prototype's path holds a Provider, so nothing establishes that one could
     * take another's place where it matters. Closing this is a change to
     * assembleIncident, and it is not made while the priority is the prototype
     * running end to end.
     */
    why: "three implementations satisfy the contract and are exercised, but assembleIncident still calls the fixture reader directly, so no alternative provider has ever taken its place anywhere the prototype actually runs",
  },
  {
    n: 9, claim: "Read-only/no-remediation behavior.", covered: true,
    by: [
      "refuses executed: true, so the day something runs an action every check fails loudly",
      "refuses an action that simply omits executed",
    ],
  },
  {
    n: 10, claim: "The deployed workflow — not merely local code — produces the required result.", covered: true,
    by: ["the deployed workflow, not local code, produced a scored result"],
    why: "drift detection establishes that the deployment IS what this repository generates, which is a different claim from the deployment producing the right answer. Codex, 2026-09-06: 'required result' was undefined, so no run could close the item as written. It is defined now — a conclusion matching the scenario's expected.json, which scripts/score-run.mjs compares — and what remains is a captured deployed execution that satisfies it",
  },
];
