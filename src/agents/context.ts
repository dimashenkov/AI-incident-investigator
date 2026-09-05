/**
 * Assembling what an agent is given.
 *
 * This is where cross-incident leakage would happen, and Codex said in the very
 * first review of the plan that testing the model's answer is not enough:
 *
 *   "Model-output assertions alone are insufficient because a model may ignore
 *    leaked data."
 *
 * A model that received another incident's data and happened not to mention it
 * would pass an output test while the leak sat there. So the thing under test
 * is the assembled context itself, before any model sees it, and these
 * functions exist to be testable without spending anything.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PROMPT_ROOT = new URL("../../prompts/", import.meta.url).pathname;

import {
  buildObservingContext, buildRootCauseContext, buildCheckedContext,
  type AgentName, type ContextResult,
} from "./slice.js";

export {
  OBSERVING_AGENTS, AGENT_SLOT, checkPayloadIsExactlyTheSlice,
  checkSourceForForeignIncidents, foreignIncidentIds, deepDiffPaths,
} from "./slice.js";
export type { AgentName, ContextResult } from "./slice.js";

export function readPrompt(agent: AgentName, root: string = PROMPT_ROOT): string | null {
  const path = join(root, `${agent}-agent.md`);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/*
 * The disk half. These keep the signatures every caller already uses, and read
 * the prompt that slice.ts is handed. A refactor that rewrites its own callers
 * is a refactor whose tests were rewritten with it.
 */
export function assembleObservingContext(
  agent: AgentName, incident: Record<string, unknown>, root: string = PROMPT_ROOT,
): ContextResult {
  return buildObservingContext(agent, incident, readPrompt(agent, root));
}

export function assembleRootCauseContext(
  incident: Record<string, unknown>, root: string = PROMPT_ROOT,
): ContextResult {
  return buildRootCauseContext(incident, readPrompt("root-cause", root));
}

export function assembleCheckedContext(
  agent: AgentName, incident: Record<string, unknown>, root: string = PROMPT_ROOT,
): ContextResult {
  return buildCheckedContext(agent, incident, readPrompt(agent, root));
}
