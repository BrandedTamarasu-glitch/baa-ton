# Baa-ton

<p align="center">
  <img src="assets/mascot.png" alt="Baazle, the Baa-ton sheep" width="192" height="192">
</p>

Baa-ton is an orchestration core for [Herdr](https://github.com/herdrdev/herdr) (0.9+), the
terminal multiplexer for coding agents. Herdr owns the terminals and the agent processes;
Baa-ton plans their work, checks each agent before handing it a task, and keeps a record of
what actually happened.

## Install

You'll need [Herdr](https://github.com/herdrdev/herdr) 0.9+, Node.js 20+, and a
Pi session running inside a Herdr pane (that's the root host). Then:

```sh
git clone git@github.com:zachristmas/baa-ton.git
cd baa-ton && npm install

# 1. Pi extension (the herdr_* tools)
ln -s "$PWD/packages/herdr-tools" ~/.pi/agent/extensions/herdr-orchestrator

# 2. Event controller (review before enabling — see its README)
herdr plugin link "$PWD/packages/controller"
```

From your Herdr-rooted Pi pane, call `herdr_bootstrap_root` once to claim the root,
then `herdr_plan` → `herdr_dispatch` to delegate. Full details:
[workflow tools](packages/herdr-tools/README.md) ·
[event controller](packages/controller/README.md).

**Run the tests** (harness CLIs on `PATH` required for adapter tests):

```sh
npm test
```

The suite runs the workflow smoke check plus the workflow and controller tests. To run
just one package, use `npm run test:extension` or `npm run test:controller`. Local
tests don't replace live harness qualification.

## Why Baa-ton

**What problem does it solve?** Running several coding agents at once is easy. Trusting
what they tell you is not. Baa-ton makes delegation *durable and verifiable* instead of
hope-and-scrollback.

- *"The agent said tests passed."* Claims aren't receipts. A lane only completes by
  storing a durable `herdr_complete` receipt, and the parent independently re-runs the
  checks before accepting anything.
- *"My session died mid-round."* Plans, lane assignments, events, and receipts all live
  in transactional manifests, so reloading or restarting just picks the round back up
  from the ledger.
- *"Which of my six panes needs me?"* The event controller only wakes the parent for
  events that need a human: done, blocked, or a question only you can answer. It
  suppresses everything else; `action-required` means *you* must act.
- *"Don't let it push to prod."* Lanes are fenced per harness, through interception,
  deny-rules, and sandboxes. Push, merge, deploy, and resource closure always require
  a human.
- *"I want Codex to implement and Claude to review."* One versioned contract works
  across any qualified harness, so lanes can mix vendors freely. Capability discovery
  checks that a model or thinking level actually exists, instead of just hoping.

**Who is it for?** Anyone driving coding agents from a terminal through Herdr who wants
parallel work they can actually trust.

**What it is not.** Not a daemon, not a hosted service, not CI. It never spawns processes
(Herdr does), and every harness that isn't explicitly qualified fails closed.

## What it does

It plans work into lanes, one writer per worktree workflow, with read-only lanes set
aside for review. Before it assigns anything, it checks the exact provider, model,
thinking level, and auth, confirms startup attestation, and discovers capabilities
live, so unverified harnesses fail closed *before* any terminal is created. Every
harness talks to it through one MCP bridge covering all ten `herdr_*` tools, and
lifecycle events turn into durable wakes and receipts, so nothing has to poll.

## Example prompts

You talk to a root session in a Herdr pane; Baa-ton does the rest. Real shapes that work today:

**Delegate one bounded task**

```text
Close the failing tests in packages/controller — delegate to a luna lane
in a worktree and verify it yourself before we merge.
```
→ The root plans a single-lane workflow (BB-029 local scope), dispatches it after startup
proof, the lane works/tests/commits and files its receipt, the root re-runs the suite and
reports evidence.

**Run a parallel round**

```text
Close these three gaps. Parallelize the disjoint ones, sequence the ones
that share files, and have Claude review the whole diff before we push.
```
→ One workflow per writer over separate worktrees, parent verification between lanes,
then a read-only cross-vendor review lane. No push without your explicit gate.

**Answer a lane's question**

```text
(the lane hit a decision) → you get woken with the question
Pick option 2 — reuse the existing adapter.
```
→ Questions persist durably and route to the mapped root; your answer is recorded and
delivered to the waiting lane. Lanes never prompt their own UI.

## Supported harnesses

| Harness | Adapter | Live qualification | Tested with | Notes |
| --- | --- | --- | --- | --- |
| Pi | `pi-launch-adapter.ts` | 2026-09-15, several lanes | pi 0.85.1 | First-class: native tools, bash interception, can host the root |
| Claude Code | `claude-launch-adapter.ts` | 2026-09-15, durable-core + review lanes | claude 2.1.273 | Deny-rules (push/merge/PR), SessionStart attestation |
| Codex | `codex-launch-adapter.ts` | 2026-09-15, messaging-core lane | codex-cli 0.154.0 | Sandbox can't write worktree git metadata; no MCP respawn (dead bridge orphans lane tools) |
| OpenCode | `opencode-launch-adapter.ts` | 2026-09-15, goals/profiles lane | opencode 1.18.31 | READY handshake auto-sent, conservative bash permissions |
| Anything else | — | Fails closed | — | By design, before topology is created |

Qualification covers the tested subscription profiles, not every model or configuration.
Recovery and lifecycle integration still have rough edges — see the
[progress log](docs/native-prerequisite-progress.md) for evidence and limitations.

## How it fits together

```mermaid
flowchart TD
    subgraph herdr["Herdr — owns the terminals"]
        R["root pane<br/>(parent session)"]
        L["lane panes<br/>any qualified harness"]
    end
    subgraph core["Baa-ton core"]
        P["plan · dispatch<br/>verify, then start"]
        B["MCP bridge<br/>the herdr_* tools"]
        K["event controller<br/>durable wakes + receipts"]
    end
    R --> P
    P -->|"verified start"| L
    L <-->|"tools"| B
    L -->|"lifecycle events"| K
    K -->|"wake"| R
```

Read it as one loop: the root plans and dispatches through the core, lanes only start
once they're verified, they call the bridge for tools, their events feed the
controller, and the controller wakes the root back up.

A delegation round looks like this:

```mermaid
sequenceDiagram
    participant U as Root (with user)
    participant H as Herdr
    participant L as Lane agent
    U->>H: herdr_plan — lanes, profiles, worktree
    U->>H: herdr_dispatch — startup proof verified
    H->>L: new session in assigned cwd
    L->>L: work · foreground tests · commit
    L-->>U: herdr_complete receipt (durable)
    Note over L,U: done / blocked / question events wake the root
    U->>U: independent parent verification
```

Parallel writers each get their own workflow and worktree, with disjoint file
ownership; if two lanes would touch the same files, they're sequenced instead.
Integration is the parent's job: land the changes one at a time, re-run the merged
test suite, and get a cross-vendor review before anything ships.

## Go deeper

- [Design philosophy](docs/DESIGN-PHILOSOPHY.md) — enforced interface, truthful capabilities, fail closed.
- [Add a harness](docs/ADDING-A-HARNESS.md) — implement the adapter and prove it works.
- [Launch contract and evidence](packages/herdr-tools/HARNESS-ADAPTERS.md) — the versioned adapter contract.
- [Workflow tools and MCP setup](packages/herdr-tools/README.md) — planning, parallel lanes, worktrees.
- [Event controller](packages/controller/README.md) — durable wakes, receipts, goal statuses.
- [Progress log](docs/native-prerequisite-progress.md) — evidence, qualifications, open gaps.
