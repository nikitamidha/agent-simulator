# Handoff — build the agent spec files + the webapp ticket poller

Self-contained context for a **separate session** to do two things:
1. Generate the **13 remaining agent spec files** (+ `orchestrator.md`).
2. Build the **webapp ticket poller** (auto-trigger the Orchestrator for tickets created in the webapp).

Everything else in the agent simulator is built and working; do **not** rebuild it.

---

## System overview

Three pieces, all reading/writing the **same Salesforce org** (alias `claude-mcp`):

- **`agent-simulator/`** — the AI engine. An Orchestrator (manager) agent routes an
  injected event to specialist agents; they read the org, act, and write a trace to the
  ticket. Node, zero-dependency, model = Claude `claude-opus-4-8`.
- **`webapp/`** — the operator console (the prototype UI). Reads Cases + their trace live
  from Salesforce and renders the ticket detail. (`webapp/server.js`, port 3000.)
- **Salesforce** — system of record. Ticket = **`Case`**; trace = **`Agent_Action_Log__c`**
  child rows.

Data flow that already works end-to-end:
`inject event (+ Account) → create Case (Correlation_Id__c='ITF-…') → Orchestrator routes
→ specialists run → log_trace_step writes Agent_Action_Log__c → webapp renders it.`

## Run it

```bash
# Simulator (API :4000, client UI :3000)
cd agent-simulator && npm start           # loads .env

# Webapp (console) — uses port 3000 too, so run on another port if both at once:
cd .. && PORT=3100 node webapp/server.js
```

Auth: both reuse the **`sf` CLI session**. The simulator gets a token via
`sf org auth show-access-token` (the CLI encrypts ~/.sfdx tokens and redacts `org display`,
so read the token from `show-access-token`, not the file). If Salesforce calls fail with
`invalid_grant`, run `sf org login web --alias claude-mcp`. Simulator `.env` needs
`ANTHROPIC_API_KEY`, `SF_USERNAME`, `SF_LOGIN_URL`, `SF_API_VERSION`.

## Key files

| File | What |
|---|---|
| `agent-simulator/server/agents.js` | The 14 specialists + Orchestrator (id, name, layer, mode, description, humanTrigger, kpi, systemPrompt). **Source of truth for spec content.** |
| `agent-simulator/server/index.js` | API + orchestration: tools (`salesforce_query/create/update`, `log_trace_step`, `activate_agent`), event→Case→route, approve/reject, end-state guard. |
| `agent-simulator/server/salesforce.js` | SF client (query/create/update/delete) via CLI session. |
| `agent-simulator/agents-spec/` | Spec files. `README.md`, `_TEMPLATE.md`, and the worked example `cctv-diagnostic.md`. |
| `build/02-agentforce.md` | The one-agent-many-topics Agentforce build spec — source for each spec's **Agentforce mapping** section. |
| `webapp/server.js` | Console backend. Cases scoped to `Correlation_Id__c LIKE 'ITF-%'`; `/api/case?corr=` returns the journey. |

## Agent roster (ids ↔ files)

Orchestrator: `orchestrator` (Manager, autonomous, role=orchestrator).
Specialists (14): `monitoring-detection`, `asset-inventory`, `preventive-maintenance`,
`impact-correlation`, `scoping-triage`, `router`, `field-dispatch`(hitl), `communication`(hitl),
`footage-integrity`, `cctv-diagnostic` ✅(done), `deployment-watch`, `web-hosting-resolution`(hitl),
`network-baseline`, `network-diagnostic`.

## Trace contract (don't change)

Each step = one `Agent_Action_Log__c` row on the Case:
`Case__c, Step__c, Actor__c, Actor_Type__c('Agent'|'Human'|'System'), Observation__c (one-sentence
finding), Action_Taken__c (one-sentence action), Logged_At__c (timestamp)`, optional
`Stage__c, Confidence__c, Gate_Type__c, Decision__c, Outcome__c, Runbook__c`. The webapp reads
exactly these. Cases must carry `Correlation_Id__c LIKE 'ITF-%'` to appear in the console.

## End-state rules (already implemented — respect them)

- A ticket is done at `Case.Stage__c='Resolved'` (verified fix) → `'Closed'` (after closure comms).
- Once Resolved/Closed, **autonomous agents must not run** on the ticket (guard in `activate_agent`).
- HITL gates: `salesforce_create/update` by hitl agents are proposed, not executed, until
  `/api/approve`; approve/reject resume the Orchestrator.

---

# TASK 1 — generate the 13 remaining agent spec files

Create one file per agent in `agent-simulator/agents-spec/<id>.md`, matching
`agents-spec/cctv-diagnostic.md` exactly in structure (copy `_TEMPLATE.md`). Fill each with
that agent's real details, pulled from:
- **`server/agents.js`** — name, layer, mode, description, **humanTrigger**, **kpi**, and the
  verbatim **systemPrompt** (paste into the "System prompt" section).
- **`build/02-agentforce.md`** — map each agent to its Agentforce **Topic** + classification +
  instructions + actions for the "Agentforce mapping" section (Triage→Topic A, Diagnose→B,
  Resolve→C, Communicate→D, Dispatch→E; platform/sensing agents map to M2 automation or their
  nearest topic).
- **Trace output** section: the one-sentence finding + one-sentence action this agent writes.
- **Hand-offs**: who it hands to (e.g. triage→domain diagnostic; diagnostic→resolution/dispatch/comms).

Also create `agents-spec/orchestrator.md` (Manager; tools = `salesforce_query`, `log_trace_step`,
`activate_agent`; drives to Resolved/Closed; no specialist work itself).

**Acceptance:** 14 new files + the existing `cctv-diagnostic.md` = one per agent; each has every
template section filled; system prompts match `agents.js` verbatim; Agentforce mapping present.
Keep them concise (the CCTV example is the length target).

---

# TASK 2 — webapp ticket poller (activation mode B)

**Goal:** a ticket created **in the webapp** (or anywhere) should auto-trigger the Orchestrator,
just like an injected event does — "on ticket create, the right agent activates."

**Design (build in the simulator backend):**
- A background job (e.g. `server/poller.js`, started from `start.js` or `index.js`) that every
  N seconds queries Salesforce for **unprocessed** tickets:
  `SELECT Id, CaseNumber, Subject, Service_Line__c, AccountId, Correlation_Id__c FROM Case
   WHERE Stage__c='Detected' AND Correlation_Id__c LIKE 'ITF-%' ORDER BY CreatedDate LIMIT 10`
- **Dedupe:** only trigger a Case once. Pick one mechanism: (a) skip Cases that already have any
  `Agent_Action_Log__c` rows; or (b) keep an in-memory `Set` of handled Case Ids; or (c) flip a
  field (e.g. `Autonomy_Mode__c`) when picked up. (a) is simplest and stateless.
- For each new Case, call the existing orchestration entry point — refactor the body of
  `/api/event` into a reusable `orchestrateCase(caseId, {sessionId})` and have both the event
  endpoint and the poller call it. (The poller passes the existing Case Id instead of creating one.)
- **Respect the end-state guard:** never trigger autonomous work on Resolved/Closed Cases (the
  `Stage__c='Detected'` filter already excludes them; keep it).
- Make the interval + on/off configurable via env (`AGENT_SIM_POLL_MS`, default off or ~10000).

**Note:** this also delivers "operate on an existing ticket" — `orchestrateCase(caseId)` works on
any existing Case, not just freshly-created ones.

**Acceptance:** create a Case in the webapp with `Correlation_Id__c='ITF-…'`, `Stage__c='Detected'`;
within one poll interval the Orchestrator runs and trace rows appear on that ticket in the console;
re-polling does not re-trigger it; Resolved/Closed Cases are never picked up.

---

## Handy commands

```bash
# Snapshot current org data (before testing)
cd agent-simulator && node --env-file=.env scripts/snapshot.mjs
# Reset: delete post-snapshot ITF- test junk (dry-run, then --apply)
node --env-file=.env scripts/reset.mjs
node --env-file=.env scripts/reset.mjs --apply
```

## Known constraints
- A full orchestrated run takes **>2 minutes** (many model calls); responses are not streamed yet.
- Ports: simulator client and webapp both default to 3000 — run the webapp on another port if both.
- All simulator state is in-memory (restart clears sessions); the org is the durable store.
