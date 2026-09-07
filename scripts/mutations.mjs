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
    from: '"reason",\n                            "exit_code",',
    to: '"exit_code",',
    mustFail: "refuses a termination that does not say why",
  },
  {
    // The defect this project produces most often, here in the function written
    // to prevent it: a missing file reported as "the provider found nothing".
    id: "missing-fixture-reads-as-nothing",
    file: "src/providers/fixtures.ts",
    from: '  if (!existsSync(root)) return { state: "failed", slot, kind: "absent", reason: `no scenario root at ${root}` };',
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
    file: "src/core/merge.ts",
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
    // Codex, 2026-09-05: five duplicate reviews of one incident satisfied the
    // minimum and reported 100% accuracy.
    id: "one-incident-counted-many-times",
    file: "src/core/review.ts",
    from: "      if (held === undefined || r.reviewed_at > held.reviewed_at) latest.set(r.incident_id, r);",
    to: "      latest.set(r.review_id, r);",
    mustFail: "counts one incident once, however many times it is reviewed",
  },
  {
    // Codex, 2026-09-05: supersession was decorative — the mistake and its
    // correction both counted.
    id: "superseded-reviews-keep-counting",
    file: "src/core/review.ts",
    from: "  const live = reviews.filter((r) => !superseded.has(r.review_id));",
    to: "  const live = reviews;",
    mustFail: "drops a superseded review even when the correction is older by the clock",
  },
  {
    // Grok, 2026-09-05: requiring in-observation evidence refused exactly the
    // reviews worth having, so accuracy would climb as hard cases vanished.
    id: "honest-late-review-refused",
    file: "src/core/review.ts",
    from: '  if (review.evidence_source === "in_observations" && review.decisive_ref !== undefined) {',
    to: "  if (review.decisive_ref !== undefined) {",
    mustFail: "does not check a path against the observations when the evidence came from outside",
  },
  {
    // Codex, 2026-09-05: the stamp hashed a build artifact made from schemas,
    // so changing the model changed the answer and not the stamp.
    id: "stamp-ignores-the-model",
    file: "src/core/review.ts",
    from: '  core.update(`model:${model.name}@${model.temperature}`);',
    to: "  // no model in the stamp",
    mustFail: "moves when the model or its temperature changes",
  },
  {
    // Without this the contradicting slot is filed as one absence among three
    // and two healthy slots carry the incident anyway.
    id: "assembly-tolerates-a-contradicting-slot",
    file: "src/core/assemble.ts",
    from: '  const contradictions = failures.filter((f) => f.kind === "contradiction");',
    to: "  const contradictions = [];",
    mustFail: "refuses an answer whose stamp disagrees about the namespace",
  },
  {
    // Eleven contract tests went vacuous when the stamp became required and
    // nothing stamped them. The precondition is what noticed; this keeps it so.
    id: "contract-tests-stop-stamping-the-slot",
    file: "tests/providers.test.ts",
    from: "      ? { ...(data as Record<string, unknown>), provenance: stampOf(slot) }",
    to: "      ? { ...(data as Record<string, unknown>) }",
    mustFail: "accepts a well-formed slot, so the refusals below are about what they say",
  },
  {
    // The sentinel is the one answer nothing else looks at. Recognised before
    // the stamp, it is a way in that leaves no trace.
    id: "sentinel-read-before-the-stamp-is-checked",
    file: "src/providers/fixtures.ts",
    from: "  const said = readSentinel(data as Record<string, unknown>, slot);\n  if (said !== null) return said;",
    to: "  const said = null;\n  if (said !== null) return said;",
    mustFail: "reports nothing under a request too, not only when read raw",
  },
  {
    // "Nothing here" is the one answer nothing downstream re-examines, so it is
    // the one that has to say why, and say only that.
    id: "sentinel-accepted-without-a-reason",
    file: "src/providers/fixtures.ts",
    from: "  if (typeof why !== \"string\" || why.trim().length === 0) {",
    to: "  if (false) {",
    mustFail: "refuses a nothing that does not say why it is nothing",
  },
  {
    id: "sentinel-accepted-alongside-real-data",
    file: "src/providers/fixtures.ts",
    from: "  if (extra.length > 0) {",
    to: "  if (false) {",
    mustFail: "refuses a nothing that arrives carrying an observation as well",
  },
  {
    id: "release-reads-an-unestablished-drift-check-as-behind",
    file: "scripts/release.mjs",
    from: '  if (notPassing[0]?.state !== "fail") {',
    to: "  if (false) {",
    mustFail: "stops when the drift check could not be established, rather than reading it as merely behind",
  },
  {
    id: "sentinel-provenance-exempted-wholesale",
    file: "src/providers/fixtures.ts",
    from: "    if (strays.length > 0) {",
    to: "    if (false) {",
    mustFail: "refuses a nothing that hides an observation inside its provenance",
  },
  {
    // The second provider exists to be refused. If it stops being refused the
    // proof of substitutability turns into a demonstration that two things can
    // both return data.
    id: "rogue-provider-bypasses-the-shared-checker",
    file: "src/providers/rogue.ts",
    from: "      return readSlotWithPayload({ ...data, provenance: stamp }, slot, request);",
    to: "      return { state: \"collected\", slot, data };",
    mustFail: "refuses every rogue behaviour that claims something about itself",
  },
  {
    id: "unrun-provider-counted-as-working",
    file: "src/providers/kubernetes.ts",
    from: "    exercised: false,",
    to: "    exercised: true,",
    mustFail: "says which implementations have never been run, rather than counting them as working",
  },
  {
    // A total that swallows what it could not price is the same defect as a
    // gate that reports PASS for a check that never ran.
    id: "unpriced-run-counted-as-free",
    file: "scripts/spend.mjs",
    from: '    return { state: "unknown", why: `no recorded price for ${model}; add it with the date it was read` };',
    to: "    return { state: \"measured\", usd: 0, inTok: 0, outTok: 0, model };",
    mustFail: "says it could not establish a cost rather than counting it as zero",
  },
  {
    // The human report and the exit code must come from the same count.
    id: "unreadable-run-counted-after-the-total-is-qualified",
    file: "scripts/spend.mjs",
    from: '  for (const u of unreadable) { unknown += 1; lines.push(`    UNREADABLE ${u}`); }\n  lines.push(`\\n    measured total: $${total.toFixed(4)}`);\n  if (unknown > 0) lines.push(`    ${unknown} run(s) could not be priced \u2014 the total above is a floor, not the answer`);',
    to: '  lines.push(`\\n    measured total: $${total.toFixed(4)}`);\n  if (unknown > 0) lines.push(`    ${unknown} run(s) could not be priced \u2014 the total above is a floor, not the answer`);\n  for (const u of unreadable) { unknown += 1; lines.push(`    UNREADABLE ${u}`); }',
    mustFail: "qualifies the total in the same report where an unreadable run is counted",
  },
  {
    id: "token-counts-coerced-instead-of-checked",
    file: "scripts/spend.mjs",
    from: '    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {',
    to: "    if (false) {",
    mustFail: "refuses a token count that is not a whole non-negative number",
  },
  {
    // The one line is the only place the number is usually read.
    id: "one-line-drops-the-floor-qualification",
    file: "scripts/spend.mjs",
    from: "  if (r.unknown > 0) {\n    return `${money} \u2014 floor, ${r.unknown} run(s) could not be priced (npm run spend for the breakdown)`;\n  }",
    to: "  if (false) {\n    return money;\n  }",
    mustFail: "carries the qualification with the one figure, not only in the breakdown",
  },
  {
    // The whole point is surviving a kill, so the record must be written before
    // the file is touched. Written after, it protects nothing.
    id: "mutation-record-written-after-the-damage",
    file: "scripts/acceptance-gate.mjs",
    from: '    writeFileSync(IN_FLIGHT, JSON.stringify({ id: m.id, file: m.file, original, mutated: original.replace(m.from, m.to) }));',
    to: "",
    mustFail: "records the file before it damages it, which is the only ordering that survives a kill",
  },
  {
    id: "unreadable-repair-record-acted-on-anyway",
    file: "scripts/acceptance-gate.mjs",
    from: '    return { state: "unreadable", detail: "the record names no file, or holds no original or mutated text" };',
    to: '    return { state: "already-clean" };',
    mustFail: "refuses to act on a record it cannot read, rather than guessing",
  },
  {
    id: "repair-overwrites-a-file-it-no-longer-describes",
    file: "scripts/acceptance-gate.mjs",
    from: "  if (now !== record.mutated) {",
    to: "  if (false) {",
    mustFail: "refuses to touch a file someone edited after the interruption",
  },
  {
    id: "repair-follows-a-path-out-of-the-repository",
    file: "scripts/acceptance-gate.mjs",
    from: "  if (target !== realRoot && !target.startsWith(realRoot + sep)) {",
    to: "  if (false) {",
    mustFail: "refuses a record naming a path outside the repository",
  },
  {
    id: "dynamic-import-passes-the-blocklist",
    file: "scripts/workflow-runtime.mjs",
    from: '    { what: /\\bimport\\s*\\(/g, why: "a dynamic import" },',
    to: "",
    mustFail: "catches a dynamic import, which the static-import pattern does not match",
  },
  {
    // A throwing expression stops the workflow with an n8n error rather than a
    // refusal that says which agent produced nothing.
    id: "collect-throws-instead-of-returning-null",
    file: "scripts/generate-workflow.mjs",
    from: "        + ` var o; try { o = JSON.parse(t); } catch (e) { return null; }`",
    to: "        + ` var o = JSON.parse(t);`",
    mustFail: "turns an unparseable answer into null rather than throwing inside n8n",
  },
  {
    // Comparing the path string is not comparing the file a link points at.
    id: "repair-judges-the-path-string-not-the-real-file",
    file: "scripts/acceptance-gate.mjs",
    from: "    target = realpathSync(named);",
    to: "    target = named;",
    mustFail: "refuses a symlink inside the repository that points outside it",
  },
  {
    // The part of a prompt a model copies most literally is the example.
    id: "prompt-example-shows-a-placeholder-citation",
    file: "prompts/kubernetes-agent.md",
    from: '"source_ref": "collected_at", "severity": "warning"',
    to: '"source_ref": "...", "severity": "warning"',
    mustFail: "shows no citation a model could copy into a refusal",
  },
  {
    // A realistic path is a worse example than a boring one: it resolves only
    // where that thing happened, so the example itself becomes an answer that
    // would be refused for every other scenario.
    id: "prompt-example-cites-a-scenario-specific-path",
    file: "prompts/root-cause-agent.md",
    from: '"supported_by": ["pods[0].containers[0].last_state.terminated.reason"] }],\n  "confidence": 0.0',
    to: '"supported_by": ["events[0].reason"] }],\n  "confidence": 0.0',
    mustFail: "shows no example whose hypothesis cites something its own findings do not",
  },
  {
    // Measured, and it cost money: a refused item flowed into the next HTTP
    // node and was charged for the agents before it.
    id: "gate-lets-a-refusal-reach-the-paid-call",
    file: "scripts/generate-workflow.mjs",
    // Inverted by its right-hand side, not by rewriting the expression: the
    // first attempt rewrote the expression and had to survive two layers of
    // escaping. It produced a syntax error instead, the file then failed to
    // load, its tests never ran — and the mutation read as surviving, which is
    // the one answer that must never come from not looking.
    from: '          rightValue: "asking",',
    to: '          rightValue: "skipped",',
    mustFail: "skips an agent whose slot holds an established absence, rather than refusing the incident",
  },
  {
    id: "conclude-accepts-any-state-that-reaches-it",
    file: "scripts/workflow-runtime.mjs",
    from: '  if (j.state !== "recorded" && j.state !== "skipped") {',
    to: "  if (false) {",
    mustFail: "refuses a state this chain does not produce, rather than concluding from it",
  },
  {
    id: "conclude-promotes-a-verdict-this-run-never-asked-for",
    file: "scripts/workflow-runtime.mjs",
    from: "  if (asked.length !== 1) {",
    to: "  if (false) {",
    mustFail: "refuses when the root cause agent did not answer in this run",
  },
  {
    // Deciding by the words of a message means any future failure phrased that
    // way becomes a skip, and the rule breaks the day someone rewords it.
    id: "skip-decided-by-a-message-not-by-the-record",
    file: "scripts/workflow-runtime.mjs",
    from: '  if (record.state === "nothing") {',
    to: '  if (String(ctx.reason || "").indexOf("nothing was collected") !== -1) {',
    mustFail: "refuses a slot that could not be read, rather than skipping it like an absence",
  },
  {
    // Measured live on 2026-09-06: routing a gate's false branch past the node
    // that prepares the next question skipped the agent AND everything after
    // it, so an incident with no metrics reached the end having never asked the
    // root cause agent. Every test passed, because the harness walked the order
    // it remembered instead of the connections the workflow declares.
    id: "skip-routes-past-the-node-that-asks-the-next-question",
    file: "scripts/generate-workflow.mjs",
    from: '    connections[gate].main[1] = [{ node: record, type: "main", index: 0 }];',
    to: '    connections[gate].main[1] = [{ node: "Conclude", type: "main", index: 0 }];',
    mustFail: "skips an agent whose slot holds an established absence, rather than refusing the incident",
  },
  {
    // A history shared between runs lets one scenario read another's incident.
    id: "harness-history-shared-between-runs",
    file: "tests/helpers/run-workflow.ts",
    from: "  const seen = new Map<string, Record<string, unknown>>();",
    to: "  const seen = SHARED_HISTORY;",
    mustFail: "keeps each run's node outputs to itself",
  },
  {
    // The agent that weighs the others reads no slot; skipping it would leave a
    // conclusion drawn from nothing weighing anything.
    id: "slotless-agent-can-be-skipped-like-an-empty-slot",
    file: "scripts/workflow-runtime.mjs",
    from: "  if (slot === null || slot === undefined) {",
    to: "  if (false) {",
    mustFail: "refuses, never skips, when the agent that reads no slot cannot be given a context",
  },
  {
    // A run that gave no answer is not a wrong answer. Folding them together
    // makes a routing bug look like a model that cannot think.
    id: "a-refused-run-scored-as-a-wrong-answer",
    file: "scripts/score-run.mjs",
    from: '  if (answer.state !== "concluded") {',
    to: "  if (false) {",
    mustFail: "keeps a run that gave no answer apart from one that gave a wrong answer",
  },
  {
    // The comparison that was missing on 2026-09-06, when a wrong answer was
    // reported as one of "three of five concluded".
    id: "any-conclusion-counted-as-the-right-one",
    file: "scripts/score-run.mjs",
    from: "  if (got !== want.code) {",
    to: "  if (false) {",
    mustFail: "calls the right code correct and the wrong code wrong",
  },
  {
    // A field that cannot fail the run is a comment.
    id: "missing-citations-hidden-inside-correct",
    file: "scripts/score-run.mjs",
    from: "  if (missing.length > 0) {",
    to: "  if (false) {",
    mustFail: "keeps the right code on other ground apart from the right code on its own",
  },
  {
    // Comparing must_cite against the agent name matches nothing, and the
    // verdict becomes noise that always says the same thing.
    id: "citations-read-from-the-wrong-field",
    file: "scripts/score-run.mjs",
    from: "  const agents = answer?.incident?.analysis?.agents;",
    to: "  const agents = answer?.analysis?.agents;",
    mustFail: "reads the citations from the agents' findings, not from the evidence list",
  },
  {
    // Two rules that contradict make the model obey whichever matches the shape
    // in front of it, and the live run showed which one that is.
    id: "root-cause-prompt-forbids-what-it-requires",
    file: "prompts/root-cause-agent.md",
    from: "**The question is whether a finding OBSERVES the cause, not how many findings",
    to: "**Naming a cause because one finding points at it is the failure this agent exists to avoid. Not how many findings",
    mustFail: "does not both require and forbid naming a cause from one finding",
  },
  {
    id: "allowed-code-with-nothing-that-observes-it",
    file: "prompts/root-cause-agent.md",
    from: "| `DEPLOYMENT_REGRESSION` | a change in the deployment lining up in time with the failure |",
    to: "| `DEPLOYMENT_REGRESSION` | |",
    mustFail: "names, for every allowed cause code, what observes it",
  },
  {
    // A number available for naming the nearest code at half confidence is an
    // invitation to name it.
    id: "a-confidence-band-for-guessing",
    file: "prompts/root-cause-agent.md",
    from: "| circumstantial evidence only — nothing observed the cause itself | `INSUFFICIENT_EVIDENCE` and `0` |",
    to: "| circumstantial evidence only — nothing observed the cause itself | 0.4 to 0.6 |",
    mustFail: "offers no confidence band for naming a cause on circumstantial evidence",
  },
  {
    // Refusing an answer over notation costs a paid run every round.
    id: "wrapper-prefix-refused-instead-of-resolved",
    file: "src/core/merge.ts",
    from: "  if (resolveRef(observation, ref) !== undefined) return ref;",
    to: "  if (false) return ref;",
    mustFail: "prefers a field genuinely called observation over the alias",
  },
  {
    // A citation the machine approved and a human cannot follow is worse than a
    // refusal: the refusal at least says something is wrong.
    id: "the-stored-citation-is-not-the-one-that-resolves",
    file: "src/core/merge.ts",
    from: "    stored = rewrite.result;",
    to: "    stored = stored;",
    mustFail: "stores the working spelling through recordAgentResult, not only in the helper",
  },
  {
    id: "the-wrapper-alone-accepted-as-a-citation",
    file: "src/core/merge.ts",
    from: "  if (rest.length === 0) return null;",
    to: "  if (false) return null;",
    mustFail: "refuses the wrapper on its own, which names everything and so names nothing",
  },
  {
    // "Could not rewrite" is not "nothing to rewrite", and the case where they
    // differ is the case where silence is worst.
    id: "unrewritable-citation-stored-as-it-came",
    file: "src/core/merge.ts",
    from: '      return { state: "refused",',
    to: '      { nextFindings.push(f); continue; }\n      return { state: "refused",',
    mustFail: "refuses rather than storing a citation it could not rewrite",
  },
  {
    id: "contradicted-by-left-behind-by-the-rewrite",
    file: "src/core/merge.ts",
    from: '    if (one["contradicted_by"] !== undefined) next["contradicted_by"] = carry(one["contradicted_by"]);',
    to: "",
    mustFail: "carries the rewrite into contradicted_by as well as supported_by",
  },
  {
    // Without the count, a model that ignored an instruction and one that
    // followed it produce the same stored finding.
    id: "normalisation-count-not-carried-out-of-the-run",
    file: "scripts/workflow-runtime.mjs",
    from: "    j.normalised = (j.normalised || 0) + (recorded.normalised || 0);",
    to: "",
    mustFail: "counts the citations it had to normalise, so an ignored instruction still shows",
  },
  {
    // The metric is how many citations the model wrote wrong; counting distinct
    // spellings makes it shrink when the model repeats itself.
    id: "normalisation-counted-per-spelling-not-per-finding",
    file: "src/core/merge.ts",
    from: "    changed += 1;",
    to: "    changed = rewritten.size;",
    mustFail: "counts every rewritten finding, not every distinct spelling",
  },
  {
    // A cluster where nothing looks wrong is not a cluster with nothing to
    // report: the limits are what make somebody else's number mean something.
    id: "healthy-cluster-reports-nothing-at-all",
    file: "prompts/kubernetes-agent.md",
    from: "| **nothing wrong at all, but there are pods** | the limits anyway — another agent's numbers may be measured against them |",
    to: "",
    mustFail: "asks each agent only for what its own slot can answer",
  },
  {
    // Two rules that fight make the model obey whichever matches the shape in
    // front of it, and a healthy-looking cluster matches the older one.
    id: "no-symptom-read-as-nothing-to-report",
    file: "prompts/kubernetes-agent.md",
    from: "**No symptom is not the same as nothing.**",
    to: "**If the observation shows nothing relevant, return no_data.**",
    mustFail: "asks each agent only for what its own slot can answer",
  },
  {
    // Adding a duty displaced the one that mattered: three configuration
    // findings and no event, on an observation whose event names the cause.
    id: "configuration-asked-for-before-the-symptom",
    file: "prompts/kubernetes-agent.md",
    from: "Two things, in this order. **The symptom first.** Then the configuration it",
    to: "Two things. **The configuration first.** Then the symptom it",
    mustFail: "asks each agent only for what its own slot can answer",
  },
  {
    // A marker inside a shown citation demonstrates a path this system would
    // refuse, and a model copying the example literally loses its whole answer.
    id: "scoped-label-inside-the-citation-it-labels",
    file: "prompts/kubernetes-agent.md",
    from: '{ "fact": "the event says: Failed to pull image ... not found", "source_ref": "events[0].message" }',
    to: '{ "fact": "the event says: Failed to pull image ... not found", "source_ref": "SCENARIO-SPECIFIC events[0].message" }',
    mustFail: "asks each agent only for what its own slot can answer",
  },
  {
    // Saying naming the cause is another agent's job while handing over a list
    // of cause codes is a contradiction the model resolves by the shape it
    // happens to see.
    id: "code-list-without-saying-why-it-is-there",
    file: "prompts/kubernetes-agent.md",
    from: "**Usually you return no hypotheses at all, and that is the expected answer.**",
    to: "**Pick the code that fits what you saw.**",
    mustFail: "asks each agent only for what its own slot can answer",
  },
  {
    id: "claimed-provider-not-compared",
    file: "src/providers/fixtures.ts",
    from: '      ["provider", `fake-${slot}`],',
    to: "",
    mustFail: "refuses an answer that claims to come from another collector",
  },
  {
    // The narrow exception has to stay narrow. Widened to any failure, the
    // release walks past the gate entirely.
    id: "release-walks-past-any-gate-failure",
    file: "scripts/release.mjs",
    from: "  const other = notPassing.filter((r) => r?.id !== DRIFT_CHECK_ID);",
    to: "  const other = [];",
    mustFail: "stops on anything else, even alongside the drift failure",
  },
  {
    id: "release-reads-a-missing-report-as-clean",
    file: "scripts/release.mjs",
    from: '    return "the gate failed and its report could not be read, so there is no way to tell what failed";',
    to: "    return null;",
    mustFail: "stops when the report cannot be read, rather than reading absence as agreement",
  },
  {
    // The question no content check can answer, unasked.
    // The provider refuses a contradicting stamp before assembly ever sees it,
    // so this is the second line: an observation that arrives stamped but was
    // not gathered under our request. Reached by the direct tests, and that is
    // said rather than hidden behind a mutation pointing somewhere convenient.
    id: "provider-normalises-a-disagreeing-stamp",
    file: "src/providers/fixtures.ts",
    from: "    ] as const).filter(([k, want]) => c[k] !== want);",
    to: "    ] as const).filter(() => false);",
    mustFail: "refuses an answer whose stamp disagrees about the namespace",
  },
  {
    // Three slots from three collections are three moments read as one.
    // The provider contradicting its own request — the path a real answer takes.
    id: "provider-stamp-overwritten-instead-of-refused",
    file: "src/providers/fixtures.ts",
    from: "    if (disagreements.length > 0) {",
    to: "    if (false) {",
    mustFail: "refuses a provider that stamps its answer with another collection",
  },
  {
    // A review that judges a different code than what was shown makes every
    // count built on these records describe something that never happened.
    id: "review-judges-something-other-than-what-was-shown",
    file: "src/core/review.ts",
    from: "  if (review.proposed_code !== actuallyProposed) {",
    to: "  if (false) {",
    mustFail: "refuses a review that disagrees about what the system proposed",
  },
  {
    // A percentage from three cases is a number people quote and nobody can
    // defend.
    id: "accuracy-reported-from-too-few-cases",
    file: "src/core/review.ts",
    from: "      accuracy: gradable >= minimum ? correct / gradable : null,",
    to: "      accuracy: gradable > 0 ? correct / gradable : null,",
    mustFail: "reports no accuracy when too few incidents are gradable, however many rows exist",
  },
  {
    // Counting unverifiable as wrong blames the system for an incident nobody
    // resolved.
    id: "unverifiable-counted-against-the-system",
    file: "src/core/review.ts",
    from: "    const gradable = correct + wrong;",
    to: "    const gradable = correct + wrong + unverifiable;",
    mustFail: "keeps unverifiable out of the denominator and says so in the counts",
  },
  {
    // could-not-read rendered as found-nothing in the one place a person reads.
    id: "thread-renders-an-error-as-an-empty-result",
    file: "src/core/report.ts",
    from: '  if (a.status === "error") {',
    to: "  if (false) {",
    mustFail: "keeps could-not-read distinct from found-nothing, in the words a reader sees",
  },
  {
    // A verdict that cites only what agrees, without saying the rest is there.
    id: "thread-hides-the-evidence-against",
    file: "src/core/report.ts",
    from: "      (against.length === 0 ? \"\" : ` ${against.length} finding(s) argue against this; they are in the incident's evidence.`);",
    to: '      "";',
    mustFail: "tells the reader that contradicting evidence exists rather than omitting it",
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
    file: "src/core/merge.ts",
    from: "  const bound = resultBelongsHere(incident, result as Record<string, unknown>, checked);",
    to: "  const bound = null;",
    mustFail: "refuses a finding citing a path that resolves to nothing in that observation",
  },
  {
    // Codex, 2026-09-05: nothing updated the incident's own verdict, so the one
    // answer the system exists to produce had no way to become the incident's.
    id: "verdict-never-reaches-the-incident",
    file: "src/core/merge.ts",
    from: '    status: "diagnosed",',
    to: '    status: "investigating",',
    mustFail: "writes the cause, the confidence and the evidence onto the incident",
  },
  {
    // Codex, 2026-09-05: both checks existed and neither was called outside the
    // tests — the appearance of a guard with nothing wiring it to the boundary.
    id: "checked-path-stops-checking-the-source",
    file: "src/agents/slice.ts",
    from: "  const source = checkSourceForForeignIncidents(incident);",
    to: '  const source = { state: "clean" };',
    mustFail: "refuses a contaminated incident rather than assembling from it",
  },
  {
    // Grok, 2026-09-05: the test named for a "checked context" never called the
    // check, so deleting the check left it green.
    id: "context-check-never-called-by-its-own-test",
    file: "src/agents/slice.ts",
    from: "export function checkPayloadIsExactlyTheSlice(",
    to: "export function unusedRenamed(",
    mustFail: "does not let a later mutation of the incident change a checked context",
  },
  {
    // Grok, 2026-09-05: only array indices and length were compared, so a named
    // property on an array produced no path while an extra key on a plain
    // object did.
    id: "array-properties-invisible-to-the-diff",
    file: "src/agents/slice.ts",
    from: "    const named = (v: unknown[]) => Object.keys(v).filter((k) => !/^\\d+$/.test(k));",
    to: "    const named = () => [];",
    mustFail: "catches a named property hung on an array, which indices alone would miss",
  },
  {
    // The question no earlier version asked: is the SOURCE contaminated. By the
    // time foreign data reaches the payload it is indistinguishable from the
    // legitimate slice, so nothing downstream can see it.
    id: "source-contamination-goes-unasked",
    file: "src/agents/slice.ts",
    from: "  const foreign = foreignIncidentIds(incident, ownId);",
    to: "  const foreign = [];",
    mustFail: "asks the source about foreign incidents, which comparing to the source cannot",
  },
  {
    id: "provenance-check-becomes-a-pattern-match",
    file: "src/agents/slice.ts",
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
    file: "src/agents/slice.ts",
    from: "    payload: { incident_id: incidentId, observation: snapshot(observation) },",
    to: "    payload: { incident_id: incidentId, observation: snapshot(observation), ...incident },",
    mustFail: "copies only what was asked for, so an unknown field cannot ride along",
  },
  {
    // Reporting clean for a context that was never assembled would mean the
    // isolation check passes hardest exactly when it inspected nothing.
    id: "unassembled-context-reads-as-clean",
    file: "src/agents/slice.ts",
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

