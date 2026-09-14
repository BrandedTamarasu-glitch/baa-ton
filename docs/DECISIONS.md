# Decisions

## 2026-09-14 — Migrate the global runtime into Baa-ton

- `packages/herdr-tools` is the canonical source for workflow operations and the MCP bridge.
- `packages/controller` is the canonical source for the Herdr event-controller plugin.
- The MCP bridge is the harness-neutral entrypoint; it depends only on repository dependencies and Herdr session context.
- Root `npm test` runs both the mocked workflow smoke check and the controller's foreground Node suite.
- The controller installation remains disabled after linking; enabling remains an explicit parent-reviewed action.
