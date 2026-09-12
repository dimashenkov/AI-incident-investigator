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
