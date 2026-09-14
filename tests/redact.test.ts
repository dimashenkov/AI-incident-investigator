/**
 * The single secret-redactor (src/core/redact.ts), shared by every Slack-bound
 * string. Moved out of reply.ts on 2026-09-14 so ONE source guards both the two-way
 * reply AND the first incident post (slackReport's text and Block Kit) — the
 * report-path gap Grok named. The redaction behaviour is tested here; the report
 * node's use of it is in generate.test.ts, the reply node's in generate-listener.
 */
import { describe, it, expect } from "vitest";
import { redactSecrets, redactBlocks } from "../src/core/redact.js";

describe("redactSecrets — the output net (Grok 2026-09-13: the boundary is the outgoing string)", () => {
  it("redacts fixed-prefix provider keys a report would never legitimately contain", () => {
    expect(redactSecrets("key is sk-abcdef0123456789ABCD here")).not.toContain("sk-abcdef");
    expect(redactSecrets("token xoxb-123456789-abcdefghijk")).not.toContain("xoxb-123456789");
    expect(redactSecrets("aws AKIAIOSFODNN7EXAMPLE creds")).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redactSecrets("ghp_0123456789abcdefghijABCDEFGHIJ012345")).not.toContain("ghp_0123456789");
  });

  it("redacts a PEM private-key block and a URL's embedded credentials", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(`before ${pem} after`)).toContain("[redacted]");
    expect(redactSecrets(`before ${pem} after`)).not.toContain("MIIabc");
    const url = redactSecrets("db at postgres://admin:s3cr3tpw@db.internal:5432/app");
    expect(url).not.toContain("s3cr3tpw");
    expect(url, "host survives, creds do not").toContain("@db.internal");
  });

  it("redacts the VALUE after a secret-named key in BOTH k=v and JSON forms (Grok's JSON slip)", () => {
    expect(redactSecrets("password=hunter2 restarts=3")).not.toContain("hunter2");
    expect(redactSecrets("password=hunter2 restarts=3"), "non-secret value untouched").toContain("restarts=3");
    expect(redactSecrets('{"password":"hunter2","cpu":"92%"}')).not.toContain("hunter2");
    expect(redactSecrets('{"password":"hunter2","cpu":"92%"}'), "non-secret field survives").toContain("92%");
    expect(redactSecrets('api_key: "AKIAX" secret=abcdef')).not.toMatch(/AKIAX|abcdef/);
  });

  it("redacts a QUOTED value with spaces to the closing quote, not just the first word (Grok 2026-09-13)", () => {
    // The k=v under-redaction: password="correct horse" left "horse" behind.
    const r = redactSecrets('password="correct horse battery"');
    expect(r).not.toMatch(/correct|horse|battery/);
    expect(r, "the quote structure survives").toContain('password="[redacted]"');
  });

  it("redacts a quoted value to its TRUE closing quote, past an escaped quote (Grok re-review 2026-09-13)", () => {
    // The escaped-quote tail leak: "say \"hi\" world" ended the match at the first
    // \" and left "hi\" world" exposed. The value must match to the real closing quote.
    const r = redactSecrets('{"password":"say \\"hi\\" world"}');
    expect(r, "no fragment of the secret survives").not.toMatch(/say|hi|world/);
    expect(r).toContain('"password":"[redacted]"');
  });

  it("redacts a secret key that carries a PREFIX — DB_PASSWORD, aws_secret_access_key (Grok 2026-09-13)", () => {
    // \bpassword does not fire after an underscore; a prefixed key is the normal
    // Kubernetes spelling, and was slipping entirely.
    expect(redactSecrets("DB_PASSWORD=hunter2")).not.toContain("hunter2");
    expect(redactSecrets("aws_secret_access_key=wJalrXUtnFEMI")).not.toContain("wJalrXUtnFEMI");
    expect(redactSecrets('{"db_password":"hunter2"}')).not.toContain("hunter2");
  });

  it("does NOT redact a Kubernetes Secret NAME after a bare colon — a reference, not a value (Grok over-redaction)", () => {
    // secret: partner-gateway-tls names a Secret resource; it is content the
    // operator asked about, not a credential. A bare value after ':' is left intact;
    // only a QUOTED value after ':' is treated as a literal secret.
    expect(redactSecrets("secret: partner-gateway-tls")).toBe("secret: partner-gateway-tls");
    expect(redactSecrets("references secret partner-gateway-tls in the pod spec"))
      .toContain("partner-gateway-tls");
  });

  it("does NOT eat the word after Bearer in prose — 'Bearer authentication failed' (Grok over-redaction)", () => {
    expect(redactSecrets("Bearer authentication failed for the pod")).toContain("authentication failed");
  });

  it("does NOT touch a bare token= or a JWT — that would eat legitimate k8s content", () => {
    // Grok's over-redaction case: a Kubernetes service-account token is real
    // evidence an operator may ask about; redacting it hides what they want. This
    // is a deliberate, documented gap — the denylist errs toward keeping evidence.
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzYSJ9.sigpart";
    expect(redactSecrets(`serviceaccount jwt ${jwt}`)).toContain(jwt);
    expect(redactSecrets("bearer token=abc123 in the SA"), "bare token= is left readable").toContain("token=abc123");
  });

  it("leaves ordinary incident prose completely unchanged", () => {
    const prose = "The pod api-7d9 in namespace production was OOMKilled; memory limit 512Mi, restarts 5.";
    expect(redactSecrets(prose)).toBe(prose);
  });
});

describe("redactBlocks — the report's Block Kit is a second carrier of the same text", () => {
  it("redacts a secret inside a nested block text field, leaving structure and prose intact", () => {
    const blocks = [
      { type: "header", text: { type: "plain_text", text: "Incident INC-1" } },
      { type: "section", text: { type: "mrkdwn", text: "root cause: OOM; key sk-abcdef0123456789ABCD leaked" } },
      { type: "context", elements: [{ type: "mrkdwn", text: "pod api-7d9 in production" }] },
    ];
    const r = redactBlocks(blocks) as typeof blocks;
    expect(JSON.stringify(r)).not.toContain("sk-abcdef");
    expect(r[1]!.text!.text, "the secret is gone but the sentence around it stays").toContain("root cause: OOM");
    expect(r[0]!.text!.text, "structure and type fields untouched").toBe("Incident INC-1");
    expect((r[2] as { elements: Array<{ text: string }> }).elements[0]!.text).toBe("pod api-7d9 in production");
  });

  it("leaves blocks with no secret byte-identical", () => {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "pod api-7d9 OOMKilled, restarts 5" } }];
    expect(redactBlocks(blocks)).toEqual(blocks);
  });
});
