# Herdr workflow tools

Harness-neutral local workflow operations for Herdr. The local MCP bridge exposes the same durable planning, dispatch, observation, recovery, and close tools to any Herdr-compatible harness.

## Tools

| Tool | Purpose |
| --- | --- |
| `herdr_goal` | Manage the root-only durable parent goal. |
| `herdr_reparent` | Preview or root-confirm a controller-root handoff. |
| `herdr_plan` | Create a durable workflow and its lanes. |
| `herdr_dispatch` | Preview or create owned Herdr workspace/tab/lane resources. |
| `herdr_observe` | Record lane state and bounded recent output. |
| `herdr_resume` | Recover lanes that have a recorded paused goal. |
| `herdr_close` | Close only a completed, evidenced, extension-owned workspace. |

All operations fail closed outside a Herdr session. Dispatch, resume, and close are previews by default. Non-root callers persist a parent-approval request rather than presenting approval UI.

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

## Validate

```sh
npm run test:extension
```

The deterministic smoke check mocks Herdr and filesystem interactions; it never creates a live workspace, tab, pane, or agent.

## Design notes

- [Parent-goal protocol](./GOAL-ADAPTER-PROTOCOL.md)
- [Topology and cleanup](./TOPOLOGY-CLEANUP-PLAN.md)
- [Defect ledger](./DEFECTS.md)
