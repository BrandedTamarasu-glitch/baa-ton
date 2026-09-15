# Defect ledger

Append verified defects here. Every entry records reproduction, impact, fix, and foreground evidence.

## 2026-09-15 — Supervisor repeatedly nudged an executing parent

- **Reproduction:** Keep an active goal's 5-second supervisor running while its parent performs multiple tool/model turns. Herdr reports transient idle snapshots; every accepted prompt leaves another due time behind.
- **Impact:** Full goals are repeatedly injected during ongoing work and into user input. Copied one-action/then-stop prompt guidance further obstructs autonomous recovery.
- **Fix:** Persist root-run authority from Pi start through `agent_settled`, not tool completion or low-level `agent_end`. Keep Herdr status hooks as telemetry. Persist the sending/delivered/acknowledged wake latch under the existing shared lock; re-arm only through meaningful goal transitions. Keep uncertain sends fail-closed and pause disarmed. Remove one-action stopping instructions without expanding approval authority.
- **Verification:** `npm test` passes the extension smoke integration and all 28 controller tests (0 failures). Virtual 5-second ticks cover active work, one idle recovery wake, acknowledgement/settlement/reload dedupe, later authorized work, pause, root-only writes, concurrent ticks, legacy receipts, ambiguous sends, unavailable-root recovery, and malformed state. The extension also tests lock contention and fail-closed persistence errors.
- **Limits:** Requires the updated controller plus a reloaded root extension with Pi `agent_settled`. No installation or live-resource change was performed. See [rollout and transport limits](./GOAL-ADAPTER-PROTOCOL.md#rollout-and-limits).

## 2026-09-13 — New lane started before its pane was ready

- **Reproduction:** Dispatch a workflow immediately after Herdr creates its workspace or tab.
- **Impact:** The lane start can return `agent_pane_busy`; created resources may otherwise be hard to recover safely.
- **Fix:** Persist every returned workspace/tab/pane before starting a lane. Use Herdr's bounded `agent start --timeout` readiness gate, retain retry state on partial failure, and never close resources automatically.
- **Verification:** The deterministic smoke check reproduces the start failure, verifies durable `retryable` state, verifies resume without a replacement workspace, and asserts no local sleep or automatic close.

## 2026-09-13 — Child approvals bypassed root mediation

- **Reproduction:** A child requested dispatch, resume, close, or a user question.
- **Impact:** Child context could expose approval UI instead of returning authority to the mapped root.
- **Fix:** Non-root operations persist deduplicated parent-approval or parent-question requests and return without presenting UI.
- **Verification:** The smoke check proves child requests issue no topology mutation, prompt, or confirmation.

## 2026-09-13 — Paused-goal evidence was not durable

- **Reproduction:** A lane entered a paused-goal state after a child-facing action.
- **Impact:** The root could not distinguish a paused lane from ordinary terminal state.
- **Fix:** Bounded recent-output observation records `goal-paused`; recovery requires an explicit root operation and retains a receipt.
- **Verification:** The smoke check verifies bounded detection, dry-run behavior, root-only recovery, and retained receipts.

## 2026-09-13 — Worktree dispatch lost native workspace metadata

- **Reproduction:** Open a supplied clean checkout through Herdr and dispatch lanes from it.
- **Impact:** A generic workspace path discarded the native worktree binding.
- **Fix:** Worktree workflows require one registered parent and use `herdr worktree open`, preserving the returned binding before lane start.
- **Verification:** The smoke check covers clean, dirty, ambiguous-parent, multi-writer, retry, and generic-workflow cases.

## 2026-09-13 — Lane kinds were artificially restricted

- **Reproduction:** Plan a workflow with an installed Herdr-compatible harness kind outside the original short allowlist.
- **Impact:** Valid lane harnesses could not be dispatched.
- **Fix:** The supported kind list mirrors the installed Herdr compatibility set; workflow and lane kind are persisted and passed unchanged to `herdr agent start`.
- **Verification:** The smoke check dispatches multiple non-default kinds and verifies their selected contracts and start arguments.
