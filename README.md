# Baa-ton

<p align="center">
  <img src="assets/mascot.png?v=3761159" alt="Nala, the Baa-ton dog" width="320" height="320">
</p>

<pre align="center">───────────────────🐕  🐑  🐑  🐑  🐑  🐑  🐑──────────────────</pre>

Baa-ton is a durable, harness-neutral orchestration layer for [Herdr](https://github.com/herdrdev/herdr) 0.9+. Herdr owns panes and agent processes; Baa-ton plans work, verifies agents before dispatch, and records durable receipts.

## Install

macOS, Linux, and WSL:

```sh
curl -fsSL https://raw.githubusercontent.com/zachristmas/baa-ton/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/zachristmas/baa-ton/main/install.ps1 | iex
```

Windows CMD:

```bat
curl -fsSL https://raw.githubusercontent.com/zachristmas/baa-ton/main/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Run the installer from the project directory you want to use. It defaults to that directory, lets you choose another, detects your installed harnesses, and runs the setup wizard. When it says `Install complete`, start the harness of your choice in that project and invoke the `baa-ton-start` skill. Use `baa-ton-configure` for worker profiles and model choices, or `baa-ton-update` to update Baa-ton. Re-running the installer updates the checkout and project configuration.

Uninstall:

```sh
curl -fsSL https://raw.githubusercontent.com/zachristmas/baa-ton/main/uninstall.sh | bash
```

On Windows, run `uninstall.ps1` or `uninstall.cmd`. The uninstaller removes only Baa-ton-owned links, plugins, and checkout files; it preserves shared Herdr config, project manifests, and harness MCP config.

## Set up a root

After the installer finishes, start a selected harness in the target project and invoke its project-local `baa-ton-start` skill. The skill handles the one-time MCP/extension connection, restarts only when needed, calls `herdr_bootstrap_root`, and waits for your task. The installer’s short clipboard prompt is a fallback for a harness that cannot discover project skills.

# Fallback for a harness that cannot discover the project-local skill:

```sh
node ~/.baa-ton/packages/herdr-tools/root-setup.mjs --harness claude
# use pi, codex, or opencode as appropriate
```

The root setup helper prints the exact integration command for the current pane. Keep the harness in that pane so Herdr identity is preserved. The root should report its workspace and pane, then wait; initialize a parent goal only after you provide the actual objective.

## Re-run project setup

If you installed from the wrong directory or want to change harness selections, run the same wizard manually from the project root. Press Enter to keep the current directory, or enter another existing project path when prompted:

macOS, Linux, and WSL:

```sh
node ~/.baa-ton/packages/herdr-tools/setup.mjs --project-root "$PWD"
```

Windows PowerShell:

```powershell
node "$HOME\.baa-ton\packages\herdr-tools\setup.mjs" --project-root "$PWD"
```

The wizard updates a managed `BAA.md` reference in existing `AGENTS.md` or `CLAUDE.md` files; use `--instructions-path <file>` to choose another instruction file.

For manual/source setup, see [workflow tools](packages/herdr-tools/README.md#any-harness-as-root).

## Task profiles

Profiles give the root a short, stable intent while `.baa-ton/config.json` holds the exact provider/model/thinking/auth launch settings.

| Profile | Use it for |
| --- | --- |
| `planning` | Explore and produce a plan; read-only. |
| `quick` | A small, well-bounded change. |
| `balanced` | The normal implementation default. |
| `implementation` | A larger multi-file change with stronger execution. |
| `sustained` | A well-specified long-running task: good context, low cost, low effort. |
| `review` | Read-only correctness and regression review. |
| `deep-review` | Read-only high-scrutiny review for risky changes. |

Pass a profile name to `herdr_plan` with `taskProfile`. Configure exact launch profiles explicitly; an unknown or incomplete profile fails closed instead of silently falling back.

## BAA.md

`BAA.md` is the canonical Baa-ton Agent Agreement. It is intentionally short and harness-neutral: it covers root/child roles, delegation, receipts, verification, safety gates, and profile selection. The setup wizard manages only its reference block in an instruction file, so your surrounding `AGENTS.md` or `CLAUDE.md` remains yours.

Existing projects using `ORCHESTRATOR.md` should migrate that contract to `BAA.md` and update their instruction-file reference.

## Supported harnesses

| Harness | Integration |
| --- | --- |
| Pi | Native extension; root or lane. |
| Claude Code | MCP bridge plus startup attestation and deny rules. |
| Codex | Headless MCP bridge; native confirmation requires a TUI-capable root. |
| OpenCode | MCP bridge with conservative permissions. |

Support is qualification-by-profile, not a promise that every model or configuration works. Unqualified harnesses and launch profiles fail before topology is created.

## Operating guarantees

- Herdr owns terminal topology; Baa-ton does not spawn detached processes.
- Plans, events, queues, sessions, and receipts are durable local records.
- Writers use isolated worktrees; read-only review lanes are explicit.
- Push, merge, deploy, and resource closure remain human-gated.
- `herdr_sweep` is dry-run by default; execution requires the native confirmation dialog. A headless MCP caller must show the exact inventory and obtain approval before cleanup.

## Tests

```sh
npm install
npm test
```

`npm run test:extension` and `npm run test:controller` run the packages separately. Live harness qualification is tracked in the [progress log](docs/native-prerequisite-progress.md).

## More

- [Workflow tools and MCP setup](packages/herdr-tools/README.md)
- [Event controller](packages/controller/README.md)
- [Adding a harness](docs/ADDING-A-HARNESS.md)
- [Design philosophy](docs/DESIGN-PHILOSOPHY.md)
- [Launch contract and evidence](packages/herdr-tools/HARNESS-ADAPTERS.md)
