/**
 * The keep-rule and read glue in eval.mjs graded a comparison scenario in isolation.
 *
 * Grok's implementation review (2026-09-14): eval.mjs called the bare score(), never
 * compareConfidences, so `conflicting-evidence` came back "correct" — and stableGreen —
 * even when its confidence was NOT lower than `container-oom`'s. That is Definition-of-Done
 * item 3, the one comparison the scenario exists for, silently skipped in the very place
 * that decides whether a new prompt is kept. A prompt that fails the reduction could be
 * kept green.
 *
 * These tests feed k=3 attempts whose confidence does NOT reduce and require the bucket to
 * be a sticky problem, not a stable green — they pass only because scoredByScenario now
 * routes the whole bucket through compareConfidences. The vacuity guard asserts the bare
 * score still says "correct", so the comparison is the ONLY thing that turns it not-green:
 * against the old eval.mjs the same input was stableGreen.
 *
 * The second block covers the model-separation fix (Grok's #2): a `grok-*` fallback is a
 * different configuration and must not share a stickiness bucket with the `gpt-*` baseline,
 * but the unevenly-recorded model_by_agent (some runs list four agents, some one) must NOT
 * fragment that baseline — its k=3 stickiness would break.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs, the same file node runs.
import { scoredByScenario, statesForSet, bucketOf, setIdOf, fallbackTag } from "../scripts/eval.mjs";
// @ts-expect-error — plain .mjs script, no types
import { score, expectedFor } from "../scripts/score-run.mjs";
import { stickiness } from "../src/core/eval.js";

const SCENARIOS = new URL("../scenarios/", import.meta.url).pathname;

// The minimal answer-building helpers, kept in step with tests/score-run.test.ts: an answer
// scores "correct" only if its incident actually carries the paths its agents cite.
const SLOT_OF: Record<string, string> = {
  pods: "kubernetes", events: "kubernetes", deployment: "kubernetes",
  lines: "logs", series: "metrics",
};
const segs = (p: string) => p.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
const materialise = (refs: string[]) => {
  const obs: Record<string, any> = {};
  for (const ref of refs) {
    const path = segs(ref);
    const slot = SLOT_OF[path[0]!] ?? "logs";
    obs[slot] ??= {};
    let cur: any = obs[slot];
    for (let i = 0; i < path.length; i++) {
      const here = path[i]!;
      const key: any = /^\d+$/.test(here) ? Number(here) : here;
      if (i === path.length - 1) { cur[key] ??= "seen"; break; }
      const nextIsIndex = /^\d+$/.test(path[i + 1]!);
      cur[key] ??= nextIsIndex ? [] : {};
      cur = cur[key];
    }
  }
  return obs;
};
const agentsFor = (cited: string[]) => {
  const by = new Map<string, string[]>();
  for (const r of cited) {
    const slot = SLOT_OF[segs(r)[0]!] ?? "logs";
    by.set(slot, [...(by.get(slot) ?? []), r]);
  }
  if (by.size === 0) return [{ agent: "kubernetes", findings: [] as unknown[] }];
  return [...by.entries()].map(([agent, refs]) =>
    ({ agent, findings: refs.map((r) => ({ fact: "f", source_ref: r })) }));
};
const mustCiteOf = (scenario: string): string[] => expectedFor(scenario, SCENARIOS).mustCite;

/** A concluded answer that carries the paths it cites, its confidence, and `against`
 *  dissent — the two things a conflicting scenario is scored on. */
const qualified = (code: string, cited: string[], confidence: number, against: number) => {
  const a: Record<string, any> = {
    state: "concluded",
    root_cause_code: code,
    incident: {
      observations: { kubernetes: {}, logs: {}, metrics: {}, ...materialise(cited) },
      analysis: { agents: agentsFor(cited), confidence, evidence: [
        { source: "kubernetes", fact: "the container was OOMKilled", supports: "for" },
        ...Array.from({ length: against }, () => ({
          source: "metrics", fact: "memory never approached the limit", supports: "against",
        })),
      ] },
    },
  };
  for (const name of ["kubernetes", "metrics"]) {
    if (!a.incident.analysis.agents.some((g: any) => g.agent === name)) {
      a.incident.analysis.agents.push({ agent: name, findings: [] });
    }
  }
  return a;
};

const PV = { kubernetes: "v1", logs: "v1", metrics: "v1", "root-cause": "v1" };
const GPT5 = {
  kubernetes: "gpt-5-mini-2025-08-07", logs: "gpt-5-mini-2025-08-07",
  metrics: "gpt-5-mini-2025-08-07", "root-cause": "gpt-5-2025-08-07",
};
const withMeta = (a: any, models: any = GPT5) => ({ ...a, prompt_versions: PV, model_by_agent: models });

/** k=3 attempts of the conflict pair at chosen confidences, in ONE file (one execution, so
 *  compareConfidences pairs #N with #N inside it). scoredByScenario takes file -> answers. */
const conflictFile = (mineConf: number, theirsConf: number) => {
  const set: Record<string, any> = {};
  for (const n of [1, 2, 3]) {
    set[`conflicting-evidence#${n}`] = withMeta(qualified("CONTAINER_OOM", mustCiteOf("conflicting-evidence"), mineConf, 1));
    set[`container-oom#${n}`] = withMeta(qualified("CONTAINER_OOM", mustCiteOf("container-oom"), theirsConf, 0));
  }
  return { "run.json": set };
};

describe("eval.mjs applies the DoD-3 confidence comparison, not a bare score", () => {
  it("refuses to call conflicting-evidence stable-green when its confidence does not drop below container-oom", () => {
    const files = conflictFile(0.6, 0.6); // equal — not a reduction
    // Vacuity guard: the bare score says "correct", so the confidence comparison is the ONLY
    // thing that can make this bucket not-green. The old eval.mjs (bare score) made it green.
    expect(
      score("conflicting-evidence#1", files["run.json"]["conflicting-evidence#1"]).state,
      "bare score must say correct here, or this test proves nothing",
    ).toBe("correct");
    const byScenario = scoredByScenario(files);
    const s = stickiness(byScenario["conflicting-evidence"].map((r: any) => r.state));
    expect(s.stableGreen, "equal confidence on the contradicted and the clean case is not a reduction").toBe(false);
    expect(s.stickyProblem, "a comparison that was made and did not reduce is a real failure").toBe(true);
  });

  it("keeps conflicting-evidence green when its confidence IS genuinely lower", () => {
    const files = conflictFile(0.4, 0.6);
    const byScenario = scoredByScenario(files);
    const s = stickiness(byScenario["conflicting-evidence"].map((r: any) => r.state));
    expect(s.stableGreen, "a real reduction is the honest, green outcome").toBe(true);
  });

  it("does NOT collapse the same bare key across files into one attempt (the @file strip bug)", () => {
    // Three separate runs (three files), each a bare conflicting-evidence + container-oom pair
    // at equal confidence. Each pair is scored inside its own file. All three attempts must
    // survive — the earlier @file-strip made them one (last write wins), Grok 2026-09-14.
    const byKey: Record<string, any> = {};
    for (const f of ["a.json", "b.json", "c.json"]) {
      byKey[`conflicting-evidence@${f}`] = withMeta(qualified("CONTAINER_OOM", mustCiteOf("conflicting-evidence"), 0.6, 1));
      byKey[`container-oom@${f}`] = withMeta(qualified("CONTAINER_OOM", mustCiteOf("container-oom"), 0.6, 0));
    }
    const bucket = bucketOf(byKey["conflicting-evidence@a.json"]);
    const { stick, n } = statesForSet(byKey, bucket);
    expect(n, "six answers across three files, none collapsed").toBe(6);
    expect(stick["conflicting-evidence"].total, "three conflicting-evidence attempts, not one").toBe(3);
    expect(stick["conflicting-evidence"].stableGreen, "equal confidence is not a reduction, in every file").toBe(false);
  });
});

describe("eval.mjs separates a fallback model without fragmenting the gpt-5 baseline", () => {
  it("keeps every gpt-5 run — however many agents it recorded — in the primary bucket", () => {
    const promptOnly = setIdOf(PV); // the documented, prompt-only id (e.g. 2c121d3550c3-style)
    const full = withMeta(qualified("CONTAINER_OOM", [], 0.5, 0), GPT5);
    const partial = withMeta(qualified("CONTAINER_OOM", [], 0.5, 0), { kubernetes: "gpt-5-mini-2025-08-07" });
    expect(bucketOf(full), "the full gpt-5 map is the primary bucket").toBe(promptOnly);
    expect(bucketOf(partial), "fewer agents recorded is data noise, not a config change").toBe(promptOnly);
    expect(fallbackTag(GPT5), "all-gpt-5 carries no tag").toBe("");
  });

  it("puts a grok fallback in its own bucket, off the documented primary id", () => {
    const promptOnly = setIdOf(PV);
    const grok = withMeta(qualified("CONTAINER_OOM", [], 0.5, 0), {
      kubernetes: "grok-4.3", logs: "grok-4.3", metrics: "grok-4.3", "root-cause": "grok-4.3",
    });
    expect(bucketOf(grok), "grok is a different configuration").not.toBe(promptOnly);
    expect(bucketOf(grok)).toBe(promptOnly + "·grok-4.3");
    expect(fallbackTag({ kubernetes: "gpt-5-mini-2025-08-07", "root-cause": "grok-4.3" }),
      "one non-gpt agent is enough to tag the run a fallback").toBe("·grok-4.3");
  });
});
