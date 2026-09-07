/**
 * How ready is this project, as a percentage, read from artifacts.
 *
 * Asked for by the owner on 2026-09-07: a readiness figure in every report.
 * The rule that shapes it is the same one that shapes the spend counter — the
 * number comes from files on disk, never from what the agent remembers. A
 * percentage the agent estimates is a percentage the agent invented.
 *
 * THREE STATES, NOT TWO, and this is where a readiness figure usually lies.
 * Every check is green, red, or UNESTABLISHED, and the third is reported as its
 * own number rather than folded into either. Counting unestablished as failure
 * understates a project that simply has not been asked yet; dropping it from
 * the denominator overstates one that cannot answer at all. Both readings are
 * wrong in the direction that flatters whoever is reporting.
 *
 * Exit codes follow the same split: 0 when everything is established and green,
 * 1 when something is established and red, 2 when something cannot be
 * established, 3 when both.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const green = (id, why) => ({ id, state: "green", why });
const red = (id, why) => ({ id, state: "red", why });
/*
 * `waits` splits the unestablished into what a paid run would answer and what
 * it would not. The split is read from the item's own `needs` field, never
 * judged here: on 2026-09-07 the one-line summary said all thirteen
 * unestablished checks "cannot be answered without a paid run", and two of them
 * waited on code that has not been written. A qualification that overstates
 * what money would buy is the same defect as a figure that overstates coverage.
 */
const unknown = (id, why, waits = "something else") => ({ id, state: "unestablished", why, waits });
const PAID = "a paid run";

/**
 * The ten Definition-of-Done items, each covered by tests that ran and passed.
 *
 * Coverage is not read from the list's own `covered` flag alone: that flag is
 * a claim, and the vitest report is what checks it. An item whose named test
 * did not run is unestablished, not covered — the distinction the acceptance
 * gate already makes, made the same way here so the two cannot disagree.
 */
export function definitionOfDone(root = ROOT, list = null, passedTitles = null) {
  const checks = [];
  if (list === null) return [unknown("definition-of-done", "the list was not supplied")];
  if (!Array.isArray(list) || list.length === 0) {
    return [unknown("definition-of-done", "the Definition-of-Done list is empty or unreadable")];
  }
  for (const item of list) {
    const id = `dod-${item.n}`;
    if (!item.covered) {
      const needs = item.needs ?? "something not built";
      checks.push(unknown(id, `${item.claim} — waits on ${needs}`,
        /model call/i.test(needs) ? PAID : "something else"));
      continue;
    }
    const names = Array.isArray(item.by) ? item.by : [];
    if (names.length === 0) {
      checks.push(unknown(id, `${item.claim} — claims coverage and names no test`));
      continue;
    }
    if (passedTitles === null) {
      checks.push(unknown(id, `${item.claim} — no test report, so coverage cannot be established`));
      continue;
    }
    const missing = names.filter((n) => !passedTitles.has(n));
    checks.push(missing.length === 0
      ? green(id, item.claim)
      : red(id, `${item.claim} — named tests did not run and pass: ${missing.join(", ")}`));
  }
  return checks;
}

/**
 * Every scenario, and whether a live run has actually answered it.
 *
 * `docs/runs/*.json` records what each paid run cost and what it did, but its
 * `outcome` is prose written for a human. Prose is not evidence a machine may
 * count, so a scenario is established here only when a run record carries a
 * machine-readable `scored` map — the scorer's own states, written when the run
 * happened. Everything else is unestablished, including scenarios whose result
 * I know perfectly well from reading the prose: knowing it is not recording it.
 */
export function scenariosMeasured(root = ROOT) {
  const dir = join(root, "scenarios");
  if (!existsSync(dir)) return [unknown("scenarios", "there is no scenarios directory")];
  const names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (names.length === 0) return [unknown("scenarios", "no scenarios exist")];

  const latest = latestScored(join(root, "docs", "runs"));
  return names.map((n) => {
    const state = latest.scored?.[n];
    if (state === undefined) {
      return unknown(`scenario-${n}`, latest.why ?? "no run record scores this scenario", PAID);
    }
    if (state === "correct") return green(`scenario-${n}`, `answered correctly in ${latest.file}`);
    /*
     * The scorer has its own third state and it must survive the journey here.
     *
     * Codex, 2026-09-07: every recorded state other than "correct" was mapped
     * to red, including the scorer's own "unestablished" — so recording that a
     * scenario went unanswered turned it from unknown into FAILED, which is the
     * exact collapse the rest of this file exists to refuse, committed by the
     * file that refuses it.
     */
    if (state === "unestablished") {
      return unknown(`scenario-${n}`, `not established in ${latest.file}`, PAID);
    }
    return red(`scenario-${n}`, `${state} in ${latest.file}`);
  });
}

/**
 * The newest run record that carries machine-readable scores.
 *
 * Newest by filename, because the records are named by date and nothing else
 * in them is ordered. A record without `scored` is skipped rather than treated
 * as an empty result: absent is not the same as nothing was answered.
 */
export function latestScored(runsDir) {
  if (!existsSync(runsDir)) return { scored: null, why: "docs/runs does not exist" };
  const files = readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort().reverse();
  for (const f of files) {
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(runsDir, f), "utf8"));
    } catch {
      continue;
    }
    const scored = rec?.scored;
    if (scored !== null && typeof scored === "object" && !Array.isArray(scored) && Object.keys(scored).length > 0) {
      return { scored, file: f, why: null };
    }
  }
  return { scored: null, file: null,
    why: `no run record carries machine-readable scores (${files.length} record${files.length === 1 ? "" : "s"} read)` };
}

/**
 * The build itself: the last gate result the repository can show.
 *
 * `out/` is gitignored, so this check is unestablished in a fresh clone rather
 * than green or red. That is the honest reading and not a gap to paper over: a
 * gate result nobody has produced here is not a gate result.
 */
export function gateResult(root = ROOT) {
  const path = join(root, "out", "acceptance-gate.json");
  if (!existsSync(path)) {
    return [unknown("gate", "out/acceptance-gate.json is absent — the gate has not run here")];
  }
  try {
    const r = JSON.parse(readFileSync(path, "utf8"));
    if (typeof r.exitCode !== "number") return [unknown("gate", "the recorded gate result names no exit code")];
    if (r.exitCode === 0) return [green("gate", "the acceptance gate passed")];
    return [red("gate", `the acceptance gate exited ${r.exitCode}`)];
  } catch (e) {
    return [unknown("gate", `out/acceptance-gate.json is unreadable: ${e instanceof Error ? e.message : String(e)}`)];
  }
}

export function summarise(checks) {
  const total = checks.length;
  const g = checks.filter((c) => c.state === "green").length;
  const r = checks.filter((c) => c.state === "red").length;
  const u = checks.filter((c) => c.state === "unestablished").length;
  /*
   * Rounded DOWN, so a readiness figure never reads higher than the checks
   * support. 99% must not appear until everything but one is green.
   */
  const pct = total === 0 ? 0 : Math.floor((g / total) * 100);
  const unknownPct = total === 0 ? 0 : Math.floor((u / total) * 100);
  const paid = checks.filter((c) => c.state === "unestablished" && c.waits === PAID).length;
  return { total, green: g, red: r, unestablished: u, waitingOnMoney: paid,
    waitingOnWork: u - paid, percent: pct, unestablishedPercent: unknownPct };
}

/**
 * The bar, in three characters rather than two.
 *
 * Asked for by the owner on 2026-09-07, next to the percentage. A two-character
 * bar — filled and empty — would have to draw unestablished as empty, and empty
 * reads as "not done yet" when the truth is "not asked yet". Those are different
 * answers everywhere else in this project, so they are different here too.
 *
 *   █  green: established and passing
 *   ▒  unestablished: nobody has asked
 *   ░  red: established and failing
 *
 * Widths are floored and the remainder goes to the LAST segment drawn, so the
 * bar is always exactly `width` characters and the green block never rounds up
 * into a cell it has not earned.
 */
export function bar(s, width = 28) {
  /*
   * No checks at all is not a finished project.
   *
   * Codex, 2026-09-07: `bar(summarise([]), 5)` returned five full green cells,
   * because with nothing counted there is no unestablished and no red, so the
   * remainder fell through to green. A bar drawn entirely green for a project
   * nobody has measured is the worst single output this file could produce.
   */
  if (s.total === 0) return "▒".repeat(width);
  const cell = (n) => (s.total === 0 ? 0 : Math.floor((n / s.total) * width));
  const g = cell(s.green);
  const u = cell(s.unestablished);
  const r = cell(s.red);
  const drawn = g + u + r;
  /*
   * The leftover cells belong to whichever state is actually present, and never
   * to green: a bar that pads with green reports work nobody did. Preference
   * goes to unestablished, then red, and only to green when it is all there is.
   */
  const pad = width - drawn;
  const extraToUnknown = s.unestablished > 0 ? pad : 0;
  const extraToRed = s.unestablished === 0 && s.red > 0 ? pad : 0;
  const extraToGreen = s.unestablished === 0 && s.red === 0 ? pad : 0;
  return "█".repeat(g + extraToGreen) + "▒".repeat(u + extraToUnknown) + "░".repeat(r + extraToRed);
}

/**
 * The one line that goes in every report.
 *
 * The qualification travels WITH the figure and not in a breakdown underneath
 * it, for the same reason the spend counter carries its floor: the single place
 * the number is read must be the place that admits what it does not know.
 */
export function oneLine(s) {
  const head = `${bar(s)} readiness ${s.percent}% — ${s.green} of ${s.total} checks green`;
  if (s.unestablished === 0) return `${head}, ${s.red} red`;
  const parts = [];
  if (s.waitingOnMoney > 0) parts.push(`${s.waitingOnMoney} wait on a paid run`);
  if (s.waitingOnWork > 0) parts.push(`${s.waitingOnWork} on work not yet done`);
  return `${head}, ${s.red} red, ${s.unestablished} unestablished — ${parts.join(", ")}`;
}

export function format(checks, s) {
  const lines = ["", "HOW READY THIS PROJECT IS, FROM ARTIFACTS ON DISK", ""];
  for (const c of checks) {
    const mark = c.state === "green" ? "GREEN " : c.state === "red" ? "RED   "
      : c.waits === PAID ? "UNEST$" : "UNEST.";
    lines.push(`  ${mark}  ${c.id.padEnd(34)} ${c.why}`);
  }
  lines.push("", `  ${oneLine(s)}`, "",
    "  █ green   ▒ nobody has asked   ░ established and failing", "",
    "  Unestablished is its own answer. Counting it as failure understates a",
    "  project that has not been asked yet; dropping it overstates one that",
    "  cannot answer at all.", "");
  return lines.join("\n");
}

export function collect(root = ROOT, list = null, passedTitles = null) {
  return [...definitionOfDone(root, list, passedTitles), ...scenariosMeasured(root), ...gateResult(root)];
}

async function main() {
  let list = null;
  try {
    ({ DEFINITION_OF_DONE: list } = await import("./definition-of-done.mjs"));
  } catch { /* left null: unestablished, not zero */ }

  let passedTitles = null;
  const report = resolve(ROOT, "out/vitest-report.json");
  if (existsSync(report)) {
    try {
      const json = JSON.parse(readFileSync(report, "utf8"));
      passedTitles = new Set((json.testResults ?? []).flatMap((f) =>
        (f.assertionResults ?? []).filter((t) => t.status === "passed").map((t) => t.title)));
      if (passedTitles.size === 0) passedTitles = null;
    } catch { passedTitles = null; }
  }

  const checks = collect(ROOT, list, passedTitles);
  const s = summarise(checks);
  const short = process.argv.includes("--short");
  process.stdout.write(short ? `${oneLine(s)}\n` : format(checks, s));
  process.exit((s.red > 0 ? 1 : 0) + (s.unestablished > 0 ? 2 : 0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
