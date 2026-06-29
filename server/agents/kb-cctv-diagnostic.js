// ============================================================================
//  KNOWLEDGE BASE — Diagnostic Agent / CCTV Service Line
//  Customer context: TechGuard ITForce platform
// ============================================================================
//  This record is injected into the Diagnostic Agent's context at runtime.
//  It contains everything specific to TechGuard and the CCTV service line —
//  signals, thresholds, elimination steps, runbooks, and field mappings.
//  The agent's system prompt stays generic; all SOPs live here.
// ============================================================================

export const kbCctvDiagnostic = `
KNOWLEDGE BASE — Diagnostic Agent | CCTV Monitoring | TechGuard ITForce

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SIGNALS TO MONITOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Two signals are checked per camera on every polling cycle:

  Signal: Heartbeat
  Meaning: Is the device online and reachable over the network?
  Anomaly threshold: Device not responding

  Signal: Footage Write
  Meaning: Is footage actively committing to storage?
  Anomaly threshold: Last reading older than 5 minutes

CRITICAL INSIGHT — always surface this explicitly in the trace when it applies:
  A green heartbeat with a stale Footage Write (>5 min) is a footage gap.
  The camera appears healthy to legacy monitoring tools. It is silently failing
  its compliance obligation. TechGuard monitors footage commit, not just uptime.
  Legacy tools don't catch this.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ASSET CRITICALITY TIERS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Compliance-critical zones (e.g. Controlled Substances Cage, cold-storage zones):
    - Footage gap = P1 regardless of heartbeat status
    - Footage-gap clock and SLA clock both start from moment of detection
    - Requires footage-gap disclosure to the customer on resolution

  Standard zones:
    - Follow normal priority matrix

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DIAGNOSTIC ELIMINATION SEQUENCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Work through these steps in order. Rule each out explicitly before proceeding.

  Step 1 — PoE draw fault
  Check: Is PoE draw within normal range and heartbeat stable?
  If yes: PoE is not the cause — ruled out.

  Step 2 — Network path
  Check: Is heartbeat stable and latency normal?
  If yes: Network is not the cause — ruled out.

  Step 3 — NVR disk health
  Check: Are other cameras on the same NVR writing footage normally?
  If yes: The NVR is not the cause — ruled out.

  Step 4 — Storage queue overflow
  Check: Is there a queue backlog or overflow anomaly in telemetry?
  If no: Storage queue overflow is not the cause — ruled out.

  Step 5 — Single-stream fault
  If only this one camera is affected across all above checks, the camera's
  own recording stream is the suspect. Common cause: stream lock acquired
  during a scheduled retention-policy rotation that did not release cleanly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONFIDENCE THRESHOLDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  85% or above: Hand off to Resolution Agent to act autonomously
  70–84%: Flag to Resolution Agent; human review recommended before acting
  Below 70%: Escalate — do not proceed to remediation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AVAILABLE RUNBOOKS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Recording Stream Recovery runbook
    When to use: single-stream fault, retention-policy lock, or stream stuck
                 after a scheduled rotation
    Scope constraint: single affected camera only — never the NVR or other cameras
    What it does: clears stale stream lock, restarts recording binding,
                  forces a new segment, reattaches retention policy

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
POST-FIX PREVENTION — CCTV SPECIFIC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When root cause is a retention-policy rotation failure:
  - Identify all other cameras in compliance-critical zones on the same
    rotation schedule
  - Recommend a proactive footage-write check before their next rotation
  - Surface the recommendation on the account health panel for the account team
  - Note that this incident feeds the agent learning loop — detection
    thresholds and runbook selection sharpen over time
`;
