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
//    POST /api/event  { accountId, sessionId, event }     -> orchestrated ticket run
//    POST /api/approve { actionId }    POST /api/reject { actionId, note }
//    POST /api/reset  { agentId, sessionId }
// ============================================================================

import http from "node:http";
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
const ORCHESTRATOR = AGENTS.find((a) => a.role === "orchestrator");
const SPECIALISTS = AGENTS.filter((a) => a.role !== "orchestrator");

// Trace persistence: runs are ALWAYS kept locally; Salesforce gets the trace only
// per TRACE_TO_SF = "off" (default) | "milestones" | "full". Cases are always in SF.
const TRACE_TO_SF = (process.env.TRACE_TO_SF || "off").toLowerCase();
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
const ACTIVATE_AGENT_TOOL = {
  name: "activate_agent",
  description:
    "Activate a specialist agent to work the active ticket. Use to triage and to coordinate hand-offs. The specialist reads the Case, does its work, writes its own trace rows, and returns a summary.",
  input_schema: {
    type: "object",
    properties: {
      agentId: { type: "string", enum: SPECIALISTS.map((a) => a.id), description: "Which specialist to activate." },
      task: { type: "string", description: "What you want this specialist to do for this ticket." },
    },
    required: ["agentId", "task"],
  },
};

function buildTools(agent) {
  const tools = [SF_QUERY_TOOL, LOG_TRACE_TOOL];
  if (agent.role === "orchestrator") tools.push(ACTIVATE_AGENT_TOOL);
  else tools.push(SF_CREATE_TOOL, SF_UPDATE_TOOL);
  return tools;
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

async function getCaseStage(caseId) {
  try {
    const r = await sf.query(`SELECT Stage__c FROM Case WHERE Id='${caseId}' LIMIT 1`);
    return r.records[0] && r.records[0].Stage__c;
  } catch {
    return null;
  }
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
    "SALESFORCE ORG ACCESS: live tools (salesforce_query + log_trace_step" +
      (agent.role === "orchestrator" ? " + activate_agent" : " + salesforce_create/update") +
      "). Read real records before acting; never invent data.",
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
  if (agent.role === "orchestrator") {
    const roster = SPECIALISTS.map((a) => `  - ${a.id} (${a.layer}): ${a.description}`).join("\n");
    parts.push(
      "SPECIALISTS you can activate (activate_agent):\n" + roster +
        "\nRoute Scoping & Triage first, then the matching domain specialist; coordinate hand-offs; stop at the first human-in-the-loop gate. Drive the ticket to its end state — Resolved (after a verified fix), then Closed (after closure comms) — then stop. Do not activate autonomous agents on a ticket that is already Resolved or Closed.",
    );
  } else {
    parts.push(
      agent.mode === "hitl"
        ? "WRITE GATING: human-in-the-loop. salesforce_query and log_trace_step run freely; salesforce_create/salesforce_update are captured as proposals needing operator approval — propose, then summarize and stop."
        : "WRITE GATING: autonomous. salesforce_create/salesforce_update execute immediately; keep actions reversible and in-scope, and log each via log_trace_step.",
    );
  }
  return parts.join("\n\n");
}

function knowledgeContext(hits) {
  if (!hits || hits.length === 0)
    return "KNOWLEDGE BASE: no sections matched this turn. Do not invent runbooks/SLAs — escalate or ask.";
  const blocks = hits.map((h, i) => `[${i + 1}] ${h.citation}\n${h.text}`).join("\n\n");
  return `KNOWLEDGE BASE (authoritative; cite [n]):\n\n${blocks}`;
}

function buildSystem(agent, hits, ctx) {
  const modeRules =
    agent.role === "orchestrator"
      ? "ROLE: MANAGER. Coordinate; delegate specialist work via activate_agent; do not do it yourself."
      : agent.mode === "autonomous"
        ? "OPERATING MODE: AUTONOMOUS. Decide and act, then report; escalate only on your human trigger."
        : "OPERATING MODE: HUMAN-IN-THE-LOOP. Propose and wait for approval before any external effect.";
  return [
    agent.systemPrompt.trim(),
    modeRules,
    dataAccessContext(agent, ctx),
    "END STATE: a ticket is done at Case.Stage__c='Resolved' (after a verified fix) and then 'Closed' (after closure comms). A specialist sets Case.Stage__c when it completes its part; the Orchestrator drives the ticket to this end state and then stops. Once a ticket is Resolved or Closed, autonomous agents do not run on it.",
    knowledgeContext(hits),
    "Keep responses concise and operational.",
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
//  Agent execution
// ---------------------------------------------------------------------------
function lastUserText(messages) {
  const m = [...messages].reverse().find((x) => x.role === "user");
  return m ? String(m.content) : "";
}

function makeExecutor(agent, ctx, proposed) {
  return async (name, input) => {
    if (name === "salesforce_query") {
      const r = await sf.query(input.soql);
      return JSON.stringify({ totalSize: r.totalSize, records: stripAttributes(r.records) }).slice(0, 8000);
    }

    if (name === "log_trace_step") {
      if (!ctx.caseId) return "No active ticket — cannot log a trace step.";
      const { step } = await recordTrace(ctx.caseId, { actor: agent.name, finding: input.finding, action: input.action, stage: input.stage, confidence: input.confidence, gate_type: input.gate_type, decision: input.decision, outcome: input.outcome, milestone: input.milestone });
      return `Logged trace step ${step}.`;
    }

    if (name === "activate_agent") {
      const spec = getAgent(input.agentId);
      if (!spec || spec.role === "orchestrator") return `Unknown specialist: ${input.agentId}`;
      // End state: once the ticket is Resolved/Closed, autonomous agents don't run on it.
      if (ctx.caseId && spec.mode === "autonomous") {
        const stage = await getCaseStage(ctx.caseId);
        if (stage === "Resolved" || stage === "Closed")
          return `Ticket is ${stage} — autonomous agents do not run on a resolved/closed ticket. Do not activate ${spec.name}; the ticket has reached its end state.`;
      }
      const sub = await runAgentTask(spec, ctx, input.task);
      if (sub.proposedActions.length) proposed.push(...sub.proposedActions);
      return (
        `${spec.name} reported: ${sub.reply}` +
        (sub.proposedActions.length ? " [This specialist PROPOSED a gated action awaiting operator approval — stop and report it.]" : "")
      );
    }

    const isWrite = name === "salesforce_create" || name === "salesforce_update";
    if (isWrite && agent.mode === "hitl") {
      const id = "act_" + Math.random().toString(36).slice(2, 9);
      const action = { id, agentId: agent.id, sessionId: ctx.sessionId, caseId: ctx.caseId, accountId: ctx.accountId, op: name, input, status: "pending" };
      pendingActions.set(id, action);
      proposed.push({ id, agentId: agent.id, agentName: agent.name, op: name, sobject: input.sobject, recordId: input.recordId, fields: input.fields });
      return `PROPOSED (approval required, id=${id}): ${name} on ${input.sobject}. NOT executed — summarize and stop.`;
    }
    if (name === "salesforce_create") return JSON.stringify(await sf.createRecord(input.sobject, input.fields));
    if (name === "salesforce_update") return JSON.stringify(await sf.updateRecord(input.sobject, input.recordId, input.fields));
    return `Unknown tool: ${name}`;
  };
}

async function runAgentMessages(agent, messages, ctx, proposed) {
  const hits = retrieve(lastUserText(messages), { k: 4 });
  const tools = SF_ON ? buildTools(agent) : undefined;
  const executeTool = SF_ON ? makeExecutor(agent, ctx, proposed) : undefined;
  const reply = await chat({
    system: buildSystem(agent, hits, ctx),
    messages,
    meta: { name: agent.name, mode: agent.mode, sources: hits.map((h, i) => ({ tag: i + 1, citation: h.citation })) },
    tools,
    executeTool,
    maxSteps: agent.role === "orchestrator" ? 24 : 10,
  });
  const sources = hits.map((h, i) => ({ tag: i + 1, citation: h.citation, score: h.score }));
  return { reply, sources };
}

// Ephemeral run (orchestrator + specialist activations + approvals).
async function runAgentTask(agent, ctx, task) {
  const proposed = [];
  const { reply, sources } = await runAgentMessages(agent, [{ role: "user", content: task }], ctx, proposed);
  return { reply, sources, proposedActions: proposed };
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

// Run the Orchestrator on an existing ticket — it reads the Case from SF itself.
async function orchestrateCase(caseId, sessionId) {
  const ctx = await loadCaseCtx(caseId, sessionId);
  return runAgentTask(
    ORCHESTRATOR,
    ctx,
    `A new ticket ${ctx.caseNumber} (Case Id ${caseId}) was just created. ` +
      `Read the Case from Salesforce (Subject, Description, Service_Line__c, Account, Asset) to learn the incident — ` +
      `do not assume; query it. Then route it to the right specialist(s), coordinate hand-offs, and stop at any human approval gate.`,
  );
}

// Direct-chat run (uses stored history).
async function runChatTurn(agent, sessionId) {
  const history = historyFor(agent.id, sessionId);
  const proposed = [];
  const ctx = { sessionId, caseId: null, accountId: null };
  const { reply, sources } = await runAgentMessages(agent, history, ctx, proposed);
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

    // Inject event -> create ticket -> Orchestrator routes & coordinates.
    // Step 1: create the ticket and return it IMMEDIATELY (so the UI can show the
    // record link right away). The agent run is a separate call (/api/run).
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

    // Step 2: run the Orchestrator on an existing ticket (it queries the Case itself).
    if (req.method === "POST" && url.pathname === "/api/run") {
      const { caseId, sessionId } = await readBody(req);
      if (!caseId || !sessionId) return sendJSON(res, 400, { error: "caseId and sessionId required" });
      let out;
      try {
        out = await orchestrateCase(caseId, sessionId);
      } catch (e) {
        out = { reply: `⚠️ Agent run could not start: ${e.message}`, sources: [], proposedActions: [] };
      }
      return sendJSON(res, 200, { trace: runTraces.get(caseId) || [], ...out });
    }

    // Approve a pending HITL write: execute it, then the specialist verifies/logs.
    if (req.method === "POST" && url.pathname === "/api/approve") {
      const { actionId } = await readBody(req);
      const action = pendingActions.get(actionId);
      if (!action) return sendJSON(res, 404, { error: "Unknown action" });
      if (action.status !== "pending") return sendJSON(res, 409, { error: `Action already ${action.status}` });

      let result;
      if (action.op === "salesforce_create") result = await sf.createRecord(action.input.sobject, action.input.fields);
      else result = await sf.updateRecord(action.input.sobject, action.input.recordId, action.input.fields);
      action.status = "approved";

      const agent = getAgent(action.agentId);
      const ctx = { sessionId: action.sessionId, caseId: action.caseId, accountId: action.accountId };
      if (action.caseId)
        await recordTrace(action.caseId, {
          actor: agent.name,
          actorType: "Human",
          finding: `Operator approved the proposed ${action.op} on ${action.input.sobject}.`,
          action: `Executed it (${JSON.stringify(result)}).`,
          gate_type: "Approval",
          decision: "Approved",
          outcome: "Success",
        });
      const out = await runAgentTask(
        ORCHESTRATOR,
        ctx,
        `On the active ticket (Case Id ${action.caseId}), the operator APPROVED and the system executed: ${action.op} on ${action.input.sobject} → ${JSON.stringify(result)}. ` +
          `Resume coordinating: re-read the ticket and its trace, continue hand-offs, and drive it to its end state (Stage Resolved after a verified fix, then Closed after closure comms). Stop at the next human gate or once resolved.`,
      );
      return sendJSON(res, 200, { ok: true, result, trace: runTraces.get(action.caseId) || [], ...out });
    }

    if (req.method === "POST" && url.pathname === "/api/reject") {
      const { actionId, note } = await readBody(req);
      const action = pendingActions.get(actionId);
      if (!action) return sendJSON(res, 404, { error: "Unknown action" });
      if (action.status !== "pending") return sendJSON(res, 409, { error: `Action already ${action.status}` });
      action.status = "rejected";
      const agent = getAgent(action.agentId);
      const ctx = { sessionId: action.sessionId, caseId: action.caseId, accountId: action.accountId };
      if (action.caseId)
        await recordTrace(action.caseId, {
          actor: agent.name,
          actorType: "Human",
          finding: `Operator rejected the proposed ${action.op} on ${action.input.sobject}.`,
          action: note ? `Reason: ${note}` : "No alternative executed.",
          gate_type: "Approval",
          decision: "Rejected",
          outcome: "Pending",
        });
      const out = await runAgentTask(
        ORCHESTRATOR,
        ctx,
        `On the active ticket (Case Id ${action.caseId}), the operator REJECTED the proposed ${action.op} on ${action.input.sobject}.${note ? " Note: " + note : ""} ` +
          `Re-plan via the specialists: propose an alternative path to resolution, or stop if nothing further is safe.`,
      );
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

server.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
  console.log(usingRealModel ? "Model: real Claude" : "Model: offline MOCK (set ANTHROPIC_API_KEY)");
  console.log(SF_ON ? "Salesforce: configured — live read/write" : "Salesforce: NOT configured (mock DB)");
  console.log(`Trace: local always (runs/); to Salesforce = ${TRACE_TO_SF}`);
  const kb = knowledgeStats();
  console.log(kb.ok ? `Knowledge base: ${kb.chunks} sections from ${kb.files} files` : `Knowledge base: EMPTY`);
});
