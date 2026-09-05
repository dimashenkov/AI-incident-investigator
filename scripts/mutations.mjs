/**
 * Known defects, each with the test that must notice it.
 *
 * Codex, chunk 0 round 3: "that each fix carries a test which fails without the
 * fix" was sitting in the list of things the gate cannot decide, and that was
 * dishonest — mutation testing decides it mechanically. A claim parked where it
 * can never fail is how exit 0 gets bought instead of earned.
 *
 * They live in their OWN file for a measured reason. When these entries sat
 * inside acceptance-gate.mjs, the anchor text appeared twice in that file: once
 * in the real code and once quoted here as data. The mutation replaced the
 * quotation, the code was never touched, the test passed, and the mutation was
 * reported as surviving. A mutation that edits its own description proves
 * nothing. The gate now also refuses any anchor that is not unique.
 */
export const MUTATIONS = [
  {
    id: "empty-suite-reads-as-pass",
    file: "scripts/acceptance-gate.mjs",
    from: 'if (total === 0) return fail("the suite collected 0 tests',
    to: 'if (total === 0) return pass("the suite collected 0 tests',
    mustFail: "refuses a suite that collected zero tests",
  },
  {
    id: "unknown-collapses-into-pass",
    file: "scripts/acceptance-gate.mjs",
    from: "const exitCode = (failed.length > 0 ? 1 : 0) + (unresolved.length > 0 ? 2 : 0);",
    to: "const exitCode = failed.length > 0 ? 1 : 0;",
    mustFail: "exits 2, not 0, when a check could not establish anything",
  },
  {
    id: "rename-second-path-gets-sliced",
    file: "scripts/acceptance-gate.mjs",
    from: '    if (xy.includes("R") || xy.includes("C")) {',
    to: "    if (false) {",
    mustFail: "keeps a renamed file's original path intact",
  },
  {
    id: "cross-file-ref-points-nowhere",
    file: "schemas/conversation.schema.json",
    from: "https://ai-sre-mvp/schemas/common.schema.json#/$defs/evidenceSource",
    to: "https://ai-sre-mvp/schemas/gone.schema.json#/$defs/evidenceSource",
    mustFail: "points every cross-file reference at a document the validator registers",
  },
  {
    id: "common-schema-grows-an-assertion",
    file: "schemas/common.schema.json",
    from: '"title": "Shared definitions",',
    to: '"title": "Shared definitions",\n  "const": 1,',
    mustFail: "keeps common.schema.json free of anything anyone would validate against",
  },
  {
    id: "ssh-key-stops-being-ignored",
    file: ".gitignore",
    from: "\nid_rsa\n",
    to: "\n",
    mustFail: "keeps the gate's idea of a secret and .gitignore's from drifting apart",
  },
  {
    id: "only-the-flattering-evidence-is-traced",
    file: "src/schema/validate.ts",
    from: 'const EVIDENCE_LISTS = ["supported_by", "contradicted_by"] as const;',
    to: 'const EVIDENCE_LISTS = ["supported_by"] as const;',
    mustFail: "traces contradicting evidence back to a finding, not only supporting evidence",
  },
  {
    // Passes every build assertion — the require text is unchanged — and only
    // the differential corpus notices. Measured 2026-09-04: without it, fast
    // mode shipped and the artifact accepted month 13 and February 30th.
    id: "date-time-semantics-drift-to-fast-mode",
    file: "scripts/build-core.mjs",
    from: "  addFormats(ajv);",
    to: '  addFormats(ajv, { mode: "fast" });',
    mustFail: "agrees on every date-time in the corpus that once split the two",
  },
  {
    // The committed workflow must stay derived. If the generator's output can
    // change while the file on disk does not, the drift comparison proves
    // nothing about the generator — only that two hand-maintained files agree.
    id: "generated-workflow-drifts-from-committed",
    file: "scripts/generate-workflow.mjs",
    from: 'export const WEBHOOK_PATH = "ai-sre-incident";',
    to: 'export const WEBHOOK_PATH = "ai-sre-incident-changed";',
    mustFail: "matches the committed file exactly, so a hand edit fails here",
  },
  {
    // The failure Codex named: normalisation that erases drift rather than
    // reporting it. Dropping credentials wholesale looks tidy and silently
    // hides a node rewired to somebody else's account.
    id: "normalisation-erases-credential-drift",
    file: "scripts/drift.mjs",
    from: '    if (key === "credentials" && isObject(v)) {',
    to: "    if (key === \"credentials\") { continue; } if (false) {",
    mustFail: "keeps the credential name, so a node pointed at a different account is drift",
  },
  {
    // A fixture contract that stops refusing is a contract in name only. The
    // termination reason is what the whole container-oom scenario turns on.
    id: "termination-reason-becomes-optional",
    file: "schemas/observations.schema.json",
    from: '"required": ["reason", "exit_code", "started_at", "finished_at"]',
    to: '"required": ["exit_code", "started_at", "finished_at"]',
    mustFail: "refuses a termination that does not say why",
  },
  {
    // The defect this project produces most often, here in the function written
    // to prevent it: a missing file reported as "the provider found nothing".
    id: "missing-fixture-reads-as-nothing",
    file: "src/providers/fixtures.ts",
    from: '  if (!existsSync(root)) return { state: "failed", slot, reason: `no scenario root at ${root}` };',
    to: '  if (!existsSync(root)) return { state: "nothing", slot };',
    mustFail: "reports failure, not nothing, when the scenario root does not exist",
  },
  {
    // Two workflows sharing a name is a deployment nobody can reason about:
    // picking either yields a verdict about a workflow that may not be live.
    id: "ambiguous-deployment-picked-anyway",
    file: "scripts/verify-deployment.mjs",
    from: '  if (matches.length > 1) return { state: "ambiguous", ids: matches.map((w) => w.id) };',
    to: "  if (false) { return null; }",
    mustFail: "treats two workflows sharing the name as drift, not as a choice to make",
  },
  {
    // The hole Codex named: a release that deploys without checking afterwards
    // proves the same nothing the gate proves, and drift lives on indefinitely.
    id: "release-skips-the-live-check",
    file: "scripts/release.mjs",
    from: '  step("verify the deployment", "node", ["scripts/verify-deployment.mjs"]);',
    to: "  // skipped",
    mustFail: "runs verify-deployment as part of the chain",
  },
  {
    // Recording from a fresh copy while claiming to record from the deployment.
    id: "baseline-recorded-from-a-copy-not-the-deployment",
    file: "scripts/record-baseline.mjs",
    from: '  if (id !== undefined && id !== null && id !== "") return { mode: "existing", id };',
    to: "  if (false) { return null; }",
    mustFail: "reads the configured deployment when there is one",
  },
  {
    // An invalid agent result inside a valid incident passes the incident check
    // and poisons everything downstream of it.
    id: "agent-result-attached-unchecked",
    file: "src/core/assemble.ts",
    from: '  const r = validate("agent-result", result);',
    to: '  const r = { state: "valid" };',
    mustFail: "says the result was invalid, not that attaching broke the incident",
  },
  {
    // Every slot failing is a scenario that could not be read, not an incident
    // with three established absences.
    id: "total-provider-failure-builds-an-incident",
    file: "src/core/assemble.ts",
    from: "  if (failures.length === SLOTS.length) {",
    to: "  if (false) {",
    mustFail: "refuses to build an incident when every observation failed",
  },
  {
    // A scenario whose correct answer the schema refuses can never be answered
    // correctly. Found on 2026-09-04: cpu-throttling expected CPU_THROTTLING and
    // the enum did not have it, so the right diagnosis would have been invalid.
    id: "expected-cause-code-not-in-the-schema",
    file: "scenarios/cpu-throttling/expected.json",
    from: '"root_cause_code": "CPU_THROTTLING"',
    to: '"root_cause_code": "MYSTERY"',
    mustFail: "names a cause code the incident schema permits",
  },
  {
    // Ignoring the scenario made two scenarios share an incident id, a thread
    // id and a conversation, while the distinctness test varied both arguments
    // and never asked whether the scenario mattered.
    id: "unregistered-scenario-gets-a-number-invented",
    file: "src/core/assemble.ts",
    from: "    throw new Error(`scenario ${JSON.stringify(scenario)} has no number in scenarios/registry.json; add one at next_free`);",
    to: "    return `INC-2026-${String(sequence).padStart(4, \"0\")}`;",
    mustFail: "refuses a scenario with no number rather than inventing one at call time",
  },
  {
    // The stronger question the gate asks now: a name in a file is not a test
    // that ran. Codex, chunk 2: "A comment or inert string containing it(...)
    // satisfies it… This proves only that matching text exists."
    id: "dod-names-a-test-that-never-runs",
    file: "scripts/definition-of-done.mjs",
    from: '"opens a thread and links it durably, not merely returns it",',
    to: '"a name that appears nowhere in any suite",',
    mustFail: "names, for every covered item, tests that actually exist",
  },
  {
    // Counting an item as covered while its tests do not exist is how a list of
    // ten turns into a statistic nobody checks.
    id: "dod-item-claims-a-test-that-does-not-exist",
    file: "scripts/definition-of-done.mjs",
    from: '"refuses executed: true, so the day something runs an action every check fails loudly",',
    to: '"a test nobody ever wrote",',
    mustFail: "names, for every covered item, tests that actually exist",
  },
  {
    // Measured on the first real model call, 2026-09-05: the prompt showed the
    // field and never said what may go in it, so the model answered "H1" and
    // the schema refused an otherwise sound result.
    id: "prompt-stops-listing-the-allowed-codes",
    file: "prompts/kubernetes-agent.md",
    from: "**A hypothesis `code` must be one of these, exactly.**",
    to: "**A hypothesis code is whatever seems right.**",
    mustFail: "states the code rule in the kubernetes prompt, in both id and prose",
  },
  {
    // Codex, 2026-09-05: the fix covered the observing agents and left the final
    // step able to invent an identifier exactly as the first real call did.
    id: "root-cause-prompt-stops-listing-codes",
    file: "prompts/root-cause-agent.md",
    from: "**The `root_cause_code` must be one of these, exactly.**",
    to: "**Pick a root_cause_code.**",
    mustFail: "lists every allowed code in the root cause prompt, including its own verdict",
  },
  {
    // Measured on a real call, 2026-09-05: told to state the unit without being
    // told where, the model made it a field, and the reply was refused.
    id: "metrics-prompt-stops-saying-where-the-unit-goes",
    file: "prompts/metrics-agent.md",
    from: "**Always state the unit, inside the `fact` text.**",
    to: "**Always state the unit.**",
    mustFail: "tells the metrics agent where the unit goes, not merely that it must appear",
  },
  {
    // Grok and Codex, independently, 2026-09-05: the root-cause prompt asked for
    // an object the validator refuses outright, so that call was guaranteed to
    // be wasted whatever the model said.
    id: "root-cause-prompt-asks-for-a-shape-the-validator-refuses",
    file: "prompts/root-cause-agent.md",
    from: '"agent": "root_cause",',
    to: '"root_cause_code": "CONTAINER_OOM",',
    mustFail: "shows the root cause agent an example the validator would accept",
  },
  {
    // Grok, 2026-09-05: a reply from another incident, citing a path that
    // resolves to nothing, was recorded as a completed agent turn.
    id: "reply-recorded-without-belonging-to-the-incident",
    file: "src/core/assemble.ts",
    from: "  const bound = resultBelongsHere(incident, result as Record<string, unknown>);",
    to: "  const bound = null;",
    mustFail: "refuses a finding citing a path that resolves to nothing in that observation",
  },
  {
    // Codex, 2026-09-05: nothing updated the incident's own verdict, so the one
    // answer the system exists to produce had no way to become the incident's.
    id: "verdict-never-reaches-the-incident",
    file: "src/core/assemble.ts",
    from: '    status: "diagnosed",',
    to: '    status: "investigating",',
    mustFail: "writes the cause, the confidence and the evidence onto the incident",
  },
  {
    // Codex, 2026-09-05: both checks existed and neither was called outside the
    // tests — the appearance of a guard with nothing wiring it to the boundary.
    id: "checked-path-stops-checking-the-source",
    file: "src/agents/context.ts",
    from: "  const source = checkSourceForForeignIncidents(incident);",
    to: '  const source = { state: "clean" };',
    mustFail: "refuses a contaminated incident rather than assembling from it",
  },
  {
    // Grok, 2026-09-05: the test named for a "checked context" never called the
    // check, so deleting the check left it green.
    id: "context-check-never-called-by-its-own-test",
    file: "src/agents/context.ts",
    from: "export function checkPayloadIsExactlyTheSlice(",
    to: "export function unusedRenamed(",
    mustFail: "does not let a later mutation of the incident change a checked context",
  },
  {
    // Grok, 2026-09-05: only array indices and length were compared, so a named
    // property on an array produced no path while an extra key on a plain
    // object did.
    id: "array-properties-invisible-to-the-diff",
    file: "src/agents/context.ts",
    from: "    const named = (v: unknown[]) => Object.keys(v).filter((k) => !/^\\d+$/.test(k));",
    to: "    const named = () => [];",
    mustFail: "catches a named property hung on an array, which indices alone would miss",
  },
  {
    // The question no earlier version asked: is the SOURCE contaminated. By the
    // time foreign data reaches the payload it is indistinguishable from the
    // legitimate slice, so nothing downstream can see it.
    id: "source-contamination-goes-unasked",
    file: "src/agents/context.ts",
    from: "  const foreign = foreignIncidentIds(incident, ownId);",
    to: "  const foreign = [];",
    mustFail: "asks the source about foreign incidents, which comparing to the source cannot",
  },
  {
    id: "provenance-check-becomes-a-pattern-match",
    file: "src/agents/context.ts",
    from: "  const paths = deepDiffPaths(expected, result.payload);",
    to: "  const paths = [];",
    mustFail: "catches content added to the payload after assembly",
  },
  {
    id: "prompt-rule-disappears",
    file: "prompts/root-cause-agent.md",
    from: "**Only cite what the agents reported.**",
    to: "**Cite whatever seems right.**",
    mustFail: "requires the root cause agent to cite only what agents reported",
  },
  {
    // The leak this system is built to prevent, in the function built to prevent
    // it: copying the whole incident instead of the one slot the agent reads.
    id: "agent-context-copies-the-whole-incident",
    file: "src/agents/context.ts",
    from: "    payload: { incident_id: incidentId, observation: snapshot(observation) },",
    to: "    payload: { incident_id: incidentId, observation: snapshot(observation), ...incident },",
    mustFail: "copies only what was asked for, so an unknown field cannot ride along",
  },
  {
    // Reporting clean for a context that was never assembled would mean the
    // isolation check passes hardest exactly when it inspected nothing.
    id: "unassembled-context-reads-as-clean",
    file: "src/agents/context.ts",
    from: '  if (result.state !== "assembled") return { state: "unchecked", reason: result.reason };',
    to: '  if (result.state !== "assembled") return { state: "clean" };',
    mustFail: "reports unchecked, not clean, when the context could not be assembled",
  },
  {
    id: "executed-becomes-optional-again",
    file: "schemas/remediation.schema.json",
    from: '    "rationale",\n    "executed"',
    to: '    "rationale"',
    mustFail: "refuses an action that simply omits executed",
  },
];

