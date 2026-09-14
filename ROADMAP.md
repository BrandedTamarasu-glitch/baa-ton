# Baa-ton reset roadmap

## Purpose

This is the clean-start plan after retiring the current Herdr server, spaces, tabs, panes, agents, plugin state, and controller mappings. Do **not** preserve or reuse the current Herdr IDs or controller config.

## Shipped in source

- Herdr controller plugin and Pi extension migrated into this repository.
- Standalone local stdio MCP bridge loads repository dependencies first.
- Explicit child `herdr_complete` receipt path; chat-only completion is insufficient.
- Durable parent-goal state with start/stop/pause controls and root activity tracking.
- Controller config v2 design for isolated orchestrators/root-workspace-program records.
- Dispatcher safety work: stale workspace recovery and native readiness retry coverage.
- Test suites were passing before reset (`npm test`, controller suite, extension smoke check).

## Not yet proven live

1. **Fresh v2 install:** install plugin/extension only from this repo; create a new config from scratch; no legacy v1 migration state.
2. **Goal nudge:** prove a 5-second nudge only after the root is idle/inactive; prove no nudge while root is working; prove pause/completion disarms it.
3. **Supervisor lifecycle:** prove exactly one supervisor after a fresh server start; prove disable stops it.
4. **MCP registration preflight:** implement and validate idempotent local registration for Pi, Codex, and Claude before agent startup. MCP tools must remain absent outside `HERDR_ENV=1`.
5. **Root identity:** prove root authority survives Pi `/reload` using verified v2 mapping, not a transient environment flag.
6. **Dispatch topology:** enforce Zach-only workspace creation. The controller must require a registered existing workspace and create only tabs/panes. A distinct Git worktree requires a separately user-created workspace.
7. **Completion contract:** prove a fresh child calls `herdr_complete` and parent receives exactly one receipt without manually prompting the child.

## Fresh bootstrap order

1. Start a new Herdr server/session.
2. Zach creates the desired root workspace(s) and any worktree workspace(s).
3. Install/link Baa-ton plugin and Pi extension from this repo, disabled first.
4. Create fresh v2 controller config with one orchestrator record for the root/workspace/program.
5. Register the root and explicitly registered user-created workspaces.
6. Enable plugin; verify exactly one supervisor process.
7. Run the goal nudge proof before dispatching any real work.
8. Run one read-only child proof: dispatch in a new tab, receipt reaches root, no workspace is created.
9. Add MCP registration preflight, then verify Pi/Codex/Claude inside Herdr and no tool noise outside Herdr.

## Explicit non-goals during reset

- Do not migrate old workspace, tab, pane, agent, or relationship IDs.
- Do not auto-create/reuse a Herdr workspace from stale manifest data.
- Do not enable a supervisor until its fresh-install proof is complete.
- Do not push, deploy, or mutate production as part of reset.

## Current source

- Repository: https://github.com/zachristmas/baa-ton
- Current pushed baseline: `main` at the initial migration commit.
