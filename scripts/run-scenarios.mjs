/**
 * Issue the paid runs and write down what came back — nobody's memory in between.
 *
 * The protocol in docs/next-measurement.md says the answers are recorded at the
 * moment they arrive, not afterwards from the round log. Until this file
 * existed there was nothing that could do that: every earlier run was typed in
 * by hand from what the n8n screen showed, and a number a person retypes is a
 * number nobody can check.
 *
 * THIS SCRIPT SPENDS MONEY. Each scenario it names is one execution of the
 * deployed workflow, and that workflow calls a model. It is never run without
 * the owner's word, and it never retries on its own: a retry is a second
 * payment for the same question, which is how one permission becomes three
 * bills.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, realpathSync, openSync, fsyncSync, closeSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIOS = join(ROOT, "scenarios");

/**
 * Read `.env` into the environment, without ever printing what it holds.
 *
 * The webhook address is not a password, but anyone holding it can make the
 * deployed workflow call a model — so it lives in a gitignored file rather than
 * in a chat log or a shell history. A value already set in the environment
 * WINS: the file is a fallback, not an override, so a deliberate one-off cannot
 * be silently replaced by a stale line in a file.
 *
 * It never echoes a value. Checking a secret by printing it is how a secret
 * ends up in the transcript that was written to keep it out.
 */
export function loadEnvFile(text, env) {
  const named = [];
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith("#")) continue;
    const at = t.indexOf("=");
    if (at <= 0) continue;
    const key = t.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = t.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    }
    /*
     * Set is set, and an empty value is a choice.
     *
     * The first version skipped only a NON-EMPTY existing value, so
     * `N8N_WEBHOOK_URL=` — an operator deliberately blanking the address —
     * was refilled from the file, and the run went to whatever instance the
     * file still named. Grok, 2026-09-08, before the first paid call.
     */
    if (env[key] !== undefined) continue;
    env[key] = value;
    named.push(key);
  }
  return named;
}

if (existsSync(join(ROOT, ".env"))) {
  loadEnvFile(readFileSync(join(ROOT, ".env"), "utf8"), process.env);
}

/**
 * Write a file so that a kill leaves either the old content or the new one.
 *
 * `writeFileSync` truncates in place, so a process killed mid-write leaves an
 * empty or half-written file — and the file being written here is the record of
 * money already spent. Both reviewers reached it independently on 2026-09-08.
 * Temp file, fsync, rename: rename is atomic within one filesystem, and fsync
 * is what makes the bytes survive a host crash rather than sitting in a cache.
 */
/**
 * Which of the two files is written first, and it depends on the direction.
 *
 * Before a call the cautious half is the RECORD: "may have been charged" must
 * survive a kill. After a successful call the cautious half is the ANSWERS —
 * writing a record saying `answered` and dying before the answer left a record
 * claiming the key was answered with no answer anywhere, and the restart check
 * ignores `answered`, so it paid again. Codex and Grok, independently,
 * 2026-09-08. One order applied in the wrong direction reopened the window it
 * was written to close.
 */
export function writeOrderFor({ answersFirst }) {
  return answersFirst ? ["answers", "record"] : ["record", "answers"];
}

let tmpCounter = 0;

/** A scratch name unique to this process and this call. */
export function tempNameFor(path, pid = process.pid) {
  return `${path}.${pid}.${tmpCounter += 1}.tmp`;
}

export function writeAtomic(path, text) {
  /*
   * A temporary name no other process can be holding.
   *
   * One shared `${path}.tmp` meant two runs at once wrote the same scratch file
   * and the last rename won, losing bodies that had been paid for. Grok,
   * 2026-09-08. The pid and a counter make the name unique, and `wx` refuses
   * rather than overwrites if it somehow exists.
   */
  const tmp = tempNameFor(path);
  writeFileSync(tmp, text, { flag: "wx" });
  const fd = openSync(tmp, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

/** A key like `image-pull-failure#2` split into the scenario and the attempt. */
export function splitKey(key) {
  const at = String(key).lastIndexOf("#");
  if (at === -1) return { scenario: String(key), attempt: null };
  const n = String(key).slice(at + 1);
  if (!/^\d+$/.test(n)) return { scenario: String(key), attempt: null };
  return { scenario: String(key).slice(0, at), attempt: Number(n) };
}

/**
 * The alert a scenario is triggered by, or why it could not be read.
 *
 * Three states rather than two: an alert that is missing and an alert that is
 * unreadable are different problems, and neither is "the run failed".
 */
export function alertFor(scenario, root = SCENARIOS) {
  const path = join(root, scenario, "alert.json");
  if (!existsSync(path)) return { state: "missing", why: `${scenario}/alert.json does not exist` };
  try {
    const alert = JSON.parse(readFileSync(path, "utf8"));
    if (alert === null || typeof alert !== "object" || Array.isArray(alert)) {
      return { state: "unreadable", why: `${scenario}/alert.json is not an object` };
    }
    return { state: "known", alert };
  } catch (e) {
    return { state: "unreadable", why: `${scenario}/alert.json could not be parsed: ${e.message}` };
  }
}

/**
 * What one call produced, in the three states this project keeps apart.
 *
 * `answered` carries the body whatever it says — a refusal by the chain is an
 * ANSWER and is scored as one. `unreachable` is this script failing to get a
 * reply at all, which is not the model's fault and must never be recorded as
 * the model's answer. `unreadable` is a reply that arrived and was not JSON.
 */
export async function callOnce(url, alert, { fetchImpl = fetch, timeoutMs = 300000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    /*
     * A redirect is not followed, because following it POSTs again.
     *
     * 307 and 308 preserve the method and the body, so a redirect arriving
     * AFTER the workflow has already run replays the whole paid execution at
     * the new address — one authorisation, two bills, and the second one
     * invisible. Codex, 2026-09-08. `redirect: "error"` turns it into a
     * transport failure, which this script records and never retries.
     */
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(alert),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { state: "unreachable", why: `HTTP ${res.status}`, body: text.slice(0, 500) };
    }
    try {
      return { state: "answered", answer: JSON.parse(text), status: res.status };
    } catch (e) {
      return { state: "unreadable", why: `the reply was not JSON: ${e.message}`, body: text.slice(0, 500) };
    }
  } catch (e) {
    /*
     * A timeout is NOT a reason to call again. The execution may well have run
     * and been billed; a second call is a second bill for the same question,
     * recorded as if it were the same run. Grok, 2026-09-05: "one yes
     * authorizes one run; a retry is a new run."
     */
    return { state: "unreachable", why: `no reply: ${e.name === "AbortError" ? `timed out after ${timeoutMs}ms` : e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge new answers into an answers file without unsaying an earlier one.
 *
 * The run is bought in parts, so this file is written more than once. A key
 * that already carries an answer is never overwritten here: replacing it would
 * throw away a measurement that was paid for.
 */
export function mergeAnswers(before, arriving) {
  const out = { ...(before ?? {}) };
  const refused = [];
  for (const [key, value] of Object.entries(arriving)) {
    if (Object.prototype.hasOwnProperty.call(out, key)) { refused.push(key); continue; }
    out[key] = value;
  }
  return { answers: out, refused };
}

/**
 * Does this failure mean the ADDRESS is wrong, rather than this one run?
 *
 * Grok, 2026-09-08: after key 1 came back unreachable, keys 2 and 3 were still
 * POSTed to the same URL — so one wrong address bought the whole list, three
 * times over. A reply that never arrived, or one the server refused on
 * authentication or routing, says nothing about the next scenario and
 * everything about where the calls are going.
 */
export function addressIsWrong(r) {
  if (r.state !== "unreachable") return false;
  const m = /^HTTP (\d+)$/.exec(String(r.why ?? ""));
  if (m === null) return true;                 // no reply at all: DNS, refused, redirect, timeout
  const code = Number(m[1]);
  return code === 401 || code === 403 || code === 404 || code === 405;
}

/**
 * Did this call possibly leave a charge with no answer to show for it?
 *
 * A timeout is the worst case and used to be the one that disappeared: the
 * intent line said "may have been charged", and the timeout then overwrote it
 * with a plain transport failure, so the warning at the end never fired for the
 * one case that most deserved it. Grok, 2026-09-08.
 */
export function mayHaveBeenCharged(r) {
  if (r.state === "answered") return false;
  /*
   * The question is not "did it fail" but "did it fail BEFORE the workflow ran".
   *
   * The first version said yes only for a timeout, so a 200 carrying HTML — a
   * workflow that ran, was billed, and answered something this script could not
   * parse — and a 500 after execution both counted as ordinary failures, left
   * no in-flight mark, and a restart bought them again. Grok, 2026-09-08.
   *
   * Only a refusal at the door proves nothing ran: wrong path, wrong method, no
   * permission. Everything else may have been charged, and unknown falls to the
   * expensive side rather than the convenient one.
   */
  const m = /^HTTP (\d+)$/.exec(String(r.why ?? ""));
  if (m === null) return true;
  const code = Number(m[1]);
  return !(code === 401 || code === 403 || code === 404 || code === 405);
}

/**
 * Keys an EARLIER run record says were called with no reply recorded.
 *
 * The intent line survives a kill, and then nothing read it: a restart saw the
 * key missing from the answers file and paid for it again. Codex, 2026-09-08.
 * Evidence that a charge may exist is only evidence if something refuses to act
 * against it.
 */
export function inFlightFromRecords(runsDir, read = readFileSync, list = readdirSync) {
  const out = new Map();
  let names;
  try { names = list(runsDir).filter((f) => f.endsWith(".json")); } catch { return out; }
  for (const f of names) {
    let rec;
    try { rec = JSON.parse(read(join(runsDir, f), "utf8")); } catch { continue; }
    const outcomes = rec?.outcomes;
    if (outcomes === null || typeof outcomes !== "object") continue;
    for (const [k, v] of Object.entries(outcomes)) {
      if (typeof v === "string" && v.startsWith("called,")) out.set(k, f);
    }
  }
  return out;
}

/**
 * The run record, with what could not be established said as such.
 *
 * The webhook returns the chain's report and NOT the model's token usage —
 * `Collect` keeps only the reply. So on this path the token counts and the cost
 * are unestablished, and they are written as unestablished with the reason,
 * never as zero and never as a guess. `scripts/spend.mjs` reports a floor when
 * it sees this, which is the honest reading.
 */
export function recordShape(keys, { when, webhookHost, outcomes }) {
  return {
    note: "Issued by scripts/run-scenarios.mjs against the deployed workflow's webhook. "
      + "The reply carries the chain's report; it does not carry the model's token usage, because the "
      + "Collect nodes keep only the reply. Token counts and cost are therefore UNESTABLISHED on this "
      + "path, not zero — read them from the n8n execution and add them with a second edit if they are "
      + "wanted, and say that they were added by hand.",
    recorded: "at the moment the answers arrived, by the script that issued them",
    when,
    webhook_host: webhookHost,
    keys,
    outcomes,
    totals: {
      input_tokens: null,
      output_tokens: null,
      why: "the webhook reply carries no usage; nothing here could read it",
    },
    scored: null,
  };
}

/** The host of a URL, so a record says which instance answered without carrying a token. */
export function hostOf(url) {
  try { return new URL(url).host; } catch { return "unreadable"; }
}

/** Flags that take a value, so the value is never mistaken for a run to buy. */
export const VALUED_FLAGS = ["--answers", "--record"];

/**
 * Split argv into keys and flags.
 *
 * The first version took "everything not starting with --" as a key, so
 * `--record oom-killed thing#2` bought TWO runs: the wanted one, and the path
 * to the record. Grok found it before the first paid call, and it is the
 * cheapest kind of defect to find then and the most expensive to find after.
 */
export function parseArgv(argv) {
  const keys = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUED_FLAGS.includes(a)) { flags[a] = argv[i + 1] ?? null; i += 1; continue; }
    if (a.startsWith("--")) { flags[a] = true; continue; }
    keys.push(a);
  }
  return { keys, flags };
}

/**
 * Everything that must be true before a single call is paid for.
 *
 * All of it is decided from files and arguments, so a mistake costs nothing.
 * A reason to stop, or null.
 */
/**
 * The two files this script writes must not be the same file.
 *
 * Each call flushes the answers and then the record. Point `--answers` and
 * `--record` at one path and the second write erases the first: three paid
 * calls, `written` counted three, exit 0, and no answer anywhere. Codex found
 * it by walking main on 2026-09-08, before the script had ever been run.
 */
export function refuseAliasedPaths(answersAt, recordAt, real = realpathSync) {
  /*
   * Two names for one file are one file.
   *
   * Comparing the strings misses a symlink: two different paths, one pointing
   * at the other, both not yet existing, each write landing on the same inode.
   * Codex, 2026-09-08. The deepest ancestor that EXISTS is resolved, because
   * the files themselves may not exist yet.
   */
  const settled = (p) => {
    let at = resolve(p);
    const tail = [];
    for (let i = 0; i < 40; i++) {
      try { return join(real(at), ...tail); } catch { /* not there yet; go up */ }
      const up = dirname(at);
      if (up === at) return resolve(p);
      tail.unshift(at.slice(up.length + 1));
      at = up;
    }
    return resolve(p);
  };
  if (settled(answersAt) === settled(recordAt)) {
    return `--answers and --record both point at ${resolve(answersAt)}. The record would be written over `
      + "the answers after every call, so a paid run would keep nothing";
  }
  return null;
}

export function refuseToStart(keys, answersBefore, inFlight = new Map()) {
  const seen = new Set();
  for (const k of keys) {
    if (seen.has(k)) {
      return `${k} is named twice. Two calls under one key pay twice and keep one answer; `
        + "write the second as its own attempt, like name#2";
    }
    seen.add(k);
  }
  const unresolved = keys.filter((k) => inFlight.has(k));
  if (unresolved.length > 0) {
    return `${unresolved.map((k) => `${k} (in ${inFlight.get(k)})`).join(", ")} was called by an earlier `
      + "run and no reply was recorded, so it may already have been charged. Read the n8n execution and "
      + "either write the answer into the answers file or edit that record before calling again";
  }
  const already = keys.filter((k) => Object.prototype.hasOwnProperty.call(answersBefore ?? {}, k));
  if (already.length > 0) {
    return `${already.join(", ")} already carries an answer in the answers file. Paying again would `
      + "produce a body this script then throws away; write it as its own attempt, like name#2";
  }
  return null;
}

/** A record path that cannot quietly overwrite the record of an earlier run. */
export function recordPathFor(given, when, exists = existsSync) {
  const base = given ?? join(ROOT, "docs", "runs", `${when}-webhook-run.json`);
  if (!exists(resolve(base))) return resolve(base);
  for (let n = 2; n < 100; n++) {
    const tryIt = resolve(base.replace(/\.json$/, `-${n}.json`));
    if (!exists(tryIt)) return tryIt;
  }
  return null;
}

async function main() {
  const url = process.env.N8N_WEBHOOK_URL;
  const { keys, flags } = parseArgv(process.argv.slice(2));
  const answersAt = flags["--answers"] ? resolve(flags["--answers"]) : resolve(ROOT, "out/answers.json");

  if (url === undefined || url.length === 0) {
    process.stderr.write("N8N_WEBHOOK_URL is not set; this script has nothing to call\n");
    process.exit(2);
  }
  if (keys.length === 0) {
    process.stderr.write("usage: node scripts/run-scenarios.mjs <key> [key...] [--answers path] [--record path]\n"
      + "  a key is a scenario name, optionally with an attempt: image-pull-failure#2\n"
      + "  EVERY key is one paid execution of the deployed workflow\n");
    process.exit(2);
  }

  /*
   * Everything readable is read BEFORE any money is spent.
   *
   * A typo in a name, a duplicated key, an answers file that is not JSON — each
   * of these used to be discovered after the calls had been paid for, and one
   * of them (a corrupt answers file) threw AFTER the loop, so the bodies were
   * lost with the money. Grok, 2026-09-08.
   */
  let answersBefore = {};
  if (existsSync(answersAt)) {
    try {
      answersBefore = JSON.parse(readFileSync(answersAt, "utf8"));
    } catch (e) {
      process.stderr.write(`refusing to start: ${answersAt} exists and is not readable JSON (${e.message}). `
        + "Move it aside or point --answers somewhere else; nothing is called until it can be written.\n");
      process.exit(2);
    }
    if (answersBefore === null || typeof answersBefore !== "object" || Array.isArray(answersBefore)) {
      process.stderr.write(`refusing to start: ${answersAt} is not an object of answers\n`);
      process.exit(2);
    }
  }

  const plan = [];
  for (const key of keys) {
    const { scenario } = splitKey(key);
    const a = alertFor(scenario);
    if (a.state !== "known") {
      process.stderr.write(`refusing to start: ${a.why}\n`);
      process.exit(2);
    }
    plan.push({ key, alert: a.alert });
  }

  const when = new Date().toISOString().slice(0, 10);
  const recordAt = recordPathFor(flags["--record"] === true ? null : flags["--record"], when);
  if (recordAt === null) {
    process.stderr.write("refusing to start: could not find a free run-record path; a paid run must leave "
      + "an artifact, and one that overwrites another run's record is not an artifact\n");
    process.exit(2);
  }

  /*
   * Both places a record can be: the standard one and the one this run was
   * told to use.
   *
   * The scan looked only in `docs/runs`, while `--record` accepts any path — so
   * a run recorded elsewhere left its "may have been charged" mark somewhere
   * nothing read, and the next run with the same command paid for that key
   * again. Codex, 2026-09-09, walking the restart rather than the helper: the
   * test handed the helper the right directory, so it could not see the runner
   * looking in the wrong one.
   */
  const inFlight = new Map([
    ...inFlightFromRecords(join(ROOT, "docs", "runs")),
    ...inFlightFromRecords(dirname(recordAt)),
  ]);
  const stop = refuseToStart(keys, answersBefore, inFlight);
  if (stop !== null) {
    process.stderr.write(`refusing to start: ${stop}\n`);
    process.exit(2);
  }

  const aliased = refuseAliasedPaths(answersAt, recordAt);
  if (aliased !== null) {
    process.stderr.write(`refusing to start: ${aliased}\n`);
    process.exit(2);
  }

  // Prove the answers file can be written before anything is paid for. An
  // unwritable destination is a reason to stop, not an exception to leak.
  try {
    mkdirSync(dirname(answersAt), { recursive: true });
    writeAtomic(answersAt, `${JSON.stringify(answersBefore, null, 2)}\n`);
    mkdirSync(dirname(recordAt), { recursive: true });
  } catch (e) {
    process.stderr.write(`refusing to start: cannot write where the answers and the record must go `
      + `(${e instanceof Error ? e.message : String(e)})\n`);
    process.exit(2);
  }

  process.stdout.write(`\ncalling ${hostOf(url)} for ${plan.length} run(s). Each one is paid.\n`);
  process.stdout.write(`  answers → ${answersAt}\n  record  → ${recordAt}\n\n`);

  let answers = { ...answersBefore };
  const outcomes = {};
  let written = 0;
  let wroteEverything = true;
  /*
   * The RECORD is written first, then the answers.
   *
   * Both files describe the same moment, and one of them is going to be the
   * older one if the process dies between them. The record is the one that says
   * a charge may exist, so it is the one that must never be the stale half: an
   * answers file ahead of the record loses nothing, while a record ahead of the
   * answers is what tells the next run not to pay again.
   *
   * A failure to write is announced rather than thrown away. Grok, 2026-09-08:
   * a throw from here exited 1 and the "read the n8n execution" line never
   * printed, on a run that had already spent money.
   */
  const flush = ({ answersFirst = false } = {}) => {
    const writeRecord = () => writeAtomic(recordAt,
      `${JSON.stringify(recordShape(keys, { when, webhookHost: hostOf(url), outcomes }), null, 2)}\n`);
    const writeAnswers = () => writeAtomic(answersAt, `${JSON.stringify(answers, null, 2)}\n`);
    try {
      /*
       * The cautious half is written first, and which half that is DEPENDS.
       *
       * Before a call it is the record: "may have been charged" must survive a
       * kill. After a successful call it is the ANSWERS — Codex, 2026-09-08:
       * writing the record with `answered` first and dying before the answer
       * left a record saying the key was answered and no answer anywhere, and
       * `inFlightFromRecords` ignores `answered`, so a restart paid again. One
       * order, applied in the wrong direction, reopened the window it closed.
       */
      for (const which of writeOrderFor({ answersFirst })) {
        if (which === "answers") writeAnswers(); else writeRecord();
      }
      return true;
    } catch (e) {
      process.stderr.write(`\n  COULD NOT WRITE: ${e instanceof Error ? e.message : String(e)}\n`
        + "  Money may already have been spent. Read the n8n executions before calling anything again.\n");
      return false;
    }
  };

  for (const { key, alert } of plan) {
    process.stdout.write(`  ${key} … `);
    /*
     * The intent is on disk BEFORE the money leaves.
     *
     * Killed between the reply and the write, the old version left no trace at
     * all: the key looked unbought, a restart happily paid for it again, and
     * nothing anywhere said a call had been made. Codex, 2026-09-08. `called,
     * no reply recorded` is not a result — it is the one state that says a
     * charge may exist with no answer to show for it, and it survives a kill
     * because it is written first.
     */
    outcomes[key] = "called, no reply recorded — this key may have been charged";
    /*
     * If the intent could not be written, nothing is called.
     *
     * `flush` returned false and the caller ignored it, so a run that could not
     * record anything went on spending — and then printed "answers written" and
     * exited 0. Codex, 2026-09-08. A call whose evidence cannot be saved is a
     * charge nobody will ever see.
     */
    if (!flush()) {
      process.stderr.write("  stopping before this call: the intent could not be written, so a charge "
        + "would leave no evidence\n");
      wroteEverything = false;
      break;
    }
    const r = await callOnce(url, alert);
    const detail = `${r.state}: ${r.why}${typeof r.body === "string" && r.body.length > 0 ? ` | body: ${r.body}` : ""}`;
    /*
     * A call that may have been charged keeps saying so.
     *
     * The intent line was overwritten by the transport failure, so a TIMEOUT —
     * the case most likely to have run and been billed — ended up recorded as
     * an ordinary failure and dropped out of the warning at the end.
     */
    outcomes[key] = r.state === "answered" ? "answered"
      : mayHaveBeenCharged(r) ? `called, no reply recorded — this key may have been charged (${detail})`
        : detail;
    if (r.state === "answered") {
      const merged = mergeAnswers(answers, { [key]: r.answer });
      answers = merged.answers;
      process.stdout.write(`answered (state ${JSON.stringify(r.answer?.state ?? "none")})\n`);
    } else {
      // Nothing is retried here. A retry is a new run and needs its own word.
      process.stdout.write(`${r.state}: ${r.why}\n`);
    }
    /*
     * Written after EVERY call, not after the loop. Money already spent must be
     * on disk before the next call can fail, be interrupted, or hang.
     */
    /*
     * `written` counts what reached the DISK, not what reached memory.
     *
     * It used to be incremented on the merge, so the script could print "3
     * answers written" and exit 0 with nothing saved.
     */
    const saved = flush({ answersFirst: r.state === "answered" });
    if (r.state === "answered" && saved) written += 1;
    if (!saved) {
      process.stderr.write("  stopping: the answer could not be written, and calling again would "
        + "spend without recording\n");
      wroteEverything = false;
      break;
    }
    /*
     * Any call that did not produce an answer stops the line.
     *
     * The first version stopped only when the failure looked like a wrong
     * ADDRESS, so a webhook answering HTML on every call, or a run of 500s,
     * still bought the whole list — each one possibly billed. Grok, 2026-09-08.
     *
     * The cheap direction is to stop and let a person look: a single flaky run
     * halts a batch that can be re-issued for the keys that are still unbought,
     * while continuing spends on a question nobody has answered yet.
     */
    if (r.state !== "answered") {
      process.stdout.write(`\n  stopping after ${key}: it produced no answer, so the remaining keys `
        + `were NOT called.${addressIsWrong(r) ? " That failure is about the address, not this scenario." : ""}\n`);
      break;
    }
  }

  process.stdout.write(`\n  ${written} answer(s) written into ${answersAt}\n`);
  process.stdout.write(`  run record: ${recordAt}\n`);
  const answered = Object.values(outcomes).filter((o) => o === "answered").length;
  process.stdout.write(`  ${answered} of ${keys.length} answered\n\n`);
  /*
   * Exit 0 only when every key was answered AND every answer was written.
   *
   * The first version compared HTTP outcomes alone, so calls whose bodies were
   * dropped on merge exited 0 — a run that paid and kept nothing, reported as
   * success. That path is now refused before it starts; the exit code no longer
   * relies on that being true.
   */
  const maybeCharged = Object.entries(outcomes).filter(([, v]) => String(v).startsWith("called,"));
  for (const [k] of maybeCharged) {
    process.stdout.write(`  ${k} was called and no reply was recorded; it may have been charged. `
      + "Read the n8n execution before asking for it again\n");
  }
  process.exit(answered === keys.length && written === keys.length
    && maybeCharged.length === 0 && wroteEverything ? 0 : 2);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
