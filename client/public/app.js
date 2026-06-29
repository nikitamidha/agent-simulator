// ============================================================================
//  Frontend logic for the Agent Simulator chat UI.
//  Talks to the API server on port 4000.
// ============================================================================

const API = `http://${location.hostname}:4000`;
const WS_URL = `ws://${location.hostname}:4000/ws`;

// A per-browser-tab session id so each tab has its own conversation per agent.
const sessionId =
  sessionStorage.getItem("sessionId") ||
  (() => {
    const id = Math.random().toString(36).slice(2);
    sessionStorage.setItem("sessionId", id);
    return id;
  })();

let agents = [];
let activeAgent = null;
const transcripts = {}; // agentId -> array of {role, text}

// --- DOM refs ---
const els = {
  modelBadge: document.getElementById("model-badge"),
  resetOrgBtn: document.getElementById("reset-org-btn"),
  agentList: document.getElementById("agent-list"),
  customerList: document.getElementById("customer-list"),
  activeName: document.getElementById("active-agent-name"),
  activeMode: document.getElementById("active-agent-mode"),
  messages: document.getElementById("messages"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  resetBtn: document.getElementById("reset-btn"),
  eventAccount: document.getElementById("event-account"),
  eventPreset: document.getElementById("event-preset"),
  eventText: document.getElementById("event-text"),
  injectBtn: document.getElementById("inject-btn"),
  ticketLink: document.getElementById("ticket-link"),
};

// ---------------------------------------------------------------------------
//  WebSocket — live thinking stream from the agent server
// ---------------------------------------------------------------------------
let ws = null;
let activeThinkingNode = null; // the DOM node currently showing streaming steps
let thinkingSteps = [];        // accumulated HTML strings for that node

function connectWebSocket() {
  ws = new WebSocket(`${WS_URL}?sessionId=${sessionId}`);

  ws.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      handleStreamEvent(event);
    } catch {}
  };

  // Reconnect automatically if the server restarts.
  ws.onclose = () => setTimeout(connectWebSocket, 2000);
  ws.onerror = () => {};
}

function handleStreamEvent(event) {
  if (event.type === "done") {
    // Final reply is delivered via HTTP — the thinking node gets replaced there.
    return;
  }
  if (!activeThinkingNode) return;

  const stepsDiv = activeThinkingNode.querySelector(".thinking-steps");
  if (!stepsDiv) return;

  let html = "";
  switch (event.type) {
    case "thinking":
      if (event.text) {
        html = `<div class="ts-thinking">💭 <strong>${escapeHtml(event.agent || "")}</strong>: ${escapeHtml(event.text.slice(0, 300))}${event.text.length > 300 ? "…" : ""}</div>`;
      }
      break;
    case "tool_call":
      html = `<div class="ts-tool-call">🔧 <strong>${escapeHtml(event.agent || "")}</strong> → <code>${escapeHtml(event.name)}</code></div>`;
      break;
    case "tool_result":
      html = `<div class="ts-tool-result">✓ <code>${escapeHtml(event.name)}</code>: ${escapeHtml(event.preview || "")}</div>`;
      break;
    case "activate_agent":
      html = `<div class="ts-activate">⚡ Activating <strong>${escapeHtml(event.specialist || "")}</strong></div>`;
      break;
  }

  if (html) {
    thinkingSteps.push(html);
    stepsDiv.innerHTML = thinkingSteps.join("");
    els.messages.scrollTop = els.messages.scrollHeight;
  }
}

// --- Reset Org to Demo Data ---
els.resetOrgBtn.addEventListener("click", async () => {
  if (
    !confirm(
      "Reset the Salesforce org to the clean demo data set?\n\nThis deletes current tickets, traces, and telemetry and re-seeds the 48 demo records (3 accounts · 5 contacts · 5 assets · 7 telemetry · 2 cases · 18 logs · 8 runbooks).",
    )
  )
    return;
  const original = els.resetOrgBtn.textContent;
  els.resetOrgBtn.disabled = true;
  els.resetOrgBtn.textContent = "Resetting org…";
  try {
    const res = await fetch(`${API}/api/reset-org`, { method: "POST" });
    const data = await res.json();
    if (data.error) {
      alert("Reset failed: " + data.error);
    } else {
      els.modelBadge.textContent = "Org reset to demo ✓";
      await loadCustomers(); // accounts changed — refresh the dropdown + panel
    }
  } catch (e) {
    alert("Reset failed: " + e.message);
  } finally {
    els.resetOrgBtn.disabled = false;
    els.resetOrgBtn.textContent = original;
  }
});

// --- Init ---
init();

async function init() {
  connectWebSocket();
  await Promise.all([loadAgents(), loadCustomers()]);
  syncPreset();
}

async function loadAgents() {
  try {
    const res = await fetch(`${API}/api/agents`);
    const data = await res.json();
    agents = data.agents;
    els.modelBadge.textContent = data.usingRealModel
      ? "Claude connected"
      : "Mock mode (no API key)";
    renderAgentList();
  } catch (e) {
    els.modelBadge.textContent = "API offline";
  }
}

async function loadCustomers() {
  try {
    const res = await fetch(`${API}/api/customers`);
    const { customers } = await res.json();
    els.customerList.innerHTML = customers
      .map(
        (c) => `
        <div class="customer-card">
          <div class="cname">${escapeHtml(c.name)}</div>
          <div class="crow">Site: ${escapeHtml(c.deploymentSite)}</div>
          <div class="crow">Profile: ${escapeHtml(c.deploymentProfile)}</div>
        </div>`,
      )
      .join("");

    // Populate the event Account dropdown (default to Atlas Logistics) and
    // enable event injection once accounts are loaded.
    els.eventAccount.innerHTML = customers
      .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
      .join("");
    const atlas = customers.find((c) => /atlas/i.test(c.name));
    if (atlas) els.eventAccount.value = atlas.id;
    els.injectBtn.disabled = false;
  } catch (e) {
    els.customerList.innerHTML = `<p class="hint">Could not load customers.</p>`;
  }
}

function renderAgentList() {
  els.agentList.innerHTML = "";
  agents.forEach((a) => {
    const btn = document.createElement("button");
    btn.className = "agent-card" + (activeAgent?.id === a.id ? " active" : "");
    btn.innerHTML = `
      <div class="name">${escapeHtml(a.name)}
        <span class="mode-chip ${a.mode}">${a.mode === "hitl" ? "human-in-the-loop" : "autonomous"}</span>
      </div>
      <div class="desc">${escapeHtml(a.description)}</div>`;
    btn.onclick = () => selectAgent(a);
    els.agentList.appendChild(btn);
  });
}

function selectAgent(agent) {
  activeAgent = agent;
  if (!transcripts[agent.id]) transcripts[agent.id] = [];
  renderAgentList();
  els.activeName.textContent = agent.name;
  els.activeMode.textContent = agent.mode === "hitl" ? "human-in-the-loop" : "autonomous";
  els.activeMode.className = "mode-tag " + agent.mode;
  els.chatInput.disabled = false;
  els.chatForm.querySelector("button").disabled = false;
  els.injectBtn.disabled = false;
  renderMessages();
}

function renderMessages() {
  const list = activeAgent ? transcripts[activeAgent.id] : [];
  if (!list || list.length === 0) {
    els.messages.innerHTML = `<div class="empty">No messages yet. Say hello or inject an event.</div>`;
    return;
  }
  els.messages.innerHTML = list
    .map((m) => {
      if (m.role === "trace") return traceHtml(m.trace);
      const label = m.role === "user" ? "You" : activeAgent.name;
      return `<div class="msg ${m.role}"><div class="role">${escapeHtml(label)}</div>${escapeHtml(m.text)}${sourcesHtml(m.sources)}${actionsHtml(m.actions)}</div>`;
    })
    .join("");
  els.messages.scrollTop = els.messages.scrollHeight;
}

function push(role, text, sources, actions) {
  transcripts[activeAgent.id].push({ role, text, sources, actions });
  renderMessages();
}

// The local run trace (always available even when TRACE_TO_SF=off).
function pushTrace(trace) {
  if (!trace || !trace.length) return;
  transcripts[activeAgent.id].push({ role: "trace", trace });
  renderMessages();
}

function traceHtml(trace) {
  if (!trace || !trace.length) return "";
  const items = trace
    .map(
      (r) =>
        `<li><span class="t-step">${r.step}</span><div class="t-body">` +
        `<div class="t-actor">${escapeHtml(r.actor || "")} <span class="t-type">${escapeHtml(r.actorType || "Agent")}</span></div>` +
        `<div class="t-find">🔎 ${escapeHtml(r.finding || "")}</div>` +
        `<div class="t-act">⚙️ ${escapeHtml(r.action || "")}</div></div></li>`,
    )
    .join("");
  return `<div class="msg trace"><div class="trace-label">🧭 Run trace (local · ${trace.length} steps)</div><ol class="trace-list">${items}</ol></div>`;
}

// Pending write proposals that have already been approved/rejected (hide buttons).
const resolvedActions = new Set();

// Render the "Sources" footer under an agent reply (the RAG citations).
function sourcesHtml(sources) {
  if (!sources || !sources.length) return "";
  const items = sources
    .map(
      (s) =>
        `<li><span class="src-tag">[${s.tag}]</span> ${escapeHtml(s.citation)}</li>`,
    )
    .join("");
  return `<div class="sources"><div class="sources-label">📚 Knowledge base sources</div><ul>${items}</ul></div>`;
}

// Render proposed Salesforce writes (from human-in-the-loop agents) with
// Approve / Reject controls. Once resolved, show the outcome instead of buttons.
function actionsHtml(actions) {
  if (!actions || !actions.length) return "";
  const blocks = actions
    .map((a) => {
      const summary =
        a.op === "salesforce_update"
          ? `Update <strong>${escapeHtml(a.sobject)}</strong> ${escapeHtml(a.recordId || "")}`
          : `Create <strong>${escapeHtml(a.sobject)}</strong>`;
      const fields = escapeHtml(JSON.stringify(a.fields || {}, null, 0));
      const controls = resolvedActions.has(a.id)
        ? `<span class="act-done">resolved</span>`
        : `<button class="approve" data-act="${a.id}">Approve</button>` +
          `<button class="reject ghost" data-act="${a.id}">Reject</button>`;
      return `<div class="action"><div class="action-summary">⚠️ Proposed write — needs approval: ${summary}</div><div class="action-fields">${fields}</div><div class="action-controls">${controls}</div></div>`;
    })
    .join("");
  return `<div class="actions">${blocks}</div>`;
}

// One delegated listener handles Approve/Reject on any rendered proposal.
els.messages.addEventListener("click", async (e) => {
  const btn = e.target.closest("button.approve, button.reject");
  if (!btn) return;
  const actionId = btn.dataset.act;
  const isApprove = btn.classList.contains("approve");
  resolvedActions.add(actionId); // hide buttons immediately
  renderMessages();
  const pending = thinking();
  try {
    const res = await fetch(`${API}/api/${isApprove ? "approve" : "reject"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actionId }),
    });
    const data = await res.json();
    pending.remove();
    activeThinkingNode = null;
    if (data.error) {
      push("agent", `Error: ${data.error}`);
    } else {
      push("agent", data.reply, data.sources, data.proposedActions);
      pushTrace(data.trace);
    }
  } catch (err) {
    pending.remove();
    activeThinkingNode = null;
    push("agent", `Request failed: ${err.message}`);
  }
});

// --- Chat ---
els.chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text || !activeAgent) return;
  els.chatInput.value = "";
  push("user", text);
  const pending = thinking();
  try {
    const res = await fetch(`${API}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: activeAgent.id, sessionId, message: text }),
    });
    const data = await res.json();
    pending.remove();
    activeThinkingNode = null;
    push("agent", data.reply ?? `Error: ${data.error}`, data.sources, data.proposedActions);
  } catch (err) {
    pending.remove();
    activeThinkingNode = null;
    push("agent", `Request failed: ${err.message}`);
  }
});

// --- Event injection ---
els.eventPreset.addEventListener("change", syncPreset);
function syncPreset() {
  const v = els.eventPreset.value;
  if (v === "__custom__") {
    els.eventText.value = "";
    els.eventText.focus();
  } else {
    els.eventText.value = v;
  }
}

els.injectBtn.addEventListener("click", async () => {
  const text = els.eventText.value.trim();
  if (!text) return;
  const accountId = els.eventAccount.value || undefined;

  // The Orchestrator handles the ticket — switch to it so its run shows here.
  const orch = agents.find((a) => a.role === "orchestrator");
  if (orch) selectAgent(orch);

  els.injectBtn.disabled = true;
  els.ticketLink.innerHTML = "";

  // Step 1 — create the ticket and show its Salesforce link immediately.
  // No messages in the chat for this; only the ticket link is shown.
  let ticket;
  try {
    const res = await fetch(`${API}/api/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, event: text, accountId }),
    });
    const data = await res.json();
    if (data.error || !data.ticket) {
      push("agent", `Error creating ticket: ${data.error || "no ticket returned"}`);
      els.injectBtn.disabled = false;
      return;
    }
    ticket = data.ticket;
    if (ticket.url)
      els.ticketLink.innerHTML = `<a href="${ticket.url}" target="_blank" rel="noopener">🎫 ${escapeHtml(ticket.caseNumber)} — open in Salesforce ↗</a>`;
    else if (ticket.caseNumber)
      els.ticketLink.innerHTML = `<span class="ticket-badge">🎫 ${escapeHtml(ticket.caseNumber)} created</span>`;
  } catch (err) {
    push("agent", `Ticket creation failed: ${err.message}`);
    els.injectBtn.disabled = false;
    return;
  }

  // Step 2 — run the Orchestrator on the ticket.
  // Thinking steps stream in live via WebSocket; final reply arrives via HTTP.
  const pending = thinking();
  try {
    const res = await fetch(`${API}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, caseId: ticket.caseId }),
    });
    const data = await res.json();
    pending.remove();
    activeThinkingNode = null;
    push("agent", data.reply ?? `Error: ${data.error}`, data.sources, data.proposedActions);
    pushTrace(data.trace);
  } catch (err) {
    pending.remove();
    activeThinkingNode = null;
    push("agent", `Agent run failed: ${err.message}`);
  } finally {
    els.injectBtn.disabled = false;
  }
});

// --- Reset ---
els.resetBtn.addEventListener("click", async () => {
  if (!activeAgent) return;
  transcripts[activeAgent.id] = [];
  renderMessages();
  await fetch(`${API}/api/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: activeAgent.id, sessionId }),
  });
});

// --- Helpers ---
function thinking() {
  thinkingSteps = [];
  const node = document.createElement("div");
  node.className = "msg agent thinking-stream";
  node.innerHTML =
    `<div class="role">${escapeHtml(activeAgent?.name ?? "Agent")}</div>` +
    `<div class="thinking-steps"><em class="thinking-pulse">Working…</em></div>`;
  els.messages.appendChild(node);
  els.messages.scrollTop = els.messages.scrollHeight;
  activeThinkingNode = node;
  return node;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
