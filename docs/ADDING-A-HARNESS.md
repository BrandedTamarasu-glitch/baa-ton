# Adding a harness

A harness adapter translates launch settings and startup evidence. Herdr still owns agent processes and terminals. The shared core owns planning, routing, persistence, retries, decisions, and completion. Reuse those operations instead of building another orchestration engine.

Start with the [contract](../packages/herdr-tools/harness-adapter.ts), [dispatcher](../packages/herdr-tools/dispatch-task.ts), and [adapter notes](../packages/herdr-tools/HARNESS-ADAPTERS.md). Registration alone does not qualify a harness.

## 1. Define the supported profile

Choose the exact provider, model, thinking level, and authentication policy you will qualify. The current [launch profile](../packages/herdr-tools/launch-profile.ts) accepts subscription authentication only. Never silently substitute a model, provider, or billing route.

Check the installed runtime and authentication without exposing credentials. A catalog's thinking-level list may be a UI enumeration, not a complete support boundary; use runtime evidence where needed. Record unsupported combinations explicitly. The current schema gives a workflow one profile; per-lane profiles need a versioned schema extension.

## 2. Implement the version-1 contract

Add a harness-specific module under `packages/herdr-tools/` implementing `HarnessLaunchAdapter`:

| Member | Responsibility |
| --- | --- |
| `version: 1`, `kind` | Declare the contract version and unique harness kind. |
| `preflight(profile)` | Validate the exact installed profile and requested auth policy. Reject unsupported settings before topology changes. |
| `launchArguments(profile, source, context?)` | Return harness CLI arguments and arrange harness-specific config/hooks. `context.startupIntentPath` supplies the shared startup intent when needed. Do not create workspaces or mutate controller state. |
| `verifyStartup(nativeAgent, attestation)` | Compare native identity with startup evidence and return a normalized `StartupProof`; throw on disagreement. |
| `attestationComplete?(attestation)` | If multiple writers assemble evidence, report whether identity and operation evidence are ready to verify. |

Use the [Pi](../packages/herdr-tools/pi-launch-adapter.ts), [Claude Code](../packages/herdr-tools/claude-launch-adapter.ts), [Codex](../packages/herdr-tools/codex-launch-adapter.ts), or [OpenCode](../packages/herdr-tools/opencode-launch-adapter.ts) adapter as a reference for your harness's startup behavior.

## 3. Declare capabilities honestly

The registry requires both `startupAttestation: true` and `supportsSessionPersistence: true`. Missing or false required flags must reject dispatch before topology changes.

The capability map is open to additional boolean flags, such as `supportsNativeSessionIdentity`. Declare `lifecycle` separately as `native`, `screen`, or `unavailable`. Native session identity and native lifecycle events are different capabilities: a harness can have an identifiable session while its idle state is inferred from the screen. Detection or an idle screen is never startup proof.

## 4. Produce startup attestation

Wire the harness's hook or plugin to the startup intent and shared workflow tools. If the harness creates its session only after a first turn, make the required handshake explicit and qualify that sequence. Do not deliver the task until proof is verified.

Return a `StartupProof` containing:

- `paneId` and `workspaceId` for the actual lane.
- The launch `nonce`, bridge `source`, and exact `profile`.
- `session: { kind: "path" | "id", value: string }`, matched to Herdr's native identity.
- `operations`, normalized to the common `plan`, `dispatch`, and `complete` operations, even if the harness uses different tool names.

Attest the tools actually exposed to the lane. When the hook and bridge write separate parts, merge them without losing identity or operation evidence. The common dispatcher also checks pane/workspace/agent identity, nonce, source, profile, required operations, and session stability. A replaced session must not inherit the old launch's proof.

## 5. Register and test it

Register the adapter in the dispatch registry and expose its capabilities through the doctor path; both are currently wired in [`index.ts`](../packages/herdr-tools/index.ts). Keep harness SDK types and command construction out of the common dispatcher. Unknown adapters must continue to fail closed.

Add adapter conformance tests plus shared-dispatch regressions. Cover:

- Exact arguments and config; rejected profile/auth combinations before assignment.
- Missing capabilities and unregistered kinds before topology changes.
- Valid startup proof; wrong nonce, source, identity, profile, or operations; incomplete evidence; replaced native sessions.
- Tool-alias normalization and the session representation the harness uses.
- Routes installed before launch and all lanes verified before any assignment.
- Different-cwd routing and retry/restart in the same task workspace without duplicate terminals.
- Decision, pause, and completion round trips, including durable completion receipts.
- Ambiguous timeouts without duplicate terminal input.
- Process-separated contract tests across the real bridge boundary, not just in-process mocks.

From the repository root, run:

```sh
npm test
```

For focused work, use `npm run test:extension` or `npm run test:controller`. A synthetic adapter proves the contract can accommodate a harness; it does not prove the real harness starts correctly.

## 6. Qualify the real harness

Use an authorized Herdr workflow with the real installed harness and exact profile. Preserve Herdr's ownership of launch and topology. Collect evidence that:

1. Unsupported profile/auth settings fail without assignment or unintended topology changes.
2. Native session identity matches the startup attestation, required operations are available, and verification precedes assignment.
3. A real lane receives work, routes a decision/pause round trip, and stores a durable `herdr_complete` receipt for its parent.
4. Different-cwd routing, same-workspace retry/restart, session replacement, and uncertain delivery obey the shared contract.

Record the workflow ID, harness version, exact profile/auth route, test commands/results, startup evidence, receipt, and known limitations in the adapter evidence notes. Separate directly observed live behavior from mocked coverage or operator reconciliation. A chat message, registered adapter, or green unit suite alone is insufficient.

Only then describe that harness/profile as live-qualified. Keep unsupported harnesses closed and document any remaining manual handshake, recovery, or sandbox limitations.
