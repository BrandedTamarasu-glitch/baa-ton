# Baa-ton

Canonical source repository for local Herdr orchestration tooling.

## Layout

- `packages/herdr-tools/` — durable workflow manifest operations, local MCP bridge, and deterministic smoke check.
- `packages/controller/` — the Herdr event-controller plugin and its Node test suite.
- `docs/` — architecture and ownership decisions.

The runtime is local-only. It does not push, deploy, or create remote resources.

## Validate

```sh
npm install
npm test
```

Requires Node 20+.

## Use from any Herdr-compatible harness

Configure the harness's local stdio MCP client to run:

```sh
node /Users/zchristmas/baa-ton/packages/herdr-tools/mcp-server.mjs
```

Inside a Herdr session, this exposes the `herdr_*` workflow tools. The MCP bridge uses repository dependencies only; it has no platform-specific runtime dependency.

## Install the event controller

Review these commands before running them. They make only local Herdr registration changes. Linking remains disabled; enabling is a separate explicit parent-reviewed action.

```sh
herdr plugin unlink herdr-orchestrator-controller
herdr plugin link /Users/zchristmas/baa-ton/packages/controller --disabled
herdr plugin list --plugin herdr-orchestrator-controller --json
```

See the package READMEs for configuration and safety boundaries.
