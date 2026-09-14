# Herdr topology and cleanup plan

## Model

- **Workspace:** durable project or program boundary.
- **Tab:** a goal or lane workstream within that workspace.
- **Pane:** an agent or explicit command surface within a tab.

The orchestrator reuses an extension-owned, non-worktree workspace for later non-closed workflows with the same canonical cwd. It creates a fresh tab/root pane for each lane. Git worktree workflows remain isolated because their checkout is a separate durable boundary.

## Safe close behavior

- A workflow that shares a workspace never closes that workspace while another non-closed workflow references it.
- Workflow close still requires normal root confirmation and evidence. It never closes individual tabs or panes.
- No existing workspace is closed or adopted by this change.

## Orphaned/failed workspace cleanup (parent-approved only)

1. Root observes the workflow and records the failure/completion evidence in its manifest.
2. Root verifies the workspace ID is extension-owned and checks every manifest workflow for live references.
3. Root verifies no mapped controller registration still points at an agent in that workspace.
4. Root supplies the evidence to `herdr_close` and explicitly confirms the close.
5. If ownership, references, or controller cleanup are ambiguous, retain the workspace and record a `cleanup-pending` blocker; do not close it.

This plan is intentionally non-executing: it authorizes no cleanup by itself.
