# <Agent Name> (`<agent-id>`)

| | |
|---|---|
| **Layer** | Platform / CCTV / Web Hosting / Network |
| **Mode** | autonomous / hitl |
| **Status** | draft / active |
| **Persona owner** | (human approver, if hitl: Sarah Rose CSA / Marcus Chen IT Ops / Ray Oak Field) |

## Mission
One or two sentences: what this agent is for.

## Activation (trigger)
When this agent runs:
- Event types (e.g. injected "CCTV camera not working")
- Case condition (e.g. `Service_Line__c='CCTV' AND Stage__c='Triaged'`)
- Hand-off from: `<agent-id>`

## Deck contract
- **Owns:** …
- **Human trigger:** …
- **KPI:** …

## Reads (inputs)
- Salesforce: `Object.Field`, … (via `salesforce_query`)
- Knowledge base: which sections/runbooks

## Tools
- `salesforce_query` (read)
- `log_trace_step` (writes a finding+action row to `Agent_Action_Log__c`) — always allowed
- `salesforce_create` / `salesforce_update` — gated if Mode = hitl
- (any agent-specific tools)

## Decision logic & guardrails
- Confidence floors / blast-radius rules / compliance rules
- What it must NOT do

## Hand-offs
- → `<agent-id>` when `<condition>`

## Trace output (Agent_Action_Log__c)
Per step it writes: `Observation__c` (finding), `Action_Taken__c` (action),
`Logged_At__c` (timestamp), `Stage__c`, `Decision__c`, `Gate_Type__c`, `Outcome__c`,
`Confidence__c`, `Runbook__c` (if used).

## System prompt (runtime — keep in sync with agents.js)
```
<verbatim system prompt>
```

## Agentforce mapping (for migration)
- **Topic:** <topic name>
- **Classification:** "<when the agent picks this topic>"
- **Instructions:** <paste-ready topic instructions>
- **Actions:** <Apex invocable / Flow / Prompt template names>
- **Model:** claude-opus-4-8

## Change log
- YYYY-MM-DD — initial.
