// ============================================================================
//  AGENTS — entry point
// ============================================================================
//  This file assembles the agent registry from individual agent files.
//
//  To iterate on a specific agent's prompt, edit ONLY that agent's file:
//    server/agents/diagnostic-agent.js
//    server/agents/intake-agent.js
//    server/agents/resolution-agent.js
//    server/agents/communications-agent.js
//
//  Do not put prompt content here.
// ============================================================================

import {
  orchestratorAgent,
  diagnosticAgent,
  intakeAgent,
  resolutionAgent,
  communicationsAgent,
} from "./agents/index.js";

export const AGENTS = [
  orchestratorAgent,
  diagnosticAgent,
  intakeAgent,
  resolutionAgent,
  communicationsAgent,
];

export function getAgent(id) {
  return AGENTS.find((a) => a.id === id);
}
