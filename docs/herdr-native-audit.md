# Herdr-native orchestration audit

Date: 2026-09-15. Scope: Baa-ton workflow tools, MCP bridge, controller, supervisor patch, installed Herdr 0.9.0/protocol 22, and this lane's failed completion routing.

## Verdict

**Do not treat the current system as a finished, harness-neutral orchestration platform.** The nudge patch closes one periodic-delivery path, but identity, goal authority, delivery, approval, and recovery still differ between entrypoints. The failure is architectural, not a routine repair the user should perform.

“Herdr can start this harness” is not equivalent to “this harness can participate correctly in goals, messaging, approvals, and recovery.” The product currently conflates those capabilities.

This was a read-only runtime audit. No live configuration, installations, agent bindings, goals, or resources were changed. Source files were changing concurrently, so findings were verified against a frozen copy:

`/var/folders/mk/mqdvknn571g7h8hg14tw3kz00000gn/T/baa-ton-audit-pzh5rhzw`

Its `snapshot-hashes.json` records file hashes. References below use source file/function names rather than shifting line numbers.

## Direct evidence

### Live routing failure

- This lane is mapped as `herdr-40eb9daa/lane-1`, pane `w17:p1`.
- The controller configuration correctly points at the parent manifest under `/Users/zchristmas/the-study/.pi/herdr-orchestrator/manifest.json`.
- The child runs in `/Users/zchristmas/.herdr/worktrees/baa-ton/astra-supervisor-nudge-fix`; there is no workflow manifest there.
- `complete()` starts with `loadManifest(cwd)` before consulting the controller mapping. The observed `Unknown Herdr workflow` is therefore explained directly by the code and filesystem state.
- The mapping also retains `agent_pi_erdr40eb9daa_1` and the previous Pi session. Native `herdr agent get w17:p1` reports the replacement session and no agent name. Fixing the path alone would still leave an identity mismatch.
- The running extension points into the separate `codex-baa-manifest-identity` worktree, not this audited source. Source validation and live installation are distinct.

### Isolated fault probes

Ran real registered extension tools and the actual stdio MCP bridge against temporary fixtures. No live Herdr calls were used. All eight fault scenarios below were reproduced and asserted:

| Probe | Observed failure |
| --- | --- |
| Child completion from a distinct cwd | Cannot find the existing, correctly mapped parent workflow. |
| Retry identical completion | Two calls produce two parent prompts, not one logical receipt. |
| Concurrent completion and parent pause | Hold completion after its manifest read, persist a parent pause, then finish completion: the newer pause is overwritten by stale `active` state. |
| MCP argument validation | An action outside the advertised `herdr_goal` enum succeeds rather than being rejected. |
| MCP lifecycle parity | Goal writes persist active root-turn state, while the bridge discards all lifecycle hooks; it cannot produce a settled transition. |
| Repeated real lifecycle event | `blocked -> working -> blocked` delivers only the first blocker because the second occurrence hashes to the same permanent identity. |
| Parent availability recovery | A pending child wake remains pending after the root becomes idle; the supervisor does not drain it because the goal is `action-required`. |
| Lost socket response | A mock Herdr server receives the prompt but withholds its reply. The actual socket client times out; the controller labels delivery pending and sends the prompt again on the next due tick. |

Preserved probe script: `docs/audit-probes/herdr-native.mjs`. Captured results: `docs/audit-probes/results.json`. Run with `node docs/audit-probes/herdr-native.mjs /absolute/path/to/audited/source` after installing that source's dependencies. The audit used the frozen path above. These are diagnostic fault reproducers, deliberately outside the release test suite: a zero exit code means **the defects were reproduced**, not that the product is healthy. Convert them to corrected-behavior regression tests during remediation; they should stop passing as the defects are fixed.

The snapshot's controller suite passes **28/28** despite these faults. Its aggregate `npm test` fails at the extension smoke's source-regex assertion after the readiness loop was reformatted across lines. This is separate from the earlier pre-concurrent-edit source that passed the full suite. Logs: `/tmp/astra-audit-controller-tests.log`, `/tmp/astra-audit-baseline-tests.log`.

## Findings

### P0 — Writers can erase each other's durable state

**Sources:** `herdr-tools/index.ts::saveManifest`, `complete`, `dispatch`, `observe`, `persistParentQuestion`; `controller/controller.mjs::acquireManifestLock`.

Atomic rename protects file integrity, not read-modify-write transactions. The controller and goal/lifecycle writers use the sibling lock, but many workflow writers load an aggregate manifest and later overwrite it without the same transaction. This can erase pauses, event receipts, approvals, and other lane updates. The pause overwrite was reproduced.

**Required:** one transactional state owner. Every mutation must use the same transaction/revision mechanism. Do not hold a long transaction across a terminal/network call: persist an intent, perform the effect, then reconcile its result in a second conditional transaction. Use operation IDs and incarnation fencing.

**Remediation (durable-core batch, item 1, commit `89e3297`):** re-verified against current source: `complete()`'s per-write `transaction()` helper and `parentGoal()` already held the lock across a fresh reload before saving, so the original pause-overwrite probe scenario no longer reproduces through `herdr_complete`. `observe()` still loaded the manifest once, ran several unlocked `herdr agent get`/`agent read` calls, then saved the stale object back, silently reverting any concurrent write (a pause, an approval, another lane's completion) that landed during those reads; `registerEventController()` (called from `observe`, sharing its manifest object) had the same shape. Added `withManifestTransaction()`: gather external results first, reconcile only the resulting deltas against a freshly reloaded manifest inside one lock hold. Migrated `observe()` and `registerEventController()` onto it. Regression `packages/herdr-tools/test/manifest-transaction.test.mjs` converts the "concurrent completion and parent pause" probe into an `herdr_observe`-shaped test, verified to fail against the pre-fix source. **Not remediated in this pass:** `resume()`, `close()`, and `reparent()` share the same unlocked load-then-save shape but are not named in this finding's Sources list and have no existing test coverage; tracked as follow-up.

### P0 — Ambiguous transport failures can still duplicate prompts

**Sources:** `controller.mjs::unavailable`, `deliverSupervisorNudge`, `deliverWake`, `JsonLineHerdrClient`.

`socket_timeout`/socket failures are classified as unavailable for both identity reads and prompt submission. A timeout after submission is not proof of nondelivery. The socket-level reproduction sends two prompts after two lost replies, bypassing the intended uncertain-delivery suppression.

**Required:** distinguish pre-send rejection from post-send uncertainty at the transport boundary. Durable operation IDs and recipient acknowledgements should make retries idempotent. Without transport support, retain uncertainty rather than replaying potentially delivered input.

**Remediation (durable-core batch, item 2, commit `9c544a0`):** `JsonLineHerdrClient.request()` now tracks whether the request bytes were already written before a `socket_timeout`/`socket_error` occurs and attaches that as `error.sent`. `deliverWake` and `deliverSupervisorNudge` check `error.sent` before falling back to the `unavailable()` code-based classification, so any failure known to follow a real write becomes durable `uncertain` (never auto-replayed) rather than `pending` (retried), regardless of the specific error code. The `agent.get` identity-read paths are unchanged (a read has no duplicate-delivery risk). Regressions in `packages/controller/test/controller.test.mjs` reproduce the original "ambiguous socket delivery" probe with a real socket that accepts the write and withholds its reply, for both the supervisor-nudge and lane-wake code paths, and verify a second tick/hook does not resend.

### P1 — Identity and manifest resolution are tied to cwd and mutable agent names

**Sources:** `index.ts::complete`, `workflowForQuestionRequest`, `wakeParentForQuestion`, `controllerWorkflowMapping`, `liveAgentIdentity`, `reparent`.

Child reporting resolves state from the child's cwd; question routing looks for a program whose ID equals that cwd. Both fail for normal worktree delegation. Completion also requires a name that native Herdr clears when an occupant exits/replaces. Native session identity is not part of the durable binding/reconciliation protocol.

**Required:** resolve current participant from native session/server identity and the verified registration index, then locate its authoritative program/workflow store. Treat cwd as a code location and agent name as a display alias—not routing authority. Model a stable lane and separately fenced execution incarnations. Authorized restarts must register a new incarnation automatically. Never silently adopt an arbitrary replacement process merely because it occupies the same pane.

### P1 — Message delivery is several incompatible implementations

**Sources:** `index.ts::complete`, `wakeParentForQuestion`, `answerChildQuestion`; `controller.mjs::deliverWake` and supervisor delivery.

Completion, questions, answers, lifecycle events, and supervisor wakes use different persistence, validation, retry, and acknowledgement rules. Completion has no idempotency guard; answer failures stay pending without a reconciler; question delivery failure can be swallowed by the Pi tool hook. Direct child prompts do not use the supervisor's active-run gate. There is no general durable peer inbox or reply/correlation protocol.

**Required:** one durable inbox/outbox for all message kinds. Persist before notifying; separate stored, notified, received, acknowledged, and resolved states. A notification should be a coalesced wake hint, not the only copy of the work. Completion should be retry-safe even if the caller loses the response. Root/peer authorization must be checked consistently.

### P1 — The advertised harness-neutral bridge is not behaviorally equivalent

**Sources:** `herdr-tools/mcp-server.mjs`; `index.ts::persistRootTurn`, `confirmExecution`, `tool_call` handler; `controller.mjs::runSupervisorTick`.

The bridge ignores `on()` handlers, discards prompt guidelines/bootstrap context, supplies `hasUI:false`, omits schema validation, and ignores execution timeout/cancellation options. Thus Pi-only question interception and lifecycle tracking do not exist in other clients. Root operations requiring TUI confirmation are impossible through ordinary MCP unless a TUI-capable root or exact approved manual path is used; headless callers must show the dry-run inventory and ask the user directly rather than silently treating the operation as complete. My supervisor patch explicitly gates on Pi, so it is not the requested all-harness solution.

**Required:** extract a harness-independent orchestration API; make Pi, MCP, and CLI thin adapters. Use a proper validated/cancellable MCP transport. Provide a first-class request-input/request-approval operation usable by every participant rather than intercepting one harness's tool. Approval belongs to the authorized user's decision channel, not to the presence of Pi TUI APIs.

**Partial remediation (durable-core batch, item 6, commit `c953c81`):** only the schema-validation slice. `mcp-server.mjs`'s `tools/call` handler now runs `Value.Check(definition.parameters, args)` against each tool's own advertised TypeBox schema before calling `execute()`, returning an `isError` tool result for arguments outside it (an out-of-enum `herdr_goal` action, a missing required `herdr_dispatch` field); a schema-valid call still reaches the real implementation unchanged. Converts the "MCP argument validation" probe into a regression in `packages/herdr-tools/test/mcp-server.test.mjs` (which also newly exercises the bridge as a real spawned process at all, closing part of the P2 finding's "MCP paths are not exercised end to end" gap). **Not remediated:** `on()`/lifecycle-hook parity ("MCP lifecycle parity" probe still reproduces: a goal write through the bridge leaves `rootTurn` active with no settled-transition path), execution timeout/cancellation, and the harness-independent orchestration-API extraction itself.

### P1 — Launch success does not prove the requested worker exists and is connected

**Sources:** `index.ts::plan`, `contract`, `dispatch`, `registerEventController`; `ROADMAP.md`.

The launch schema carries agent kind, but no validated provider/model/thinking/auth profile. The native start command accepts agent arguments, but this layer does not expose them. Controller registration happens after work is prompted and is best-effort. A short-lived child can finish or ask a question before its route exists. No per-harness MCP/tool/capability handshake is required before execution.

**Required:** typed launch profiles translated by harness adapters; resolve and verify provider/model/reasoning/auth compatibility before creating work. Register routing and durable assignment first. Start the worker, verify native incarnation and tool capabilities, establish context, then deliver the assignment. Never silently substitute a model or bill a different authentication path.

### P1 — Goals are parent-only, while task completion depends on a UI attention state

**Sources:** `index.ts::requireRootGoalExecutor`, `parentGoal`, `observe`, `resume`.

There is one parent goal per manifest and no shared model for lane-owned goals/subgoals. Children are instructed to use harness-specific Pi goal semantics, but other harnesses have no equivalent API. `observe()` marks a workflow completed when every agent is `done`; in native Herdr, `done` means **idle and unseen**, not task success. Focusing a pane can change that state without changing the work.

**Required:** goal IDs, revisions, dependency edges, scoped ownership, and explicit outcomes independent of terminal attention. All agents may create/update goals within their assigned scope; only the authorized root/user controls broader authority. Agent readiness, task completion, reviewed acceptance, and safe resource cleanup are different states.

### P1 — Dedupe suppresses new work, while pending work lacks autonomous recovery

**Sources:** `controller.mjs::validateHookEnvelope`, `newRecord`, `handleHook`, `recordRootActivity`, `runSupervisorTick`.

The event identity hashes normalized kind/pane/workspace/status data, not an event occurrence, execution incarnation, or transition sequence. Later genuine repeated statuses collapse permanently. Conversely, pending events retry only when an identical hook arrives; root readiness does not drain pending delivery, and the supervisor excludes action-required goals.

**Required:** occurrence-aware event identity, ordered state transitions and session fencing, plus an event-driven pending-outbox reconciler. Native protocol 22's plugin status payload does not contain an occurrence ID; the API's `state_change_seq` is exposed elsewhere. Do not invent an unsupported hook field or fabricate exactly-once event history. Use an adapter event sequence/receipt where available, reconcile current state, and document any necessary native API addition.

**Remediation (durable-core batch, item 4, commit `6628bf7`):** confirmed live that `pane_agent_status_changed` carries no occurrence field in this checkout's `validateHookEnvelope` (unlike `pane_output_changed`, whose `revision` already makes its content hash occurrence-aware); did not add one, per the explicit constraint above. Instead, `handleHook` now fences occurrences from the controller's own durable, ordered event history: a status hook is treated as a repeat of an existing record only if it matches the most recently recorded transition for that exact pane, so `blocked -> working -> blocked` produces three distinct records/identities instead of collapsing the second `blocked` into the first. (This also exposed and fixed a latent bug: `newRecord()` was recomputing its own content-only identity internally instead of using the caller's occurrence-aware one, silently colliding two distinct occurrences under one identity.) Separately, `runSupervisorTick` now drains any lane's pending wake independently of parent-goal status on every tick, closing the "action-required goals excluded" gap; each attempt still goes through `deliverWake`'s own live root-availability check, so it is a no-op unless the root is actually ready. Both probes ("lifecycle dedupe identity", "pending event recovery") are converted into regressions in `controller.test.mjs`. Session fencing (execution-incarnation identity) is not addressed by this remediation and remains open, entangled with item 8's incarnation-rebind work below.

### P2 — Installation, topology, and tests do not constitute a coherent product contract

**Sources:** `README.md`, `ROADMAP.md`, `TOPOLOGY-CLEANUP-PLAN.md`, runtime symlink, smoke tests.

Documentation simultaneously says canonical repo installs, active worktree-linked runtime, extension-created workspaces, and a reset roadmap requiring user-created workspaces only. There is no complete idempotent preflight/doctor for harness configuration, plugin enablement, routing, versions, and native capabilities. Tests mostly exercise all roles in one process/cwd with mocked replies; key completion/MCP paths are not exercised end to end. Static regex checks fail on harmless formatting.

**Required:** one installation/version source and one explicit topology policy, machine-readable health checks, behavioral tests, native-shape protocol fixtures, process-separated role tests, and actual per-harness acceptance runs before claiming support.

**Partial remediation (durable-core batch, item 9, commit `ef8427a`):** added `herdr_doctor`, an idempotent read-only preflight covering extension source, native Herdr connectivity, plugin/routing registration, manifest store version, and the real adapter capability matrix (`HarnessAdapterRegistry.capabilities()`, not a hand-maintained list), returning machine-readable `{id, status, detail}` results. Registered like every other `herdr_*` tool, so it is already reachable through the MCP bridge and covered by the schema validation added for item 6. Regressions verify a healthy fixture, that the manifest is byte-for-byte unchanged after running it, and fail-closed behavior when native connectivity is unavailable. **Not addressed:** the one-installation/version-source and topology-policy documentation cleanup, native-shape protocol fixtures, and process-separated role tests this finding also calls for.

**Partial remediation (durable-core batch, item 10 "tracked smalls," commits `15c9412`, `15c7db4`):** the two smalls tracked against this finding in `docs/native-prerequisite-progress.md`'s Open Items are done: (1) `session_start` never fires on `/reload`, so the activation-ack path could never complete automatically after one; `acknowledgeActivation()` is now also attempted from `agent_start` (idempotent, cheap no-op when nothing is pending), which does fire on the first turn after a reload, with a regression that fires only `agent_start` and verifies the journal reaches `acknowledged`. (2) `smoke-check.mjs` now drops an inherited `BAA_STARTUP_INTENT` for itself instead of requiring `env -u` at every call site; verified `npm test` passes both ways and reproduced the prior `ENOENT` failure against the pre-fix script. The machine-readable idempotent doctor/preflight tool itself (item 9) is not part of this remediation.

## What native Herdr already supplies

Installed CLI/server: 0.9.0, protocol 22, compatible. Native status integrations are installed/current for Pi, Claude, Codex, Copilot, and OpenCode; other available integrations are not all installed. This is installation evidence, not a declaration that all those harnesses have full lifecycle hooks or have passed Baa-ton acceptance.

Herdr supplies pane/workspace topology, live agent identity, native session references, status authority, event subscriptions, bounded native waits/startup, and display metadata. The inspected native Pi integration already uses `agent_settled` plus `ctx.isIdle()`—the original “tool gaps are idle” explanation was not sufficient proof that Herdr's installed Pi integration was itself wrong.

Native support differs by harness:

- Full lifecycle authority where installed/reporting: Pi, OMP, Kimi, OpenCode, Kilo, MastraCode.
- Session integration but screen-based state for others, including Claude and Codex.
- Some detected harnesses have no session/lifecycle integration.

Screen fallback can report idle when no known rule matches. Therefore removing the Pi-only gate and trusting every idle screen would be unsafe. Normalize native capabilities and make unsupported guarantees explicit, while retaining shared goals/inbox/completion APIs for every client.

The inspected native API has no built-in goal or durable agent-mailbox methods. Such methods below are **proposed Baa-ton/core contracts**, not existing Herdr calls. Atomic draft/session-aware prompt submission and stronger event occurrence metadata may require changes upstream in Herdr.

## Recommended architecture

Use **one Herdr-owned orchestration core**, not a Pi extension pretending to be a universal controller.

```text
Pi adapter   Codex/Claude/... MCP clients   Local CLI
         \              |                 /
          Shared validated orchestration API
                         |
         Transactional goals + identity registry
         Durable inbox/outbox + scoped permissions
         Reconciler + capability/launch adapters
                         |
          Native Herdr topology/session/events
```

The core should be owned by the Herdr plugin lifecycle, not by an individual assistant session or an untracked detached launcher. A transactional store (for example SQLite) is a reasonable implementation, but the essential requirement is a single transaction/revision contract, not a particular database.

### Participant contract

Every launched/resumed participant discovers:

- stable program/workflow/lane and current execution-incarnation IDs;
- its native server/session/pane binding;
- authoritative state/inbox endpoints, independent of cwd;
- assigned goals and permitted goal/message/operation scopes;
- parent and permitted peers;
- verified launch profile and adapter capabilities.

Conceptual operations: context discovery, scoped goal create/update, inbox read/ack, message send/reply, input/approval request, idempotent completion, and health/reconciliation. Names and schemas should be finalized together; do not bolt on unrelated one-off tools for each incident.

### Recovery contract

- Parent restart: durable inbox remains and is drained on verified reattachment.
- Child restart: authorized new incarnation receives the same lane assignment; stale incarnation is fenced out.
- Tool retry or lost response: returns the same durable operation/receipt, not another notification.
- Busy parent: messages accumulate/coalesce without repeated terminal injection.
- Uncertain send: reconcile an acknowledgement/receipt, never blindly retype it.
- Unknown screen state: no destructive assumption or fabricated settled state.
- Routine local reconciliation stays within granted capabilities; real user decisions and authority changes remain explicit.

## Implementation order and acceptance gates

1. **Correctness foundation:** transactional writer API, durable operation IDs/outbox, transport-stage uncertainty. Gate: concurrent pause cannot be lost; lost reply cannot duplicate work.
2. **Native identity and startup:** cwd-independent discovery, fenced incarnations, verified model/provider/reasoning profile, pre-assignment routing and capability handshake. Gate: a child in another worktree can complete, restart, and complete again safely without manual JSON/name repair.
3. **Shared goal/message/approval contract:** scoped lane goals, dependency-aware progress, parent/peer inboxes, harness-neutral decision routing. Gate: mixed-harness agents can ask, reply, acknowledge, and finish through the same durable protocol.
4. **Adapter/install and recovery proof:** per-harness capability matrix, idempotent registration/doctor, native-shaped event fixtures, session restart and offline recovery. Gate: first support Pi, Codex, and Claude with real end-to-end tests, then qualify each remaining harness; unqualified features must be explicit rather than silently failing.

Required scenarios before calling the system reliable:

- Correct provider/model/reasoning/auth path or an actionable preflight failure before dispatch.
- Child and parent in different cwd/worktrees; nested cwd changes do not affect routing.
- Two children complete simultaneously while a parent pauses/updates a goal.
- Identical completion/message requests retried after disconnect return one logical receipt.
- Parent offline, busy, or restarted; messages remain durable and eventually arrive once acknowledged.
- New real blocker after a resolved blocker is delivered; duplicate transport replay is not.
- Authorized child replacement rebinds automatically; an unrelated process in the same pane does not acquire its authority.
- Pending approvals work from Pi, Codex, and Claude without requiring a hidden Pi-only TUI.
- Display focus never changes whether a task is completed.
- No tools leak outside the intended Herdr context, and malformed/cancelled MCP requests fail predictably.
- Disable/re-enable/update yields one core runtime and no abandoned wake loop.

## Native references

- <https://herdr.dev/llms.txt>
- <https://raw.githubusercontent.com/herdrdev/herdr/v0.9.0/docs/next/website/src/content/docs/agents.mdx>
- <https://raw.githubusercontent.com/herdrdev/herdr/v0.9.0/docs/next/website/src/content/docs/integrations.mdx>
- <https://raw.githubusercontent.com/herdrdev/herdr/v0.9.0/docs/next/website/src/content/docs/socket-api.mdx>

Installed API schema captured at `/tmp/astra-herdr-schema.json`; installed Pi integration inspected at `~/.pi/agent/extensions/herdr-agent-state.ts`.
