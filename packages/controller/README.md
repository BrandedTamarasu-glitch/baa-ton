# Herdr Orchestrator Controller

A local [Herdr](https://herdr.dev) event controller for Baa-ton workflows. It is an observer and root notifier, never a dispatcher: it records durable lane events and sends a non-waiting notification only to an explicitly mapped root agent.

## Supported hook

The plugin declares one harness-neutral event:

- `pane.agent_status_changed` — classifies `done` and `blocked` states for every supported Herdr agent kind.

An opted-in workflow may perform one bounded recent-output read after an `idle` or `working` event to classify a paused goal. This is optional and never changes generic `done` or `blocked` behavior. There is no polling, `agent.wait`, `agent.prompt --wait`, or foreground wait.

## Install (parent review only)

Do **not** enable this plugin. After review, validate a fresh disabled link only:

```sh
herdr plugin unlink herdr-orchestrator-controller
herdr plugin link /Users/zchristmas/baa-ton/packages/controller --disabled
herdr plugin list --plugin herdr-orchestrator-controller --json
herdr plugin log list --plugin herdr-orchestrator-controller --limit 20
```

A reviewed parent supplies configuration in the plugin configuration directory:

```sh
PLUGIN_CONFIG_DIR="$(herdr plugin config-dir herdr-orchestrator-controller)"
install -d -m 700 "$PLUGIN_CONFIG_DIR"
install -m 600 config.sample.json "$PLUGIN_CONFIG_DIR/config.json"
```

Replace all placeholders with real opaque IDs and the absolute workflow manifest path. The controller never links or enables itself.

## Safety model

- Configuration maps one verified root and explicit child lanes to workflow IDs.
- Event identity is `{ pane_id, workspace_id }`; target names are verified only through live `agent.get` results.
- Every accepted event is atomically appended under `workflow.eventController.events`; duplicate events do not wake the root twice.
- Root unavailability leaves a durable pending event. Ambiguous delivery becomes uncertain and is not retried automatically.
- The optional parent-goal supervisor sends one non-waiting recovery nudge per durable work transition, only after the mapped Pi root has fully settled. Delivered/uncertain wakes survive restarts without replay; terminal snapshots cannot release an active run. See the [supervisor wake protocol and rollout limits](../herdr-tools/GOAL-ADAPTER-PROTOCOL.md#supervisor-wake-protocol).
- The controller never dispatches, resumes, closes, creates topology, mutates Git, or contacts external services.

Each supervisor tick compares the latest recorded lane transition against a five-minute wall-clock threshold. A routed lane that remains `working` beyond that threshold emits one durable `stall-suspected` signal per stale period and wakes its root; the signal is advisory, may be a false positive on a genuinely slow turn, and tells the root to inspect rather than declaring the lane dead.

## Validate

```sh
npm test
```

Tests use a temporary mocked JSON-line socket and cover strict configuration and payload validation, concurrent event serialization, event deduplication, root identity checks, parent-goal scheduling, concurrent one-shot delivery, legacy/interrupted-send suppression, authoritative root-run gating, unavailable-root recovery, generic multi-harness events, and optional paused-goal classification. They do not contact a live Herdr server or alter a workspace.
