# Architecture

## Purpose

Baa-ton is being established as a clean repository for future Herdr orchestration
work. This first commit intentionally contains no controller runtime.

## Design references inspected

| Component | Global source | Relevant responsibility |
| --- | --- | --- |
| Pi extension | `~/.pi/agent/extensions/herdr-orchestrator/index.ts` | Plans and dispatches explicitly owned lanes, persists workflow manifests, mediates root-only approval, and observes lanes. |
| Event controller | `~/.pi/agent/plugins/herdr-orchestrator-controller/controller.mjs` | Validates mapped status hooks, records durable event facts, and sends a non-waiting root notification. |
| Plugin metadata | `~/.pi/agent/plugins/herdr-orchestrator-controller/herdr-plugin.toml` | Declares the supported agent-status hook and Herdr-owned startup supervisor. |

These remain external reference sources; this repository does not copy or operate
them.

## Invariants for future implementation

1. **Local and durable first.** Persist workflow/event state atomically before a
   notification or other effect.
2. **Explicit ownership.** A workflow may operate only resources it created and
   recorded.
3. **Root-only authority.** Child lanes report requests and evidence; they do not
   approve dispatch, resume, or close operations.
4. **Event-driven control.** Treat lifecycle signals as observations. Never turn
   them into autonomous Git, PR, deployment, production, or external actions.
5. **Bounded reads and foreground tests.** No polling loops, detached jobs, or
   hidden background test workers.
6. **Fail closed.** Reject malformed mappings, identity drift, ambiguous targets,
   and unsafe local file permissions before mutation.

## Proposed growth path

1. Define the durable manifest schema and validation tests in `src/` and `test/`.
2. Add one isolated local operation with explicit ownership checks.
3. Add foreground tests for normal, duplicate, unavailable, and malformed-input
   paths.
4. Document any new authority boundary before adding a mutation-capable feature.
