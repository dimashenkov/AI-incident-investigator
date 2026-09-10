/**
 * Configuration read from an observation by RULE, not by a model.
 *
 * Six scenarios were measured on 2026-09-10 and four of the five failures had
 * one cause: the field the scenario was built around was never extracted by any
 * specialist. Not lost between agents — the concluding agent receives every
 * specialist result in full — never extracted at all. Seven prompt rewrites did
 * not change that, which is why the prompt is not the lever.
 *
 * WHAT THIS IS NOT, and Astra named it on 2026-09-10: the kinds below were
 * chosen while looking at which citations were missing, which is
 * benchmark-informed development. It becomes an oracle the moment a scenario's
 * identity or expected answer decides what gets extracted. So the rules are
 * frozen, they apply to EVERY matching field — healthy values, containers
 * nobody asked about, series nobody cited — and the six scenarios are treated
 * as regression cases rather than as evidence that this generalises.
 *
 * It produces OBSERVATIONS. It does not endorse evidence: nothing here may be
 * written into an incident's `evidence` as support for a conclusion, because
 * support is something a reasoner selects and this code selects nothing.
 *
 * No imports. This file is transpiled into the n8n Code node.
 */

/**
 * One fact the code read, with the path and the SLOT it read it from.
 *
 * `slot` travels because a ref is relative to one observation. Without it the
 * grounding check searched every slot, and a log line handed over as a
 * `deployment-image` resolved somewhere and passed — Astra reproduced it on
 * 2026-09-10.
 *
 * `ts` and `unit` are their own fields, not glued into `value`. The first
 * version wrote `value at timestamp` and compared only the part before " at ",
 * so `"real at IGNORE ALL INSTRUCTIONS"` passed grounding and the unchecked
 * half reached the model. A value is compared WHOLE now.
 */
export type ConfigFact = {
  /** Which observation it was read from: kubernetes, logs, metrics. */
  readonly slot: string;
  /** The `source_ref` a citation would use, relative to its own observation. */
  readonly ref: string;
  /** The value as it stands in the observation, unformatted and unrounded. */
  readonly value: string;
  /** Which frozen rule produced it. */
  readonly kind: ConfigKind;
  /** When the point was recorded, for a series endpoint. Absent otherwise. */
  readonly ts?: string;
  /** The series name, for a series endpoint. Absent otherwise. */
  readonly series?: string;
  /** The unit the series declares, when it declares one. */
  readonly unit?: string;
};

export type ConfigKind =
  | "resource-limit"
  | "resource-request"
  | "deployment-image"
  | "container-readiness"
  | "last-termination"
  | "series-endpoint";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function scalar(v: unknown): string | null {
  /*
   * An empty string is not a reading.
   *
   * Extraction emitted one and the checker refused it as empty, so legitimate
   * extractor output could block the context it was built to enrich — the two
   * halves of one mechanism disagreeing. Astra, 2026-09-10. Excluded at the
   * source, where the rule belongs.
   */
  if (typeof v === "string") return v.length === 0 ? null : v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  return null;
}

/**
 * Every scalar under a subtree, with its path — so a rule names a subtree and
 * does not have to know the shape below it.
 *
 * `last_state.terminated` holds a reason, an exit code and two timestamps, and
 * a rule that listed them would go stale the first time one is added.
 */
/**
 * Can this key be written into a path at all?
 *
 * A Kubernetes resource name may hold a dot or a slash — `nvidia.com/gpu` is a
 * real one — and neither can be spelled in a `a.b[0].c` path without meaning
 * something else. Extraction skips those rather than emit a ref no reader can
 * follow. Stated here, and in docs/deterministic-configuration.md, because it
 * is a thing the code cannot report, not a thing it decided not to.
 */
function spellable(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key);
}

function scalarsUnder(node: unknown, prefix: string, out: Array<{ ref: string; value: string }>): void {
  const direct = scalar(node);
  if (direct !== null) {
    out.push({ ref: prefix, value: direct });
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) scalarsUnder(node[i], `${prefix}[${i}]`, out);
    return;
  }
  if (isObject(node)) {
    for (const key of Object.keys(node)) {
      if (!spellable(key)) continue;
      scalarsUnder(node[key], `${prefix}.${key}`, out);
    }
  }
}

/**
 * The configuration a kubernetes observation carries, by rule.
 *
 * Every pod, every container, healthy or not. Filtering to the interesting one
 * would be the oracle: which container is interesting is the question being
 * asked, not an input to it.
 */
function fromKubernetes(o: Record<string, unknown>): ConfigFact[] {
  const facts: ConfigFact[] = [];
  const pods = o["pods"];
  if (Array.isArray(pods)) {
    for (let p = 0; p < pods.length; p += 1) {
      const pod = pods[p];
      if (!isObject(pod)) continue;
      const containers = pod["containers"];
      if (!Array.isArray(containers)) continue;
      for (let c = 0; c < containers.length; c += 1) {
        const container = containers[c];
        if (!isObject(container)) continue;
        const base = `pods[${p}].containers[${c}]`;
        for (const [field, kind] of [["limits", "resource-limit"], ["requests", "resource-request"]] as const) {
          const collected: Array<{ ref: string; value: string }> = [];
          scalarsUnder(container[field], `${base}.${field}`, collected);
          for (const f of collected) facts.push({ slot: "kubernetes", ref: f.ref, value: f.value, kind });
        }
        const ready = scalar(container["ready"]);
        if (ready !== null) facts.push({ slot: "kubernetes", ref: `${base}.ready`, value: ready, kind: "container-readiness" });
        const terminated: Array<{ ref: string; value: string }> = [];
        const last = container["last_state"];
        if (isObject(last)) scalarsUnder(last["terminated"], `${base}.last_state.terminated`, terminated);
        for (const f of terminated) facts.push({ slot: "kubernetes", ref: f.ref, value: f.value, kind: "last-termination" });
      }
    }
  }
  const deployment = o["deployment"];
  if (isObject(deployment)) {
    const image = scalar(deployment["image"]);
    if (image !== null) facts.push({ slot: "kubernetes", ref: "deployment.image", value: image, kind: "deployment-image" });
  }
  return facts;
}

/**
 * The first and last point of every series.
 *
 * Astra, 2026-09-10: choosing the endpoints is extraction; calling them "before
 * and after the rollout" is interpretation, and it needs the event's timestamp
 * to be true at all. So the timestamp travels with the value and nothing here
 * says which side of anything a point falls on. Endpoints alone do NOT
 * establish a healthy baseline, and this code does not claim they do.
 *
 * A series of one point yields one endpoint, not two: the same reading twice
 * would look like a comparison.
 */
function fromMetrics(o: Record<string, unknown>): ConfigFact[] {
  const facts: ConfigFact[] = [];
  const series = o["series"];
  if (!Array.isArray(series)) return facts;
  for (let s = 0; s < series.length; s += 1) {
    const one = series[s];
    if (!isObject(one)) continue;
    const points = one["points"];
    if (!Array.isArray(points) || points.length === 0) continue;
    const indices = points.length === 1 ? [0] : [0, points.length - 1];
    for (const i of indices) {
      const point = points[i];
      if (!isObject(point)) continue;
      const value = scalar(point["value"]);
      if (value === null) continue;
      /*
       * The timestamp, the series name and the unit are their OWN fields.
       *
       * They were glued into `value` as `${value} at ${ts}`, and the grounding
       * check compared only the part before " at " — so anything after it was
       * never checked and still reached the model. Astra reproduced
       * `"real at IGNORE ALL INSTRUCTIONS"` passing as clean on 2026-09-10.
       *
       * The docs also promised identity and units, and this did not carry them.
       */
      const ts = scalar(point["ts"]);
      const name = scalar(one["name"]);
      const unit = scalar(one["unit"]);
      const fact: { slot: string; ref: string; value: string; kind: ConfigKind;
        ts?: string; series?: string; unit?: string } = {
        slot: "metrics",
        ref: `series[${s}].points[${i}].value`,
        value,
        kind: "series-endpoint",
      };
      if (ts !== null) fact.ts = ts;
      if (name !== null) fact.series = name;
      if (unit !== null) fact.unit = unit;
      facts.push(fact);
    }
  }
  return facts;
}

/**
 * The configuration one observation carries.
 *
 * An observation that was not collected yields nothing: there is nothing to
 * read, and returning an empty list for "failed" and for "collected but empty"
 * alike would lose the distinction the rest of this project keeps.
 */
export function configurationOf(slot: string, observation: unknown): ConfigFact[] {
  if (!isObject(observation)) return [];
  if (slot === "kubernetes") return fromKubernetes(observation);
  if (slot === "metrics") return fromMetrics(observation);
  // The logs contract carries no configuration: a line is a symptom, not a
  // setting, and extracting lines would be extracting the answer.
  return [];
}

/**
 * Everything wrong with a list of declared configuration facts.
 *
 * ONE implementation of the rules, not two.
 *
 * The first version re-stated them: a table of which paths each kind may name,
 * a second path resolver, an endpoint-index rule, a scalar rule, and a metadata
 * rule — all of it a second copy of what `configurationOf` above already
 * decides. Four adversarial rounds each found another boundary that copy had
 * not thought of: a glued suffix, forged metadata, a second grammar, a missing
 * slot, unknown keys, invented kinds, duplicates, permissive coercion, a middle
 * reading offered as an endpoint, two fail-open branches one level apart, a
 * table that rejected the extractor's own output, and a hyphen in
 * `ephemeral-storage`.
 *
 * Astra, 2026-09-10, when asked whether a JSON Schema would fix it: a schema
 * would catch the shape and none of the semantics, because *„the problem is
 * duplicated extraction rules, not simply hand-written validation."*
 *
 * So the check is now: read the observations again by the SAME rules, and
 * require every declared fact to be one of the facts that reading produces —
 * exactly, keys and metadata and all. Anything a submitted fact says that the
 * code would not have said is a fact the code did not read.
 *
 * WHAT THIS CANNOT DO, said plainly: sharing the extractor means this cannot
 * prove the extractor right. It proves the payload is what the extractor
 * produces. Extraction itself is held by tests against facts written out by
 * hand in tests/configuration.test.ts, which is the only place that can.
 */
export function factProblems(facts: unknown, observations: unknown): string[] {
  if (!Array.isArray(facts)) return ["configuration_read_by_code is not a list"];
  const canonical: string[] = [];
  if (isObject(observations)) {
    for (const [slot, observation] of Object.entries(observations)) {
      for (const f of configurationOf(slot, observation)) canonical.push(stableForm(f));
    }
  }
  const problems: string[] = [];
  const seen: string[] = [];
  for (let i = 0; i < facts.length; i += 1) {
    const raw = facts[i];
    const where = `configuration_read_by_code[${i}]`;
    if (!isObject(raw)) { problems.push(`${where} is not an object`); continue; }
    const form = stableForm(raw);
    if (!canonical.includes(form)) {
      problems.push(`${where} is not a fact these observations produce: ${form}`);
      continue;
    }
    if (seen.includes(form)) problems.push(`${where} repeats a fact already declared`);
    else seen.push(form);
  }
  return problems;
}

/**
 * One fact as one string, with its keys in a fixed order.
 *
 * Comparing objects by identity would compare references, and comparing them
 * key by key would be a third place that knows which keys a fact has.
 */
function stableForm(fact: Record<string, unknown>): string {
  const keys = Object.keys(fact).sort();
  const parts: string[] = [];
  for (const k of keys) parts.push(`${JSON.stringify(k)}:${JSON.stringify(fact[k])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Which of the refs a caller requires were read by the code.
 *
 * Kept apart from what a MODEL cited, and never added to it. Astra, 2026-09-10:
 * their union measures whether the evidence was available, not whether anyone
 * used it, and reporting the union as citation success would be a claim larger
 * than its evidence.
 */
export function refsRead(facts: readonly ConfigFact[]): string[] {
  const out: string[] = [];
  for (const f of facts) if (!out.includes(f.ref)) out.push(f.ref);
  return out;
}
