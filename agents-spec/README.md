# Agent specs

One file per agent — the **living source of truth** for each agent's job, tools,
knowledge, schema access, decision logic, hand-offs, and trace output. We update
these as decisions change.

Why they exist:
- **Design of record** for the 14-agent workforce (from the deck's Agent Inventory).
- **Agentforce migration artifact** — each file has an *Agentforce mapping* section
  (Topic name, classification, instructions, actions, model) so an agent here can be
  lifted into an Agentforce **topic/agent** with no re-discovery. (See the
  one-agent-many-topics model in `../../build/02-agentforce.md`.)

Relationship to the running code:
- `../server/agents.js` is the **runtime** definition the simulator executes.
- These specs are the **design**; keep them in sync. (Goal: eventually generate
  `agents.js` from these files so there's a single source.)

Files:
- `_TEMPLATE.md` — copy this for a new agent.
- `<agent-id>.md` — one per agent (ids match `agents.js`).

Trace contract (what every agent writes to the ticket): rows in
`Agent_Action_Log__c` on the Case — at minimum **`Observation__c`** (one-sentence
finding), **`Action_Taken__c`** (one-sentence action), **`Logged_At__c`** (timestamp),
plus `Case__c`, `Actor__c`, `Actor_Type__c='Agent'`, `Step__c`. The `webapp` ticket
detail renders these live.
