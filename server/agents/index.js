// ============================================================================
//  AGENT REGISTRY — Demo Story 1: Proactive CCTV Resolution
// ============================================================================
//  To add or remove agents, edit this file and the individual agent files.
//  To change an agent's prompt, edit ONLY that agent's file — no other files
//  need to change.
//
//  Agent files (one per agent):
//    intake-agent.js        — triage & scope, set priority and SLA clocks
//    diagnostic-agent.js    — detect anomaly, diagnose root cause, surface prevention
//    resolution-agent.js    — execute runbook, verify footage recovery
//    communications-agent.js — draft compliance notification (HITL gate)
//
//  Agents hand off directly to each other — no orchestrator.
// ============================================================================

export { diagnosticAgent } from "./diagnostic-agent.js";
export { intakeAgent } from "./intake-agent.js";
export { resolutionAgent } from "./resolution-agent.js";
export { communicationsAgent } from "./communications-agent.js";
