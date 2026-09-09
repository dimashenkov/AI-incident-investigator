/**
 * The release chain exists to make the live check unavoidable.
 *
 * Codex, chunk 2 debt: "the live check is not part of any release/deployment
 * workflow… a deployment can drift indefinitely while every mandatory check
 * exits 0." So the test that matters is not that release works — it is that
 * release cannot be satisfied without verifying the deployment afterwards.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs, the same file node runs.
import { chooseSource } from "../scripts/record-baseline.mjs";
// @ts-expect-error - plain .mjs script, no types
import { releaseMayProceed, gateFinished, reportIsFromThisRun, mayCreateWorkflow, DRIFT_CHECK_ID, DEBT_CHECK_ID, stepFailed, exitCodeFor, RELEASE_ORDER, RELEASE_RUNNERS } from "../scripts/release.mjs";

const SOURCE = readFileSync(new URL("../scripts/release.mjs", import.meta.url).pathname, "utf8");
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url).pathname, "utf8"));

describe("releasing cannot skip the live check", () => {
  it("runs verify-deployment as part of the chain", () => {
    // From the order, not from the text: the string appears in the runner table
    // whether or not the order ever reaches it.
    expect(RELEASE_ORDER as string[]).toContain("verify-the-deployment");
    expect(RELEASE_RUNNERS as string[]).toContain("verify-the-deployment");
  });

  it("verifies AFTER deploying, not before", () => {
    /*
     * Verifying before deploying would check the previous deployment and call
     * the new one released.
     *
     * This compared `indexOf("await deploy()")` with another index — and when
     * the sequence became data, that literal stopped existing, so `indexOf`
     * returned -1 and the comparison passed for a reason that had nothing to do
     * with order. A text search decays the moment the text moves.
     */
    const order = RELEASE_ORDER as string[];
    expect(order.indexOf("deploy")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("deploy")).toBeLessThan(order.indexOf("verify-the-deployment"));
  });

  it("stops the chain on any non-zero step rather than carrying on", () => {
    /*
     * This used to assert that two STRINGS appeared in the file. Both sit
     * inside the branch they describe, so deleting the branch left them there
     * and the test green — a subagent measured it on 2026-09-09. A predicate
     * can be called; a substring cannot.
     */
    expect(stepFailed({ status: 0 }), "a step that exited clean did not fail").toBeNull();
    expect(stepFailed({ status: 1 })).toBe("exit 1");
    expect(stepFailed({ status: null, signal: "SIGKILL" }), "a killed step is a failed step").toBe("exit null");
    expect(stepFailed({ error: new Error("ENOENT") })).toBe("ENOENT");
    expect(stepFailed(undefined), "no result at all is not success").toMatch(/no result/);
    // And a killed step leaves with 2 rather than with a status it does not have.
    expect(exitCodeFor({ status: null })).toBe(2);
    expect(exitCodeFor({ status: 3 })).toBe(3);
  });

  it("runs the gate before deploying anything", () => {
    /*
     * This used to compare where two strings appeared in the file, and
     * `acceptance-gate.mjs` appears inside gateStep's own body — so the call
     * could be deleted from the sequence and the test stayed green. The order
     * is now data the test reads.
     */
    const order = RELEASE_ORDER as string[];
    expect(order.indexOf("acceptance-gate"), "the gate is in the sequence at all")
      .toBeGreaterThanOrEqual(0);
    expect(order.indexOf("acceptance-gate")).toBeLessThan(order.indexOf("deploy"));
    expect(order.indexOf("deploy")).toBeLessThan(order.indexOf("verify-the-deployment"));
    expect(order.indexOf("verify-the-deployment")).toBeLessThan(order.indexOf("re-record-the-baseline"));
    // Every step named in the order has something to run, and nothing is registered
    // that the order never reaches.
    expect([...(RELEASE_RUNNERS as string[])].sort()).toEqual([...order].sort());
  });

  it("is reachable as a declared script", () => {
    expect(PKG.scripts.release).toBe("node scripts/release.mjs");
  });

  it("re-records the baseline after verifying, not before", () => {
    expect(SOURCE.indexOf("scripts/verify-deployment.mjs")).toBeLessThan(SOURCE.indexOf("scripts/record-baseline.mjs"));
  });
});

describe("the baseline comes from the deployment, not from a fresh copy", () => {
  it("reads the configured deployment when there is one", () => {
    // Codex, chunk 2 debt: recording always created a separate temporary
    // workflow and exported THAT, so a release claiming to re-record from the
    // deployment it had just verified recorded something else. The ordering
    // test could not have noticed, because ordering was all it checked.
    expect(chooseSource({ N8N_WORKFLOW_ID: "w1" })).toEqual({ mode: "existing", id: "w1" });
  });

  it("falls back to a temporary upload only when no deployment is configured", () => {
    const r = chooseSource({});
    expect(r.mode).toBe("temporary");
    expect(r.why, "the weaker source must say it is the weaker source").toContain("rather than from the deployment itself");
  });

  it("treats an empty id as no id rather than as a workflow named nothing", () => {
    expect(chooseSource({ N8N_WORKFLOW_ID: "" }).mode).toBe("temporary");
  });
});

describe("the one gate failure a release is allowed to walk past", () => {
  /*
   * Walked into on 2026-09-05: the gate refuses when the generated workflow
   * differs from the recorded deployment baseline, which is true of every
   * change worth releasing. The gate blocked the release and the release was
   * the only thing that could clear the gate. A deadlock whose only exit is
   * "stop running the chain" is the hole the chain exists to close.
   */
  const drift = { id: DRIFT_CHECK_ID, state: "fail" };
  const ok = (id: string) => ({ id, state: "pass" });

  it("proceeds when the drift check is the only thing not passing", () => {
    expect(releaseMayProceed({ results: [ok("tests"), ok("typecheck"), drift] })).toBeNull();
  });

  it("stops on anything else, even alongside the drift failure", () => {
    const stop = releaseMayProceed({ results: [ok("typecheck"), { id: "tests", state: "fail" }, drift] });
    expect(stop).toContain("tests");
  });

  it("stops on a check that could not be established, which is not a passing check", () => {
    const stop = releaseMayProceed({ results: [ok("tests"), { id: "mutations-still-caught", state: "unknown" }, drift] });
    expect(stop).toContain("mutations-still-caught");
  });

  it("stops when the report cannot be read, rather than reading absence as agreement", () => {
    // The defect this repository keeps finding: a missing answer treated as a
    // clean one. No report means no way to tell what failed.
    expect(releaseMayProceed(null)).toContain("could not be read");
    expect(releaseMayProceed({})).toContain("no results");
    expect(releaseMayProceed({ results: [] })).toContain("no results");
  });

  it("stops when the drift check could not be established, rather than reading it as merely behind", () => {
    // Codex, 2026-09-05: matching the id alone let the drift check through in
    // the unknown state. "The deployment is behind us" was established; "the
    // probe did not run" was not, and a release is when that difference bites.
    const stop = releaseMayProceed({ results: [ok("tests"), { id: DRIFT_CHECK_ID, state: "unknown" }] });
    // The message now names the check and the state it arrived in, because two
    // checks may be non-passing and the reader has to know which one stopped it.
    expect(stop).toContain(`${DRIFT_CHECK_ID} (unknown)`);
  });

  it("stops when the drift check appears more than once, since it is then unclear what failed", () => {
    const stop = releaseMayProceed({ results: [ok("tests"), drift, drift] });
    expect(stop).toContain("appears more than once");
  });

  it("stops when the gate failed while every check passed, because that disagreement is itself a defect", () => {
    const stop = releaseMayProceed({ results: [ok("tests"), ok("typecheck")] });
    expect(stop).toContain("disagreement");
  });
});

/*
 * A gate that was killed did not produce the report on disk.
 *
 * spawnSync on a killed child gives error: undefined and status: null, so the
 * success test did not return and the release read whatever
 * out/acceptance-gate.json held from an EARLIER run. If that leftover showed
 * only drift failing, the chain deployed while announcing "the gate failed on
 * no-drift-from-baseline only" — a claim about a run that never finished. The
 * gate has been killed by a ten-minute limit twice in this project, so the
 * trigger is recorded, not imagined. Found by a subagent on 2026-09-07.
 */
describe("a release reads a gate report only from a gate that finished", () => {
  it("stops when the gate was killed by a signal", () => {
    const r = gateFinished({ status: null, signal: "SIGTERM", error: undefined });
    expect(r, "a signal kill is not a verdict").not.toBeNull();
    expect(String(r)).toMatch(/did not finish/);
    expect(String(r)).toMatch(/SIGTERM/);
  });

  it("stops when the gate never started", () => {
    expect(String(gateFinished({ status: null, error: new Error("ENOENT") })))
      .toMatch(/could not be started/);
  });

  it("stops when the result cannot be read at all", () => {
    for (const bad of [null, undefined, "nope", 7]) {
      expect(gateFinished(bad as never), `${JSON.stringify(bad)} is not a result`).not.toBeNull();
    }
  });

  it("carries on for a gate that ran and exited, whatever the code", () => {
    // Zero, one, two, three: each is a verdict, and the caller decides on it.
    for (const status of [0, 1, 2, 3]) {
      expect(gateFinished({ status, error: undefined }), `exit ${status} is a finished run`).toBeNull();
    }
  });
});

/*
 * gateFinished rejects a killed gate and one that never started. It does not
 * reject a gate that THREW — restoreInterruptedMutation, format and the final
 * writeFileSync all sit outside runGate's per-check try, so an exception there
 * exits non-zero having written no report, and the release read whatever was
 * left on disk. If that leftover showed only drift failing, the chain deployed
 * while announcing "the gate failed on no-drift-from-baseline only". The
 * artifact has carried finishedAt since this morning and nothing read it.
 */
describe("a release judges the gate by a report from the run it just waited for", () => {
  const started = 1_000_000;

  it("stops on a report written before this run started", () => {
    const r = reportIsFromThisRun({ exitCode: 1, finishedAt: started - 1 }, started);
    expect(r, "a report older than the run is a different run's").not.toBeNull();
    expect(String(r)).toMatch(/before this run started/);
  });

  it("stops on a report that carries no time at all", () => {
    expect(String(reportIsFromThisRun({ exitCode: 1 }, started))).toMatch(/carries no time/);
  });

  it("stops when the gate wrote no readable report", () => {
    for (const bad of [null, undefined, "nope", 7]) {
      expect(reportIsFromThisRun(bad as never, started),
        `${JSON.stringify(bad)} is not a report`).not.toBeNull();
    }
  });

  it("carries on for a report from this run", () => {
    expect(reportIsFromThisRun({ exitCode: 1, finishedAt: started + 1 }, started)).toBeNull();
    expect(reportIsFromThisRun({ exitCode: 0, finishedAt: started }, started),
      "written in the same millisecond is still this run").toBeNull();
  });
});

/*
 * Creating is not idempotent, and a duplicate cannot be undone from here.
 *
 * With no N8N_WORKFLOW_ID the deploy step used to POST unconditionally, so a
 * second release on a machine that never set the variable — only SUGGESTED, never
 * required — created a second workflow with the same name and the same fixed
 * webhook path. Every later release and drift check then reports ambiguity, for
 * a reason no change to this repository can clear, and the duplicate has to be
 * deleted by hand in the n8n UI. Found by a subagent on 2026-09-07.
 */
describe("a release does not create a second workflow of the same name", () => {
  const NAME = "AI SRE — incident investigation";

  it("refuses when one of that name already exists", () => {
    const r = mayCreateWorkflow({ data: [{ id: "w1", name: NAME }, { id: "w2", name: "something else" }] }, NAME);
    expect(r, "a duplicate name shares the webhook path and makes drift ambiguous forever").not.toBeNull();
    expect(String(r)).toMatch(/already exists \(w1\)/);
  });

  it("refuses when it could not establish that none exists", () => {
    /*
     * Not "no workflow of this name exists" — "we ESTABLISHED that none does".
     * An unreadable listing is not evidence of absence.
     */
    for (const bad of [null, undefined, "nope", 7]) {
      expect(mayCreateWorkflow(bad as never, NAME),
        `${JSON.stringify(bad)} is not a listing`).not.toBeNull();
    }
    expect(String(mayCreateWorkflow({ message: "unauthorized" }, NAME))).toMatch(/not a list/);
  });

  it("allows creating when the listing is readable and holds no such name", () => {
    expect(mayCreateWorkflow({ data: [] }, NAME)).toBeNull();
    expect(mayCreateWorkflow({ data: [{ id: "w9", name: "another workflow" }] }, NAME)).toBeNull();
  });
});

/*
 * A defect I wrote and a subagent found the same hour, by reading two lines
 * next to each other.
 *
 * reportIsFromThisRun's own comment says startedAt is taken BEFORE the gate is
 * spawned. It was taken after spawnSync returned — so the gate's report was
 * always stamped earlier, every non-zero gate exited 2 with "written before
 * this run started", and the drift-only continuation gateStep exists for became
 * unreachable.
 *
 * Asserted on the SOURCE, because gateStep spawns a ten-minute gate and no test
 * may run one. Reading the order of two statements is what the defect was.
 */
describe("the gate is timed from before it starts", () => {
  const SOURCE = readFileSync(new URL("../scripts/release.mjs", import.meta.url), "utf8");

  it("takes the time before the gate is spawned, not after it finishes", () => {
    const clock = SOURCE.indexOf("const startedAt = Date.now();");
    const spawn = SOURCE.indexOf('spawnSync("node", ["scripts/acceptance-gate.mjs"]');
    expect(clock, "startedAt is gone; the freshness check has nothing to compare against")
      .toBeGreaterThan(-1);
    expect(spawn, "the gate is no longer spawned here").toBeGreaterThan(-1);
    expect(clock, "a clock read after the gate ran makes its own report look stale")
      .toBeLessThan(spawn);
  });

  it("decides whether to create through the function written for it", () => {
    // The first version made the same three decisions inline, so the exported
    // function was tested and called by nothing.
    expect(SOURCE, "deploy() must call mayCreateWorkflow rather than repeat it")
      .toMatch(/mayCreateWorkflow\(listing, generated\.name\)/);
  });
});

/*
 * A second check may be non-passing, and the exception stays narrow.
 *
 * Added 2026-09-07, into a real circle: the debt waits on a run recorded with
 * machine-readable scores; that run happened, came back wrong, and the debt
 * came due while the items stayed uncovered. Covering them needs another paid
 * run through the DEPLOYED workflow, which needs a release — so blocking on it
 * made the debt unclearable by any means.
 *
 * Widening an exception to get past a check is the defect this project keeps
 * catching, so these tests exist to say exactly how far it was widened.
 */
describe("the release passes two checks and no more", () => {
  const pass = (id: string) => ({ id, state: "pass" });
  const rest = [pass("tests"), pass("typecheck"), pass("mutations-still-caught")];

  it("passes drift failing and the debt due, together", () => {
    expect(releaseMayProceed({ results: [...rest,
      { id: DRIFT_CHECK_ID, state: "fail" }, { id: DEBT_CHECK_ID, state: "unknown" }] })).toBeNull();
  });

  it("passes either of them alone", () => {
    expect(releaseMayProceed({ results: [...rest, { id: DRIFT_CHECK_ID, state: "fail" }] })).toBeNull();
    expect(releaseMayProceed({ results: [...rest, { id: DEBT_CHECK_ID, state: "unknown" }] })).toBeNull();
  });

  it("stops on either of them in the OTHER state", () => {
    /*
     * `unknown` on drift means the probe did not run, which is not "the
     * deployment is behind". `fail` on the debt means promised work is overdue
     * with its dependency met — a different claim from "due and unwritten".
     */
    expect(String(releaseMayProceed({ results: [...rest, { id: DRIFT_CHECK_ID, state: "unknown" }] })))
      .toMatch(/no-drift-from-baseline \(unknown\)/);
    expect(String(releaseMayProceed({ results: [...rest, { id: DEBT_CHECK_ID, state: "fail" }] })))
      .toMatch(/promised-checks-due \(fail\)/);
  });

  it("stops on any third check, whatever it is", () => {
    expect(String(releaseMayProceed({ results: [...rest.slice(1),
      { id: "tests", state: "fail" },
      { id: DRIFT_CHECK_ID, state: "fail" }, { id: DEBT_CHECK_ID, state: "unknown" }] })))
      .toMatch(/tests \(fail\)/);
  });

  it("stops when one of the two appears twice", () => {
    // A duplicate makes it unclear which result the decision rested on, which
    // is how an unknown drift check got through before.
    expect(String(releaseMayProceed({ results: [...rest,
      { id: DRIFT_CHECK_ID, state: "fail" }, { id: DRIFT_CHECK_ID, state: "fail" }] })))
      .toMatch(/appears more than once/);
  });
});
