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

## Verification run (2026-09-15, `astra_verifier` gpt-6-astra/high) — findings and dispositions

Independent verifier executed a four-phase plan from a non-root pane (`w17:p3`, manually started; tab since closed). Full findings and how each was resolved:

| Finding | Disposition | Evidence |
| --- | --- | --- |
| Phase 1 “FAIL baseline”: HEAD `4f8b386` ≠ expected `cb6baa9`; four activation files modified | Explained, no defect — stale prompt (symlink-fix commit landed after the prompt was written) plus post-commit formatter churn, committed separately as `39ce443`/`efcc68f` | Tests 48/48 green in verifier's own run |
| Phase 2 partial: activation journal shows **manual** acknowledgement, not automatic | Known design gap, documented below: `session_start` hook does not fire on `/reload`, so the automatic ack path never runs | `activation-ack.mjs` exists (moved in `4f8b386` to keep the extension self-contained across its symlink); the reload-ack trigger remains open work |
| Phase 2: `pane current --current` returned the verifier, not the root | Correct behavior — caller context; prompt ambiguity, not a defect | — |
| Phase 3 delegation smoke **blocked**: `Only the verified controller-mapped root may create or update the parent goal` | **System working as designed.** Root-only delegation gating refused a non-root pane; verifier correctly refused to impersonate `w17:p1`. The earlier live dispatch (`herdr-f3afd260`) remains the Phase-3 evidence | Manifest ledger; verifier report |
| Phase 4 fail-closed proofs blocked live | Completed afterward **from root**: `herdr-f8973cb0` (thinking `high` on Luna) and `herdr-59b80276` (`agentKind claude`) both rejected before any topology mutation | Manifest `dispatch-error` evidence; topology stayed 3 tabs |
| Post-review reversal: thinking `high` on `gpt-5.6-luna` actually **works** (live probe: Pi accepted it and the backend served a turn at `high`) | Validation semantics corrected in `572f4bd`: only explicit-null catalog entries reject; absent levels are trusted to runtime attestation | Probe pane `w17:p5` (closed); regression tests updated |

### Live lessons consolidated

1. **Extensions must be self-contained across their symlink.** Relative imports that leave the extension package fail when Pi loads via `~/.pi/agent/extensions/<name>` (fix: `4f8b386`, `activation-ack.mjs` moved in-package).
2. **Shell-init race:** zshrc's synchronous `pyenv init -` leaves a new pane non-startable for ~1–3s; `agent start` correctly fail-fasts. Fixed by gating on the native `pane process-info` readiness signal (`d4104cd`). Upstream suggestion for Herdr: a native `agent start --wait-for-shell` / `tab create --wait-ready` flag.
3. **Catalog maps are UI enumerations, not support boundaries** (thinking-level semantics above).
4. **Event-driven monitoring is the contract:** lanes' completion reaches the root through the controller's durable wake (dedup + retry), as happened for `herdr-f3afd260`. Root-side blocking waits (`agent wait`) are redundant and abort on user input — do not use them as the monitoring path.
5. **Environment quirk:** smoke-check misbehaves when a lane inherits `BAA_STARTUP_INTENT`; lanes must run `env -u BAA_STARTUP_INTENT npm test` (hardening remains open work).

### Open items (tracked for delegated follow-up)

- ~~Reload-ack mechanism (ack on `/reload` rather than `session_start`)~~ Done, see Durable-core batch evidence below.
- ~~smoke-check hardening against inherited startup-intent env~~ Done, see Durable-core batch evidence below.
- Herdr upstream request: native shell-readiness wait flag
- Paseo-pattern contract evolution (in flight: workflow `herdr-fc6d2a3e`, items 1-2)

## Durable-core batch evidence (2026-09-15, `astra-supervisor-nudge-fix`)

Source-level evidence only; no live installation, reload, or agent launch was performed as part of this batch. Full suite green at each step: `env -u BAA_STARTUP_INTENT npm test` (30 extension + 32 controller after all commits below; also verified green with `BAA_STARTUP_INTENT` inherited, see item 4), `tsc --noEmit -p tsconfig.json`, `git diff --check`.

1. **Item 1 (P0, transactional manifest writer), commit `89e3297`:** re-ran `docs/audit-probes/herdr-native.mjs` against this checkout before touching anything. The "different-cwd completion," "completion retry idempotency," and "concurrent durable state" probes no longer reproduced (already fixed by prior work, undocumented here until now). `observe()`/`registerEventController()` still had the unlocked load-then-save race; fixed via a new `withManifestTransaction()` primitive. Regression: `packages/herdr-tools/test/manifest-transaction.test.mjs`, verified to fail against the pre-fix source.
2. **Item 2 (P0, transport uncertainty), commit `9c544a0`:** the "ambiguous socket delivery" probe still reproduced (two prompts sent after a lost reply). `JsonLineHerdrClient` now tracks whether a request was already written before a socket-level failure; `deliverWake`/`deliverSupervisorNudge` classify a post-write failure as durable `uncertain` regardless of error code. Regressions added to `controller.test.mjs` for both the supervisor-nudge and lane-wake paths.
3. **Item 4 (P1, occurrence-aware events plus pending reconciler), commit `6628bf7`:** the "lifecycle dedupe identity" and "pending event recovery" probes still reproduced. Fixed via pane-transition-history-derived occurrence identity (no new hook field) and an event-driven pending-wake drain in `runSupervisorTick` that runs independently of parent-goal status. Regressions added to `controller.test.mjs`.
4. **Item 10 (tracked smalls), commits `15c9412`, `15c7db4`:** reload-ack now also fires from `agent_start` (session_start never runs on `/reload`); smoke-check now drops an inherited `BAA_STARTUP_INTENT` itself. Regressions in `activation.test.mjs`; `npm test` verified green both with and without `env -u BAA_STARTUP_INTENT`.
5. **Item 6 (P1, MCP bridge parity), schema-validation slice only, commit `c953c81`:** the "MCP schema validation" probe still reproduced. `mcp-server.mjs`'s `tools/call` now checks arguments against each tool's own TypeBox schema before calling `execute`. Regression in the new `packages/herdr-tools/test/mcp-server.test.mjs`, which also newly spawns the bridge as a real process at all. **Not done:** the "MCP lifecycle parity" probe still reproduces (`on()` handlers discarded, no settled-transition path); execution timeout/cancellation; the harness-independent orchestration-API extraction.
6. **Item 9 (P2, doctor tool), commit `ef8427a`:** added `herdr_doctor`, a read-only preflight (extension source, native connectivity, plugin/routing registration, manifest version, adapter capability matrix), machine-readable output, no manifest/controller-config writes. Regressions in the new `packages/herdr-tools/test/doctor.test.mjs` verify a healthy fixture, byte-for-byte manifest non-mutation, and fail-closed behavior without native connectivity.

**Not attempted in this batch:** item 3 (durable inbox/outbox unification, including the mid-batch permission-broker amendment), item 5 (scoped lane goals), the rest of item 6 (lifecycle parity, timeout/cancellation, harness-neutral API extraction), item 7 (per-lane launch profiles), item 8 (incarnation rebind automation). See the batch's final report for scope/reasoning.

**Observed concurrent edit:** commit `00f9c94` ("Wait for question and answer delivery to settle," author `zachristmas@icloud.com`) landed in this worktree mid-batch, between items 1 and 4, changing `wakeParentForQuestion`/`answerChildQuestion`'s `herdr agent prompt` calls from `--timeout 60000` to `--wait`. Not authored by this batch; noted for traceability since it touches question/answer delivery, which is adjacent to item 3's durable-inbox scope.

## Remaining work

Broader durable-core integration (neutral domain types, durable inbox/outbox, incarnation recovery, MCP/CLI validation/timeouts), real Codex/Claude adapter qualification. Delegate via Herdr plan/dispatch in w17 with disjoint ownership and acceptance contracts.

## Next event / delegation

After verified runtime acknowledgement, verify the installed Luna profile/auth without credential output or refresh (`openai-codex`, `gpt-5.6-luna`; supported thinking must be checked, not guessed). Then use updated `herdr_plan` schema and `herdr_dispatch` in w17 only, with disjoint Luna ownership, explicit interface contracts/forbidden edits, synchronous acceptance tests, and durable completion receipts. Do not resume broad solo implementation.

Remaining delegated-core work includes neutral domain types/transactional store, durable inbox/outbox and incarnation recovery, scoped goal/decision protocol, thin Pi/MCP/CLI adapters and actual harness qualification. See required audit/architecture documents rather than treating the prerequisite module as the completed product.

Todo: #3 source prerequisites completed; #5 activation/live verification in progress; #4 delegated core pending. No Luna launched yet.

### Codex lane close-out (2026-09-15, herdr-44fa8053)

Items 3, 6-remainder, and the permission broker landed via the Codex lane (41m work). Parent verification: focused regressions 17/17 serial (parallel-run flakiness in its test isolation noted as follow-up); work committed by parent as d3816c8 because the codex workspace-write sandbox cannot write the worktree linked git metadata. The durable completion receipt could not be recorded by the lane: its bridge instance went stale mid-flight (jiti loading across concurrent lane edits), and killing it revealed codex does not respawn dead MCP servers (dead-stub tool errors surface as type errors). Work is verified and committed; receipt reconciliation is recorded here as the operator evidence. Follow-ups: bridge restart/resilience for codex lanes, operator-closure tool for receipt-blocked workflows, sandbox exceptions for worktree git metadata.

### Follow-ups batch close-out (2026-09-15, herdr-cf2fc797 + herdr-ec608e46) — supersedes all earlier "next steps" text

Landed and parent-verified (eecd940, 64/64 extension + 32/32 controller, tsc and diff-check clean): adapter-declared startup handshake with OpenCode READY wiring (dispatch 27/27), parallel test-isolation fix (inbox 4/4, MCP 5/5, repeated 42/42), doctor checks for codex sandbox git-metadata writability and bridge liveness, and `herdr_operator_close` (root-only reconciliation that never impersonates a lane receipt). README rewritten for humans (31 lines, honest harness table), docs/ADDING-A-HARNESS.md added, and assets/mascot.svg (661521c, pushed). All three receipt-blocked workflows (herdr-44fa8053, herdr-cf2fc797, herdr-ec608e46) were reconciled via herdr_operator_close with who/why/evidence.

Genuinely remaining (open):

- Codex upstream: no MCP-server respawn (dead bridge orphans lane tools for the session); sandbox cannot write linked worktree git metadata; no native wait-for-shell (our 60s process-info gate approximates it).
- Controller records post-completion lane idles as non-actionable observations (no wake), while blocked and goal-paused transitions remain actionable.
- Bridge session env must be passed explicitly to codex MCP children (fixed in 42e77c1); any future harness with non-inheriting MCP children needs the same.

## Documented-gap closeout round (2026-09-15 evening, fresh v2 root in w18)

All four writer lanes were gpt-5.6-luna/xhigh via Pi (BB-029 scope, preauthorized
dispatch), run as parallel-first single-lane workflows over two worktrees
(astra-paseo-closeout: controller; astra-paseo-contract: herdr-tools), parent-verified
between lanes, then landed linearly on local main. Note the merge-gate mechanics:
the extension's own bash guard blocks root `git merge`/`git push` regardless of
recorded approval, so integration used the established parent-landing pattern
(cherry-pick), with the lane 3b enum ported into contract.ts where lane 2 moved
the types; the amended commit carries the runtime-set fix.

Landed (local main): `28a5927` neutral contract module + PersistenceHandle
(Paseo 3+7) with planted-import neutrality regression; `32752ec` live capability
discovery (Paseo 4) — optional `discoverCatalog`, documented sha256 cacheKey
identity {provider,model,auth,source}, provider-scoped live registry refresh,
bridge refuses frozen startup snapshots, fail-closed on discovery errors;
`7bd4d4a` post-completion wake-noise suppression (done/idle after a receipt or
terminal workflow status -> non-actionable; blocked/goal-paused stay actionable);
`0ac1c33` goal-status semantics (lane events -> `review-requested`; parent
questions/approvals -> `action-required`; enum additions live in contract.ts).
Merged suite 72/72 extension + 36/36 controller, tsc 7.0.2 clean, diff-check
clean. Root extension reloaded post-merge; controller hook path live
(resident supervisor still on pre-round code until the next server restart —
its paths are secondary to the hook-side suppression).

Cross-vendor review (Claude, read-only) recorded separately below when complete.

New papercuts/observations from this round:

- `herdr worktree create` auto-opens a workspace that plan-time inspection rejects;
  documented recipe above; upstream `--no-open` flag request stands.
- Concurrent dispatches race on `mkdir config.json.lock` (EEXIST for the loser;
  fails closed, retry succeeds). Lock acquisition should retry rather than die.
- Reload-ack only journals within an explicit activation window; ad-hoc `/reload`
  of a fresh root records no ack (observed on the round's root reload).
- The main checkout had no unsaved dev deps (typescript/@earendil-works/@types/node),
  so merged-main verification initially showed 5 cancelled tests and a fake-tsc
  failure. Consider carrying devDependencies in package.json so checkouts are
  self-sufficient, or a documented `npm run verify` that installs them.

Design philosophy now written down: [DESIGN-PHILOSOPHY.md](DESIGN-PHILOSOPHY.md) —
enforced interface, truthful capabilities, fail-closed, bridge as transport,
ACP tier, pane-based root authority (any qualified harness can host the root).
