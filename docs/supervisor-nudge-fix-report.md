# Supervisor nudge-spam fix — verification report

## Context and root cause

Reviewed the last 50 parent-chat messages from the supplied September 14 session, plus the immediately preceding original fix prompt and incident messages.

The controller checked Herdr terminal status on every due tick and treated `idle` snapshots as execution authority. The extension provided no durable full-run lifecycle gate. A successful send retained another scheduled due time; only interrupted/uncertain sends were disarmed. Thus transient idle detection could repeatedly inject the entire goal during one ongoing parent run. Copied one-action/then-stop guidance further obstructed recovery.

## Changes

- `packages/herdr-tools/index.ts`: root-only, manifest-scoped `rootTurn` lifecycle persistence; active through all tool/model turns and retries, idle only on matching `agent_settled` plus `ctx.isIdle()`. Startup/shutdown invalidate idle authority. Active persistence failures abort the run; lifecycle lock contention retries for at most 10 seconds. Goal transitions re-arm only meaningful new work; repeated start/state calls preserve dedupe. Removed one-action stopping guidance, preserving approval restrictions.
- `packages/controller/controller.mjs`: strict optional lifecycle/acknowledgement validation; authoritative settled-run gate plus existing live root identity/readiness checks. Durable sending/delivered/uncertain latch consumes wake authorization. Definite pending failures remain retryable. Herdr status hooks are telemetry only; `done` is accepted as ready only with independent settled proof.
- `packages/herdr-tools/smoke-check.mjs`: actual extension hooks and controller ticks share a temporary mapped manifest, using virtual 5-second ticks. Covers active gaps, exactly one idle wake, acknowledgement/settlement/reload dedupe, later work, pause, child isolation, explicit uncertainty recovery, lock contention, and persistence failure.
- `packages/controller/test/controller.test.mjs`: additional deterministic coverage for missing/unknown/mismatched authority, concurrent ticks, legacy and interrupted receipts, uncertain sends, unavailable-root recovery, final live status/identity vetoes, unseen ready roots, and malformed fields. Existing lease and harness-neutral event coverage retained.
- `packages/herdr-tools/GOAL-ADAPTER-PROTOCOL.md`, `packages/herdr-tools/DEFECTS.md`, `packages/controller/README.md`: protocol, rollout, evidence, and limitations.
- `tsconfig.json`: strict NodeNext/ES2022 no-emit checking, matching supported Node. Validation also exposed and fixed three pre-existing extension type errors: raw lane-kind input is decoded before planning, and two invalid empty tool-content blocks were removed. Removed the unused obsolete shell-readiness helpers flagged by diagnostics.

## Foreground verification

- `npm test`: extension smoke integration **passed**; controller **28/28 passed**, 0 failures, 0 skipped/cancelled.
- `tsc --noEmit -p tsconfig.json`: **passed** using the installed Pi SDK types (linked into ignored local `node_modules` for verification), plus declared dependencies installed with `npm install --ignore-scripts --no-package-lock`.
- `node --check` for controller, controller tests, and extension smoke: **passed**.
- `git diff --check`: **passed**.
- Active LSP probe returned no errors, but the server's silent-on-clean protocol made its clean result inconclusive; the explicit compiler and runtime test results above are the confirmation.

Test output: `/tmp/astra-supervisor-tests.log` (local, temporary).

## Completion handoff

Called `herdr_complete` exactly once for the parent-planned workflow `herdr-40eb9daa`. It returned `Unknown Herdr workflow: herdr-40eb9daa`; no successful completion receipt was delivered. Implementation and verification are complete, but the session/workflow mapping must be repaired by the controller root before an authoritative receipt can be recorded. No manifest/configuration was fabricated or changed to bypass that check.

## Rollout and limitations

This is a source-only change in `astra-supervisor-nudge-fix`. No commit, push, deployment, live reload, resource closure, or delegation was performed. Update the controller first, then reload the root extension. Old controllers reject the new optional fields rather than silently bypassing them.

Older Pi versions without `agent_settled`, non-Pi/MCP-only roots, or missing lifecycle state do not receive supervisor nudges until trustworthy support/evidence exists; ordinary lane-event notifications remain unchanged. A crashed active run is not expired into idle. A restarted root must run and settle; an uncertain send still requires reviewed stop/start or pause/start recovery.

The native prompt transport lacks atomic lifecycle/draft-aware conditional submission. A one-shot wake can still race a brand-new user submission or unsent editor text after the final live check. The durable gate prevents repeated active-turn injection, but a transport-level API is needed to eliminate that final race. Already submitted prompts cannot be recalled by pause.
