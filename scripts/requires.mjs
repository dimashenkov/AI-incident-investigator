/**
 * Counting the `require` calls left in a built artifact.
 *
 * It lives in a module of its OWN, with no dependencies, because two programs
 * need it and one must survive the other's dependencies being broken: the
 * acceptance gate recounts from the artifact, and importing the BUILDER to get
 * this function pulled Ajv in at module load — so a missing or broken Ajv would
 * abort the gate before it reported a single check, or repaired a mutation an
 * interrupted run had left applied. Codex found it on 2026-09-09.
 */
/**
 * Every `require` CALL left in a body of code.
 *
 * Codex, chunk 1 part 1: matching only `require("x")` claimed more than it
 * checked. A call with a space before the paren, one with a comment between
 * them, and one with a template-literal argument are all valid calls it missed,
 * and the artifact would have shipped carrying one.
 *
 * Widening it to any mention of the word went too far the other way, and the
 * build said so on the first run: a schema description in this repository
 * contains the English word "require" in a sentence, and the check refused a
 * perfectly good artifact. The honest middle is the call syntax — the word
 * followed by an open paren, whatever spacing or comments sit between.
 *
 * What this does NOT establish: that no dynamic construction could reach a
 * module at runtime. Nothing here parses the artifact, and the claim is exactly
 * as wide as the pattern.
 */
export function remainingRequires(code) {
  const calls = [...code.matchAll(/\brequire\b\s*(?:\/\*[\s\S]*?\*\/\s*)*\(\s*(["'`])?(.*?)\1?\s*\)/g)];
  return calls.map((m) => (m[2] === undefined || m[2] === "" ? "(dynamic or unparsed argument)" : m[2]));
}
