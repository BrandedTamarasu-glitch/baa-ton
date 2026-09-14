# Controller-owned parent-goal protocol

## Purpose

Herdr owns the durable parent-goal record and lane lifecycle in the primary manifest's optional `parentGoal` field. The record is intentionally thin: objective, state, next action, deduplicated lane-event signals, and an optional durable supervisor. A registered root harness performs one parent turn when the controller delivers an actionable event or configured supervisor nudge. Children never interact with the user directly.

## Registration

A root registration contains a fixed allowlisted adapter identifier, harness kind, and verified capability evidence. The controller validates the identifier and capability shape; it never executes caller-supplied shell strings. Unsupported, ambiguous, or stale evidence fails closed and is recorded for the parent.

## Event delivery

For a deduplicated actionable lane event (`done`, `blocked`, `goal-paused`, or a persisted child question/confirmation):

1. Controller atomically records the event and marks delivery `sending`.
2. It verifies the live root identity.
3. It sends one native, non-waiting root prompt carrying the event envelope.
4. The root uses the durable goal/workflow record to decide the next allowed operation.
5. Controller marks `delivered`; unavailable roots retain `pending` and retry only on an identical later hook.

The Herdr-owned supervisor can issue a non-waiting root nudge only while `parentGoal.supervisor.state` is `running` and the durable/live root activity is `idle`. It honors the durable interval and stops at completed, blocked, or paused-with-reason states.

## Parent mediation

Children persist full question, confirmation, dispatch, resume, and close approval records in the workflow manifest. They return without presenting UI. The controller wakes only the root; root-only UI resolves the durable record.

## Proof requirements

For every enabled adapter: controlled lane completion wakes one root turn; repeated events dedupe; unavailable roots create durable `pending`; replay delivers once; child question and confirmation remain parent-mediated; malformed capabilities fail closed. Non-enabled adapters retain normal controller notification behavior only.
