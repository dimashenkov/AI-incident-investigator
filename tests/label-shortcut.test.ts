/**
 * The label-shortcut guard (Grok's brick #3, 2026-09-13).
 *
 * On 2026-09-11 Grok found four fixtures whose event `reason` SPELLED the cause code
 * the scenario is built around — `VolumeFull`, `ConnectionPoolSaturated`,
 * `PacketDropped`, `CertificateExpired`. A real controller never emits those; the
 * model could read the label and hit the code WITHOUT reasoning. They were rewritten
 * to neutral, realistic reasons, with the diagnosis left in the cited `message`.
 *
 * This test LOCKS that fix: no fixture `reason` may normalise to a schema cause code
 * — so a fabricated code-spelling reason cannot creep back in. Grok's own caveat is
 * honoured: REAL Kubernetes reasons that happen to coincide (the node controller
 * really does emit `NodeNotReady`) are allowed, via a small documented allowlist —
 * the ban is on schema-code spellings, not on genuine kubelet/controller reasons.
 *
 * The codes are read from the schema, not retyped, so the two cannot drift apart.
 *
 * Scope, stated honestly: this catches an EXACT code SPELLING (a reason that
 * normalises to the code string). It does NOT catch a semantic HINT — a reason like
 * `PacketDropped` that gestures at NETWORK_POLICY_BLOCKED without spelling it. Those
 * were removed by hand on 2026-09-11 (to `EgressDrop`, `BackendLatency`, …) and have
 * no deterministic guard, because "does this word hint at the cause" is a judgement a
 * regex cannot make. This locks the spelling half, which is the mechanical half.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SCENARIOS = new URL("../scenarios/", import.meta.url).pathname;
const SCHEMA = new URL("../schemas/common.schema.json", import.meta.url).pathname;

/** The cause codes, from the schema's single source (common.schema.json $defs.causeCode). */
function causeCodes(): Set<string> {
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
  const enumv = schema?.$defs?.causeCode?.enum;
  if (!Array.isArray(enumv) || enumv.length === 0) {
    throw new Error("could not read $defs.causeCode.enum — this test would pass on nothing");
  }
  return new Set(enumv);
}

/** CamelCase / kebab / space → SCREAMING_SNAKE, the shape a cause code takes. So
 *  `NodeNotReady` and `Volume Full` both normalise to compare against the enum. */
function normalise(reason: string): string {
  return String(reason)
    // acronym boundary first: DNSResolution -> DNS_Resolution, CPUThrottling -> CPU_Throttling
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    // then the lower/digit -> Upper boundary: nodeNotReady -> node_Not_Ready
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();
}

/**
 * Real Kubernetes reasons that legitimately normalise to a cause code — allowed,
 * because a real cluster emits them (they are not fabricated labels). Each is here
 * on purpose; the scenario is still scored on its cited evidence, not this reason.
 * Adding to this list is a deliberate act, not a silent exception.
 */
const REAL_K8S_REASONS = new Set<string>([
  // The node controller's genuine reason, which coincides with NODE_NOT_READY. Grok,
  // 2026-09-13: allowlisting it does NOT hide a false positive — it admits a RESIDUAL
  // shortcut the test cannot remove, because the reason is real and equals the code.
  // In node-not-ready the must_cite is `events[0].message` ("status is now:
  // NodeNotReady"), so a model could cite that sentence and reach the code without
  // reasoning. The test cannot fix that (the reason is genuine); the scenario's design
  // must not let the reason alone win. Named here so it is not mistaken for clean.
  "NodeNotReady",
]);

/** Every `reason` a scenario's kubernetes fixture carries — events, pod conditions,
 *  and container state/last_state. */
function reasonsIn(scenario: string): string[] {
  let k: Record<string, unknown>;
  try { k = JSON.parse(readFileSync(join(SCENARIOS, scenario, "kubernetes.json"), "utf8")); }
  catch { return []; }
  const out: string[] = [];
  const push = (r: unknown) => { if (typeof r === "string" && r) out.push(r); };
  for (const e of (Array.isArray(k.events) ? k.events : []) as Array<Record<string, unknown>>) push(e.reason);
  for (const p of (Array.isArray(k.pods) ? k.pods : []) as Array<Record<string, unknown>>) {
    for (const c of (Array.isArray(p.conditions) ? p.conditions : []) as Array<Record<string, unknown>>) push(c.reason);
    for (const cont of (Array.isArray(p.containers) ? p.containers : []) as Array<Record<string, unknown>>) {
      for (const st of ["state", "last_state"]) {
        const s = cont[st] as Record<string, Record<string, unknown>> | undefined;
        if (s && typeof s === "object") for (const phase of Object.values(s)) if (phase && typeof phase === "object") push(phase.reason);
      }
    }
  }
  return out;
}

describe("no fixture reason spells a cause code — the label-shortcut guard (Grok brick #3)", () => {
  const codes = causeCodes();
  const scenarios = readdirSync(SCENARIOS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

  it("has scenarios to check — this test must not pass on an empty set", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it("no event/condition/container reason normalises to a cause code, except a documented real k8s reason", () => {
    const offenders: string[] = [];
    for (const s of scenarios) {
      for (const reason of reasonsIn(s)) {
        if (codes.has(normalise(reason)) && !REAL_K8S_REASONS.has(reason)) {
          offenders.push(`${s}: reason "${reason}" spells ${normalise(reason)}`);
        }
      }
    }
    expect(offenders, `a fabricated code-spelling reason is a shortcut the model can read instead of reasoning:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("normalise splits ACRONYM boundaries, so a fabricated CPUThrottling/DNSResolutionFailure is caught (Grok 2026-09-13)", () => {
    // The first regex missed acronym-led spellings: CPUThrottling -> CPUTHROTTLING,
    // not CPU_THROTTLING, so a fabricated code-spelling would slip. It must normalise
    // to the code so the guard catches it.
    expect(normalise("CPUThrottling")).toBe("CPU_THROTTLING");
    expect(normalise("DNSResolutionFailure")).toBe("DNS_RESOLUTION_FAILURE");
    expect(codes.has(normalise("CPUThrottling")), "would be caught if a fixture used it").toBe(true);
    expect(codes.has(normalise("DNSResolutionFailure"))).toBe(true);
    // a neutral acronym reason is still not a code
    expect(codes.has(normalise("TLSHandshakeErrors"))).toBe(false);
  });

  it("the allowlist only holds reasons that genuinely coincide with a code — a stale entry is a dead exception", () => {
    // If a listed reason no longer normalises to any code, the exception is
    // pointless and should be removed rather than left to rot.
    for (const r of REAL_K8S_REASONS) {
      expect(codes.has(normalise(r)), `${r} is allowlisted but no longer spells a code — drop it`).toBe(true);
    }
  });
});
