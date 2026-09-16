# Harness extension boundary

`dispatch-task.ts` owns shared task-workspace topology, effect intents, route-before-start ordering, all-lanes-before-assignment verification, and uncertain-effect fencing. It has no Pi SDK context or Pi command-line construction.

`harness-adapter.ts` defines the version-1 `HarnessLaunchAdapter` contract and registry. To add a harness, implement and register:

1. `preflight(profile)`: validate exact installed provider/model/thinking and the explicitly requested authentication policy. Never substitute a provider, model, or billing route.
2. `launchArguments(profile, source)`: harness-specific CLI/config arguments; no workspace creation or controller-state mutation.
3. `verifyStartup(nativeAgent, attestation)`: compare native identity and attestation and return a normalized `StartupProof`. Sessions may be native paths **or IDs**. Normalize harness tool aliases to the common protocol operations.
4. Optional `startupHandshake`: an exact first prompt for harnesses that create a session lazily. Dispatch sends it once, after native agent start and before startup proof, with the same uncertain-terminal-input fence as assignment prompts.
5. Explicit capabilities: distinguish native session identity, native versus screen-derived lifecycle, and verified startup attestation. Detection or a screen-derived idle state is not launch qualification.

The common dispatcher additionally enforces workspace/pane/agent identity, startup nonce, bridge source, exact profile, required operations, and stable session identity. Registry registration is trusted local code, not evidence by itself: adapters need conformance tests and live qualification.

## Current evidence

| Adapter | Source/local tests | Live qualification |
| --- | --- | --- |
| Pi / openai-codex subscription | Implemented in `pi-launch-adapter.ts`; maps Pi tool names to the neutral `plan`/`dispatch`/`complete` operations | Proven: `herdr-f3afd260` and `herdr-fc6d2a3e` dispatched with verified startup proof and durable completion receipts |
| Codex | Synthetic ID-session adapter with native tool names proves normalized operations and shared dispatch sequencing without editing the core | No production launch adapter registered |
| Missing-capability adapter | Registry regression rejects missing `supportsSessionPersistence` before topology mutation | Not launch-qualified |
| Codex / openai-codex subscription | Implemented in `codex-launch-adapter.ts` (+ `codex-startup-attest.mjs` notify hook with thread-id attestation, handshake positional proof turn, per-invocation `-c` config incl. MCP env wiring, workspace-write sandbox): effort ladder maps 1:1 | Qualified live (`herdr-44fa8053`, items 3+6+broker, 17/17 serial, committed d3816c8). Known limitation: codex does not respawn dead MCP servers (a killed bridge orphans the lane tools for the session) and the workspace-write sandbox cannot write linked worktree git metadata, so lanes cannot self-commit or always reach the completion receipt; parent-proxy commit + operator reconciliation apply |
| OpenCode / openai-codex subscription | Implemented in `opencode-launch-adapter.ts` (+ generated attest plugin and project `opencode.json`): model mapped `openai/gpt-5.6-luna`, reasoningEffort option, conservative bash permissions (push/merge/PR denied). The adapter declares the exact `Reply with exactly: READY` startup handshake so lazy session creation is automatic; the bridge merges operations independently | Qualified live (`herdr-c5795503`): manual READY handshake previously matched native session/plugin attestation and delivered assignment; source-level follow-up now fences and dispatches that handshake automatically |
| Claude Code / claude-code subscription | Implemented in `claude-launch-adapter.ts` (+ `claude-startup-attest.mjs` SessionStart hook, `mcp-server.mjs` operations merge, `attest-merge.mjs`): exact model + `--effort` (identical ladder), generated settings/mcp config, conservative lane permissions (push/merge/PR denied), session attestation matched against native identity | In flight: first live dispatch qualifies it (durable-core batch) |

Unregistered adapters fail before topology mutation. The synthetic Codex test is **not** a claim that real Codex startup is qualified.

`launch-profile.ts` validates common shape only; provider qualification belongs to the adapter. Subscription-only auth is the current policy, not an automatic fallback. The present workflow schema uses one profile per workflow; heterogeneous profiles require a versioned per-lane schema extension. Capability-discovery evidence is recorded today only for adapters implementing `discoverCatalog` (Pi); other agent kinds dispatch without discovery evidence until their adapters implement the operation.

## Prior art: Paseo provider layer (design basis for contract evolution)

Surveyed 2026-09-15 from `getpaseo/paseo` (`packages/server/src/server/agent/agent-sdk-types.ts`, `providers/acp-agent.ts`, `agent/tools/types.ts`; local clone under `/tmp/pi-github-repos/`). Paseo orchestrates Claude Code, Codex, OpenCode, Copilot, and Pi behind one provider layer. Adoptable patterns, mapped to our gaps:

1. **Central injected tool catalog** (`PaseoToolCatalog`): orchestration tools are defined once and injected into every harness; MCP is one transport. They never depend on harness-native tool names — our core currently checks literal `herdr_*` strings and must move to protocol operations owned by the contract.
2. **Open capability map**: `[capability: string]: boolean` with required flags (`supportsStreaming`, `supportsSessionPersistence`, `supportsMcpServers`, `supportsReasoningStream`, `supportsToolInvocations`, `supportsDynamicModes`) plus optional/custom flags. Extensible without contract version bumps; covers the whole lifecycle, not just launch.
3. **Neutral contract module** (`agent-sdk-types.ts`): domain types live outside any harness entrypoint. Our `Workflow`/`Lane` still live in the Pi extension `index.ts` and must move to a neutral core module.
4. **Live capability discovery** (`fetchCatalog`): models + modes + `thinkingOptions[]` are discovered from the live provider runtime with documented cache-key identity, not trusted from a static registry. Matches our Luna-at-`high` finding: the catalog map is a UI enumeration, not a support boundary.
5. **Normalized event seam**: timeline items (`prompt`/`text`/`thinking`/`tool-execution`/`failure`) and a normalized permission request/response flow. This is the seam our question routing and completion still lack.
6. **ACP tier**: any harness speaking Agent Client Protocol (agentclientprotocol.com) works through one generic adapter — the long tail for free; native adapters only where depth is needed.
7. **Generalized persistence handle**: `{provider, sessionId, nativeHandle?, metadata?}` — a superset of our `NativeSessionRef {kind, value}`.

Deliberately NOT copied: Paseo's daemon owns process spawning and transports. We run inside Herdr's native agent management; our adapters stay thin (launch arguments + startup attestation). Borrow the contract shapes, not the runtime.

Near-term (this contract): items 1–2. Medium-term: 3–4. The event seam (5) is the bulk of remaining durable-core work; ACP (6) is a future harness tier.

## Remaining core work

This is the dispatch boundary, not a completed multi-harness product. Domain types still live in the Pi entrypoint and need moving to a neutral core module. Goal/decision/completion adapters, durable inbox recovery, MCP/CLI validation, and real Codex/Claude qualification remain delegated-core work. New adapters must reuse those shared state transitions rather than implement independent persistence, retry, or routing engines.

Acceptance for each adapter: exact-profile/auth failure before assignment; native-session replacement rejection; different-cwd routing; same-workspace retry/restart; explicit missing capabilities; decision/pause/completion round trips; timeout ambiguity without duplicate terminal input; and process-separated contract tests plus native live evidence.
