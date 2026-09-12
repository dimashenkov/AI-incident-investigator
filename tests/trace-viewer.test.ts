/**
 * The trace viewer's one security-critical function: stripping the webhook
 * submission token out of execution data before it is served to the page. Grok
 * flagged (2026-09-12) that execution data carries `x-submission-token` in the
 * webhook node's request headers; the viewer is local and read-only, but the
 * token must never reach the browser regardless.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs, the same file node runs.
import { stripToken } from "../scripts/trace-viewer.mjs";

describe("stripToken", () => {
  it("redacts EVERY secret-bearing header, nested, any casing — not just the submission token", () => {
    // Grok, 2026-09-12: a failed HTTP node carries Authorization: Bearer <bot
    // token>; other webhooks carry x-slack-signature and cookies. Redacting only
    // x-submission-token leaves those on the page.
    const exec = {
      data: { resultData: { runData: { "Incident Webhook": [{ data: { main: [[{ json: {
        headers: {
          "x-submission-token": "sub-secret",
          "Authorization": "Bearer xoxb-bot-secret",
          "Cookie": "session=cookie-secret",
          "x-slack-signature": "v0=sig-secret",
          "content-type": "application/json",
        },
        body: { scenario: "cpu-throttling" },
      } }]] } }] } } },
    };
    const s = JSON.stringify(stripToken(exec));
    for (const leaked of ["sub-secret", "xoxb-bot-secret", "cookie-secret", "sig-secret"]) {
      expect(s, `${leaked} must be redacted`).not.toContain(leaked);
    }
    expect(s).toContain("[redacted]");
    // The incident's own content stays — that is the point of the viewer.
    expect(s).toContain("cpu-throttling");
    expect(s).toContain("application/json");
  });

  it("leaves data without a token untouched", () => {
    const clean = { a: 1, b: [{ c: "keep" }], d: null };
    expect(stripToken(clean)).toEqual(clean);
  });
});
