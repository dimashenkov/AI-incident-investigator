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
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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

  /*
   * The newest ESTABLISHED verdict per scenario, across every record.
   *
   * This read one record — the newest that carried any scores — and the run is
   * bought in PARTS, so no single record holds every scenario. Measured on
   * 2026-09-07 minutes after it happened: part 1 established
   * readiness-probe-failure three times correct, part 2 was bought next, and
   * the figure fell from 36% back to 31% because part 2's record says nothing
   * about readiness-probe-failure. A later record that did not ASK a question
   * does not unanswer it.
   *
   * `unasked` and `unestablished` never overwrite a real verdict; a real
   * verdict from a newer record does overwrite an older one, because that is a
   * re-measurement.
   */
  const latest = latestScoredPerScenario(join(root, "docs", "runs"));
  return names.map((n) => {
    /*
     * Attempts count, and the WORST of them decides.
     *
     * A repeated measurement writes `image-pull-failure#1`, `#2`, `#3`, and
     * this read only the bare name — so three attempts of which one was wrong
     * could be reported green off a fourth, bare key, or ignored entirely.
     * Codex found the scoring half on 2026-09-08; this is the same defect one
     * reader over.
     *
     * The worst decides because the point of repeating is to separate a fix
     * from luck. Two correct and one wrong is not a fix, and a figure that
     * reported it as one would be exactly the flattery this file exists to
     * refuse.
     */
    const scored = latest.scored ?? {};
    const states = Object.keys(scored)
      .filter((k) => k === n || k.startsWith(`${n}#`))
      .map((k) => scored[k]);
    if (states.length === 0) {
      return unknown(`scenario-${n}`, latest.why ?? "no run record scores this scenario", PAID);
    }
    /*
     * Ranked, so the order the attempts happen to sit in decides nothing.
     *
     * `find` picked whichever failing state came first, so a scenario that was
     * both correct-without-its-evidence and correct-but-unqualified reported a
     * different reason depending on insertion order. Codex, 2026-09-08. Both
     * are red either way, so the figure did not move — the REASON moved, and a
     * reason that changes with the order is not a reading of anything.
     */
    /*
     * A row that says nobody asked is dropped when anything else answered.
     *
     * The scorer writes `unasked` for a scenario a part did not buy, and the
     * record keeps every part — so a scenario answered under three attempt keys
     * also carries a bare `unasked` row from the parts that asked something
     * else. Counting it would turn six correct measurements into two unanswered
     * scenarios, which Codex reproduced on 2026-09-08. If `unasked` is ALL
     * there is, it stands, because then nobody really did ask.
     */
    /*
     * The dropping of rows nobody asked happens ONCE, upstream, in
     * `latestScoredPerScenario` — and it drops `unestablished` too.
     *
     * It used to happen here as well, and only for `unasked`. Two carriers of
     * one rule, covering different sets: the upstream one made this one
     * redundant for `unasked` and this one never covered `unestablished`, so a
     * bare `unestablished` row outvoted three answered attempts while the
     * mutation guarding the rule survived — the gate said so on 2026-09-09.
     * Whatever arrives here has already been decided; the worst of it is taken.
     */
    const kept = states;
    const RANK = ["wrong", "correct-without-its-evidence", "correct-but-unqualified",
      "unestablished", "unasked", "correct"];
    const worst = RANK.find((r) => kept.includes(r))
      ?? kept.find((x) => x !== "correct") ?? "correct";
    const state = worst;
    const others = [...new Set(kept.filter((x) => x !== worst))].sort();
    const alsoSaid = state !== "correct" && others.length > 0 ? `; also ${others.join(", ")}` : "";
    const many = kept.length > 1 ? ` (${kept.length} attempts, worst kept${alsoSaid})` : "";
    if (state === "correct") return green(`scenario-${n}`, `answered correctly in ${recordFor(latest, n)}${many}`);
    /*
     * The scorer has its own third state and it must survive the journey here.
     *
     * Codex, 2026-09-07: every recorded state other than "correct" was mapped
     * to red, including the scorer's own "unestablished" — so recording that a
     * scenario went unanswered turned it from unknown into FAILED, which is the
     * exact collapse the rest of this file exists to refuse, committed by the
     * file that refuses it.
     */
    if (state === "unestablished" || state === "unasked") {
      return unknown(`scenario-${n}`, `not established in ${recordFor(latest, n)}${many}`, PAID);
    }
    return red(`scenario-${n}`, `${state} in ${recordFor(latest, n)}${many}`);
  });
}

/**
 * The newest run record that carries machine-readable scores.
 *
 * Newest by the `when` INSIDE the record, not by filename.
 *
 * Filename order was the first version, and a subagent priced it on 2026-09-07:
 * a record not named by date — `final-run.json`, or the very sentinel a debt
 * used to wait for — sorts above every `2026-…` in ASCII and becomes "the
 * newest", so a superseded run's greens could outlive the regression that
 * followed it. The date is data; the filename is a habit.
 *
 * A record with no readable `when` falls back to its filename and SAYS so, so
 * "I sorted this one by its name" is visible rather than assumed.
 *
 * A record without `scored` is skipped rather than treated as an empty result:
 * absent is not the same as nothing was answered.
 */
/**
 * For each scenario, the newest record that ESTABLISHED something about it.
 *
 * Built on latestScored's ordering — newest first by the date inside the record
 * — and stops at the same unreadable record, for the same reason: a record that
 * cannot be parsed has no date either, so nothing after it can be ordered.
 */
/** The scenario a scored key belongs to: `image-pull-failure#2` is one attempt at it. */
function base(key) {
  const i = key.indexOf("#");
  return i === -1 ? key : key.slice(0, i);
}

/** Whether a run record's verdict came from the primary model family (gpt-*), and so may
 *  supersede an older one. A record that names no model is primary — the gpt-5 era wrote no
 *  marker; only a record explicitly naming a non-gpt model (a grok fallback) is not. Reads
 *  both `model_by_agent` (per agent) and a top-level `model` string. */
export function recordIsPrimary(rec) {
  if (rec === null || typeof rec !== "object") return true;
  const mba = rec.model_by_agent;
  const perAgent = mba !== null && typeof mba === "object" && !Array.isArray(mba) ? Object.values(mba) : [];
  const top = typeof rec.model === "string" ? [rec.model] : [];
  const named = [...perAgent, ...top].filter((m) => typeof m === "string");
  return !named.some((m) => !m.startsWith("gpt-"));
}

export function latestScoredPerScenario(runsDir) {
  const ordered = orderedRecords(runsDir);
  if (ordered.unreadable !== undefined) {
    return { scored: null, file: ordered.file, unreadable: ordered.unreadable, why: ordered.why };
  }
  const scored = {};
  const from = {};
  /*
   * Two passes, because "asked and could not establish" and "never asked" are
   * different answers and this project keeps them apart everywhere else.
   *
   * The first pass takes only ESTABLISHED verdicts, oldest first, so a newer
   * real verdict overwrites an older one — that is a re-measurement. The second
   * fills in `unasked` and `unestablished` ONLY where nothing established
   * anything, so the record still says which of the two it was.
   *
   * The first version dropped them outright, and the branch downstream that
   * tells a recorded `unestablished` from a scenario no record mentions became
   * unreachable — the mutation guarding it survived, and the gate said so.
   */
  const fallback = {};
  const fallbackFrom = {};
  /*
   * The unit a re-measurement replaces is the SCENARIO, not the attempt key.
   *
   * Written oldest-first, key by key, an older `alpha#2: wrong` survived beside
   * a newer record that answered only `alpha#1` — so the worst-of rule reported
   * the scenario wrong from an attempt the newest measurement never made, and
   * attributed it to the newer file. Codex reproduced it on 2026-09-09.
   *
   * Newest first now: the first record that establishes ANYTHING for a scenario
   * claims it whole, and older records say nothing more about it.
   */
  const claimed = new Set();
  const fallbackClaimed = new Set();
  /*
   * A verdict from a non-primary model must not supersede one from the primary gpt family.
   *
   * latestScoredPerScenario took the newest record per scenario by date alone. A grok
   * fallback run (proven, exec 415) that was scored and recorded later would then override
   * the gpt-5 baseline it was never meant to replace — a newer grok `wrong` dragging a
   * scenario red off the fallback, or a grok `correct` masking a gpt-5 regression (Grok's
   * second carrier of the model-blind defect, 2026-09-14). So PRIMARY records claim first,
   * non-primary only where nothing primary established the scenario. The model is read from
   * the record if present; a record naming no model is treated as primary — the gpt-5 era
   * wrote no marker — so this demotes ONLY a record explicitly carrying a non-gpt model.
   *
   * LATENT, honestly (Grok, 2026-09-14): the recording path (recordInto/recordShape) does
   * NOT yet stamp model_by_agent into a docs/runs scored record, so a live grok-fallback
   * record is still unmarked here and this guard does not fire on it. The demotion logic is
   * correct and tested; it closes the defect only once a scored run record carries the
   * marker. See the readiness brick in docs/backlog.md — recorded as a limitation, not fixed.
   */
  for (const { f, rec } of [...ordered.records.filter((r) => recordIsPrimary(r.rec)),
                            ...ordered.records.filter((r) => !recordIsPrimary(r.rec))]) {
    const s = rec?.scored;
    if (s === null || typeof s !== "object" || Array.isArray(s)) continue;
    const here = new Set();
    const hereFallback = new Set();
    for (const [key, state] of Object.entries(s)) {
      if (state === "unasked" || state === "unestablished") {
        /*
         * Claimed by SCENARIO, exactly as an established verdict is.
         *
         * Merged key by key, a newer record saying `alpha: unasked` sat beside
         * an older record's `alpha#1` and `alpha#2`, and the reader reported
         * "not established in new.json (3 attempts)" — three, counting the
         * placeholder, and naming a file that holds only the placeholder while
         * the attempts came from another. Codex, 2026-09-09.
         */
        if (!fallbackClaimed.has(base(key))) {
          fallback[key] = state;
          fallbackFrom[key] = f;
          hereFallback.add(base(key));
        }
        continue;
      }
      if (claimed.has(base(key))) continue;
      scored[key] = state;
      from[key] = f;
      here.add(base(key));
    }
    for (const scenario of here) claimed.add(scenario);
    for (const scenario of hereFallback) fallbackClaimed.add(scenario);
  }
  /*
   * A fallback row is dropped when ANY established verdict exists for the SAME
   * SCENARIO — not merely under the same key.
   *
   * A repeated measurement writes `image-pull-failure#1`, `#2`, `#3`, while a
   * part that did not ask writes the bare `image-pull-failure`. Matching on the
   * exact key let the bare `unestablished` row survive beside three answered
   * attempts, and the scenario then reported `unestablished`, citing the older
   * file. Codex reproduced it on 2026-09-09. The rule this breaks is the one
   * the mutation `an-unasked-row-outvoting-the-attempts` already names.
   */
  const answered = new Set(Object.keys(scored).map(base));
  for (const [key, state] of Object.entries(fallback)) {
    if (Object.prototype.hasOwnProperty.call(scored, key)) continue;
    if (answered.has(base(key))) continue;
    scored[key] = state;
    from[key] = fallbackFrom[key];
  }
  if (Object.keys(scored).length === 0) {
    return { scored: null, file: null, why: ordered.why ?? "no run record establishes any scenario" };
  }
  return { scored, file: null, from, why: null };
}

/**
 * Every run record, newest first, or the one that could not be read.
 *
 * Factored out on 2026-09-07 so the ordering has ONE carrier: two readers with
 * their own copy of "which record is newest" is the second-carrier defect, and
 * this project has fixed it four times elsewhere today.
 */
/**
 * Which record a scenario's verdict came from.
 *
 * Per-scenario now, because the run is bought in parts and no single record
 * holds every scenario — so one filename for the whole answer would name the
 * wrong file for most of it.
 */
function recordFor(latest, scenario) {
  /*
   * ANY attempt of the scenario names the file, not just the bare key or `#1`.
   *
   * A record whose only verdict was `alpha#2` won the scenario and then lost
   * its filename, and the reader fell back to whatever `latest.file` held.
   * Codex noticed it on 2026-09-09 while checking the whole-scenario rule.
   */
  const from = latest.from ?? {};
  const key = Object.keys(from).find((k) => base(k) === scenario);
  return (key === undefined ? undefined : from[key]) ?? latest.file ?? "a run record";
}

/**
 * Compare two run filenames so that later run NUMBERS sort later, not later
 * strings.
 *
 * The tie-break between same-day records was `a.f < b.f` — a string compare —
 * so `...run-9.json` sorted after `...run-10.json` (because "1" < "9"), and the
 * ninth run of the day was taken as newer than the tenth. It worked only while
 * every run number had one digit. Measured on 2026-09-11: node-not-ready#3 was
 * scored correct in run-10 and readiness still reported run-9's older verdict.
 *
 * Natural order: split each name into digit and non-digit chunks and compare
 * digit chunks as numbers. Returns negative when A is older (smaller), positive
 * when A is newer, so callers wanting newest-first negate it.
 */
export function naturalOlderToNewer(a, b) {
  const chunk = (s) => s.match(/\d+|\D+/g) ?? [];
  const ca = chunk(a); const cb = chunk(b);
  for (let i = 0; i < Math.max(ca.length, cb.length); i += 1) {
    const x = ca[i]; const y = cb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x); const ny = /^\d+$/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d !== 0) return d; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function orderedRecords(runsDir) {
  if (!existsSync(runsDir)) return { records: [], why: "docs/runs does not exist" };
  const names = readdirSync(runsDir).filter((f) => f.endsWith(".json"));
  const dated = names.map((f) => {
    let when = null;
    let unreadable;
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(runsDir, f), "utf8"));
      /*
       * A date, not any non-empty string.
       *
       * Records are ordered by comparing `when` as TEXT, so `"unknown"` sorted
       * ahead of every real date and the record carrying it claimed a scenario
       * from the newest measurement — a wrong attempt was replaced by an older
       * correct one and readiness went green. Codex reproduced it on
       * 2026-09-09. Anything that is not YYYY-MM-DD is treated as undated, and
       * an undated record never outranks a dated one.
       */
      const w = rec?.when;
      if (typeof w === "string" && /^\d{4}-\d{2}-\d{2}$/.test(w)) when = w;
    } catch (e) {
      // Carried, not swallowed. The comment here used to promise it was decided
      // below and below was `catch { continue; }`.
      unreadable = e instanceof Error ? e.message : String(e);
    }
    /*
     * The parsed record is KEPT. It used to be thrown away and every file read
     * and parsed a second time below, outside any `catch` — so a record that
     * changed or vanished between the two reads made readiness THROW instead of
     * answering `unestablished`, and the mutation guarding the unreadable check
     * killed its named test with a SyntaxError rather than with the assertion
     * it names. Codex found both on 2026-09-09. One read, one parse, one answer.
     */
    return { f, when, unreadable, rec };
  });
  // Records with a date first, newest first; undated ones after, by name — an
  // undated record must never outrank a dated one it may well predate.
  dated.sort((a, b) => {
    if (a.when !== null && b.when !== null) return a.when < b.when ? 1 : a.when > b.when ? -1 : 0;
    if (a.when !== null) return -1;
    if (b.when !== null) return 1;
    return -naturalOlderToNewer(a.f, b.f);
  });
  /*
   * The comparator above returns 0 for two records with the SAME `when`, and
   * every real record carries a date without a time — so ties are the normal
   * case, and a stable sort then left the winner to `readdirSync` order. A
   * subagent scored two records of one day differently on 2026-09-07: the
   * second run of the day beat the sixth.
   *
   * The tie is broken by filename, descending, which is the same rule the
   * undated branch already uses — so one rule decides, in one direction.
   */
  dated.sort((a, b) => {
    if (a.when !== b.when) return 0;
    return -naturalOlderToNewer(a.f, b.f);
  });
  const broken0 = dated.find((d) => d.unreadable !== undefined);
  if (broken0 !== undefined) {
    // `unreadable` names the FILE, and `why` says what went wrong. They were one
    // field carrying the parse error, so a caller asking which file could not be
    // read got a message instead of a name.
    return { records: [], file: broken0.f, unreadable: broken0.f, detail: broken0.unreadable,
      why: `${broken0.f} could not be read (${broken0.unreadable}), so which run is the newest, `
        + "and what it scored, is unestablished" };
  }
  const records = dated.map((d) => ({ f: d.f, rec: d.rec }));
  return { records, why: null };
}

/** The newest record that carries any machine-readable scores. */
export function latestScored(runsDir) {
  const ordered = orderedRecords(runsDir);
  if (ordered.unreadable !== undefined) {
    return { scored: null, file: ordered.file, unreadable: ordered.unreadable, why: ordered.why };
  }
  /*
   * A record that cannot be READ is not a record that says nothing.
   *
   * This was `catch { continue; }` — silent — three lines under a comment
   * promising the opposite. A subagent truncated the newest record on
   * 2026-09-07 and readiness reported two green scenarios from an OLDER run,
   * with nothing anywhere admitting a file could not be read. The newest run
   * had scored one of them `wrong`.
   *
   * The check itself now lives ONCE, in `orderedRecords`, and the guard above
   * carries its answer here. A second copy stood in this function until
   * 2026-09-09: it read a list that no longer carried the field, so it could
   * never fire, and the mutation that guards this rule was breaking DEAD CODE
   * while the test kept passing. The gate said the mutation survived.
   */
  for (const { f, rec } of ordered.records) {
    const scored = rec?.scored;
    /*
     * A record ANSWERS only if something in it was established.
     *
     * Keys alone were enough here, and the scorer writes a key for every
     * scenario whatever happened. So a newer record of nothing but `unasked`
     * and `unestablished` — which the runner produces the moment a staged part
     * is scored — outranked an older record that actually carried verdicts, and
     * readiness then printed "no run record scores this scenario" while one on
     * disk did. Codex, 2026-09-08; the gate's own reader was strengthened the
     * same day and this one was not, which is the second-carrier defect again.
     */
    if (scored !== null && typeof scored === "object" && !Array.isArray(scored)
      && Object.values(scored).some((v) => v !== "unasked" && v !== "unestablished")) {
      return { scored, file: f, why: null };
    }
  }
  return { scored: null, file: null,
    why: `no run record carries machine-readable scores (${ordered.records.length} record${ordered.records.length === 1 ? "" : "s"} read)` };
}

/**
 * The first tracked source file newer than a moment, or null.
 *
 * Deliberately shallow and deliberately named: it walks the directories whose
 * contents the gate is about, and it returns the file it found rather than a
 * boolean, so the report can say WHICH edit outran the gate.
 */
export function sourceNewerThan(root, at, dirs = ["src", "scripts", "tests", "schemas", "prompts", "scenarios"]) {
  const stack = dirs.map((d) => join(root, d));
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      try {
        if (statSync(p).mtimeMs > at) return p.slice(root.length + 1);
      } catch { /* a file that vanished mid-walk is not evidence */ }
    }
  }
  return null;
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
    /*
     * A gate result older than the tree is not a statement about this tree.
     *
     * This said "the acceptance gate passed", present tense, from a file with
     * no date — so five mutations and a whole uncommitted diff could postdate
     * the green it was reporting. Found by a subagent on 2026-09-07, which read
     * the mtimes side by side. The same staleness the gate itself refuses for
     * the vitest report, one reader over.
     *
     * A result with no `finishedAt` predates this check and cannot be dated, so
     * it is unestablished rather than green — "I could not tell how old this
     * is" is not "it passed".
     */
    if (typeof r.finishedAt !== "number") {
      return [unknown("gate", "the recorded gate result carries no time, so it cannot be tied to this tree")];
    }
    const newer = sourceNewerThan(root, r.finishedAt);
    if (newer !== null) {
      return [unknown("gate", `the recorded gate result predates ${newer}, so it is not about this tree`)];
    }
    /*
     * The gate's four exit codes are FOUR, and this file folded them into two.
     *
     * `0` clean, `1` something failed, `2` something could not be established,
     * `3` both. Reading anything non-zero as red turned "nobody could tell" into
     * "it failed" — in the file whose own header says THREE STATES, NOT TWO, and
     * this is where a readiness figure usually lies. A subagent found it on
     * 2026-09-09, and the test that should have caught it pinned the collapse
     * instead: `exitCode: 2` was asserted to be red.
     *
     * `3` is red, because it carries a real failure alongside the unknown.
     */
    if (r.exitCode === 0) return [green("gate", "the acceptance gate passed")];
    if (r.exitCode === 2) {
      return [unknown("gate", "the acceptance gate could not establish some of its checks (exit 2)", "work not yet done")];
    }
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
