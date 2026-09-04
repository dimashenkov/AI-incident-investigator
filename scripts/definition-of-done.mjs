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
      "refuses no_action that demands approval or claims risk",
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
    n: 6, claim: "No cross-incident data in assembled prompts.", covered: true,
    by: [
      "passes a context that is exactly the slice it was supposed to be",
      "catches foreign content that looks like nothing we know",
      "copies only what was asked for, so an unknown field cannot ride along",
      "builds contexts that survive the provenance check for every scenario",
      "does not let a later mutation of the incident change a checked context",
    ],
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
