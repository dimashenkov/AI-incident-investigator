/**
 * A source that cannot run inside the n8n Code node.
 *
 * It exists so the generator's refusal has something to refuse. Every line here
 * is a thing the node genuinely lacks, and the file is never imported by
 * anything — it is read as text by the transpiler and nothing else.
 */
export const HERE = new URL("./", import.meta.url).pathname;

/**
 * A dynamic import, which the static-import pattern does not match.
 *
 * It names this same file so the type checker has something real to resolve —
 * a fixture that fails typecheck would be a fixture somebody deletes.
 */
export async function late(): Promise<unknown> {
  return import("./not-node-safe.js");
}
