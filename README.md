# Baa-ton

Local foundation for a Herdr orchestration project.

This repository starts with documentation and layout only. It does **not** package,
link, enable, or modify the installed Herdr controller or Pi extension.

## Layout

- `docs/` — architecture notes and implementation decisions.
- `src/` — future implementation source.
- `test/` — future foreground tests.

## Current reference implementation

The existing global implementation was inspected as a design reference:

- Pi extension: `~/.pi/agent/extensions/herdr-orchestrator/`
- Herdr event controller plugin:
  `~/.pi/agent/plugins/herdr-orchestrator-controller/`

Baa-ton should preserve its core safety boundaries: durable local records,
explicit ownership, root-only approval, synchronous tests, and no implicit remote
or production actions. See [Architecture](docs/ARCHITECTURE.md).

## Status

Scaffold only. No executable runtime, dependencies, or deployment configuration
are present yet.
