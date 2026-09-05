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
    n: 2, claim: "All five scenarios and INSUFFICIENT_EVIDENCE.", covered: false,
    needs: "a model call",
    why: "Codex, chunk 2: the named tests establish that five fixtures exist, assemble, validate and declare expected causes — they never establish that the system PRODUCES those answers, and marking the item covered on that basis was the claim being larger than the evidence",
  },
  {
    n: 3, claim: "Confidence reduction under conflicting evidence.", covered: false,
    needs: "a model call",
    why: "the schema permits a low confidence and requires evidence to state its direction, but whether a model actually lowers the number when findings conflict can only be seen by asking one",
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
    needs: "a provider whose answers can be checked, not only requested",
    why: "the assembler adds nothing beyond the slice, no foreign incident id appears, and every observation is stamped with the collection request we issued and refused otherwise — but a provider can return another tenant's data under a correct request, and nothing downstream can see it, so the claim as written is still larger than the evidence",
    // Owner, 2026-09-05: "the second provider will be only a possibility, a
    // placeholder in the code, we will not test it." So the dependency this
    // item waits on is not coming, and calling it "waiting" would be a promise
    // nobody intends to keep. It moves to what this project can never decide.
    outOfScope: "the owner decided on 2026-09-05 that the second provider stays hypothetical, so no provider answer will ever be checkable against another implementation",
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
    n: 8, claim: "Provider substitutability.", covered: false,
    needs: "a second provider implementation",
    why: "there is one fixture-backed provider, so nothing establishes that another could take its place; substitutability claimed from a single implementation is a claim about a thing that does not exist yet",
    // Owner, 2026-09-05, same decision. An untested placeholder provider would
    // be worse than none: the appearance of substitutability with nothing
    // exercising it is exactly the defect this repository keeps finding.
    outOfScope: "the owner decided on 2026-09-05 that there will be one provider; a second exists only as a shape in the code and is never run",
  },
  {
    n: 9, claim: "Read-only/no-remediation behavior.", covered: true,
    by: [
      "refuses executed: true, so the day something runs an action every check fails loudly",
      "refuses an action that simply omits executed",
    ],
  },
  {
    n: 10, claim: "The deployed workflow — not merely local code — produces the required result.", covered: false,
    needs: "a model call through the deployed workflow",
    why: "drift detection establishes that the deployment IS what this repository generates, which is a different claim from the deployment producing the right answer",
  },
];
