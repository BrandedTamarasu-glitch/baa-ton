# Native orchestration prerequisites — handoff

## User constraints

One task, one Herdr workspace: Astra and all Luna lanes in **w17**, separate tabs/panes. No per-agent workspace or detached/direct child launch. Delegate only via Herdr plan/dispatch after prerequisites. User authorized scoped live runtime activation and isolated Astra task-binding migration without another approval gate. Preserve unrelated mappings/manifests; no push/merge/deploy/resource closure/server restart.

Latest addition: make harness extension straightforward. Keep shared orchestration neutral, isolate model/auth/argv/startup evidence behind versioned adapters, and qualify each real harness explicitly.

## Source / local evidence

- `dispatch-task.ts`: tabs-only task binding, route-before-start, effect intents and uncertainty fencing, native identity/startup proof before any assignment.
- `harness-adapter.ts`: versioned contract/registry; `pi-launch-adapter.ts`: Pi-specific model/auth/argv/proof. Generic profiles support adapters without Pi SDK context in dispatch.
- `HARNESS-ADAPTERS.md`: contract, capability matrix, remaining core work; synthetic non-Pi ID-session dispatch test is NOT real Codex qualification.
- Cross-checkout question guard + separate-process dedupe/pause regression.
- Completion now stores durable receipts independently from notification delivery; broader delivery/recovery still pending.
- `activate-task.mjs`: operator-authorized isolated registration migration, configuration backup, extension symlink retarget, one-shot activation journal. Existing manifest is not overwritten.
- `controller/activation.mjs`: existing native hook lifecycle submits one `/reload` on verified idle identity; no new timer, child agent or polling job. Reloaded root acknowledges once and emits continuation event.

Verified before activation: extension smoke + **18/18 extension tests**, **28/28 controller tests**, `tsc --noEmit -p tsconfig.json`, `git diff --check`. Log: `/tmp/astra-adapter-activation-tests.log`. LSP reported no diagnostics but could not confirm clean (push-only server); compiler is the affirmative type evidence.

## Live changes performed

- Verified current native Pi root: `w17:p1`, workspace `w17`, tab `w17:t1`, session `01a0a340-8221-744b-a6a6-d4984e31a27a` with durable native session path. Model shown: `gpt-6-astra (high)`.
- Executed `node packages/herdr-tools/activate-task.mjs --execute`.
- Retired ONLY isolated stale mapping `herdr-40eb9daa/lane-1` from old root's controller routes. Preserved that mapping in activation receipt and preserved the old authoritative manifest. Other root/workflow records remain.
- Added current task controller root binding; preserved existing local manifest and its orphaned question.
- Extension symlink now targets this checkout's `packages/herdr-tools` (previous target recorded in journal).
- `herdr plugin link "$PWD/packages/controller"` succeeded, enabled, and reports this checkout as plugin root. No server restart, agent launch, workspace creation, or resource closure.
- Activation ID: `a849004e-dea2-489b-98c3-0465a5c427f7`.
- Journal: `~/.config/herdr/plugins/config/herdr-orchestrator-controller/activation.json`.
- Backup: same directory, `config.before-a849004e-dea2-489b-98c3-0465a5c427f7.json`.
- User confirmed `/reload` completed; journal marked `acknowledged` manually with note (session_start ack hook does not fire on `/reload` — design gap, delegated-fix candidate).

## First live Luna dispatch (2026-09-15)

- Catalog note (corrected 2026-09-15 by live probe): `gpt-5.6-luna`'s `thinkingLevelMap` lists only `minimal`/`xhigh`/`max`, but Pi and the backend accepted and served a turn at `high` in a probe pane. The map is a UI enumeration, not a support boundary; validation now rejects only explicit-null entries and trusts absent levels to runtime attestation. The original delegated fix (fail-closed on absent) was superseded by this evidence.
- MCP bridge (`mcp-server.mjs`) now constructs the real installed `ModelRegistry` (absolute-path import; package `exports` blocks subpaths) so preflight validates real catalog/auth. All 10 `herdr_*` tools verified live via bridge.
- Planned `herdr-f3afd260` (BB-029 scope, capabilities: local-herdr-topology, foreground-tests, durable-ledger, observe-retry-review), profile `openai-codex/gpt-5.6-luna/xhigh/subscription`.
- Dispatch: lane tab `w17:t2`/pane `w17:p2` created in task workspace only; first `agent start` hit `agent_pane_busy` (shell-init race) and retry reused the same pane — no duplicate topology; startup proof (workspace, native session, profile, tools) verified before assignment.
- Lane implemented fail-closed thinking validation (`Object.hasOwn(map, level) && map[level] != null`) in `pi-launch-adapter.ts` + regressions; `herdr_complete` receipt stored. Independent parent verification: focused 14 pass; full suite 48/48 (20 extension + 28 controller); `tsc --noEmit` and `git diff --check` clean.
- Environmental finding: smoke-check misbehaves when `BAA_STARTUP_INTENT` is inherited (lane ran `env -u BAA_STARTUP_INTENT npm test`); follow-up guard/neutralization recommended.
- Workflow `herdr-f3afd260` left `completion-reported`/open; lane tab idle and reusable. Parent acknowledgment/closure is an explicit decision.

## Remaining work

Broader durable-core integration (neutral domain types, durable inbox/outbox, incarnation recovery, MCP/CLI validation/timeouts), real Codex/Claude adapter qualification, reload-ack mechanism, smoke-check startup-env hardening. Delegate via Herdr plan/dispatch in w17 with disjoint ownership and acceptance contracts.

## Next event / delegation

After verified runtime acknowledgement, verify the installed Luna profile/auth without credential output or refresh (`openai-codex`, `gpt-5.6-luna`; supported thinking must be checked, not guessed). Then use updated `herdr_plan` schema and `herdr_dispatch` in w17 only, with disjoint Luna ownership, explicit interface contracts/forbidden edits, synchronous acceptance tests, and durable completion receipts. Do not resume broad solo implementation.

Remaining delegated-core work includes neutral domain types/transactional store, durable inbox/outbox and incarnation recovery, scoped goal/decision protocol, thin Pi/MCP/CLI adapters and actual harness qualification. See required audit/architecture documents rather than treating the prerequisite module as the completed product.

Todo: #3 source prerequisites completed; #5 activation/live verification in progress; #4 delegated core pending. No Luna launched yet.
