/**
 * The two-way bot's listener workflow, generated from src/core/reply.ts. These
 * tests assert the shape that keeps it honest — not that it answers (that is the
 * live run), but that it ACKs Slack before the slow model call, spends in exactly
 * one place gated behind real conditions, replies IN the thread, and leaks no
 * token.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs, the same file node runs.
import { buildListener } from "../scripts/generate-listener.mjs";
// @ts-expect-error — plain .mjs, the same file node runs.
import { OPENAI_CREDENTIAL, SLACK_CREDENTIAL } from "../scripts/generate-workflow.mjs";

const WF = buildListener();
const node = (name: string) => WF.nodes.find((n: { name: string }) => n.name === name);

describe("the Slack listener is generated, not hand-typed in n8n", () => {
  it("carries the reply logic in its Code nodes, with no import or export leaking", () => {
    for (const name of ["Handle", "Build ask", "Build reply"]) {
      const code = (node(name) as { parameters: { jsCode: string } }).parameters.jsCode;
      expect(code, `${name} lost its logic`).toMatch(/function (classifyEvent|reportTextFrom|answerFrom)/);
      expect(code, `${name} leaked an export`).not.toMatch(/\bexport\s/);
      expect(code, `${name} leaked an import`).not.toMatch(/\bimport\s/);
    }
  });

  it("uses responseNode, so it can ACK Slack fast instead of after the whole chain", () => {
    const wh = node("Slack Events") as { parameters: { responseMode: string } };
    expect(wh.parameters.responseMode).toBe("responseNode");
  });

  it("echoes the challenge on one branch and ACKs 200 on the other", () => {
    const [truePath, falsePath] = WF.connections["Is challenge"].main;
    expect(truePath[0].node).toBe("Respond challenge");
    expect(falsePath[0].node).toBe("Respond ack");
    const chal = node("Respond challenge") as { parameters: { responseBody: string } };
    expect(chal.parameters.responseBody).toContain("challenge");
  });

  it("ACKs BEFORE the model is asked — Respond ack is upstream of Ask model", () => {
    // If the model call ran before the ACK, Slack's 3s timeout would retry and
    // double-post. Respond ack must sit on the path to Ask model.
    const path: string[] = [];
    let cur = "Respond ack";
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      guard.add(cur); path.push(cur);
      const outs = WF.connections[cur]?.main?.[0] ?? [];
      cur = outs[0]?.node;
    }
    expect(path, "Ask model must come after Respond ack").toContain("Ask model");
  });

  it("drops a re-delivered event_id BEFORE the model, closing the retry double-spend", () => {
    // Grok, 2026-09-12: fast ACK is not dedup. Slack re-delivers the same
    // event_id on a lost 200. Seen event (rowNotExists) must sit between Should
    // reply and Ask model, so a duplicate never reaches the paid node.
    const seen = node("Seen event") as { type: string; parameters: { operation: string;
      filters: { conditions: Array<{ keyName: string }> } } };
    expect(seen.type).toBe("n8n-nodes-base.dataTable");
    expect(seen.parameters.operation, "rowNotExists drops a hit, passes a miss").toBe("rowNotExists");
    expect(seen.parameters.filters.conditions[0]!.keyName).toBe("event_id");
    // Should reply true → Seen event → Mark seen (record) → Fetch thread → … → Ask model
    expect(WF.connections["Should reply"].main[0][0].node).toBe("Seen event");
    expect(WF.connections["Seen event"].main[0][0].node).toBe("Mark seen");
    const mark = node("Mark seen") as { parameters: { operation: string } };
    expect(mark.parameters.operation, "the event_id is recorded before spending").toBe("insert");
    // The model must be reachable only after the dedup.
    const path: string[] = [];
    let cur: string | undefined = "Seen event";
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      guard.add(cur); path.push(cur);
      cur = WF.connections[cur]?.main?.[0]?.[0]?.node;
    }
    expect(path, "Ask model is downstream of the dedup").toContain("Ask model");
  });

  it("answers only in a thread the bot itself opened, found by thread_ts in incident_threads", () => {
    // Leak audit 2026-09-12: the bot must not pull an incident's private data into
    // a thread it did not open. Ownership is proven by looking the reply's
    // thread_ts up in incident_threads (the table the incident workflow writes when
    // IT posts a report). The lookup key is `ts`, NOT an id regex-ed from arbitrary
    // text; a miss routes to nothing (no data pull, no reply).
    expect(WF.connections["Fetch thread"].main[0][0].node).toBe("Find incident");
    const find = node("Find incident") as { type: string; onError?: string;
      parameters: { operation: string; filters: { conditions: Array<{ keyName: string; keyValue: string }> } } };
    expect(find.type).toBe("n8n-nodes-base.dataTable");
    expect(find.parameters.filters.conditions[0]!.keyName, "ownership is by thread ts").toBe("ts");
    expect(find.parameters.filters.conditions[0]!.keyValue).toContain("thread_ts");
    // Find incident → Owned? → true: Build ask ; false: nothing (not our thread).
    expect(WF.connections["Find incident"].main[0][0].node).toBe("Owned");
    expect(WF.connections["Owned"].main[0][0].node).toBe("Build ask");
    expect(WF.connections["Owned"].main[1] ?? [], "a thread the bot did not open is not answered").toEqual([]);
    // There is no regex-from-text incident id anywhere in the listener anymore.
    expect(JSON.stringify(WF), "no INC- regex on arbitrary thread text").not.toContain("INC-\\\\d");
  });

  it("answers from the report ONLY — no Fetch data node, no raw pull (Grok leak review 2026-09-13)", () => {
    // The primary leak control (owner-accepted "as Grok says"): the reply path
    // never fetches the raw observations, so a stored credential is never handed to
    // a model prompt. There must be NO Fetch data node, and Build ask must call
    // replyMessages with (report, question) only — never a data argument.
    expect(WF.nodes.find((n: { name: string }) => n.name === "Fetch data"), "the raw-data node is gone").toBeUndefined();
    const ba = (node("Build ask") as { parameters: { jsCode: string } }).parameters.jsCode;
    expect(ba, "answers from the report, no data arg").toContain("replyMessages(report, h.text)");
    expect(ba, "no raw data is read or passed").not.toMatch(/replyMessages\(report, h\.text, /);
    expect(ba, "no Fetch data lookup").not.toContain("Fetch data");
  });

  it("the Build reply node redacts the answer through the shared net before posting", () => {
    // redactSecrets moved to the shared redact.ts (2026-09-14) so it guards the report
    // path too; the reply node splices redact.ts and applies it to the outgoing answer.
    const br = (node("Build reply") as { parameters: { jsCode: string } }).parameters.jsCode;
    expect(br, "the shared redactor is spliced into the posting node").toContain("function redactSecrets");
    expect(br, "and applied to the answer before it is posted").toContain("redactSecrets(raw)");
  });

  it("spends in exactly ONE place, and only behind Should reply and Has report", () => {
    const modelNodes = WF.nodes.filter((n: { parameters?: { url?: string } }) =>
      (n.parameters?.url ?? "").includes("api.openai.com"));
    expect(modelNodes.length, "exactly one node may call the model").toBe(1);
    expect(modelNodes[0].name).toBe("Ask model");
    // gated: Should reply → Fetch thread → Build ask → Has report → Ask model
    expect(WF.connections["Should reply"].main[1], "no reply → no fetch, no spend").toEqual([]);
    expect(WF.connections["Has report"].main[1], "no report → no model call").toEqual([]);
    const ask = node("Ask model") as { credentials: { openAiApi: { id: string; name: string } } };
    expect(ask.credentials.openAiApi).toEqual({ id: OPENAI_CREDENTIAL.id, name: OPENAI_CREDENTIAL.name });
  });

  it("replies IN the thread, with the Header Auth credential and no token in the JSON", () => {
    const post = node("Post reply") as {
      credentials: { httpHeaderAuth: { id: string; name: string } };
      parameters: { jsonBody: string; authentication: string };
    };
    expect(post.parameters.authentication).toBe("genericCredentialType");
    expect(post.parameters.jsonBody, "must post into the thread").toContain("thread_ts");
    expect(post.credentials.httpHeaderAuth).toEqual({ id: SLACK_CREDENTIAL.id, name: SLACK_CREDENTIAL.name });
    expect(WF.connections["Has answer"].main[1], "no answer → post nothing").toEqual([]);
    const text = JSON.stringify(WF);
    expect(text, "no xoxb token anywhere").not.toMatch(/xoxb-/);
  });
});
