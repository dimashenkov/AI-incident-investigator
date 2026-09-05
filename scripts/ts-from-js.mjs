/**
 * Let Node import the TypeScript sources the way the TypeScript compiler sees
 * them, with no build step and no new dependency.
 *
 * The sources import each other as `./x.js`, which is what TypeScript's own ESM
 * output requires. Node 26 strips types from a `.ts` file it is given, but it
 * does not know that `./x.js` means `./x.ts`, so the first cross-file import
 * fails. This hook makes that one substitution and nothing else: only under
 * `src/`, only when the `.js` file genuinely does not exist.
 *
 * Deliberately narrow. A resolver that rewrote every `.js` would quietly reach
 * into node_modules and change which file some package loads — a whole class of
 * defect bought for no benefit.
 *
 * Registered with:  node --import ./scripts/ts-from-js.mjs <script>
 *
 * Synchronous hooks, so it works for the generator's plain `await import`.
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

function resolveJsToTs(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    const parent = context.parentURL;
    if (typeof parent === "string" && parent.includes("/src/")) {
      const asJs = new URL(specifier, parent);
      if (!existsSync(fileURLToPath(asJs))) {
        const asTs = new URL(specifier.slice(0, -3) + ".ts", parent);
        if (existsSync(fileURLToPath(asTs))) {
          return nextResolve(asTs.href, context);
        }
      }
    }
  }
  return nextResolve(specifier, context);
}

// Registered when loaded with --import. Guarded so importing this module for
// its own tests does not install the hook twice.
let installed = false;
export function install() {
  if (installed) return;
  installed = true;
  // registerHooks, not register: the older call is deprecated in Node 26 and
  // prints a warning on every run, which trains everyone to ignore warnings.
  registerHooks({ resolve: resolveJsToTs });
}
install();
