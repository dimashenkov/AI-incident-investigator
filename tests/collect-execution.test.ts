/**
 * The reader that collects an answer already paid for.
 *
 * Two runs on 2026-09-11 came back HTTP 524 while both executions were
 * `status: success` in n8n. The answers existed and were unreachable, so this
 * reads them — with two GETs and no way to spend anything.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs, the same file node runs.
import { documentFrom, keyFor, FINAL_NODE } from "../scripts/collect-execution.mjs";

const finished = (report: unknown) => ({
  status: "success",
  finished: true,
  data: { resultData: { runData: { [FINAL_NODE]: [{ data: { main: [[{ json: report }]] } }] } } },
});

describe("four states, because two would lose a measurement", () => {
  it("collects the document the final node produced, verbatim", () => {
    const doc = { scenario: "container-oom", state: "concluded", confidence: 0.4 };
    const got = documentFrom(finished(doc));
    expect(got.state).toBe("collected");
    expect(got.document, "verbatim: rebuilding it from earlier nodes is how the shape drifts")
      .toEqual(doc);
  });

  it("calls a run that is still going PENDING, not absent", () => {
    /*
     * A run in flight and a run whose data is gone are different answers.
     * Folding either into "no answer" is what turns a retention window into a
     * lost measurement.
     */
    const got = documentFrom({ status: "running", finished: false });
    expect(got.state).toBe("pending");
  });

  it("calls an errored run FAILED, whatever its data says", () => {
    for (const status of ["error", "crashed", "canceled"]) {
      expect(documentFrom({ status, finished: true, data: {} }).state, `${status} is a failure`)
        .toBe("failed");
    }
  });

  it("calls a finished run with no data UNAVAILABLE, and says why", () => {
    /*
     * `includeData=true` is required, and without it the response is still 200
     * with no `data` key at all. A reader that treated that as "no answer"
     * would report a finished execution as empty — a missing field read as a
     * missing answer.
     */
    const got = documentFrom({ status: "success", finished: true });
    expect(got.state).toBe("unavailable");
    expect(got.why, "the reason must name includeData, or nobody will find it")
      .toMatch(/includeData=true/);
  });

  it("calls a finished run that never reached the final node UNAVAILABLE", () => {
    const got = documentFrom({ status: "success", finished: true,
      data: { resultData: { runData: { "Ask kubernetes": [] } } } });
    expect(got.state).toBe("unavailable");
    expect(got.why).toContain(FINAL_NODE);
  });

  it("reads nothing out of a non-object", () => {
    for (const bad of [null, undefined, "text", 7, []]) {
      expect(documentFrom(bad).state, `${JSON.stringify(bad)} is not an execution`)
        .toBe("unavailable");
    }
  });

  it("takes the LAST run of the final node, not the first", () => {
    const older = { scenario: "x", confidence: 0.1 };
    const newer = { scenario: "x", confidence: 0.9 };
    const got = documentFrom({ status: "success", finished: true, data: { resultData: { runData: {
      [FINAL_NODE]: [
        { data: { main: [[{ json: older }]] } },
        { data: { main: [[{ json: newer }]] } },
      ] } } } });
    expect(got.document, "a node that ran twice answered twice; the answer is the last one")
      .toEqual(newer);
  });
});

describe("which key an answer is filed under", () => {
  it("uses the key the caller gave", () => {
    expect(keyFor({ scenario: "container-oom" }, "container-oom#2")).toBe("container-oom#2");
  });

  it("falls back to the scenario the document names", () => {
    expect(keyFor({ scenario: "cpu-throttling" }, undefined)).toBe("cpu-throttling");
  });

  it("returns null rather than inventing one", () => {
    expect(keyFor({}, undefined), "a document that names no scenario is not filed under a guess")
      .toBeNull();
  });
});
