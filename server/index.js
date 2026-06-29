// ============================================================================
//  API SERVER  (port 4000)
// ============================================================================
//  Agents have RAG over the TechGuard knowledge base + live Salesforce access.
//
//  Flow for an injected event:
//    inject event (+ accountId) -> create Case (Correlation_Id__c='ITF-…') ->
//    Orchestrator (manager agent) routes to specialist(s) via activate_agent ->
//    specialists read the Case, act, and write trace rows (Agent_Action_Log__c)
//    via log_trace_step -> stop at the first human-in-the-loop approval gate.
//  The webapp reads those Case + Agent_Action_Log__c rows live.
//
//  Endpoints:
//    GET  /api/agents      GET /api/customers   GET /api/knowledge   GET /api/health
//    POST /api/chat   { agentId, sessionId, message }     -> direct chat with one agent
//    POST /api/event  { accountId, sessionId, event }     -> create ticket only
//    POST /api/run    { caseId, sessionId }               -> orchestrated agent run
//    POST /api/approve { actionId }    POST /api/reject { actionId, note }
//    POST /api/reset  { agentId, sessionId }
//    WS   /ws?sessionId=…                                 -> live thinking stream
// ============================================================================

import http from "node:http";
import { createHash } from "node:crypto";
import { AGENTS, getAgent } from "./agents.js";
import { customers as mockCustomers } from "./database.js";
import { chat, usingRealModel } from "./llm.js";
import { retrieve, knowledgeStats } from "./knowledge.js";
import * as sf from "./salesforce.js";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = process.env.AGENT_SIM_API_PORT || 4000;
const SF_ON = sf.isConfigured();

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
const ORCHESTRATOR = AGENTS.find((a) => a.role === "orchestrator");

// Trace persistence: runs are ALWAYS kept locally; Salesforce gets the trace only
// per TRACE_TO_SF = "off" (default) | "milestones" | "full". Cases are always in SF.
const TRACE_TO_SF = (process.env.TRACE_TO_SF || "full").toLowerCase();
const RUNS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "runs");
await mkdir(RUNS_DIR, { recursive: true });
const runTraces = new Map(); // caseId -> [ trace rows ]

// Anonymous-Apex demo reset script (repo root scripts/seed-demo.apex).
const SEED_SCRIPT_PATH =
  process.env.AGENT_SIM_SEED_SCRIPT ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "seed-demo.apex");

// Org instance URL (My Domain), used to build clickable Lightning record links.
const INSTANCE_URL = (process.env.SF_LOGIN_URL || "").replace(/\/+$/, "");
const caseUrl = (id) => (INSTANCE_URL ? `${INSTANCE_URL}/lightning/r/Case/${id}/view` : null);

// Direct-chat history store (per agent+session). Orchestrated runs are ephemeral.
const conversations = new Map();
const keyFor = (agentId, sessionId) => `${agentId}::${sessionId}`;
function historyFor(agentId, sessionId) {
  const key = keyFor(agentId, sessionId);
  if (!conversations.has(key)) conversations.set(key, []);
  return conversations.get(key);
}

// Pending HITL write proposals.
const pendingActions = new Map(); // id -> { id, agentId, sessionId, caseId, accountId, op, input, status }

// ---------------------------------------------------------------------------
//  WebSocket server (no external deps — raw Node TCP upgrade)
// ---------------------------------------------------------------------------
const wsClients = new Map(); // sessionId -> Set<socket>

function wsFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsEmit(sessionId, event) {
  const payload = Buffer.from(JSON.stringify(event));
  const frame = wsFrame(0x1, payload); // text frame
  for (const sock of wsClients.get(sessionId) || []) {
    try { sock.write(frame); } catch {}
  }
}

// ---------------------------------------------------------------------------
//  Salesforce schema + tools
// ---------------------------------------------------------------------------
const SCHEMA_SUMMARY = [
  "Account (client): Name, SLA_Tier__c, Client_Risk_Tolerance__c, Compliance_Profile__c",
  "Case (ticket/incident): CaseNumber, Subject, Status, Priority, AccountId, AssetId, Service_Line__c, Stage__c (Detected/Triaged/Diagnosing/Resolving/Gated/Resolved/Closed), Autonomy_Mode__c, Confidence__c, Compliance_Sensitive__c, Root_Cause__c, Resolution_Summary__c, Correlation_Id__c",
  "Asset: Name, AccountId, ParentId, Service_Line__c, Asset_Type__c, Operational_Status__c, Health__c, Site__c, Site_Criticality__c, Attributes_Json__c",
  "Telemetry_Reading__c: Asset__c, Signal_Type__c, Value__c, Status__c, Reading_At__c, Is_Anomaly__c",
  "Runbook__c: Name, Runbook_Key__c, Service_Line__c, Action_Type__c, Reversible__c, Blast_Radius__c",
  "Agent_Action_Log__c (the trace): Case__c, Step__c, Actor__c, Actor_Type__c, Observation__c, Action_Taken__c, Stage__c, Confidence__c, Gate_Type__c, Decision__c, Outcome__c, Logged_At__c",
].join("\n");

// Exact allowed picklist values in this org (from `sf sobject describe`). Agents
// must use these verbatim — restricted fields reject anything else, and unrestricted
// ones (e.g. Priority) silently store junk like "P1".
const PICKLISTS = [
  "Case.Status: New | Working | Escalated | Closed",
  "Case.Priority: High | Medium | Low   (NEVER use P1/P2/P3 — the console derives P1=High, P2=Medium, P3=Low)",
  "Case.Stage__c: Detected | Triaged | Diagnosing | Resolving | Gated | Resolved | Closed",
  "Case.Autonomy_Mode__c: Auto | Watch | Approval | On-site | Inputs Required",
  "Case.Service_Line__c: CCTV | Web Hosting | Network",
  "Agent_Action_Log__c.Actor_Type__c: Agent | Human | System",
  "Agent_Action_Log__c.Gate_Type__c: None | Approval | On-site | Verify & Close | Inputs Required",
  "Agent_Action_Log__c.Decision__c: N/A | Approved | Rejected | Edited",
  "Agent_Action_Log__c.Outcome__c: Success | Failed | Partial | Pending",
].join("\n");

const SF_QUERY_TOOL = {
  name: "salesforce_query",
  description:
    "Run a read-only SOQL query against the live Salesforce org and return records as JSON. Use to read the Case, Account, Asset, Telemetry, Runbooks before acting.",
  input_schema: {
    type: "object",
    properties: { soql: { type: "string", description: "A valid SOQL query." } },
    required: ["soql"],
  },
};
const SF_CREATE_TOOL = {
  name: "salesforce_create",
  description: "Create a Salesforce record (e.g. a remediation Case child). Returns the new Id.",
  input_schema: {
    type: "object",
    properties: { sobject: { type: "string" }, fields: { type: "object" } },
    required: ["sobject", "fields"],
  },
};
const SF_UPDATE_TOOL = {
  name: "salesforce_update",
  description: "Update fields on an existing Salesforce record by Id (e.g. set Case.Stage__c / Root_Cause__c).",
  input_schema: {
    type: "object",
    properties: { sobject: { type: "string" }, recordId: { type: "string" }, fields: { type: "object" } },
    required: ["sobject", "recordId", "fields"],
  },
};
const LOG_TRACE_TOOL = {
  name: "log_trace_step",
  description:
    "Append a step to the active ticket's agent trace (Agent_Action_Log__c on the Case) so it shows on the ticket. Call this after each meaningful observation→action. Keep finding and action to one sentence each.",
  input_schema: {
    type: "object",
    properties: {
      finding: { type: "string", description: "One sentence: what you observed/found." },
      action: { type: "string", description: "One sentence: the action you took from that finding." },
      stage: { type: "string", description: "Optional Case stage: Detected/Triaged/Diagnosing/Resolving/Gated/Resolved/Closed." },
      confidence: { type: "number", description: "Optional 0–100." },
      gate_type: { type: "string", description: "Optional: Approval/On-site/Verify & Close/Inputs Required/None." },
      decision: { type: "string", description: "Optional: Approved/Rejected/N/A." },
      outcome: { type: "string", description: "Optional: Success/Failed/Partial/Pending." },
      milestone: { type: "boolean", description: "Set true for key moments (hand-off, gate, resolution, closure). Milestones are the steps persisted to Salesforce when trace-to-Salesforce is in milestone mode." },
    },
    required: ["finding", "action"],
  },
};
const RETRIEVE_KNOWLEDGE_TOOL = {
  name: "retrieve_knowledge",
  description:
    "Search the TechGuard knowledge base for SOPs, runbooks, SLA rules, thresholds, or escalation criteria relevant to a query. Use this mid-turn when you need guidance the injected context does not cover — e.g. a specific runbook step, a threshold value, or a compliance rule. Returns the top matching sections with citations.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "A plain-English question or keyword phrase — e.g. 'CCTV recording stream stuck runbook' or 'Platinum SLA response time'." },
      k: { type: "number", description: "Number of sections to return (1–8). Default 4." },
    },
    required: ["query"],
  },
};

const HANDOFF_TO_AGENT_TOOL = {
  name: "handoff_to_agent",
  description:
    "Delegate a specific task to another specialist agent and receive its response. Use when you have completed your phase and a different agent should handle the next step — e.g. Diagnostic hands off to Intake after detecting an anomaly, or Intake hands off to Resolution after triaging. The target agent runs in full and its reply is returned to you. Log a trace step before calling this to record the hand-off.",
  input_schema: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "Id of the agent to activate. One of: diagnostic-agent | intake-agent | resolution-agent | communications-agent.",
        enum: ["diagnostic-agent", "intake-agent", "resolution-agent", "communications-agent"],
      },
      task: {
        type: "string",
        description: "A concise plain-English brief for the target agent. Include the Case Id, the asset, and the specific action you need it to take.",
      },
    },
    required: ["agentId", "task"],
  },
};

const REQUEST_HUMAN_INPUT_TOOL = {
  name: "request_human_input",
  description:
    "Pause the agent and ask a human operator a specific question before proceeding. Use when you lack information needed to act safely — e.g. which asset is affected, whether a risky runbook step is authorised, or if the situation is outside your confidence threshold. The question will be surfaced to the operator in the UI. Once called, stop and do not proceed until the answer arrives.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The specific question for the human operator. Be concise and unambiguous — one question per call.",
      },
      context: {
        type: "string",
        description: "Optional: a sentence of context explaining why you need this information and what you will do once you have it.",
      },
      urgency: {
        type: "string",
        description: "Optional: High | Medium | Low. Defaults to Medium.",
        enum: ["High", "Medium", "Low"],
      },
    },
    required: ["question"],
  },
};

function buildTools(_agent) {
  return [
    SF_QUERY_TOOL,
    LOG_TRACE_TOOL,
    SF_CREATE_TOOL,
    SF_UPDATE_TOOL,
    RETRIEVE_KNOWLEDGE_TOOL,
    HANDOFF_TO_AGENT_TOOL,
    REQUEST_HUMAN_INPUT_TOOL,
  ];
}

// ---------------------------------------------------------------------------
//  Trace + Case helpers
// ---------------------------------------------------------------------------
function stripAttributes(records = []) {
  return records.map((r) => {
    const { attributes, ...rest } = r;
    return rest;
  });
}

// A trace row is a "milestone" (persisted to SF in milestones mode) when it's a
// hand-off/system/human step, a gate, a decision, or an outcome — not routine chatter.
function isMilestone(row) {
  return (
    row.milestone === true ||
    (row.actorType && row.actorType !== "Agent") ||
    (row.gate_type && row.gate_type !== "None") ||
    (row.decision && row.decision !== "N/A") ||
    ["Success", "Failed", "Partial"].includes(row.outcome)
  );
}

async function sfInsertTrace(caseId, row) {
  const fields = {
    Case__c: caseId,
    Step__c: row.step,
    Actor__c: row.actor,
    Actor_Type__c: row.actorType || "Agent",
    Observation__c: row.finding,
    Action_Taken__c: row.action,
    Logged_At__c: row.ts,
  };
  if (row.stage) fields.Stage__c = row.stage;
  if (typeof row.confidence === "number") fields.Confidence__c = row.confidence;
  if (row.gate_type) fields.Gate_Type__c = row.gate_type;
  if (row.decision) fields.Decision__c = row.decision;
  if (row.outcome) fields.Outcome__c = row.outcome;
  await sf.createRecord("Agent_Action_Log__c", fields);
}

// Single trace sink. ALWAYS records locally (memory + runs/<caseId>.json). Writes to
// Salesforce only per TRACE_TO_SF (off | milestones | full).
async function recordTrace(caseId, entry) {
  const list = runTraces.get(caseId) || [];
  const row = { step: list.length + 1, ts: new Date().toISOString(), actorType: "Agent", ...entry };
  list.push(row);
  runTraces.set(caseId, list);
  try {
    await writeFile(join(RUNS_DIR, `${caseId}.json`), JSON.stringify(list, null, 2));
  } catch {}
  if (TRACE_TO_SF === "full" || (TRACE_TO_SF === "milestones" && isMilestone(row))) {
    try {
      await sfInsertTrace(caseId, row);
    } catch (err) {
      console.error("trace→SF failed:", err.message);
    }
  }
  return { step: row.step };
}

function inferServiceLine(text = "") {
  const t = text.toLowerCase();
  if (/\b(camera|cctv|footage|nvr|recording|lens|poe)\b/.test(t)) return "CCTV";
  if (/\b(network|circuit|latency|packet|isp|brownout|demarc|cpe|router|switch)\b/.test(t)) return "Network";
  if (/\b(web|deploy|deployment|http|site|server|rollback|malware|hosting|5\d\d error)\b/.test(t)) return "Web Hosting";
  return null;
}

let atlasAccountId = null;
async function defaultAccountId() {
  if (atlasAccountId) return atlasAccountId;
  const r = await sf.query("SELECT Id FROM Account WHERE Name='Atlas Logistics' LIMIT 1");
  atlasAccountId = (r.records[0] && r.records[0].Id) || null;
  return atlasAccountId;
}

async function createCaseFromEvent(event, accountId) {
  const serviceLine = inferServiceLine(event);
  const correlationId = "ITF-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const fields = {
    Subject: event.slice(0, 255),
    Description: event,
    Status: "New",
    Priority: "Medium",
    AccountId: accountId,
    Stage__c: "Detected",
    Proactive__c: true,
    Correlation_Id__c: correlationId,
    Detected_At__c: new Date().toISOString(),
  };
  if (serviceLine) fields.Service_Line__c = serviceLine;
  const created = await sf.createRecord("Case", fields);
  const info = await sf.query(`SELECT CaseNumber, Account.Name FROM Case WHERE Id='${created.id}' LIMIT 1`);
  const row = info.records[0] || {};
  return {
    caseId: created.id,
    caseNumber: row.CaseNumber,
    account: row.Account && row.Account.Name,
    serviceLine,
    correlationId,
    url: caseUrl(created.id),
  };
}

// ---------------------------------------------------------------------------
//  System prompt assembly
// ---------------------------------------------------------------------------
function dataAccessContext(agent, ctx) {
  if (!SF_ON) {
    const rows = mockCustomers
      .map((c) => `- ${c.name} [${c.id}] | site: ${c.deploymentSite} | profile: ${c.deploymentProfile}`)
      .join("\n");
    return `CUSTOMER DATABASE (mock — Salesforce not configured):\n${rows}`;
  }
  const parts = [
    "SALESFORCE ORG ACCESS: live tools — salesforce_query, salesforce_create, salesforce_update, log_trace_step, retrieve_knowledge, handoff_to_agent, request_human_input. Read real records before acting; never invent data.",
    "KEY OBJECTS & FIELDS:\n" + SCHEMA_SUMMARY,
    "ALLOWED PICKLIST VALUES (use these EXACTLY — do not invent values):\n" + PICKLISTS,
  ];
  if (ctx && ctx.caseId) {
    parts.push(
      `ACTIVE TICKET: Case Id ${ctx.caseId}` +
        (ctx.caseNumber ? ` (CaseNumber ${ctx.caseNumber})` : "") +
        (ctx.account ? ` for account "${ctx.account}"` : "") +
        `. Log every observation→action to THIS ticket with log_trace_step, and scope queries to it.`,
    );
  }
  if (ctx && ctx.assets && ctx.assets.length) {
    parts.push(
      "ASSETS ON THIS ACCOUNT (the ONLY valid assets for this incident — never invent assets or use another account's):\n" +
        ctx.assets
          .map((a) => `  - ${a.Name} [${a.Id}] ${a.Service_Line__c || ""} ${a.Asset_Type__c || ""}${a.Site__c ? " @ " + a.Site__c : ""}`)
          .join("\n") +
        '\nIf the event does not match any of these assets, do not fabricate one — log a trace step (finding = the mismatch; action = "Inputs Required: confirm the correct account/asset") and stop.',
    );
  } else if (ctx && ctx.caseId) {
    parts.push(
      'This account has no assets on record. If the incident needs an asset, log a trace step (action = "Inputs Required") and stop rather than inventing one.',
    );
  }
  parts.push(
    agent.mode === "hitl"
      ? "WRITE GATING: human-in-the-loop. salesforce_query and log_trace_step run freely; salesforce_create/salesforce_update are captured as proposals needing operator approval — propose, then summarize and stop."
      : "WRITE GATING: autonomous. salesforce_create/salesforce_update execute immediately; keep actions reversible and in-scope, and log each via log_trace_step.",
  );
  return parts.join("\n\n");
}

function buildSystem(agent, ctx) {
  const modeRules =
    agent.mode === "autonomous"
      ? "OPERATING MODE: AUTONOMOUS. Decide and act, then report; escalate only on your human trigger."
      : "OPERATING MODE: HUMAN-IN-THE-LOOP. Propose and wait for approval before any external effect.";
  return [
    agent.systemPrompt.trim(),
    modeRules,
    dataAccessContext(agent, ctx),
    "END STATE: a ticket is done at Case.Stage__c='Resolved' (after a verified fix) and then 'Closed' (after closure comms). A specialist sets Case.Stage__c when it completes its part; the Orchestrator drives the ticket to this end state and then stops. Once a ticket is Resolved or Closed, autonomous agents do not run on it.",
    "Use retrieve_knowledge to look up runbooks, SLA rules, and escalation criteria before acting. Do not invent procedures.",
    "Keep responses concise and operational.",
    `TICKET WRITING STYLE: When calling log_trace_step, write the 'finding' and 'action' fields in plain, human-readable English sentences — not technical key=value notation.
- finding: Describe what you observed in simple sentences. Avoid raw field names like "Is_Anomaly=true" or "Status=Critical". Instead say what it means in plain terms. Put each distinct observation on its own line.
- action: Describe what you did or decided. Each distinct action should be on its own line. Avoid long run-on sentences that pack everything together.
Example finding: "The camera at C-07 at Meridian Cold Storage shows a green heartbeat, but its footage telemetry has not written in 11 minutes. This is a classic recording stream stuck fault, not a full camera outage."
Example action: "Classified this as a CCTV service line issue.\nMarked the incident as compliance-sensitive due to the controlled substance profile and compliance-critical site.\nSet priority to High given the Platinum SLA and low risk tolerance.\nAdvancing stage to Triaged."`,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
//  Agent execution
// ---------------------------------------------------------------------------
function lastUserText(messages) {
  const m = [...messages].reverse().find((x) => x.role === "user");
  return m ? String(m.content) : "";
}

function makeExecutor(agent, ctx, proposed, onStep) {
  return async (name, input) => {
    if (name === "salesforce_query") {
      const r = await sf.query(input.soql);
      return JSON.stringify({ totalSize: r.totalSize, records: stripAttributes(r.records) }).slice(0, 8000);
    }

    if (name === "log_trace_step") {
      if (!ctx.caseId) return "No active ticket — cannot log a trace step.";
      const { step } = await recordTrace(ctx.caseId, { actor: agent.name, finding: input.finding, action: input.action, stage: input.stage, confidence: input.confidence, gate_type: input.gate_type, decision: input.decision, outcome: input.outcome, milestone: input.milestone });
      if (SF_ON) {
        const feedBody = `[${agent.name}] Finding: ${input.finding}\nAction: ${input.action}`;
        if (onStep) onStep({ type: "feed_post", agent: agent.name, caseId: ctx.caseId, body: feedBody });
        sf.postToFeed(ctx.caseId, feedBody).catch((err) => console.error("[FEED POST FAILED] Case", ctx.caseId, "—", err.message));
      }
      return `Logged trace step ${step}.`;
    }

    const isWrite = name === "salesforce_create" || name === "salesforce_update";
    if (isWrite && agent.mode === "hitl") {
      const id = "act_" + Math.random().toString(36).slice(2, 9);
      const action = { id, agentId: agent.id, sessionId: ctx.sessionId, caseId: ctx.caseId, accountId: ctx.accountId, op: name, input, status: "pending" };
      pendingActions.set(id, action);
      proposed.push({ id, agentId: agent.id, agentName: agent.name, op: name, sobject: input.sobject, recordId: input.recordId, fields: input.fields });
      return `PROPOSED (approval required, id=${id}): ${name} on ${input.sobject}. NOT executed — summarize and stop.`;
    }
    if (name === "salesforce_create") {
      if (onStep) onStep({ type: "sf_write", agent: agent.name, op: "salesforce_create", sobject: input.sobject, fields: input.fields, caseId: ctx.caseId });
      return JSON.stringify(await sf.createRecord(input.sobject, input.fields));
    }
    if (name === "salesforce_update") {
      if (onStep) onStep({ type: "sf_write", agent: agent.name, op: "salesforce_update", sobject: input.sobject, recordId: input.recordId, fields: input.fields, caseId: ctx.caseId });
      return JSON.stringify(await sf.updateRecord(input.sobject, input.recordId, input.fields));
    }

    if (name === "retrieve_knowledge") {
      const k = Math.min(Math.max(1, input.k || 4), 8);
      const hits = retrieve(input.query, { k });
      if (!hits.length) return "No matching knowledge base sections found for that query.";
      return hits.map((h, i) => `[${i + 1}] ${h.citation}\n${h.text}`).join("\n\n");
    }

    if (name === "handoff_to_agent") {
      const target = getAgent(input.agentId);
      if (!target) return `Unknown agent id: ${input.agentId}. Valid ids: diagnostic-agent, intake-agent, resolution-agent, communications-agent.`;
      if (onStep) onStep({ type: "handoff", from: agent.name, to: target.name, caseId: ctx.caseId, task: input.task });
      const { reply } = await runAgentTask(target, ctx, input.task, onStep);
      return `[${target.name} response]\n${reply}`;
    }

    if (name === "request_human_input") {
      const id = "input_" + Math.random().toString(36).slice(2, 9);
      const gate = {
        id,
        type: "human_input",
        op: "request_human_input",
        agentId: agent.id,
        agentName: agent.name,
        sessionId: ctx.sessionId,
        caseId: ctx.caseId,
        accountId: ctx.accountId,
        question: input.question,
        context: input.context || null,
        urgency: input.urgency || "Medium",
        status: "pending",
        askedAt: new Date().toISOString(),
        // thread snapshot so the agent can resume mid-run when the answer arrives
        _resumeAgent: agent,
        _resumeCtx: ctx,
        _resumeProposed: proposed,
      };
      pendingActions.set(id, gate);
      proposed.push({ id, agentId: agent.id, agentName: agent.name, op: "request_human_input", question: input.question, context: input.context, urgency: input.urgency || "Medium" });
      if (onStep) onStep({ type: "human_input_requested", agent: agent.name, caseId: ctx.caseId, question: input.question, urgency: gate.urgency, id });
      return `HUMAN INPUT REQUESTED (id=${id}): "${input.question}". Stop and wait — do not proceed until the operator responds.`;
    }

    return `Unknown tool: ${name}`;
  };
}

async function runAgentMessages(agent, messages, ctx, proposed, onStep) {
  const tools = SF_ON ? buildTools(agent) : undefined;
  const executeTool = SF_ON ? makeExecutor(agent, ctx, proposed, onStep) : undefined;
  const reply = await chat({
    system: buildSystem(agent, ctx),
    messages,
    meta: { name: agent.name, mode: agent.mode },
    tools,
    executeTool,
    maxSteps: agent.role === "orchestrator" ? 24 : 10,
    onStep,
  });
  return { reply };
}

// Ephemeral run (orchestrator + specialist activations + approvals).
async function runAgentTask(agent, ctx, task, onStep) {
  const proposed = [];
  const { reply } = await runAgentMessages(agent, [{ role: "user", content: task }], ctx, proposed, onStep);
  return { reply, sources: [], proposedActions: proposed };
}

// Build the run context for an existing Case (account + its assets).
async function loadCaseCtx(caseId, sessionId) {
  const info = await sf.query(`SELECT CaseNumber, AccountId, Account.Name FROM Case WHERE Id='${caseId}' LIMIT 1`);
  const row = info.records[0] || {};
  let assets = [];
  if (row.AccountId) {
    try {
      const ar = await sf.query(
        `SELECT Id, Name, Service_Line__c, Asset_Type__c, Operational_Status__c, Site__c, Site_Criticality__c FROM Asset WHERE AccountId='${row.AccountId}' ORDER BY Name LIMIT 50`,
      );
      assets = stripAttributes(ar.records);
    } catch {}
  }
  return { sessionId, caseId, caseNumber: row.CaseNumber, account: row.Account && row.Account.Name, accountId: row.AccountId, assets };
}

// Run the Orchestrator on an existing ticket.
async function orchestrateCase(caseId, sessionId, onStep) {
  const ctx = await loadCaseCtx(caseId, sessionId);
  return runAgentTask(
    ORCHESTRATOR,
    ctx,
    `This is a new ticket created with ticket ID ${ctx.caseNumber} (Case Id: ${caseId}). Handle and triage it.`,
    onStep,
  );
}

// Direct-chat run (uses stored history).
async function runChatTurn(agent, sessionId) {
  const history = historyFor(agent.id, sessionId);
  const proposed = [];
  const ctx = { sessionId, caseId: null, accountId: null };
  const { reply, sources } = await runAgentMessages(agent, history, ctx, proposed, null);
  history.push({ role: "assistant", content: reply });
  return { reply, sources, proposedActions: proposed };
}

// ---------------------------------------------------------------------------
//  HTTP plumbing
// ---------------------------------------------------------------------------
function sendJSON(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function listCustomers() {
  if (!SF_ON) return mockCustomers;
  const r = await sf.query(
    "SELECT Id, Name, SLA_Tier__c, Compliance_Profile__c, Client_Risk_Tolerance__c FROM Account ORDER BY Name LIMIT 200",
  );
  return r.records.map((a) => ({
    id: a.Id,
    name: a.Name,
    deploymentSite: `${a.SLA_Tier__c || "—"} tier`,
    deploymentProfile: `Compliance: ${a.Compliance_Profile__c || "None"} · Risk: ${a.Client_Risk_Tolerance__c || "—"}`,
  }));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJSON(res, 204, {});
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/agents") {
      return sendJSON(res, 200, {
        usingRealModel,
        salesforce: SF_ON,
        agents: AGENTS.map(({ id, name, mode, layer, role, description }) => ({ id, name, mode, layer, role, description })),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/customers") {
      try {
        return sendJSON(res, 200, { customers: await listCustomers(), source: SF_ON ? "salesforce" : "mock" });
      } catch (e) {
        return sendJSON(res, 200, { customers: mockCustomers, source: "mock", error: String(e.message) });
      }
    }

    // Reset the org to the clean demo data set (runs scripts/seed-demo.apex).
    if (req.method === "POST" && url.pathname === "/api/reset-org") {
      if (!SF_ON) return sendJSON(res, 400, { error: "Salesforce not configured." });
      await sf.runApex(SEED_SCRIPT_PATH);
      runTraces.clear(); // local traces point at now-deleted cases
      return sendJSON(res, 200, { ok: true, message: "Org reset to demo data (48 records)." });
    }

    if (req.method === "GET" && url.pathname === "/api/trace") {
      const caseId = url.searchParams.get("caseId");
      return sendJSON(res, 200, { caseId, traceToSf: TRACE_TO_SF, trace: runTraces.get(caseId) || [] });
    }

    if (req.method === "GET" && url.pathname === "/api/knowledge") {
      const q = url.searchParams.get("q");
      return sendJSON(res, 200, { ...knowledgeStats(), ...(q ? { query: q, results: retrieve(q, { k: 5 }) } : {}) });
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const { agentId, sessionId, message } = await readBody(req);
      const agent = getAgent(agentId);
      if (!agent) return sendJSON(res, 404, { error: "Unknown agent" });
      if (!message || !sessionId) return sendJSON(res, 400, { error: "message and sessionId required" });
      historyFor(agent.id, sessionId).push({ role: "user", content: message });
      return sendJSON(res, 200, await runChatTurn(agent, sessionId));
    }

    // Inject event -> create ticket and return it IMMEDIATELY (UI shows the record
    // link right away). The agent run is a separate call (/api/run).
    if (req.method === "POST" && url.pathname === "/api/event") {
      const { event, sessionId, accountId } = await readBody(req);
      if (!event || !sessionId) return sendJSON(res, 400, { error: "event and sessionId required" });
      if (!SF_ON) return sendJSON(res, 400, { error: "Salesforce not configured — cannot create a ticket." });

      const acct = accountId || (await defaultAccountId());
      if (!acct) return sendJSON(res, 400, { error: "No account to attach the ticket to." });

      const tk = await createCaseFromEvent(event, acct);
      await recordTrace(tk.caseId, {
        actor: "Simulator",
        actorType: "System",
        finding: `New ticket created from incident report: "${event}".`,
        action: `Opened ${tk.caseNumber} (service line ${tk.serviceLine || "unclassified"}); notifying the Orchestrator with the Case Id.`,
        stage: "Detected",
        outcome: "Pending",
      });
      return sendJSON(res, 200, { ticket: tk, trace: runTraces.get(tk.caseId) || [] });
    }

    // Run the Orchestrator on an existing ticket. Streams thinking via WebSocket
    // to the session before returning the final reply over HTTP.
    if (req.method === "POST" && url.pathname === "/api/run") {
      const { caseId, sessionId } = await readBody(req);
      if (!caseId || !sessionId) return sendJSON(res, 400, { error: "caseId and sessionId required" });
      req.socket.setTimeout(300_000); // 5 min — agent runs can be long
      const onStep = (e) => wsEmit(sessionId, e);
      let out;
      try {
        out = await orchestrateCase(caseId, sessionId, onStep);
      } catch (e) {
        out = { reply: `⚠️ Agent run could not start: ${e.message}`, sources: [], proposedActions: [] };
      }
      wsEmit(sessionId, { type: "done" });
      return sendJSON(res, 200, { trace: runTraces.get(caseId) || [], ...out });
    }

    // Unified human-in-the-loop response endpoint.
    // Handles all gate types: SF write approvals, human input answers, verify-and-close.
    // Body: { actionId, decision: "approved"|"rejected", answer?, note? }
    //   answer — free-text response for request_human_input gates
    //   note   — optional operator note for rejections
    if (req.method === "POST" && url.pathname === "/api/hitl-respond") {
      const { actionId, decision, answer, note } = await readBody(req);
      if (!actionId || !decision) return sendJSON(res, 400, { error: "actionId and decision required" });
      const action = pendingActions.get(actionId);
      if (!action) return sendJSON(res, 404, { error: "Unknown action" });
      if (action.status !== "pending") return sendJSON(res, 409, { error: `Action already ${action.status}` });

      action.status = decision;
      const agent = getAgent(action.agentId);
      const ctx = { sessionId: action.sessionId, caseId: action.caseId, accountId: action.accountId };
      const onStep = (e) => wsEmit(action.sessionId, e);
      let out;

      // ── SF write gate (Approval) ──────────────────────────────────────────
      if (action.op === "salesforce_create" || action.op === "salesforce_update") {
        if (decision === "approved") {
          const result = action.op === "salesforce_create"
            ? await sf.createRecord(action.input.sobject, action.input.fields)
            : await sf.updateRecord(action.input.sobject, action.input.recordId, action.input.fields);
          if (action.caseId)
            await recordTrace(action.caseId, {
              actor: "Human",
              actorType: "Human",
              finding: `Operator approved ${action.op} on ${action.input.sobject}.`,
              action: `Executed: ${JSON.stringify(result)}.`,
              gate_type: "Approval",
              decision: "Approved",
              outcome: "Success",
              milestone: true,
            });
          out = await runAgentTask(
            agent,
            ctx,
            `The operator APPROVED your proposed ${action.op} on ${action.input.sobject}. ` +
              `The system executed it → ${JSON.stringify(result)}. ` +
              `Re-read the ticket, continue from where you left off, and drive it to resolution.`,
            onStep,
          );
        } else {
          if (action.caseId)
            await recordTrace(action.caseId, {
              actor: "Human",
              actorType: "Human",
              finding: `Operator rejected ${action.op} on ${action.input.sobject}.`,
              action: note ? `Reason: ${note}` : "No alternative executed.",
              gate_type: "Approval",
              decision: "Rejected",
              outcome: "Pending",
              milestone: true,
            });
          out = await runAgentTask(
            agent,
            ctx,
            `The operator REJECTED your proposed ${action.op} on ${action.input.sobject}.${note ? " Reason: " + note : ""} ` +
              `Re-read the ticket and propose an alternative path to resolution, or escalate if nothing safe remains.`,
            onStep,
          );
        }
      }

      // ── Human input gate (Inputs Required / Verify & Close) ──────────────
      else if (action.op === "request_human_input") {
        const humanAnswer = answer || (decision === "approved" ? "Confirmed." : note || "Request declined.");
        if (action.caseId)
          await recordTrace(action.caseId, {
            actor: "Human",
            actorType: "Human",
            finding: `Human responded to agent question: "${action.question}"`,
            action: humanAnswer,
            gate_type: "Inputs Required",
            decision: decision === "approved" ? "Approved" : "Rejected",
            outcome: "Pending",
            milestone: true,
          });
        // Resume the originating agent with the answer injected as context.
        out = await runAgentTask(
          action._resumeAgent || agent,
          action._resumeCtx || ctx,
          `The human operator has responded to your question.\n` +
            `Question: "${action.question}"\n` +
            `Answer: ${humanAnswer}\n\n` +
            `Resume from where you left off using this answer. ` +
            `If this was a Verify & Close confirmation, proceed to set the Case stage to Resolved and then hand off to the Communications Agent for closure.`,
          onStep,
        );
      }

      else {
        return sendJSON(res, 400, { error: `Unhandled gate op: ${action.op}` });
      }

      wsEmit(action.sessionId, { type: "done" });
      return sendJSON(res, 200, { ok: true, trace: runTraces.get(action.caseId) || [], ...out });
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      const { agentId, sessionId } = await readBody(req);
      conversations.delete(keyFor(agentId, sessionId));
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      let salesforce = { configured: SF_ON };
      if (SF_ON) {
        try {
          salesforce = { configured: true, ...(await sf.ping()) };
        } catch (e) {
          salesforce = { configured: true, ok: false, error: String(e.message) };
        }
      }
      return sendJSON(res, 200, { ok: true, usingRealModel, salesforce });
    }

    return sendJSON(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    return sendJSON(res, 500, { error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
//  WebSocket upgrade handler
// ---------------------------------------------------------------------------
server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/ws") return socket.destroy();
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();

  const accept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const sid = url.searchParams.get("sessionId") || "default";
  if (!wsClients.has(sid)) wsClients.set(sid, new Set());
  const clientSet = wsClients.get(sid);
  clientSet.add(socket);

  socket.on("data", (buf) => {
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    if (opcode === 0x8) return socket.destroy(); // close frame
    if (opcode === 0x9) {
      // ping → pong (unmask client payload first)
      const masked = (buf[1] & 0x80) !== 0;
      const rawLen = buf[1] & 0x7f;
      let offset = 2;
      if (rawLen === 126) offset = 4;
      else if (rawLen === 127) offset = 10;
      const maskKey = masked ? buf.slice(offset, offset + 4) : null;
      if (masked) offset += 4;
      const payload = Buffer.from(buf.slice(offset, offset + rawLen));
      if (masked && maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      socket.write(wsFrame(0xa, payload));
    }
  });

  socket.on("close", () => clientSet.delete(socket));
  socket.on("error", () => clientSet.delete(socket));
});

server.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws?sessionId=<id>`);
  console.log(usingRealModel ? "Model: real Claude" : "Model: offline MOCK (set ANTHROPIC_API_KEY)");
  console.log(SF_ON ? "Salesforce: configured — live read/write" : "Salesforce: NOT configured (mock DB)");
  console.log(`Trace: local always (runs/); to Salesforce = ${TRACE_TO_SF}`);
  const kb = knowledgeStats();
  console.log(kb.ok ? `Knowledge base: ${kb.chunks} sections from ${kb.files} files` : `Knowledge base: EMPTY`);
});
