// ============================================================================
//  Frontend logic for the Agent Simulator chat UI.
//  Talks to the API server on port 4000.
// ============================================================================

const API = `http://${location.hostname}:4000`;
const WS_URL = `ws://${location.hostname}:4000/ws`;

// Override marked's table renderer so pipe-separated agent output flows as
// normal text instead of being laid out as an HTML table.
marked.use({
  renderer: {
    table(header, body) {
      return `<div class="md-flat-table">${header}${body}</div>`;
    },
    tablerow(content) {
      return `<p class="md-flat-row">${content}</p>`;
    },
    tablecell(content, flags) {
      return flags && flags.header
        ? `<strong>${content}</strong> `
        : `${content} `;
    },
  },
});

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
const sfWriteLogs = []; // all SF create/update events across all runs
let activeTab = "chat";

// --- DOM refs ---
const els = {
  modelBadge: document.getElementById("model-badge"),
  resetOrgBtn: document.getElementById("reset-org-btn"),
  agentList: document.getElementById("agent-list"),
  customerList: document.getElementById("customer-list"),
  activeName: document.getElementById("active-agent-name"),
  activeMode: document.getElementById("active-agent-mode"),
  messages: document.getElementById("messages"),
  finalSnapshot: document.getElementById("final-snapshot"),
  sfLogs: document.getElementById("sf-logs"),
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
let activeThinkingNode = null;   // run-stream container node
let currentThinkingAgent = null; // name of agent whose <details> is currently open
let currentThinkingBlock = null; // the <details> DOM element for that agent

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

// Returns the .ts-steps div for the current agent's thinking <details>.
// Creates a new labeled <details> when the agent changes.
function agentThinkingSteps(agentName) {
  if (!activeThinkingNode) return null;
  const runBody = activeThinkingNode.querySelector(".run-body");
  if (!runBody) return null;
  if (currentThinkingAgent !== agentName || !currentThinkingBlock) {
    currentThinkingAgent = agentName;
    const details = document.createElement("details");
    details.className = "thinking-block";
    details.open = true;
    details.innerHTML =
      `<summary class="thinking-summary"><span class="ts-agent-name">${escapeHtml(agentName)}</span> thinking…</summary>` +
      `<div class="ts-steps"></div>`;
    runBody.appendChild(details);
    currentThinkingBlock = details;
  }
  return currentThinkingBlock.querySelector(".ts-steps");
}

function handleStreamEvent(event) {
  if (event.type === "done") {
    // Mark the run-stream as complete — leave it fully intact in Agent Run tab.
    if (activeThinkingNode) {
      // Close any thinking block still open when the run ends.
      if (currentThinkingBlock) {
        currentThinkingBlock.open = false;
        const summary = currentThinkingBlock.querySelector(".thinking-summary");
        if (summary) summary.dataset.done = "1";
      }
      const runBody = activeThinkingNode.querySelector(".run-body");
      if (runBody) {
        const marker = document.createElement("div");
        marker.className = "run-complete-marker";
        marker.textContent = "✓ Run complete";
        runBody.appendChild(marker);
      }
      activeThinkingNode = null;
      currentThinkingAgent = null;
      currentThinkingBlock = null;
    }

    // Populate Final Snapshot tab with the full trace + closing summary.
    const panel = document.getElementById("final-snapshot");
    if (panel) {
      let html = "";
      if (event.reply) {
        html += `<div class="snapshot-reply md-body">${marked.parse(event.reply)}</div>`;
      }
      if (event.trace && event.trace.length) {
        html += traceHtml(event.trace);
      }
      panel.innerHTML = html || `<div class="snapshot-empty">Run completed with no output.</div>`;
      // Badge the tab so the user knows it's ready, then switch to it.
      const snapTab = document.getElementById("snapshot-tab");
      if (snapTab) snapTab.classList.add("tab-badge");
      switchTab("final-snapshot");
    }

    els.injectBtn.disabled = false;
    return;
  }

  if (event.type === "sf_write") {
    sfWriteLogs.push({ ...event, ts: new Date().toISOString() });
    renderSfLogs();
    return;
  }

  if (!activeThinkingNode) return;
  const runBody = activeThinkingNode.querySelector(".run-body");
  if (!runBody) return;

  // trace_step: a formatted finding card lands in the run-body, then the
  // current thinking block collapses (that agent's step is done).
  if (event.type === "trace_step") {
    const card = document.createElement("div");
    card.className = "live-step";
    card.innerHTML =
      `<div class="ls-actor">${escapeHtml(event.actor || "")} <span class="ls-type">AGENT</span></div>` +
      `<div class="md-body">${marked.parse(event.finding || "")}</div>` +
      (event.action ? `<div class="md-body ls-section">${marked.parse(event.action)}</div>` : "") +
      (event.handoff ? `<div class="md-body ls-section">${marked.parse(event.handoff)}</div>` : "");
    runBody.appendChild(card);
    if (currentThinkingBlock) currentThinkingBlock.open = false;
    currentThinkingBlock = null;
    currentThinkingAgent = null;
    els.messages.scrollTop = els.messages.scrollHeight;
    return;
  }

  // All other events go into the agent's thinking <details>.
  const stepsDiv = agentThinkingSteps(event.agent || event.from || "Agent");
  if (!stepsDiv) return;

  let html = "";
  switch (event.type) {
    case "thinking":
      if (event.text) {
        const t = event.text.slice(0, 300);
        html = `<div class="ts-thinking">${escapeHtml(t)}${event.text.length > 300 ? "…" : ""}</div>`;
      }
      break;
    case "tool_call":
      html = `<div class="ts-tool-call">🔧 <code>${escapeHtml(event.name)}</code></div>`;
      break;
    case "tool_result":
      html = `<div class="ts-tool-result">✓ <code>${escapeHtml(event.name)}</code>: ${escapeHtml(event.preview || "")}</div>`;
      break;
    case "handoff":
      html = `<div class="ts-handoff">↪ handoff to <strong>${escapeHtml(event.to || "")}</strong></div>`;
      break;
    case "feed_post": {
      const snippet = (event.body || "").slice(0, 140) + ((event.body || "").length > 140 ? "…" : "");
      html = `<div class="ts-feed-post">📝 Salesforce feed: ${escapeHtml(snippet)}</div>`;
      break;
    }
  }

  if (html) {
    stepsDiv.insertAdjacentHTML("beforeend", html);
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

// --- Tab switching ---
function switchTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tabId));
  els.messages.classList.toggle("hidden", tabId !== "agent-run");
  document.getElementById("final-snapshot").classList.toggle("hidden", tabId !== "final-snapshot");
  els.sfLogs.classList.toggle("hidden", tabId !== "sfdc-logs");
}

document.querySelector(".tab-bar").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  // Clear the new-run badge when user clicks Final Snapshot
  if (btn.dataset.tab === "final-snapshot") btn.classList.remove("tab-badge");
  switchTab(btn.dataset.tab);
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
      const body = m.role === "agent"
        ? `<div class="md-body">${marked.parse(m.text ?? "")}</div>`
        : escapeHtml(m.text);
      return `<div class="msg ${m.role}"><div class="role">${escapeHtml(label)}</div>${body}${sourcesHtml(m.sources)}${actionsHtml(m.actions)}</div>`;
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
        `<div class="t-find md-body">${marked.parse(r.finding || "")}</div>` +
        (r.action ? `<div class="t-act md-body">${marked.parse(r.action)}</div>` : "") +
        (r.handoff ? `<div class="t-act md-body">${marked.parse(r.handoff)}</div>` : "") +
        `</div></li>`,
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

// Render HITL gates — SF write proposals and human input requests.
// Once resolved, buttons are replaced with an outcome label.
function actionsHtml(actions) {
  if (!actions || !actions.length) return "";
  const blocks = actions
    .map((a) => {
      if (resolvedActions.has(a.id)) {
        return `<div class="action resolved"><span class="act-done">✓ resolved</span></div>`;
      }
      if (a.op === "request_human_input") {
        const urgencyClass = (a.urgency || "Medium").toLowerCase();
        const ctx = a.context ? `<div class="action-context">${escapeHtml(a.context)}</div>` : "";
        const answerInput = `<textarea class="hitl-answer" data-act="${a.id}" placeholder="Type your answer…" rows="2"></textarea>`;
        return (
          `<div class="action action-input urgency-${urgencyClass}">` +
          `<div class="action-summary">🙋 Agent needs input <span class="urgency-badge">${escapeHtml(a.urgency || "Medium")}</span></div>` +
          `<div class="action-question">${escapeHtml(a.question)}</div>` +
          ctx +
          answerInput +
          `<div class="action-controls">` +
          `<button class="approve" data-act="${a.id}">Send answer</button>` +
          `<button class="reject ghost" data-act="${a.id}">Decline</button>` +
          `</div></div>`
        );
      }
      // SF write proposal
      const summary =
        a.op === "salesforce_update"
          ? `Update <strong>${escapeHtml(a.sobject)}</strong> ${escapeHtml(a.recordId || "")}`
          : `Create <strong>${escapeHtml(a.sobject)}</strong>`;
      const fields = escapeHtml(JSON.stringify(a.fields || {}, null, 0));
      return (
        `<div class="action">` +
        `<div class="action-summary">⚠️ Proposed write — needs approval: ${summary}</div>` +
        `<div class="action-fields">${fields}</div>` +
        `<div class="action-controls">` +
        `<button class="approve" data-act="${a.id}">Approve</button>` +
        `<button class="reject ghost" data-act="${a.id}">Reject</button>` +
        `</div></div>`
      );
    })
    .join("");
  return `<div class="actions">${blocks}</div>`;
}

// Unified HITL response handler — routes all gate types through /api/hitl-respond.
els.messages.addEventListener("click", async (e) => {
  const btn = e.target.closest("button.approve, button.reject");
  if (!btn) return;
  const actionId = btn.dataset.act;
  const isApprove = btn.classList.contains("approve");
  const decision = isApprove ? "approved" : "rejected";

  // For human-input gates, grab the answer from the textarea.
  const answerEl = els.messages.querySelector(`.hitl-answer[data-act="${actionId}"]`);
  const answer = answerEl ? answerEl.value.trim() : undefined;

  resolvedActions.add(actionId);
  renderMessages();
  const pending = thinking();
  try {
    const res = await fetch(`${API}/api/hitl-respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actionId, decision, answer }),
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

  // Step 2 — kick off the Orchestrator run. The server returns 202 immediately;
  // thinking steps and the final result arrive via WebSocket (handleStreamEvent).
  // injectBtn stays disabled until the "done" WS event re-enables it.
  thinking();
  try {
    const res = await fetch(`${API}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, caseId: ticket.caseId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      activeThinkingNode?.remove();
      activeThinkingNode = null;
      push("agent", `Agent run failed: ${data.error || res.statusText}`);
      els.injectBtn.disabled = false;
    }
    // Success (202) — wait for "done" over WebSocket.
  } catch (err) {
    activeThinkingNode?.remove();
    activeThinkingNode = null;
    push("agent", `Agent run failed: ${err.message}`);
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
  currentThinkingAgent = null;
  currentThinkingBlock = null;
  // Remove the "no messages yet" placeholder if it's still showing.
  const empty = els.messages.querySelector(".empty");
  if (empty) empty.remove();
  const node = document.createElement("div");
  node.className = "msg agent run-stream";
  node.innerHTML = `<div class="run-body"></div>`;
  els.messages.appendChild(node);
  els.messages.scrollTop = els.messages.scrollHeight;
  activeThinkingNode = node;
  return node;
}

function renderSfLogs() {
  if (!sfWriteLogs.length) {
    els.sfLogs.innerHTML = `<div class="sf-logs-empty">No Salesforce writes yet. Inject an event to see account updates here.</div>`;
    return;
  }
  els.sfLogs.innerHTML = sfWriteLogs.map((e, i) => {
    const opLabel = e.op === "salesforce_create" ? "CREATE" : "UPDATE";
    const opClass = e.op === "salesforce_create" ? "sf-op-create" : "sf-op-update";
    const fields = JSON.stringify(e.fields || {}, null, 2);
    const time = new Date(e.ts).toLocaleTimeString();
    return `<div class="sf-log-entry">
      <div class="sf-log-header">
        <span class="sf-log-num">#${i + 1}</span>
        <span class="sf-op ${opClass}">${opLabel}</span>
        <strong>${escapeHtml(e.sobject || "")}</strong>
        ${e.recordId ? `<span class="sf-log-id">${escapeHtml(e.recordId)}</span>` : ""}
        <span class="sf-log-agent">by ${escapeHtml(e.agent || "")}</span>
        <span class="sf-log-time">${time}</span>
        ${e.caseId ? `<span class="sf-log-case">Case: ${escapeHtml(e.caseId)}</span>` : ""}
      </div>
      <pre class="sf-log-fields">${escapeHtml(fields)}</pre>
    </div>`;
  }).join("");
  if (activeTab === "sf-logs") els.sfLogs.scrollTop = els.sfLogs.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
