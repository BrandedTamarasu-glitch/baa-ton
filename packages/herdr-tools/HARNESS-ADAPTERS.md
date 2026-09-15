# Harness extension boundary

`dispatch-task.ts` owns shared task-workspace topology, effect intents, route-before-start ordering, all-lanes-before-assignment verification, and uncertain-effect fencing. It has no Pi SDK context or Pi command-line construction.

`harness-adapter.ts` defines the version-1 `HarnessLaunchAdapter` contract and registry. To add a harness, implement and register:

1. `preflight(profile)`: validate exact installed provider/model/thinking and the explicitly requested authentication policy. Never substitute a provider, model, or billing route.
2. `launchArguments(profile, source)`: harness-specific CLI/config arguments; no workspace creation or controller-state mutation.
3. `verifyStartup(nativeAgent, attestation)`: compare native identity and attestation and return a normalized `StartupProof`. Sessions may be native paths **or IDs**. Normalize harness tool aliases to the common protocol operations.
4. Explicit capabilities: distinguish native session identity, native versus screen-derived lifecycle, and verified startup attestation. Detection or a screen-derived idle state is not launch qualification.

The common dispatcher additionally enforces workspace/pane/agent identity, startup nonce, bridge source, exact profile, required operations, and stable session identity. Registry registration is trusted local code, not evidence by itself: adapters need conformance tests and live qualification.

## Current evidence

| Adapter | Source/local tests | Live qualification |
| --- | --- | --- |
| Pi / openai-codex subscription | Implemented in `pi-launch-adapter.ts` | Pending activation and observed startup |
| Codex | Synthetic ID-session adapter proves the shared dispatch path without editing the core | No production launch adapter registered |
| Claude | Native Herdr compatibility is not startup qualification | No production launch adapter registered |

Unregistered adapters fail before topology mutation. The synthetic Codex test is **not** a claim that real Codex startup is qualified.

`launch-profile.ts` validates common shape only; provider qualification belongs to the adapter. Subscription-only auth is the current policy, not an automatic fallback. The present workflow schema uses one profile per workflow; heterogeneous profiles require a versioned per-lane schema extension.

## Remaining core work

This is the dispatch boundary, not a completed multi-harness product. Domain types still live in the Pi entrypoint and need moving to a neutral core module. Goal/decision/completion adapters, durable inbox recovery, MCP/CLI validation, and real Codex/Claude qualification remain delegated-core work. New adapters must reuse those shared state transitions rather than implement independent persistence, retry, or routing engines.

Acceptance for each adapter: exact-profile/auth failure before assignment; native-session replacement rejection; different-cwd routing; same-workspace retry/restart; explicit missing capabilities; decision/pause/completion round trips; timeout ambiguity without duplicate terminal input; and process-separated contract tests plus native live evidence.
