/**
 * What the prototype has cost, read from artifacts rather than remembered.
 *
 * The owner asked on 2026-09-05: "I still want to know at the end how much the
 * whole prototype cost." A number I recall is a number I made up, so this reads
 * recorded runs and says plainly which part of the answer it cannot give.
 *
 * Two things are deliberately NOT added together:
 *
 *   - n8n model calls bill real credits, per call, from a balance that runs
 *     out. That is the spend.
 *   - Codex and Grok run on flat monthly subscriptions. One more run does not
 *     move the bill. Grok reports a `total_cost_usd`, and it is what the call
 *     WOULD have cost at API prices — a measure of weight, not an invoice.
 *     Adding it to the total would invent an expense nobody paid.
 *
 * Three states, as everywhere else: a cost is measured, or it is knowably
 * absent, or it could not be established. The third is reported, never folded
 * into the first two, and it decides the exit code.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = resolve(ROOT, "docs/runs");

/**
 * Published prices, in dollars per million tokens, with the date they were read.
 *
 * Written down rather than fetched: a price the script looks up would make the
 * report change under a reader for reasons that have nothing to do with the
 * work. Stale is visible; silently moving is not.
 */
export const PRICES = {
  "gpt-4o-mini-2024-07-18": { input: 0.15, output: 0.60, read: "2026-09-05" },
};

export function costOfRun(run) {
  const model = run?.model;
  const totals = run?.totals;
  if (typeof model !== "string" || typeof totals !== "object" || totals === null) {
    return { state: "unknown", why: "the run records no model or no totals" };
  }
  const price = PRICES[model];
  if (price === undefined) {
    return { state: "unknown", why: `no recorded price for ${model}; add it with the date it was read` };
  }
  // Codex, 2026-09-05: Number() turned null, "", false and -100 into finite
  // numbers, so a run with a negative token count came back "measured" and was
  // subtracted from the total in silence. A count is a non-negative integer of
  // type number, and anything else is unknown rather than coerced into one.
  const counted = (v, name) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      return { bad: `${name} is ${JSON.stringify(v)}, and a token count must be a non-negative whole number` };
    }
    return { ok: v };
  };
  const i = counted(totals.input_tokens, "input_tokens");
  const o = counted(totals.output_tokens, "output_tokens");
  if (i.bad !== undefined || o.bad !== undefined) {
    return { state: "unknown", why: [i.bad, o.bad].filter(Boolean).join("; ") };
  }
  const inTok = i.ok;
  const outTok = o.ok;
  return {
    state: "measured",
    usd: (inTok / 1e6) * price.input + (outTok / 1e6) * price.output,
    inTok, outTok, model,
  };
}

/**
 * Every run record under `dir`, INCLUDING subdirectories.
 *
 * The first version read one level. A subagent asked one question about this
 * file on 2026-09-07 and priced the gap: a record filed one directory down
 * carrying 500k input tokens was not "could not establish", it was INVISIBLE —
 * so `unknown` stayed zero, the floor qualification never printed, and the one
 * figure every report ends with came back $0.0002 with $0.195 sitting one level
 * away. The glob that reads a single level is in this project's own list of
 * defects; it was here.
 *
 * Depth is bounded so a symlink loop cannot hang the counter, and a directory
 * that cannot be listed is reported as unreadable rather than skipped.
 */
export function readRuns(dir = RUNS, depth = 6) {
  if (!existsSync(dir)) return { runs: [], unreadable: [`no ${dir}`] };
  const runs = [];
  const unreadable = [];
  const walk = (at, rel, left) => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch (e) {
      unreadable.push(`${rel || "."}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (left <= 0) {
          // Not skipped silently: a directory too deep to walk is unestablished
          // cost, and unestablished cost is what the floor qualification is for.
          unreadable.push(`${name}: nested deeper than this counter walks`);
          continue;
        }
        walk(join(at, e.name), name, left - 1);
        continue;
      }
      if (!e.name.endsWith(".json")) continue;
      try {
        runs.push({ name, run: JSON.parse(readFileSync(join(at, e.name), "utf8")) });
      } catch (err) {
        // A run that cannot be read is not a run that cost nothing.
        unreadable.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  walk(dir, "", depth);
  runs.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { runs, unreadable };
}

/**
 * Build the report as text, so tests can assert against what a reader SEES.
 *
 * Codex, 2026-09-05: a test that greps this file's source passes on the comment
 * explaining the line — the report lines could be deleted while the phrases
 * survived up here. Returning the text is what makes the assertion about the
 * report.
 */
export function report(dir) {
  const { runs, unreadable } = dir === undefined ? readRuns() : readRuns(dir);
  const lines = [];
  let total = 0;
  let unknown = 0;

  lines.push("WHAT THE PROTOTYPE HAS COST\n");
  lines.push("  Paid model calls — real credits, from recorded runs:");
  if (runs.length === 0) lines.push("    (no run is recorded under docs/runs)");
  for (const { name, run } of runs) {
    const c = costOfRun(run);
    if (c.state === "measured") {
      total += c.usd;
      lines.push(`    ${name}  $${c.usd.toFixed(4)}  ${c.inTok} in / ${c.outTok} out  ${c.model}`);
    } else {
      unknown += 1;
      lines.push(`    ${name}  COULD NOT ESTABLISH — ${c.why}`);
    }
  }
  // Counted BEFORE the total is qualified. Codex, 2026-09-05: unreadable files
  // were added to `unknown` after the "this is a floor" line was decided, so a
  // run nobody could parse reached the exit code while the report printed an
  // unqualified total. The warning and the exit code must come from the same
  // count, or the number a human reads disagrees with the number CI reads.
  for (const u of unreadable) { unknown += 1; lines.push(`    UNREADABLE ${u}`); }
  lines.push(`\n    measured total: $${total.toFixed(4)}`);
  if (unknown > 0) lines.push(`    ${unknown} run(s) could not be priced — the total above is a floor, not the answer`);

  lines.push("\n  On a subscription, so not part of that number:");
  lines.push("    codex exec   — flat monthly fee; one more run does not move the bill");
  lines.push("    grok -p      — flat monthly fee; its total_cost_usd is what the call would");
  lines.push("                   have cost at API prices, which is weight, not an invoice");

  lines.push("\n  Not counted anywhere, and nothing here can count it:");
  // Codex, 2026-09-05: "largest" was never measured. Asserting it here would be
  // the same defect this counter exists to prevent, in the report about cost.
  // What IS certain is that nothing here can see it.
  lines.push("    the Claude Code session you are reading, billed to the owner's plan");
  lines.push("    rather than to this repository. How it compares to the total above is");
  lines.push("    not measured by anything, and is therefore not claimed.");

  return { text: lines.join("\n") + "\n", unknown, total };
}

/**
 * The one line that goes in every report.
 *
 * Owner, 2026-09-05: "I want it to give me only one figure, and the breakdown
 * only if I ask. That figure I want appearing in the report."
 *
 * So the number is always visible and the detail never is unless asked. The
 * qualification travels WITH the number rather than in the detail: a figure
 * that is a floor must say so wherever it appears, or the one place it is read
 * is the one place it does not admit what it is missing.
 */
export function oneLine(dir) {
  const r = dir === undefined ? report() : report(dir);
  const money = `$${r.total.toFixed(4)}`;
  if (r.unknown > 0) {
    return `${money} — floor, ${r.unknown} run(s) could not be priced (npm run spend for the breakdown)`;
  }
  return `${money} in metered model calls (npm run spend for the breakdown)`;
}

function main() {
  if (process.argv.includes("--short")) {
    process.stdout.write(oneLine() + "\n");
    const r = report();
    process.exit(r.unknown > 0 ? 2 : 0);
  }
  const r = report();
  process.stdout.write(r.text);
  // Three states: clean, nothing to price, could-not-establish.
  process.exit(r.unknown > 0 ? 2 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
