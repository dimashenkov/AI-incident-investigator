/**
 * The thread, with this process's validator injected.
 *
 * The building lives in ./thread.ts, which has no imports so the n8n Code node
 * can carry it — the same split assemble.ts has over merge.ts. This file exists
 * so every caller in the repository keeps working unchanged, and so there is
 * exactly one place that decides which validator the thread is checked against.
 */
import { validate } from "../schema/validate.js";
import { reportIncident as build, appendMessage as append, asPercent as percent,
  type Validate, type Message, type Reported, type ThreadResult } from "./thread.js";

export type { Message, Reported, ThreadResult };

export function reportIncident(incident: Record<string, unknown>, at: string): Reported {
  return build(validate as Validate, incident, at);
}

export function appendMessage(conversation: Record<string, unknown>, message: Message): ThreadResult {
  return append(validate as Validate, conversation, message);
}

export const asPercent = percent;
