# Design philosophy

Baa-ton's one-sentence law: **a neutral core under a versioned, truthfully-declared
contract, with fail-closed behavior everywhere a fact is unverifiable.**

## The contract is the product

Orchestration semantics (workflows, lanes, goals, receipts, capabilities, handles)
live in `packages/herdr-tools/contract.ts` — importable by any process, tied to no
harness SDK. The neutrality is enforced, not aspirational: a regression test rejects
any planted harness import in the contract's import graph.

Every harness integrates through one versioned `HarnessLaunchAdapter` contract:

1. **Declared capabilities are truthful or absent.** The capability map
   (`supportsSessionPersistence`, startup attestation, …) is an open map; required
   flags missing means the adapter is rejected *before any topology is created*.
2. **Unimplemented = unsupported = fail closed.** A harness that does not implement
   a protocol operation must mark it unsupported; it is never guessed, substituted,
   or silently skipped. Unregistered adapters fail closed by design.
3. **Qualification is evidence, not registration.** A registered adapter is trusted
   local code, not proof; each harness needs conformance tests plus live
   qualification (see `HARNESS-ADAPTERS.md`'s evidence table).

## Transports and tiers

- **The MCP bridge is the single tool transport.** All `herdr_*` operations are
  served to any MCP-capable harness through one bridge; schema validation,
  lifecycle parity, and timeouts are tested against the extension's behavior.
- **ACP is a tier, not the contract.** Any harness speaking the Agent Client
  Protocol (an open standard for the client↔agent boundary) should eventually be
  served by one generic adapter satisfying this same contract. Native adapters
  exist only where depth is needed.
- **Herdr owns processes.** Baa-ton never spawns agents or terminals; adapters are
  launch arguments plus startup attestation. There is no daemon by design.

## The root is a role, not a harness

Root authority is **pane-based, not harness-based**: the controller config maps a
pane, and any session in that pane — of any qualified harness — can exercise root
authority through the same bridge surface. Pi is the *first* root host, not the
only one. A future root-host tier should make the three host-side jobs
harness-neutral or per-harness compilable:

1. **Bootstrap grounding** — start-of-session context can be delivered as a
   controller assignment prompt rather than host prompt injection.
2. **Lifecycle observation** — Herdr pane transitions, not host SDK events.
3. **Policy enforcement** — one policy in the contract, compiled per harness into
   its native mechanism: Pi extensions get tool interception; Claude gets deny
   rules and hooks; Codex gets a sandbox; OpenCode gets permission config.

Today's asymmetry (a Pi extension shim) reflects what each host can enforce
natively, not a preference. The end state shrinks every host's shim toward
"compiled policy plus qualification."

## Decomposition and parallelism

One writer per worktree workflow: a worktree-bound workflow may carry multiple
lanes only when all are read-only. Parallel work is expressed as N workflows over
N worktrees with disjoint file ownership; lanes that share files are sequenced.
Integration is a parent concern: verify each lane independently, land linearly,
re-run the merged suite before declaring green.

## What we do not do

No model fallback, no auth substitution, no reviving completed goals on late
hooks, no authorize-from-a-stale-snapshot. Uncertainty is surfaced (`uncertain`
wake states, `parent-approval-required` records), never resolved by guessing.
Push, merge, deploy, and resource closure always require explicit user approval
outside the local policy's reach.
