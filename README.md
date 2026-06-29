# Agent Simulator

A small, self-contained local app for experimenting with the TechGuard ITForce
agent workforce. It has:

- an **HTML chat UI** where you pick one of the agents,
- a **backend chat loop** per agent wired to the same UI/API,
- **live Salesforce access** — agents read and write your org via tool-use
  (falls back to a mock customer DB if Salesforce isn't configured),
- **RAG over the TechGuard knowledge base** — each turn retrieves the most
  relevant runbook/SLA sections and injects them into the agent's prompt,
- the ability to **inject events** into an agent from the UI, and
- a clean place to **name agents and edit their prompts**.

## The agents (from the deck)

The 14 agents are the workforce from the **Agent Inventory Schema** in
*Vision and Solution Approach*, by layer — each a mix of **autonomous** (acts,
escalating only on its human trigger) and **human-in-the-loop** (proposes a
write, waits for approval):

| Layer | Agents | HITL |
| --- | --- | --- |
| Platform | Monitoring & Detection, Asset Discovery & Inventory, Preventive Maintenance, Impact & Correlation, Scoping & Triage, Router, **Field Dispatch**, **Communication** | Field Dispatch (IT Ops), Communication (CSA) |
| CCTV | Footage Integrity, CCTV Diagnostic | — |
| Web Hosting | Deployment Watch, **Web Hosting Resolution** | Web Hosting Resolution (rollback) |
| Network | Network Baseline Monitor, Network Diagnostic | — |

Each agent definition carries its deck columns (Owns / Human trigger / KPI).

## Salesforce access

When configured, agents have live read/write access to your org through three
tools — `salesforce_query` (SOQL), `salesforce_create`, `salesforce_update` —
grounded in the real schema (Account, Case, Asset, `Telemetry_Reading__c`,
`Runbook__c`, `Agent_Action_Log__c`).

- **Autonomous** agents' writes execute immediately.
- **Human-in-the-loop** agents' writes are captured as **proposals** and do not
  run until you click **Approve** (or **Reject**) on the card under the reply.
  Reads (SOQL) always run freely.

Configure it in `.env` (copy from [`.env.example`](.env.example)):

```
SF_USERNAME=you@example.com
SF_PASSWORD=your-password
SF_SECURITY_TOKEN=your-security-token        # Setup → reset/view My Security Token
SF_LOGIN_URL=https://login.salesforce.com    # https://test.salesforce.com for a sandbox
SF_API_VERSION=60.0
```

Until `SF_USERNAME`/`SF_PASSWORD` are set, the app uses the mock customer DB in
`server/database.js`. `GET /api/health` reports whether Salesforce connected.

## Knowledge base (RAG)

On each chat message or injected event, the API retrieves the top matching
sections from the TechGuard knowledge base and adds them to the agent's system
prompt, so answers are grounded in the real runbooks, SLAs, and approval gates.
Retrieved sources are shown under each agent reply.

- **Corpus:** `knowledge/techguard/` (repo root). Override with `AGENT_SIM_KB_DIR`.
- **Retriever:** dependency-free BM25 over heading-scoped markdown chunks — see
  [`server/knowledge.js`](server/knowledge.js). No embeddings service required.
- **Inspect it:** `GET /api/knowledge` for stats, or `GET /api/knowledge?q=footage+gap`.

## Run it

No dependencies to install — only Node built-ins (Node 18+).

```bash
cd agent-simulator
npm start
```

`npm start` runs `start.js` (which loads `.env` via `--env-file-if-exists`) and
**spawns both servers**:

- **client server** → http://localhost:3000  ← open this in your browser
- **API server**    → http://localhost:4000

### Credentials

Put your keys in `.env` (gitignored). `npm start` loads it automatically:

```
ANTHROPIC_API_KEY=sk-ant-...     # omit to run in mock mode
SF_USERNAME=...                  # omit to use the mock customer DB
```

Default model is `claude-opus-4-8`. Override with `AGENT_SIM_MODEL`.

## Where to change things

| What you want to do | File |
| --- | --- |
| **Rename agents / edit prompts / change autonomous vs. human-in-the-loop** | [`server/agents.js`](server/agents.js) |
| **Salesforce auth + query/create/update** | [`server/salesforce.js`](server/salesforce.js) |
| **Tools, write-gating, schema summary, approval flow** | [`server/index.js`](server/index.js) |
| Mock customer DB (fallback when Salesforce is off) | [`server/database.js`](server/database.js) |
| RAG corpus / retrieval (chunking, ranking, top-K) | [`server/knowledge.js`](server/knowledge.js) |
| Model / tool loop | [`server/llm.js`](server/llm.js) |
| UI | [`client/public/`](client/public/) |

### Editing an agent

Each entry in `AGENTS` (in `server/agents.js`) has `name`, `mode`
(`"autonomous"` or `"hitl"`), `layer`, and `systemPrompt`. Edit those and
restart — the UI picks up the changes automatically.

## Injecting events

Use the **Inject event** panel on the right. Pick a preset or write your own,
then click **Inject event** (`POST /api/event`):

- **Autonomous** agents act on it (including Salesforce writes) and report.
- **Human-in-the-loop** agents read, then propose any write as an Approve/Reject
  card; the write runs only on approval, after which the agent verifies and reports.

## API reference

| Method | Path | Body | Purpose |
| --- | --- | --- | --- |
| GET | `/api/agents` | — | Agents (id, name, mode, layer) + model/Salesforce status |
| GET | `/api/customers` | — | Client Accounts (from Salesforce, else mock) |
| GET | `/api/knowledge` | `?q=...` (optional) | KB stats; with `q`, retrieval results |
| GET | `/api/health` | — | Model + Salesforce connection status |
| POST | `/api/chat` | `{ agentId, sessionId, message }` | Chat turn → `{ reply, sources, proposedActions }` |
| POST | `/api/event` | `{ agentId, sessionId, event }` | Inject an event → `{ reply, sources, proposedActions }` |
| POST | `/api/approve` | `{ actionId }` | Execute a proposed write, then agent verifies → `{ ok, result, reply }` |
| POST | `/api/reject` | `{ actionId, note? }` | Discard a proposed write → `{ ok, reply }` |
| POST | `/api/reset` | `{ agentId, sessionId }` | Clear a conversation |
