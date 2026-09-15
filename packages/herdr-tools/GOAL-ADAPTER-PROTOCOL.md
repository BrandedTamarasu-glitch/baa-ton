# Controller-owned parent-goal protocol

## Purpose

Herdr owns the durable parent-goal record and lane lifecycle in the primary manifest's optional `parentGoal` field. The record is intentionally thin: objective, state, next action, deduplicated lane-event signals, and an optional durable supervisor. A registered root harness continues authorized safe local work when the controller delivers an actionable event or configured supervisor nudge, until a real wait, blocker, pause, or completion boundary. Children never interact with the user directly.

## Registration

A root registration contains a fixed allowlisted adapter identifier, harness kind, and verified capability evidence. The controller validates the identifier and capability shape; it never executes caller-supplied shell strings. Unsupported, ambiguous, or stale evidence fails closed and is recorded for the parent.

## Event delivery

For a deduplicated actionable lane event (`done`, `blocked`, `goal-paused`, or a persisted child question/confirmation):

1. Controller atomically records the event and marks delivery `sending`.
2. It verifies the live root identity.
3. It sends one native, non-waiting root prompt carrying the event envelope.
4. The root uses the durable goal/workflow record to decide the next allowed operation.
5. Controller marks `delivered`; unavailable roots retain `pending` and retry only on an identical later hook.

## Supervisor wake protocol

The supervisor is a **one-shot recovery wake**, not a periodic reminder. Its interval controls when eligible work is checked, not how frequently a delivered goal is re-injected.

- Eligibility requires an `active` goal, a `running` supervisor, an overdue `nextNudgeAt`, and an identity-matched `rootTurn.state: idle` written by the root Pi extension. Live Herdr identity and `idle`/`done` readiness are checked again before sending. (`done` is Herdr's unseen ready state.)
- `before_agent_start` / `agent_start` persist `rootTurn: active`, including a run ID and root pane/workspace binding. Every tool and model turn, automatic retry, compaction retry, and queued continuation stays inside that active run. Only `agent_settled` with `ctx.isIdle()` and the matching active run may persist idle.
- `tool_execution_end`, `turn_end`, `agent_end`, and Herdr `pane.agent_status_changed` hooks do **not** grant idle authority. Herdr activity is retained separately as telemetry. Silence never expires an active run into idle.
- Startup/reload/shutdown invalidate idle authority to `unknown`; they never re-arm a delivered wake. Missing lifecycle evidence (including older Pi versions without `agent_settled`, and non-Pi/MCP-only roots) fails closed for supervisor nudges. Generic lane-event notifications remain harness-neutral and unchanged.
- Before prompting, the controller durably writes `lastDelivery: sending` and clears `nextNudgeAt` under the shared manifest lock. Successful delivery stays latched; the next root run records `acknowledgedAt`. Neither acknowledgement, settlement, repeated ticks, nor controller restart clears the latch. Legacy delivered records are suppressed even if they still contain an old periodic due time.
- A definite pre-delivery unavailability/readiness failure remains `pending` with a later due time. An ambiguous send or interrupted `sending` record becomes/stays `uncertain` and is never automatically replayed.
- A material root `set-state` change (status, objective, or next action) may authorize another delivered wake when work becomes active. Identical `set-state` and repeated `start` on an already running supervisor are idempotent. Uncertain delivery requires explicit reviewed `stop`/`start` (or pause/start) recovery; work edits alone cannot replay it.
- Waiting-for-event, action-required, blocked, completed, paused, and stopped states never receive supervisor nudges. Pause clears the due time, and lifecycle activity cannot restart it.

Lifecycle writes use the existing sibling manifest lock and atomic rename. They wait at most 10 seconds for lock contention, without polling agents or starting background jobs. Failure to persist active authority aborts the Pi run rather than silently continuing with stale idle evidence. A failed idle write leaves supervision suppressed.

### Rollout and limits

Update the controller and reload the root extension together (controller first is fail-closed); this source change does not install, enable, or reload either live component. Old controllers strictly reject the new optional fields. After reload a real root run must settle before recovery nudges become eligible. A crashed run does not become idle on a timeout; restart plus fresh lifecycle evidence is required, and uncertain sends still require explicit review.

The native `agent.prompt` transport is not an atomic compare-and-submit against Pi lifecycle or editor contents. The final live readiness check plus durable one-shot latch prevents repeated interruption, but cannot eliminate the narrow race with a newly submitted user turn or protect unsent editor text. A draft-safe conditional prompt API would be needed for that stronger guarantee. A prompt already submitted before pause cannot be recalled.

## Parent mediation

Children persist full question, confirmation, dispatch, resume, and close approval records in the workflow manifest. They return without presenting UI. The controller wakes only the root; root-only UI resolves the durable record.

## Display metadata

A root may publish display-only goal metadata with native Herdr `pane report-metadata`.
The optional Baa-ton sidebar adapter renders the `herdr_goal_*` tokens in an
expanded desktop sidebar without modifying other renderers' source. Compact and
mobile switchers do not render custom sidebar rows, so Baa-ton also publishes a
concise `idle`/`done` state label (for example, `Goal: waiting`). This is a
presentation fallback only: it never changes a pane's semantic state,
notifications, supervision, or lifecycle decisions.

## Proof requirements

For every enabled adapter: controlled lane completion wakes one root turn; repeated events dedupe; unavailable roots create durable `pending`; replay delivers once; child question and confirmation remain parent-mediated; malformed capabilities fail closed. Non-enabled adapters retain normal controller notification behavior only.
