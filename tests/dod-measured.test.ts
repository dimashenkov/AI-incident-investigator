/**
 * Two Definition-of-Done items that a model call closes, and this is the
 * evidence it closed them.
 *
 * dod-2 "every scenario and INSUFFICIENT_EVIDENCE" and dod-10 "the deployed
 * workflow, not merely local code, produces the required result" were marked
 * covered:false with needs:"a model call" — because the named tests proved the
 * fixtures existed and validated, never that the system PRODUCED the answers.
 * The model calls happened on 2026-09-11. These tests read the recorded
 * verdicts, so the claim rests on what was measured, not on a flag.
 *
 * Both couple to docs/runs, which is committed. That coupling is the point: the
 * moment a registered scenario has no measured verdict, dod-2 goes red here —
 * which is the true state of "every scenario measured" while one is not.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs, the same file node runs.
import { scenariosMeasured } from "../scripts/readiness.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("the model has actually produced the answers", () => {
  it("every registered scenario has been measured against a model", () => {
    /*
     * Measured means asked and answered — green (correct) or red (a verdict),
     * never unestablished (nobody asked, or it could not be established). A red
     * scenario is measured; the claim is coverage, not correctness.
     */
    const rows = scenariosMeasured(ROOT) as Array<{ id: string; state: string }>;
    expect(rows.length, "this is vacuous with no scenarios").toBeGreaterThan(10);
    const unmeasured = rows.filter((r) => r.state !== "green" && r.state !== "red").map((r) => r.id);
    expect(unmeasured, `these scenarios have no measured verdict: ${unmeasured.join(", ")}`).toEqual([]);
  });

  it("the deployed workflow, not local code, produced a scored result", () => {
    /*
     * The proof that dod-10 is about the DEPLOYED instance: a run record whose
     * webhook_host is the cloud instance AND which carries a correct verdict.
     * A local harness run would not carry that host.
     */
    const runs = join(ROOT, "docs", "runs");
    let proven = false;
    let where = "";
    for (const f of readdirSync(runs).filter((n) => n.endsWith(".json"))) {
      let rec: { webhook_host?: string; scored?: Record<string, string> };
      try { rec = JSON.parse(readFileSync(join(runs, f), "utf8")); } catch { continue; }
      const host = rec.webhook_host ?? "";
      const onCloud = host.includes(".n8n.cloud");
      const hasCorrect = Object.values(rec.scored ?? {}).some((v) => v === "correct");
      if (onCloud && hasCorrect) { proven = true; where = `${f} (${host})`; break; }
    }
    expect(proven, "no run record from the deployed cloud webhook carries a correct verdict").toBe(true);
    expect(where).toContain(".n8n.cloud");
  });

  it("confidence came back reduced under conflicting evidence, measured", () => {
    /*
     * dod-3 "confidence reduction under conflicting evidence" needed a model
     * call: whether the model LOWERS the number when findings conflict cannot
     * be seen from a schema. conflicting-evidence declares both a ceiling
     * (max_confidence 0.6) and must_be_less_confident_than: container-oom, so
     * compareConfidences returns "correct" for it ONLY when the number is below
     * the ceiling AND below the comparable's. recordInto stores the raw state,
     * "correct-but-unqualified" and all — so a scored "correct" for the
     * conflicting-evidence attempt IS the reduction, not a flag over it.
     *
     * The comparable must have been scored in the SAME record: a comparison
     * nobody could make has not been made. This reads docs/runs, committed, so
     * the claim rests on the measurement of 2026-09-11 (0.55 against 0.92), and
     * goes red the moment that record leaves the tree.
     */
    const runs = join(ROOT, "docs", "runs");
    let proven = false;
    let where = "";
    for (const f of readdirSync(runs).filter((n) => n.endsWith(".json"))) {
      let rec: { scored?: Record<string, string> };
      try { rec = JSON.parse(readFileSync(join(runs, f), "utf8")); } catch { continue; }
      const scored = rec.scored ?? {};
      const conflictKey = Object.keys(scored).find(
        (k) => k.replace(/#.*/, "") === "conflicting-evidence" && scored[k] === "correct");
      if (!conflictKey) continue;
      const attempt = conflictKey.includes("#") ? conflictKey.slice(conflictKey.indexOf("#")) : "";
      const comparableKey = `container-oom${attempt}`;
      if (scored[comparableKey] === "correct") {
        proven = true;
        where = `${f} (${conflictKey} qualified against ${comparableKey})`;
        break;
      }
    }
    expect(proven,
      "no committed run scored conflicting-evidence 'correct' alongside its comparable at the same "
      + "attempt — the reduction the scenario is built to measure is unmeasured, or scored unqualified").toBe(true);
    expect(where).toContain("conflicting-evidence");
  });
});
