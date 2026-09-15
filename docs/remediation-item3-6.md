# Durable-core remediation: items 3 and 6 remainder

This note records the source-level work completed in this lane. Shared audit
and progress documents were left unchanged because they are owned by the
parallel lane.

## Item 3 — unified durable inbox/outbox

- Added `packages/herdr-tools/inbox/index.mjs`, a locked and atomically-written
  JSON store with logical-key deduplication, occurrence identity, the
  `herdr-link/1` envelope shape, stored/notified/received/acknowledged/resolved
  state history, coalesced recipient wake hints, and a pending reconciler.
- Controller lane events and supervisor wakes persist an inbox record before
  calling `agent.prompt`; delivery status is reconciled afterward. Existing
  cross-workspace diagnostic mappings remain on the legacy path and are not
  emitted as `herdr-link/1` messages.
- MCP mutations persist durable bridge messages before invoking the shared tool
  implementation. Permission answers and releases use the same store, with
  uncertain delivery held pending and release idempotent.

## Item 6 remainder — MCP parity

- The MCP bridge now retains `on()` lifecycle handlers, writes active/idle or
  cancelled/unknown root-turn state, validates request containers and tool
  schemas, supports `notifications/cancelled`, and applies bounded per-call
  `timeoutMs`/`timeout_ms` cancellation.
- Resolved mutation results are replayed from the inbox; uncertain calls are
  returned as pending review instead of being re-executed.

## Permission-broker amendment

- Claude’s `--permission-prompt-tool` is default-off. It is enabled only by an
  explicit adapter option or `BAA_CLAUDE_PERMISSION_PROMPT_TOOL=1`, and the
  generated value is `mcp__herdr-orchestrator__herdr_permission_prompt`.
- The MCP broker rejects calls outside `HERDR_ENV=1` and rejects unregistered
  child routes. Regressions cover deduplication, uncertain answers remaining
  pending, and exactly-once release/replay.
- The requested `git stash pop` was attempted twice for
  `stash@{0}` (`claude permission-broker WIP`); both attempts were unable to
  write the worktree index and the stash remains intact. Its patch contained
  only formatting already present in this checkout, not the broker behavior.

## Verification

Passing focused command:

```text
node --test packages/herdr-tools/test/inbox.test.mjs packages/herdr-tools/test/claude-adapter.test.mjs packages/herdr-tools/test/mcp-server.test.mjs packages/controller/test/inbox-controller.test.mjs
```

This produced 17 passing focused tests. `git diff --check` and JavaScript
syntax checks pass. The direct `tsc --noEmit -p tsconfig.json` check passed
before the parallel lane changed its owned shared files; the final check now
fails only in those untouched files (`index.ts` and `launch-profile.ts`). The prescribed
`env -u BAA_STARTUP_INTENT npm test` is not green in this
sandbox: the extension phase has one pre-existing missing-Codex-CLI failure
(54/55 pass), and the controller phase has 14 pre-existing Unix-socket
`listen EPERM` failures (18/32 pass). The repository has no local
`node_modules/.bin/tsc`; the globally available TypeScript compiler was used
for the earlier passing required command.

No commit was created because the sandbox denies writes to the linked Git
worktree metadata (`.git/worktrees/.../index.lock`); the working-tree changes
remain available for the parent lane to stage and commit.
