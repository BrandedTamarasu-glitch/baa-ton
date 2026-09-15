# Baa-ton durable orchestration core — implementation batch

You are implementing the remaining remediation from a completed architecture audit. You did not write the existing code. Read first, then implement in the stated order. Report honestly; do not mark anything done that is not tested.

## Repository

Work ONLY in: /Users/zchristmas/.herdr/worktrees/baa-ton/astra-supervisor-nudge-fix

## Required reading (in this order, before any edit)

1. `docs/herdr-native-audit.md` — the authoritative audit: every finding, its P0/P1/P2 class, required remediation, and the acceptance scenarios at the end. Your work items below map directly to its findings.
2. `docs/audit-probes/herdr-native.mjs` and `docs/audit-probes/results.json` — fault reproducers. They currently assert BROKEN behavior (exit 0 = defects reproduced). Converting them to corrected-behavior regressions is part of this task.
3. `docs/native-prerequisite-progress.md` — what has already been fixed and verified live (launch verification, identity fencing, readiness gate, thinking-level semantics, activation). Do not redo these; do not regress them.
4. `packages/herdr-tools/HARNESS-ADAPTERS.md` — the versioned harness adapter contract (protocol operations, open capability flags) and the Paseo prior-art design basis. Evolve this contract version-wise, do not fork it.
5. `packages/herdr-tools/DEFECTS.md`, `packages/herdr-tools/GOAL-ADAPTER-PROTOCOL.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`.

## Hard constraints

- No push, merge, PR creation, deploy, or production/external mutation. Local commits are allowed and expected after each work item passes its tests; use small, logically scoped commits.
- Source only: do NOT touch `~/.config/herdr/`, `~/.pi/`, symlinks, plugins, or any live runtime. The extension and controller in this checkout are live-linked; your edits take effect only on a future reload, which you must NOT trigger.
- Preserve every currently passing behavior. The full suite must stay green: `env -u BAA_STARTUP_INTENT npm test` (currently 22 extension + 28 controller), `tsc --noEmit -p tsconfig.json`, `git diff --check`.
- No new background daemons, polling loops, or timers in the orchestration core. Delivery is event-driven and durable.
- One Herdr workspace rule: nothing you write may create, move, replace, or close Herdr workspaces; lane tabs only, inside the bound task workspace.
- Uncertain ≠ failed: a lost response after a submitted effect must never be retried as if it never happened. Retain and reconcile uncertainty.

## Work items (audit implementation order — this sequence is deliberate)

### 1. P0 — Single transactional state owner

Replace the aggregate read-modify-write manifest pattern with one transactional store: every mutation goes through a single revision/operation-ID mechanism (SQLite via node:sqlite is acceptable; the requirement is one transaction contract, not a particular database). No long transaction across terminal/network calls — persist intent, perform effect, reconcile in a second conditional transaction. Migrate the existing manifest format with an explicit, idempotent migration. Convert the audit's concurrent-writer and pause-overwrite probes into corrected-behavior regressions.

### 2. P0 — Transport uncertainty cannot duplicate prompts

In `packages/controller/controller.mjs`, distinguish pre-send rejection from post-send uncertainty (`socket_timeout` after submission is NOT nondelivery). Add durable operation IDs so prompt retries are idempotent. Convert the lost-socket-response probe into a regression proving one logical delivery despite lost replies.

### 3. P1 — Unified durable inbox/outbox

One durable message substrate for completion, questions, answers, lifecycle events, and supervisor wakes (today these are several incompatible implementations — audit finding with sources listed). Persist before notifying; separate stored/notified/received/acknowledged/resolved states; a notification is a coalesced wake hint, not the only copy. Adoption reference for the wire format: the `herdr-link/1` envelope protocol (github.com/LZHcode1986/herdr-link, PROTOCOL.md — adapter-resolved sender identity, workspace-scoped authorization) — reuse the envelope shape rather than inventing a fourth format; keep OUR durability semantics, which herdr-link deliberately lacks. Convert the retry-dedup and pending-drain probes into regressions.

### 4. P1 — Occurrence-aware events + pending reconciler

Controller event identity currently hashes normalized event data, so genuine repeated statuses (`blocked → working → blocked`) collapse permanently. Use occurrence-aware identity (state_change_seq or equivalent), and add an event-driven pending-outbox reconciler that drains pending deliveries when the root becomes ready (today pending events retry only if an identical hook recurs, and action-required goals are excluded). Convert both probes into regressions.

### 5. P1 — Scoped lane goals, focus-independent completion

Goals are parent-only today; `observe()` marks workflows completed when agents are `done`, but native `done` means "idle and unseen," not success — display focus changes it. Add goal IDs, revisions, dependency edges, scoped ownership (lanes own their subgoals; only the authorized root/user holds broader authority), and explicit outcomes independent of terminal attention state.

### 6. P1 — MCP bridge behavioral parity

`packages/herdr-tools/mcp-server.mjs` currently: ignores `on()` lifecycle handlers, omits schema validation of tool arguments, and drops timeout/cancellation. Bring the bridge to behavioral parity with the Pi extension path: validated/cancellable MCP transport, lifecycle-equivalent state, and the existing harness-neutral orchestration API. The audit probe "MCP argument validation" (out-of-enum action accepted) must become a rejection regression.

### 7. P1 — Per-lane launch profiles

The workflow schema carries one launch profile for all lanes. Extend the schema (versioned) so each lane may declare its own provider/model/thinking/auth profile; the dispatcher already validates per-adapter, so wire per-lane profiles through `dispatch-task.ts`. Do not weaken: exact model, subscription-auth, startup attestation.

### 8. P1 — Automated authorized incarnation rebind

Today a mismatched native session on a lane fails closed (correct) but recovery is manual. Implement the audit's recovery contract for the authorized case: a restart initiated through the orchestrator rebinds the lane to the new incarnation automatically, while an unrelated process in the same pane never acquires authority. Live-evidence docs must show both directions.

### 9. P2 — Installation doctor

Add an idempotent `doctor`/preflight tool that verifies: extension/controller source consistency, plugin enablement, routing registration, adapter registry and capability matrix, manifest store version/migrations, and native Herdr connectivity — machine-readable output, no mutation.

### 10. Tracked smalls

- Reload-acknowledgement mechanism: the activation ack currently can never fire because `session_start` does not run on `/reload`; ack should happen on the reload path (see `docs/native-prerequisite-progress.md` verification section).
- Smoke-check hardening: `smoke-check.mjs` must tolerate an inherited `BAA_STARTUP_INTENT` instead of requiring `env -u` at the call site.

## Acceptance gates (from the audit — all must be demonstrable in tests)

- Concurrent pause cannot be lost; a lost reply cannot duplicate work.
- A child in a different cwd/worktree can complete, restart, and complete again safely without manual JSON/name repair.
- Mixed-harness agents can ask, reply, acknowledge, and finish through the same durable protocol.
- Parent offline/busy/restarted: messages remain durable and arrive once, acknowledged.
- A new genuine blocker after a resolved one is delivered; duplicate transport replay is not.
- Authorized child replacement rebinds automatically; an unrelated occupant does not inherit authority.
- Display focus never changes whether a task is completed.
- Malformed/cancelled MCP requests fail predictably; no tools leak outside Herdr context.

## Definition of done

For each item: implementation + regressions (including the converted audit probes) + docs updated (`docs/herdr-native-audit.md` findings annotated with remediation commits; `docs/native-prerequisite-progress.md` evidence rows). Full suite green, `tsc` clean, `git diff --check` clean. Final report: per-item status, exact test counts, commit list, and an explicit list of anything NOT done with reasons. Do not claim live verification you did not perform — source-level evidence only; live qualification is recorded separately by the orchestrator owner.
