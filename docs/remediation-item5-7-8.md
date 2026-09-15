# Durable-Core Items 5, 7, and 8

Source-level remediation for the scoped lane-goal, per-lane launch-profile,
and authorized-incarnation requirements in
`docs/tasks/durable-core-batch.md`.

## Item 5: Scoped Goals

Each workflow now carries a version-1 goal graph. The graph contains one
workflow goal owned by the authorized root and one subgoal per lane owned by
that lane. Goals have stable IDs, revision counters, dependency edges, and
explicit outcomes. Lane goal updates are made only through the lane's verified
assignment; native Herdr state remains observation telemetry.

`herdr_observe` reports `awaiting-explicit-outcome` when every native agent is
idle/unseen but no lane has reported an explicit success outcome. It cannot
complete a workflow from focus-sensitive native `done` state. A durable
`herdr_complete` receipt records the lane outcome and completes the workflow
only when every lane subgoal explicitly succeeds.

## Item 7: Per-Lane Profiles

Launch-profile schema version 1 is recorded on workflow and lane profile
fields. A lane may provide its own provider/model/thinking/subscription
profile; otherwise dispatch validates and uses the workflow profile as the
fallback. `dispatch-task.ts` validates and preflights every resolved lane
profile independently, writes the selected profile into that lane's startup
intent, and compares it with the startup attestation before assignment.

## Item 8: Authorized Rebind

`herdr_dispatch({ execute: true, restart: true })` is the explicit root-owned
restart path. Before replacing a lane, dispatch verifies the currently live
pane/session against the recorded incarnation, persists a new incarnation and
startup nonce, then requests the incumbent agent to stop. The replacement is
accepted only after the new nonce, native identity, exact profile, and startup
operations are attested. A mismatched or unrelated occupant fails closed and
receives no assignment. Completion fencing uses the native session and
incarnation, so an old process cannot report for the replacement.

## Verification

- `env -u BAA_STARTUP_INTENT npm test`: passed, including the extension smoke suite and controller suite.
- `tsc --noEmit -p tsconfig.json`: passed.
- `git diff --check`: passed.
- Focused regressions cover native `done` without explicit success, goal graph ownership/dependencies, distinct lane profiles, authorized restart/rebind, and unrelated occupant rejection.

No live installation, reload, workspace mutation, or agent launch was
performed for this source-level remediation.
