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
    id: "provenance-check-becomes-a-pattern-match",
    file: "src/agents/context.ts",
    from: "  const paths = deepDiffPaths(expected, result.payload);",
    to: "  const paths = [];",
    mustFail: "catches foreign content that looks like nothing we know",
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

