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
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, realpathSync, openSync, fsyncSync, closeSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname, join, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

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

/*
 * The `.env` file is NOT read at import time. It is read inside `main`.
 *
 * At module level it poisoned every process that merely IMPORTED this file:
 * a vitest worker that imports the runner carried the real paid address in its
 * own `process.env`, and any child it spawned with `{ ...process.env }` and no
 * explicit address inherited it — no mutation needed, nothing in the test
 * saying so. Found on 2026-09-11 by a subagent reading for this one class of
 * defect, after the gate had already been paying for its mutation runs.
 *
 * Importing a module must not change the environment of the process that
 * imported it.
 */
function loadDotEnvOnce(env = process.env) {
  const at = join(ROOT, ".env");
  if (!existsSync(at)) return [];
  return loadEnvFile(readFileSync(at, "utf8"), env);
}

/**
 * May this run call an address that is not on this machine?
 *
 * Only with `AI_SRE_LIVE=1` in the ENVIRONMENT of the invocation. Three
 * reasons, and the third is the one that was measured:
 *
 * 1. A paid call should be an explicit act, which is what the owner's rule
 *    about the word `харчи` says in prose. This is the same thing in code.
 * 2. A test never sets it, so no test can reach a paid instance — whatever
 *    happens to its address, its ledger, or its mutations.
 * 3. The earlier floor keyed on a temporary claims ledger, which guards the
 *    shape the test helper happens to use rather than "a test". A spawn that
 *    omitted the ledger went straight through it.
 *
 * And it may NOT come from the `.env` file, because that file is read by every
 * invocation including the ones under test. `loadEnvFile` answers with the
 * names it set, so a value that arrived that way is refused by name.
 */
export function liveCallAllowed(env, setByFile = []) {
  if (env.AI_SRE_LIVE !== "1") {
    return { allowed: false,
      why: "AI_SRE_LIVE=1 is not set, so this run may only call an address on this machine. A paid call "
        + "is an explicit act: put AI_SRE_LIVE=1 in front of the command" };
  }
  if (setByFile.includes("AI_SRE_LIVE")) {
    return { allowed: false,
      why: "AI_SRE_LIVE came from the .env file, and that file is read by every invocation including the "
        + "ones under test. Give it on the command line instead" };
  }
  return { allowed: true };
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
  /*
   * The rename itself has to survive the crash, not only the bytes.
   *
   * Astra, 2026-09-11: the file was fsynced and the DIRECTORY was not, so a
   * host failure could keep the contents and lose the entry that names them —
   * and the entry is the charged guard and the submission token. Killing the
   * process and killing the machine were being treated as one guarantee.
   *
   * A filesystem that refuses to fsync a directory is not a reason to stop: the
   * data is already renamed and every ordinary failure is covered. It IS a
   * reason to say so, because "durable" would otherwise be claimed for
   * something that was not confirmed.
   */
  try {
    const dir = openSync(dirname(path), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (e) {
    return { durable: false, why: `the directory entry could not be fsynced (${e.message})` };
  }
  return { durable: true };
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
 * What each key will post, worked out before a single call is made.
 *
 * Exported so the body can be checked without buying a run. Nothing checked it
 * before: the harness builds its own item and the generate tests read the
 * workflow as text, so the one field a real call must carry was the one field
 * nothing looked at — and three paid executions came back "no such scenario:
 * undefined" on 2026-09-07, refused at the first node.
 *
 * Throws rather than exiting, so a caller that is not the CLI can see why.
 */
export function planFor(keys, root = SCENARIOS) {
  const plan = [];
  for (const key of keys) {
    const { scenario } = splitKey(key);
    const a = alertFor(scenario, root);
    if (a.state !== "known") throw new Error(`refusing to start: ${a.why}`);
    /*
     * The SCENARIO travels with the alert, because the workflow asks for it.
     * It is added BESIDE the alert rather than into it: alert.json is what a
     * provider would hand over, and this field is ours.
     */
    plan.push({ key, alert: { ...a.alert, scenario } });
  }
  return plan;
}

/**
 * What one call produced, in the three states this project keeps apart.
 *
 * `answered` carries the body whatever it says — a refusal by the chain is an
 * ANSWER and is scored as one. `unreachable` is this script failing to get a
 * reply at all, which is not the model's fault and must never be recorded as
 * the model's answer. `unreadable` is a reply that arrived and was not JSON.
 */
/**
 * The file that claims one key, so two runners cannot both buy it.
 *
 * The directory is NOT taken from `--record`, and that is the whole point.
 * `wx` is exclusive per PATH, so a claims directory that moves with a command
 * line argument is not exclusive at all: two runners with different `--record`
 * values would claim in different places, both succeed, and both pay. Found on
 * 2026-09-11, in the first version of this fix, while the gate was running.
 *
 * `AI_SRE_CLAIMS_DIR` exists so tests do not write into the real ledger. It is
 * printed on every run, because an override nobody can see is the same hole
 * wearing a different name.
 *
 * A key is not a filename: `image-pull-failure#2` has a character that means
 * something to a shell and nothing to a filesystem. The name is flattened, and
 * the RAW key is written inside — so two different keys that flatten to one
 * name are detected as a collision instead of quietly sharing a claim.
 */
/*
 * The ledger lives BESIDE the run records, not inside them.
 *
 * `docs/runs/claims` put it under the directory the spend counter walks, and
 * `readRuns` reads subdirectories on purpose — a listed defect once had
 * results hiding in a subfolder. So a claim was counted as a RUN: one more
 * unpriced run in a total that is already a floor, which is exactly the kind
 * of number this project refuses to let drift. Caught by the test that pins
 * the runs on disk against the ones the counter reads, 2026-09-11.
 *
 * A claim is not a run. It says a key was bought; the run record says what
 * came back.
 */
export const LEDGER = join(ROOT, "docs", "claims");

/**
 * Where the ledger may be pointed, and where it may not.
 *
 * Astra, 2026-09-11: an override is an override. Two runners with different
 * `AI_SRE_CLAIMS_DIR` values both claim and both pay, and printing the value
 * does not stop that. So the override is accepted ONLY inside the operating
 * system's temporary directory — which tests use and a real run never does.
 *
 * That leaves one hole, named rather than hidden: two deliberately-configured
 * test runners with different temp ledgers. Retargeting a symlink between the
 * claim and the call would also defeat it. Neither is a production path, and
 * this prototype does not build against an adversary with write access to the
 * repository.
 */
/**
 * The real directory a path names, whether or not it exists yet.
 *
 * `resolve` normalises TEXT. It does not follow symlinks, so `/tmp/alias`
 * pointing at `/outside` passed a containment test against `/tmp` — no race
 * and no retargeting needed, just a link somebody made. Astra, 2026-09-11.
 *
 * The deepest ancestor that exists is resolved for real, and the part that does
 * not exist yet is appended to it. One rule, both cases.
 */
export function canonical(path, real = realpathSync) {
  let at = resolve(path);
  const rest = [];
  for (;;) {
    try { return join(real(at), ...[...rest].reverse()); }
    catch {
      const up = dirname(at);
      if (up === at) return resolve(path);     // nothing along the way exists
      rest.push(basename(at));
      at = up;
    }
  }
}

/**
 * Is one directory inside another, by path COMPONENTS rather than by text?
 *
 * A string prefix says `/tmp-elsewhere` is inside `/tmp`, and appending a
 * separator to compare says `C:\\Temp\\claims` is not inside `C:\\Temp`. Astra
 * found both. Components have neither problem, on either platform.
 */
export function isInside(child, parent, real = realpathSync) {
  const a = canonical(child, real).split(sep).filter((x) => x !== "");
  const b = canonical(parent, real).split(sep).filter((x) => x !== "");
  if (a.length < b.length) return false;
  return b.every((seg, i) => a[i] === seg);
}

/**
 * Where the ledger may be pointed, and where it may not.
 *
 * Astra, 2026-09-11: an override is an override. Two runners with different
 * `AI_SRE_CLAIMS_DIR` values both claim and both pay, and printing the value
 * does not stop that. So the override is accepted ONLY inside the operating
 * system's temporary directory — which tests use and a real run never does.
 *
 * That leaves one hole, named rather than hidden: two deliberately-configured
 * test runners with different temp ledgers. Retargeting a symlink between the
 * claim and the call would also defeat it. Neither is a production path, and
 * this prototype does not build against an adversary with write access to the
 * repository.
 */
export function ledgerFrom(env = process.env, tmp = tmpdir(), real = realpathSync) {
  const given = env.AI_SRE_CLAIMS_DIR;
  if (given === undefined || given.length === 0) return { dir: LEDGER };
  const at = resolve(given);
  if (!isInside(at, tmp, real)) {
    return { dir: null,
      why: `AI_SRE_CLAIMS_DIR points at ${at}, which really is ${canonical(at, real)} and is not inside `
        + `${canonical(tmp, real)}. The ledger of bought keys is only overridable for tests; a real run `
        + "uses one place, or two runners can both pay" };
  }
  return { dir: at, overridden: true };
}

const LEDGER_ASKED = ledgerFrom();
export const CLAIMS_DIR = LEDGER_ASKED.dir;

export function claimPathFor(key, dir = CLAIMS_DIR) {
  return join(dir, `${String(key).replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
}

/**
 * Create one claim file exclusively and durably, and say that it created it.
 *
 * Exported so the production path can be tested. It used to be a closure over
 * `fs` inside `claimKey`, which meant the only writer any test could exercise
 * was a hand-made one — and a hand-made error carries whatever the test puts
 * on it. The case this code exists for, a write that fails AFTER the file was
 * created, could not be reached at all.
 */
export function writeClaimFile(path, text, io = {}) {
  const {
    open = openSync, write = writeFileSync, sync = fsyncSync, close = closeSync,
  } = io;
  const fd = open(path, "wx");
  /*
   * From here on the file EXISTS, so every failure below is one this run has
   * to clean up. The mark travels on the error, because the caller owns the
   * claim and has to know whether the file on disk is its own.
   */
  try {
    try { write(fd, text); sync(fd); } finally { close(fd); }
    const d = open(dirname(path), "r");
    try { sync(d); } finally { close(d); }
  } catch (e) {
    if (e !== null && typeof e === "object") e[CLAIM_CREATED] = true;
    throw e;
  }
  return { created: true };
}

/**
 * Take exclusive, durable ownership of one key before paying for it.
 *
 * Astra, 2026-09-11: the guard read existing records and then acted on what it
 * had read, with nothing in between. Two runners could both pass it, choose
 * different record paths, bind different tokens, and POST the same key — two
 * charges for one question, and each record overwriting the other's evidence.
 * Reading a state is not holding it.
 *
 * `wx` is the whole mechanism: the filesystem decides who wins, once, and the
 * loser is told rather than allowed to proceed. Four answers, because "a claim
 * exists" and "I could not make one" are different situations and only one of
 * them means somebody already paid.
 */
export function claimKey(key, token, io = {}) {
  const {
    dir = CLAIMS_DIR,
    /*
     * `wx` for exclusivity and fsync for durability, because the claim has to
     * survive the crash it exists to guard against. Astra, 2026-09-11: it was
     * written with plain writeFileSync, so a host failure could lose the
     * evidence of a key that had been paid for.
     */
    /*
     * Answers whether it CREATED the file, which decides who may clean up.
     *
     * `openSync` with `wx` can fail for reasons that say nothing about the
     * path — `EMFILE`, out of descriptors — and a cleanup that ran anyway
     * would `unlink` another runner's paid claim, taking its recovery token
     * with it. Astra, 2026-09-11, reproduced with an injected failure. It is
     * the worst thing found in this work: a guard against paying twice that
     * could delete the evidence of having paid once.
     *
     * A writer that does not say falls to NOT cleaning up. A stranded
     * half-claim is a key refused until a person looks; a deleted claim is a
     * second charge nobody can see.
     */
    write = writeClaimFile,
    read = (p) => readFileSync(p, "utf8"),
    remove = unlinkSync,
    ensure = ensureDurableDir,
  } = io;
  const path = claimPathFor(key, dir);
  let made;
  try { made = ensure(dirname(path)); } catch (e) {
    return { state: "unclaimable", why: `the claims directory could not be made (${e.message})`, path };
  }
  let mine = false;
  try {
    const wrote = write(path, `${JSON.stringify({ key, token, claimed: "before the call was made" }, null, 2)}\n`);
    mine = wrote?.created === true;
    /*
     * Directories that could not be confirmed travel WITH the claim.
     *
     * Astra, 2026-09-11: `ensureDurableDir` reported them and `claimKey` threw
     * the report away, so a failed ancestor sync was accepted in silence —
     * which is the same as claiming durability that was never established.
     */
    return { state: "claimed", path, token,
      ...(made?.skipped !== undefined ? { unconfirmed: made.skipped } : {}) };
  } catch (e) {
    mine = e?.[CLAIM_CREATED] === true;
    if (e?.code !== "EEXIST") {
      /*
       * The exclusive create may have SUCCEEDED with the write failing after
       * it, leaving a file that claims the key and says nothing. Astra,
       * 2026-09-11: the next attempt found a held — possibly truncated — claim
       * for a submission that never happened, and refused a key nobody bought.
       *
       * The cleanup belongs here rather than inside the writer, because this
       * function is what owns the claim: an injected writer would otherwise
       * each need its own copy of the same rule.
       */
      let left = false;
      if (mine) {
        try { remove(path); } catch (r) { left = r?.code !== "ENOENT"; }
      }
      return { state: "unclaimable", path,
        why: `the claim could not be written (${e.message})`
          + (!mine
            ? `, and it is not established that this run created ${path}, so nothing was removed — `
              + "removing a claim another run paid for would be worse than leaving one nobody owns"
            : left ? `, and the half-made claim at ${path} could not be removed` : "") };
    }
  }
  let held;
  try { held = JSON.parse(read(path)); } catch (e) {
    // An unreadable claim is still a claim. Treating it as absent is how the
    // exclusive thing becomes advisory.
    return { state: "held", path, why: `a claim exists at ${path} and could not be read (${e.message})` };
  }
  if (held?.key !== key) {
    return { state: "collision", path,
      why: `${path} claims ${JSON.stringify(held?.key)}, not ${JSON.stringify(key)} — two keys flatten to one `
        + "filename, and neither can be trusted to own it" };
  }
  return { state: "held", path, token: held?.token,
    why: `${key} was already claimed${typeof held?.token === "string" ? ` as ${held.token}` : ""}; it may have `
      + "been paid for. Collect that submission instead of making a new one" };
}

/** Lowercase, because every HTTP stack in the path lowercases it anyway. */
export const TOKEN_HEADER = "x-submission-token";

/**
 * The mark a claim writer puts on its own failure to say "I created the file".
 *
 * A plain property would be trusted from any error that happened to carry it.
 * Astra, 2026-09-11, could not establish a real filesystem error doing that —
 * and a symbol costs nothing and removes the question, which is cheaper than
 * an argument about how likely it is.
 */
export const CLAIM_CREATED = Symbol("the claim file was created by this run");

/**
 * Make a directory and confirm the ENTRIES that name it, not only its contents.
 *
 * Astra, 2026-09-11: `mkdirSync` created a whole chain and only the leaf was
 * fsynced afterwards, so a host crash could lose the directory that holds the
 * claim while the claim's own bytes were safe. A name nobody can reach is the
 * same as no name.
 *
 * `mkdirSync` with `recursive` answers with the FIRST path it created, which is
 * exactly what is needed: everything from there down is new, and the entry that
 * links it into the existing tree lives in that path's parent.
 */
export function ensureDurableDir(dir, io = {}) {
  const { make = mkdirSync, open = openSync, sync = fsyncSync, close = closeSync } = io;
  const first = make(dir, { recursive: true });
  /*
   * The chain is confirmed EVERY time, not only when this call created it.
   *
   * Astra, 2026-09-11: returning early on "it already existed" equated that
   * with "durably linked". A previous run whose fsync failed left the
   * directories in place, and every run after it took the shortcut — so the
   * ledger subtree could be lost by a host crash forever after, while each
   * individual claim's own fsync succeeded. A concurrent runner could take the
   * same shortcut before the creator had finished.
   *
   * It costs a handful of fsyncs on an existing path, once per claim.
   */
  const chain = [];
  for (let at = resolve(dir); ; at = dirname(at)) {
    chain.push(at);
    if (dirname(at) === at) break;
  }
  const skipped = [];
  for (const at of chain) {
    let fd;
    try { fd = open(at, "r"); } catch (e) {
      // A directory this process may not open is not a failure to record a
      // claim. It is said, and the claim still stands or falls on its own.
      skipped.push({ at, why: e.message });
      continue;
    }
    try { sync(fd); } catch (e) { skipped.push({ at, why: e.message }); } finally { close(fd); }
  }
  return { created: first !== undefined, synced: chain, ...(skipped.length > 0 ? { skipped } : {}) };
}

/**
 * Give a claim back, because nothing was ever called under it.
 *
 * Astra, 2026-09-11: the claim was taken, the intent write failed, no POST
 * happened — and the claim stayed forever. The next attempt was told to
 * „collect that submission instead", pointing at a submission that does not
 * exist, for a key nobody had bought. A guard against paying twice had become
 * a guard against paying once.
 *
 * Only ever called on the path where the call did NOT happen. A claim whose
 * POST was attempted is never released: that is the one that must outlive
 * everything.
 */
export function releaseClaim(key, io = {}) {
  const { dir = CLAIMS_DIR, remove = unlinkSync } = io;
  const path = claimPathFor(key, dir);
  try { remove(path); return { state: "released", path }; }
  catch (e) {
    return { state: "still-held", path,
      why: `the claim at ${path} could not be removed (${e.message}); ${key} will be refused until it is` };
  }
}

/**
 * A name for ONE submission, written down before the call that it names.
 *
 * The incident id cannot do this job. `planFor` sends the same alert for
 * `scenario#1` and `scenario#2`, so two attempts share an incident identity —
 * and finding an execution by that identity can hand back the older attempt's
 * answer while looking like a match. Astra, 2026-09-11.
 *
 * It carries nothing about the scenario on purpose. The record binds token to
 * key; the token itself is opaque so that reconciliation has to read the
 * record rather than guess from the string.
 */
export function submissionToken(uuid = randomUUID) {
  return `sub-${String(uuid()).replace(/-/g, "")}`;
}

export async function callOnce(url, alert, { fetchImpl = fetch, timeoutMs = 300000, token } = {}) {
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
      /*
       * The token goes in a HEADER and never in the body.
       *
       * The body is the model's input. A token in there becomes part of what
       * the chain is asked to reason about, and a run whose inputs differ from
       * every earlier run is not comparable with them. The header lands in the
       * entry node's item, which was established by reading a real execution.
       */
      headers: {
        "Content-Type": "application/json",
        ...(typeof token === "string" && token.length > 0 ? { [TOKEN_HEADER]: token } : {}),
      },
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
 * Is this reply the chain's report, or only an acknowledgement?
 *
 * With the webhook answering immediately, a 200 no longer means "answered". It
 * means accepted — n8n returns something like `message: Workflow was started`
 * while the investigation is still running. Writing that into the answers file
 * would record an acknowledgement as a measurement, and the scorer would then
 * grade a document that contains no findings at all.
 *
 * A report is recognised by what it HAS, never by what an acknowledgement
 * happens to say. Matching the ack's wording would break the day n8n rewords
 * it, and it would break in the direction that saves the ack as an answer.
 */
export function classifyReply(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { state: "unrecognised", why: "the reply was not a JSON object" };
  }
  const hasState = typeof body["state"] === "string" && body["state"].length > 0;
  const hasFindings = Object.prototype.hasOwnProperty.call(body, "root_cause_code")
    || Object.prototype.hasOwnProperty.call(body, "raw_answers");
  if (hasState && hasFindings) return { state: "report" };
  return { state: "acknowledged",
    why: "the reply carries no report; the investigation continues and the answer is read from the execution" };
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
  return REFUSED_AT_THE_DOOR.includes(code);
}

/*
 * The marker that says a key was called and no reply came back.
 *
 * It was spelled out inside four prose sentences: two writers, two readers
 * matching with `startsWith("called,")`, and two tests carrying their own copy
 * of the sentence. Reword the sentence and the tests still pass while
 * `inFlightFromRecords` returns nothing — a key that was CHARGED then reads as
 * unbought, and `refuseToStart` lets the next run pay for it again. That is the
 * exact failure the marker was written to prevent. A subagent found it on
 * 2026-09-09. One carrier now, and the tests import it.
 */
export const CHARGED_PREFIX = "called,";
export const CHARGED_SENTENCE = `${CHARGED_PREFIX} no reply recorded — this key may have been charged`;

/*
 * The replies that mean the door refused us before any model was asked.
 *
 * The list was written twice, three lines apart, in opposite senses: once as
 * "the address is wrong", once negated as "this may have been charged". Adding
 * a code to one only flips one of the two answers, and the two answers decide
 * whether a key is recorded as possibly billed. One list decides both.
 */
const REFUSED_AT_THE_DOOR = [401, 403, 404, 405];

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
  return !REFUSED_AT_THE_DOOR.includes(code);
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
      if (typeof v === "string" && v.startsWith(CHARGED_PREFIX)) out.set(k, f);
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
export function recordShape(keys, { when, webhookHost, outcomes, submissions }) {
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
    /*
     * Token to key, written BEFORE the call each token names.
     *
     * This is what makes an interrupted run recoverable: with it, the execution
     * that did the work can be found by reading only. Without it, a key marked
     * "may have been charged" can never be resolved into an answer, and the
     * measurement stays bought and undelivered.
     *
     * An empty object is written when nothing was submitted, rather than the
     * field being absent — a missing field would read as "this runner does not
     * bind tokens", which is a different and now untrue statement.
     */
    submissions: submissions ?? {},
    totals: {
      input_tokens: null,
      output_tokens: null,
      why: "the webhook reply carries no usage; nothing here could read it",
    },
    scored: null,
  };
}

/**
 * A test ledger and a real address are a contradiction, and it stops the run.
 *
 * Measured, and then ESTABLISHED, on 2026-09-11. Twenty-one `container-oom`
 * executions reached the live instance across the day, in groups of exactly
 * three, and every group lines up with a run of the acceptance gate.
 *
 * The chain, reproduced by hand with this interlock in place so it cost
 * nothing: the gate applies the mutation `the-env-file-overriding-a-chosen-
 * value`, which deletes the line that makes the environment beat the `.env`
 * file. It then runs the test file that declares that mutation's named test —
 * and that file is the one whose tests spawn THIS script as a real child
 * process. With the guard mutated away, `.env` overwrote the test's
 * `127.0.0.1` address with the paid instance, and three tests POSTed to it.
 * Three paid executions per gate run, on every gate run.
 *
 * So the gate — the thing that exists to prove the code is honest — was
 * spending the owner's credits every time it ran, and nothing said so. The
 * mutation is right to exist and stays; what was missing is a floor under it.
 *
 * This is that floor: with a ledger under the temporary directory, a
 * non-loopback address is refused BEFORE the POST. Verified live by applying
 * the mutation by hand — the address became the real instance and the run
 * stopped without calling it.
 *
 * Deliberately not clever. It does not try to detect "am I a test"; it refuses
 * one specific contradiction, and says what to do instead.
 */
export function liveCallFromTestLedger(url, overridden, host = undefined) {
  if (overridden !== true) return null;
  const at = host ?? hostOf(url);
  if (at === "unreadable") {
    return `the claims ledger is a temporary one, so this is a test, and ${url} cannot be read as an address`;
  }
  /*
   * `hostOf` answers with the PORT attached — `127.0.0.1:5000` — because that
   * is what a record wants. So the port is stripped here rather than compared,
   * and an IPv6 literal keeps its brackets. Caught by running it: the first
   * version refused the loopback address every test uses, which would have
   * turned the interlock into a suite that cannot run.
   */
  const bare = at.startsWith("[") ? at.slice(0, at.indexOf("]") + 1) : at.split(":")[0];
  if (bare === "localhost" || bare === "127.0.0.1" || bare === "[::1]") return null;
  return `refusing to call ${at}: the claims ledger is under the temporary directory, which only a test `
    + "sets, and a test must never reach a paid instance. If this is a real run, unset AI_SRE_CLAIMS_DIR; "
    + "if it is a test, its local address did not reach this process";
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
  /*
   * The file is read HERE, not at import, and what it set is remembered — so a
   * value that arrived from the file can be refused by name below.
   */
  const setByFile = loadDotEnvOnce();
  const url = process.env.N8N_WEBHOOK_URL;
  const { keys, flags } = parseArgv(process.argv.slice(2));
  const answersAt = flags["--answers"] ? resolve(flags["--answers"]) : resolve(ROOT, "out/answers.json");

  /*
   * A ledger that was pointed somewhere it may not go stops the run before
   * anything is read, let alone paid for. `unknown` falls to stopping.
   */
  if (CLAIMS_DIR === null) {
    process.stderr.write(`refusing to start: ${LEDGER_ASKED.why}\n`);
    process.exit(2);
  }
  /*
   * A test ledger pointed at a paid instance stops here — before anything is
   * read, and long before anything is POSTed.
   */
  const contradiction = liveCallFromTestLedger(url ?? "", LEDGER_ASKED.overridden);
  if (contradiction !== null) {
    process.stderr.write(`refusing to start: ${contradiction}\n`);
    process.exit(2);
  }
  /*
   * The floor that does not depend on the ledger, or on the address being
   * wrong, or on anything a test happens to set: an address off this machine
   * is called only when the invocation says, explicitly, that it may be.
   */
  const host = hostOf(url ?? "");
  const bare = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  const offMachine = !(bare === "localhost" || bare === "127.0.0.1" || bare === "[::1]");
  if (offMachine) {
    const may = liveCallAllowed(process.env, setByFile);
    if (!may.allowed) {
      process.stderr.write(`refusing to call ${host}: ${may.why}\n`);
      process.exit(2);
    }
  }
  if (url === undefined || url.length === 0) {
    process.stderr.write("N8N_WEBHOOK_URL is not set; this script has nothing to call\n");
    process.exit(2);
  }
  if (keys.length === 0) {
    process.stderr.write("usage: AI_SRE_LIVE=1 node scripts/run-scenarios.mjs <key> [key...] [--answers path] [--record path]\n"
      + "  AI_SRE_LIVE=1 is required to call an address off this machine, and must come from the command\n"
      + "  line rather than the .env file — a paid call is an explicit act\n"
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

  let plan;
  try {
    plan = planFor(keys);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
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
  process.stdout.write(`  answers → ${answersAt}\n  record  → ${recordAt}\n  claims  → ${CLAIMS_DIR}\n\n`);

  let answers = { ...answersBefore };
  const outcomes = {};
  const submissions = {};
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
      `${JSON.stringify(recordShape(keys, { when, webhookHost: hostOf(url), outcomes, submissions }), null, 2)}\n`);
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
        const how = which === "answers" ? writeAnswers() : writeRecord();
        /*
         * Said out loud, once, rather than assumed. A write that went through
         * but could not confirm its directory entry is not a failure — it is a
         * weaker guarantee than the one this script relies on, and the person
         * reading the output is the only one who can weigh that.
         */
        if (how?.durable === false) {
          process.stderr.write(`  NOT CONFIRMED DURABLE: ${which} — ${how.why}. `
            + "The bytes are written; a host crash could still lose the entry.\n");
        }
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
    /*
     * The token is bound in the SAME write as the intent, not a later one.
     *
     * A second write would be a second chance to die in between, and the half
     * that survived would be the intent without the name — which is the state
     * this whole mechanism exists to remove.
     */
    const token = submissionToken();
    /*
     * The claim comes before the record and before the call. Nothing is paid
     * for a key this process does not exclusively own.
     */
    const claim = claimKey(key, token);
    /*
     * Durability that could not be confirmed is said BEFORE the money goes.
     *
     * Astra, 2026-09-11: `claimKey` reported the directories it could not sync
     * and nothing read the report, so a failed ancestor sync still allowed the
     * POST in silence. Returning the information had moved the original defect
     * one level outward instead of removing it.
     *
     * It does not stop the run. The claim itself is on disk and exclusive; what
     * is unestablished is whether a HOST crash could lose the directory that
     * names it, and that is a judgement for the person watching, not a reason
     * to refuse a measurement they asked for.
     */
    if (Array.isArray(claim.unconfirmed) && claim.unconfirmed.length > 0) {
      process.stderr.write(`  NOT CONFIRMED DURABLE: the claim on ${key} is written, but `
        + `${claim.unconfirmed.map((u) => u.at).join(", ")} could not be confirmed `
        + `(${claim.unconfirmed[0].why}). A host crash could lose the ledger entry; `
        + "an ordinary kill could not.\n");
    }
    if (claim.state !== "claimed") {
      process.stderr.write(`  not calling ${key}: ${claim.why ?? claim.state}\n`
        + (claim.state === "held"
          ? `  collect it with:  node scripts/collect-execution.mjs --token ${claim.token ?? "<token>"} ${answersAt} ${key}\n`
          : ""));
      wroteEverything = false;
      break;
    }
    submissions[key] = { token, bound: "before the call was made", claim: claim.path };
    outcomes[key] = CHARGED_SENTENCE;
    /*
     * If the intent could not be written, nothing is called.
     *
     * `flush` returned false and the caller ignored it, so a run that could not
     * record anything went on spending — and then printed "answers written" and
     * exited 0. Codex, 2026-09-08. A call whose evidence cannot be saved is a
     * charge nobody will ever see.
     */
    if (!flush()) {
      /*
       * No POST happened, so the claim must go back. Keeping it would block a
       * key nobody bought, and the refusal would point at a submission that
       * does not exist. Astra, 2026-09-11.
       */
      const gave = releaseClaim(key);
      /*
       * The record may already say this key may have been charged.
       *
       * `flush` writes the record FIRST, so a failure on the answers half
       * leaves the charged sentence on disk for a key that was never called —
       * and `inFlightFromRecords` then refuses it forever. Astra, 2026-09-11:
       * giving back the claim without correcting the record swapped one
       * stranded key for another.
       *
       * Corrected on a best-effort basis, because the thing that failed may be
       * the writing itself. If it cannot be corrected, that is SAID, and the
       * sentence names the file a person has to look at.
       */
      outcomes[key] = "not called: the intent could not be written, and nothing was submitted";
      let corrected = false;
      try {
        writeAtomic(recordAt, `${JSON.stringify(recordShape(keys,
          { when, webhookHost: hostOf(url), outcomes, submissions }), null, 2)}\n`);
        corrected = true;
      } catch { /* reported below rather than thrown */ }
      delete submissions[key];
      process.stderr.write("  stopping before this call: the intent could not be written, so a charge "
        + "would leave no evidence\n"
        + (gave.state === "released"
          ? `  nothing was called, so the claim on ${key} was given back\n`
          : `  ${gave.why}\n`)
        + (corrected
          ? `  and the record says ${key} was not called\n`
          : `  WARNING: ${recordAt} may still say ${key} may have been charged. It was NOT called. `
            + "Correct that line by hand, or the next run will refuse a key nobody bought\n"));
      wroteEverything = false;
      break;
    }
    const r = await callOnce(url, alert, { token });
    const detail = `${r.state}: ${r.why}${typeof r.body === "string" && r.body.length > 0 ? ` | body: ${r.body}` : ""}`;
    /*
     * A call that may have been charged keeps saying so.
     *
     * The intent line was overwritten by the transport failure, so a TIMEOUT —
     * the case most likely to have run and been billed — ended up recorded as
     * an ordinary failure and dropped out of the warning at the end.
     */
    /*
     * Set from the transport result first, then corrected below once the reply
     * has been classified. "answered" here means the HTTP call answered, and
     * that is not the same claim as "the measurement arrived".
     */
    outcomes[key] = r.state === "answered" ? "answered"
      : mayHaveBeenCharged(r) ? `${CHARGED_SENTENCE} (${detail})`
        : detail;
    /*
     * A 200 is no longer the same thing as an answer.
     *
     * The webhook returns as soon as it accepts the alert, so the chain's
     * report arrives later, in the execution. An acknowledgement merged into
     * the answers file would be a measurement made of the word "started".
     */
    const kind = r.state === "answered" ? classifyReply(r.answer) : { state: "n/a" };
    if (r.state === "answered" && kind.state === "report") {
      const merged = mergeAnswers(answers, { [key]: r.answer });
      answers = merged.answers;
      process.stdout.write(`answered (state ${JSON.stringify(r.answer?.state ?? "none")})\n`);
    } else if (r.state === "answered") {
      /*
       * Accepted, charged, and not yet delivered — which is exactly the state
       * the submission token exists for. It keeps the charged mark, so a
       * restart cannot buy this key again, and the mark is cleared by
       * COLLECTING the answer rather than by calling anything.
       */
      outcomes[key] = `${CHARGED_SENTENCE} (accepted, awaiting collection: token ${token})`;
      process.stdout.write(`accepted — the answer is in the execution, not in this reply\n`);
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
    /*
     * The counter counts MEASUREMENTS, not successful HTTP calls.
     *
     * Astra, 2026-09-11: it incremented for any parsed 200, so the ordinary
     * asynchronous acknowledgement printed "1 answer(s) written" with nothing
     * written. The exit code was still 2, so this was a false sentence rather
     * than a false success — and the sentence is the part a person reads.
     */
    if (r.state === "answered" && kind.state === "report" && saved) written += 1;
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
    if (r.state === "answered" && kind.state !== "report" && flags["--submit-all"] !== true) {
      /*
       * One paid submission, then a person looks. Under the old shape a broken
       * chain failed the first call and stopped the line; an acknowledgement
       * succeeds no matter how broken the chain behind it is, so without this
       * a single word would buy the whole list before anyone saw one answer.
       *
       * `--submit-all` is how that is asked for deliberately.
       */
      process.stdout.write(`\n  stopping after ${key}: it was accepted but not answered, and the `
        + `remaining keys were NOT called.\n`
        + `  collect it with:  node scripts/collect-execution.mjs --record ${recordAt} ${key} ${answersAt}\n`
        + "  pass --submit-all to send every key before collecting any of them.\n");
      break;
    }
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
  const maybeCharged = Object.entries(outcomes).filter(([, v]) => String(v).startsWith(CHARGED_PREFIX));
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
