/**
 * The single secret-redactor, shared by every Slack-bound string.
 *
 * It lived inside reply.ts and guarded only the two-way bot's reply. Grok's leak
 * review named the wider gap (2026-09-13): the FIRST Slack post — the incident report
 * built by slackReport — is also a string that reaches Slack, and it never passed
 * through the net. buildRuntime splices this file into every node's prelude, so one
 * source now guards both paths (the report node and the reply node) with no second
 * copy — the duplication the project fights.
 *
 * It is deliberately NARROW. It matches ONLY shapes that a curated incident report or
 * a remediation suggestion would never legitimately contain:
 *   - provider keys with a fixed prefix: sk-…, xox[baprs]-…, AKIA…, AIza…, ghp_/gho_…
 *   - PEM private-key blocks
 *   - a Bearer token, and credentials embedded in a URL (user:pass@host)
 *   - the VALUE after a secret-named key: password / passwd / pwd / secret / api_key /
 *     apikey / access_key / client_secret / dsn — in `k=v` or JSON `"k":"v"` form.
 * It does NOT touch bare `token=` or JWTs (eyJ…): a Kubernetes service-account token
 * is legitimate content an operator may be asking about, and eating it would hide the
 * very evidence they want (Grok's over-redaction case). A denylist catches known
 * shapes, not novel ones; this one errs toward keeping evidence readable.
 *
 * Because it is narrow, it is SAFE to apply to every string in a structure — it
 * changes only secret-shaped substrings — which is what redactBlocks relies on. No
 * imports: same discipline as the other spliced core files.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== "string" || text === "") return text;
  let out = text;
  const R = "[redacted]";
  // PEM private-key blocks (any BEGIN…END PRIVATE KEY).
  out = out.replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, R);
  // Provider keys with an unambiguous prefix.
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, R);                 // OpenAI
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, R);           // Slack
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, R);                    // AWS access key id
  out = out.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, R);               // Google API key
  out = out.replace(/\bgh[posru]_[A-Za-z0-9]{20,}/g, R);           // GitHub tokens
  // Credentials embedded in a URL: scheme://user:pass@host -> scheme://[redacted]@host
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${R}@`);
  // A Bearer token. Require length AND a digit so a dictionary word — "Bearer
  // authentication failed" — is not eaten (Grok, 2026-09-13).
  out = out.replace(/\bBearer\s+(?=[^\s]*\d)[A-Za-z0-9._~+/=-]{16,}/g, `Bearer ${R}`);
  // The value of a secret-named assignment. The key may carry a prefix so it ENDS in
  // the secret word (DB_PASSWORD, aws_secret_access_key), and the value may be quoted
  // with spaces. `key` is an optionally-quoted identifier ending in a secret word,
  // not preceded by an identifier char.
  const secretKey = "(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|dsn)";
  const key = `(?<![A-Za-z0-9_.])"?[A-Za-z0-9_.]*${secretKey}"?`;
  // A quoted value matched to its TRUE closing quote, past an escaped quote.
  const dq = '"(?:\\\\.|[^"\\\\])*"';
  const sq = "'(?:\\\\.|[^'\\\\])*'";
  // '=' assignment: quoted (escapes handled) or a bare value.
  out = out.replace(new RegExp(`(${key}\\s*=\\s*)${dq}`, "gi"), `$1"${R}"`);
  out = out.replace(new RegExp(`(${key}\\s*=\\s*)${sq}`, "gi"), `$1'${R}'`);
  out = out.replace(new RegExp(`(${key}\\s*=\\s*)[^\\s"',;}]+`, "gi"), `$1${R}`);
  // ':' with a QUOTED value only (JSON "k":"v" and YAML k: "v"). A BARE value after
  // ':' is a reference/name — a Kubernetes Secret NAME (secret: partner-gateway-tls)
  // is content, not a credential, so it is left intact (Grok's over-redaction case).
  out = out.replace(new RegExp(`(${key}\\s*:\\s*)${dq}`, "gi"), `$1"${R}"`);
  out = out.replace(new RegExp(`(${key}\\s*:\\s*)${sq}`, "gi"), `$1'${R}'`);
  return out;
}

/**
 * Redact every string inside a Block Kit structure — the report's second carrier.
 * The report reaches Slack as plain `text` AND as Block Kit blocks; redacting only
 * the text would leave a secret in the structured blocks (Grok, 2026-09-13). Because
 * redactSecrets is narrow, deep-applying it to every string leaf is safe: it touches
 * only secret-shaped substrings and leaves block types, ids and prose untouched.
 */
export function redactBlocks<T>(blocks: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactSecrets(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)) o[k] = walk((v as Record<string, unknown>)[k]);
      return o;
    }
    return v;
  };
  return walk(blocks) as T;
}
