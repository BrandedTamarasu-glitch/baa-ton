# Herdr workflow tools

Harness-neutral local workflow operations for Herdr. The local MCP bridge exposes the same durable planning, dispatch, observation, recovery, and close tools to any Herdr-compatible harness.

## Tools

| Tool | Purpose |
| --- | --- |
| `herdr_goal` | Manage the root-only durable parent goal. |
| `herdr_reparent` | Preview or root-confirm a controller-root handoff. |
| `herdr_plan` | Create a durable workflow and its lanes. |
| `herdr_dispatch` | Preview or create owned Herdr workspace/tab/lane resources. |
| `herdr_observe` | Record lane state and bounded recent output, including child messages. |
| `herdr_message` | Send durable informational context from a child to its parent. |
| `herdr_resume` | Recover lanes that have a recorded paused goal. |
| `herdr_close` | Close only a completed, evidenced, extension-owned workspace. |

All operations fail closed outside a Herdr session. Dispatch, resume, and close are previews by default. Non-root callers persist a parent-approval request rather than presenting approval UI.

## Messaging the parent

A registered child uses `herdr_message` for durable informational context the root should review, including late facts after `herdr_complete`; use the question flow when Zach must decide something, and use `herdr_complete` for the lane's one completion receipt. Messages are not approval requests and are controller-routed to wake the mapped root.

## UI labels

Herdr lanes are labeled `🐑 <slug>` and the manually bootstrapped parent tab is
labeled `🐕 root`; the same role markers appear in the optional sidebar rows.
Lane slugs are deterministic kebab-case made from up to five significant
objective words after stopword removal, capped at 32 ASCII characters. New
lane agents use `child-<workflow8>-<laneNumber>` (for example,
`child-b5cc61d5-1`); existing names remain valid and unchanged.

Herdr v0.9.0 measures tab labels with Unicode display width (including the
East Asian Wide width of both role glyphs) before truncating, so the emoji
format is the active format. If a future renderer loses that width handling,
use the equivalent fallback prefixes `R: root` and `C: <slug>`.

The native `rows_by_agent` selector is canonical-agent scoped, so the
controller supplies `$herdr_role` and `$herdr_workflow` as pane metadata
(tokens are omitted when a value is unavailable); a root does not get one
workflow ID when it supervises multiple workflows.

## Guarantees

- Manifests are private, atomic local records.
- Workflows operate only resources they created and recorded.
- Each lane gets its own Herdr tab/root pane; no pane splits or implicit child sessions.
- Worktree workflows bind to one clean, pre-existing checkout and one registered parent workspace.
- Partial dispatch failures preserve resources and retry state; nothing is automatically closed.
- Observation is bounded; completion requires every lane to be done.
- No operation pushes, merges, deploys, invokes external services, or runs detached work.

## Run as MCP

After `npm install` in the repository root, configure a local stdio MCP client with:

```sh
node /Users/zchristmas/baa-ton/packages/herdr-tools/mcp-server.mjs
```

The bridge exposes tools only when `HERDR_ENV=1` is present. It has no platform-specific dependency.

## Any harness as root

The bridge preserves root-role parity for `herdr_bootstrap_root`, `herdr_goal`,
`herdr_plan`, `herdr_dispatch`, `herdr_observe`, `herdr_resume`,
`herdr_close`, `herdr_operator_close`, `herdr_reparent`,
`herdr_question_answer`, and `herdr_doctor`. A non-Pi root receives a concise
`ROOT BRIEFING` when it bootstraps, covering the durable manifest, delegation,
wake, and approval/closure gates.

From the **current Herdr pane**, print exact setup instructions with:

```sh
node packages/herdr-tools/root-setup.mjs --harness claude
# or: codex | opencode | pi
```

The helper is stdout-only unless `--write` is supplied; it prints an `export`
line for the current pane identity as part of the setup commands. `--write` writes only
the selected harness's normal config location: project `.mcp.json` for Claude,
`~/.codex/config.toml` (only when absent) for Codex, or project
`opencode.json` for OpenCode; it does not write a Pi config. Claude and
OpenCode MCP processes inherit the current pane's `HERDR_*` identity, so keep
the harness in that pane. Codex MCP children do **not** inherit it; the helper
puts `HERDR_ENV`, `HERDR_WORKSPACE_ID`, `HERDR_PANE_ID`, and
`HERDR_PLUGIN_CONFIG_DIR` explicitly in Codex's MCP configuration. Pi uses the
extension directly. Live qualification of a non-Pi root remains the final
step.

To register another root without retiring an existing one, call
`herdr_bootstrap_root` from that root's current pane with `add: true`. Add mode
appends only the current pane/workspace mapping and leaves existing controller
records and manifests intact. The new root must use both a distinct pane and a
distinct workspace; using an already-registered root pane, a child-lane pane,
or a workspace already owned by another root is rejected. A same-pane/different
checkout replacement remains a `reset: true` operation, while an already
registered pane and checkout is idempotent.

Concurrent roots are isolated: each root owns its own checkout manifest,
parent goal, workflow/lanes, and wake/approval state. The controller keeps all
orchestrator records in one config but routes lifecycle events and wakes by the
registered pane/workspace mapping, so Pi, Claude Code, and other harness roots
can run side by side without sharing parent state.

## Validate

```sh
npm run test:extension
```

The deterministic smoke check mocks Herdr and filesystem interactions; it never creates a live workspace, tab, pane, or agent.

## Design notes

- [Parent-goal protocol](./GOAL-ADAPTER-PROTOCOL.md)
- [Topology and cleanup](./TOPOLOGY-CLEANUP-PLAN.md)
- [Defect ledger](./DEFECTS.md)

## Planning parallel and sequential lanes

A worktree-bound workflow carries exactly one writer lane; multi-lane worktree
workflows must be all read-only. To parallelize writers, plan one workflow per
worktree with disjoint file ownership and dispatch them concurrently — lanes that
touch the same files must be sequenced (plan the second after the first verifies).
Integration is the parent's job: land lanes linearly, resolve the expected
type-move conflicts, and re-run the merged suite before calling the round green.

Worktree note: `herdr worktree create` auto-opens a workspace, which plan-time
inspection rejects. Create the branch, `herdr worktree remove` it, then a plain
`git worktree add <path> <branch>` registers it with Herdr without an open
workspace. An upstream `--no-open` flag request is tracked in the progress log.
