// ============================================================================
//  LLM CLIENT  —  talks to Claude (or a built-in mock if no API key)
// ============================================================================
//
//  - If ANTHROPIC_API_KEY is set, calls the real Claude Messages API
//    (default model: claude-sonnet-4-6) and runs an agentic TOOL LOOP so the
//    agent can read/write Salesforce via the tools passed in by index.js.
//  - If it is NOT set, falls back to a deterministic MOCK so the simulator
//    still runs end-to-end with zero setup.
//
//  Dependency-free: raw Messages HTTP endpoint via Node fetch (Node 18+).
// ============================================================================

const MODEL = process.env.AGENT_SIM_MODEL || "claude-sonnet-4-6";

function toolPreview(name, out) {
  const s = typeof out === "string" ? out : JSON.stringify(out);
  try {
    if (name === "salesforce_query") {
      const r = JSON.parse(s);
      const n = r.totalSize ?? r.records?.length ?? "?";
      if (n === 0) return "No records found";
      const first = r.records?.[0] || {};
      // Pick the most human-readable field available
      const label = first.CaseNumber || first.Name || first.CaseNumber
        || first.Signal_Type__c || first.Runbook_Key__c || first.Id || "";
      return `${n} record${n !== 1 ? "s" : ""}${label ? ` — ${label}` : ""}`;
    }
    if (name === "salesforce_update" || name === "salesforce_create") {
      const r = JSON.parse(s);
      return r.success ? `OK — ${r.id || ""}` : `Failed: ${JSON.stringify(r.errors)}`;
    }
    if (name === "retrieve_knowledge") {
      // First line is "[N] citation › ..." — extract just that
      const firstLine = s.split("\n")[0].slice(0, 100);
      return firstLine;
    }
    if (name === "log_trace_step") {
      return s; // already short: "Logged trace step N."
    }
    if (name === "handoff_to_agent") {
      return "Sub-agent response received";
    }
  } catch {}
  return s.slice(0, 120);
}
const API_KEY = process.env.ANTHROPIC_API_KEY;

export const usingRealModel = Boolean(API_KEY);

// Runs one agent turn. If `tools` + `executeTool` are provided, loops:
//   call model -> if it requests tools, execute them, feed results back -> repeat
// until the model produces a final text answer (or maxSteps is hit).
// `onStep` (optional) is called with streaming events so the UI can show live
// thinking states: { type: 'thinking'|'tool_call'|'tool_result', agent, ... }
export async function chat({ system, messages, meta, tools, executeTool, maxSteps = 8, onStep }) {
  if (!API_KEY) return mockReply({ messages, meta });

  // No tools wired (e.g. Salesforce not configured): single completion.
  if (!tools || !tools.length || !executeTool) {
    return textOf(await callClaude({ system, messages }));
  }

  // Work on a copy so we don't persist intermediate tool blocks into the
  // long-term conversation history (index.js keeps history as plain text turns).
  const work = messages.map((m) => ({ role: m.role, content: m.content }));

  for (let step = 0; step < maxSteps; step++) {
    const data = await callClaude({ system, messages: work, tools });

    // Emit any text blocks that accompany tool calls as "thinking" events.
    if (onStep && data.stop_reason === "tool_use") {
      for (const block of data.content) {
        if (block.type === "text" && block.text.trim()) {
          onStep({ type: "thinking", agent: meta?.name, text: block.text.trim() });
        }
      }
    }

    if (data.stop_reason !== "tool_use") return textOf(data) || "(no response)";

    work.push({ role: "assistant", content: data.content });

    // Execute all tool calls in this response in parallel for speed.
    const toolBlocks = data.content.filter((b) => b.type === "tool_use");
    const results = await Promise.all(
      toolBlocks.map(async (block) => {
        if (onStep) onStep({ type: "tool_call", agent: meta?.name, name: block.name, input: block.input });
        let out;
        try {
          out = await executeTool(block.name, block.input);
        } catch (e) {
          if (e?.constructor?.name === "HandoffSignal") throw e;
          out = `ERROR: ${e.message}`;
        }
        const preview = toolPreview(block.name, out);
        if (onStep) onStep({ type: "tool_result", agent: meta?.name, name: block.name, preview });
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: typeof out === "string" ? out : JSON.stringify(out),
        };
      }),
    );
    work.push({ role: "user", content: results });
  }

  // Ran out of tool steps — get a final summary without forcing more tools.
  return textOf(await callClaude({ system, messages: work })) || "(stopped after max tool steps)";
}

function textOf(data) {
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function callClaude({ system, messages, tools }) {
  const body = { model: MODEL, max_tokens: 4096, system, messages };
  if (tools && tools.length) body.tools = tools;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Claude API ${res.status}: ${detail}`);
  }
  return res.json(); // full message object: { content, stop_reason, ... }
}

// ---------------------------------------------------------------------------
//  Offline mock — keeps the simulator functional without an API key.
//  (No real tool execution in mock mode; it just narrates intent.)
// ---------------------------------------------------------------------------
function mockReply({ messages, meta }) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = lastUser ? String(lastUser.content) : "";
  const isEvent = text.startsWith("⚡");
  const who = `${meta?.name ?? "Agent"} (${meta?.mode ?? "agent"})`;

  const sources = meta?.sources ?? [];
  const retrieved = sources.length
    ? `\nRetrieved from knowledge base:\n` +
      sources.map((s) => `  [${s.tag}] ${s.citation}`).join("\n")
    : `\n(No knowledge-base sections matched this turn.)`;

  if (isEvent) {
    const event = text.replace(/^⚡\s*EVENT INJECTED:\s*/i, "");
    if (meta?.mode === "autonomous") {
      return (
        `[${who} — MOCK] Event received: "${event}".\n` +
        `With Claude + Salesforce connected I would query the affected records, ` +
        `apply the reversible remediation, and log it. ${retrieved}\n` +
        `(Set ANTHROPIC_API_KEY and SF_* in .env to run for real.)`
      );
    }
    return (
      `[${who} — MOCK] Event received: "${event}".\n` +
      `With Claude + Salesforce connected I would propose the write and wait for ` +
      `operator approval at the gate. ${retrieved}\n` +
      `(Set ANTHROPIC_API_KEY and SF_* in .env to run for real.)`
    );
  }

  return (
    `[${who} — MOCK] You said: "${text}". ` +
    `Connect Claude (ANTHROPIC_API_KEY) and Salesforce (SF_* in .env) to read/write ` +
    `your org for real.${retrieved}`
  );
}
