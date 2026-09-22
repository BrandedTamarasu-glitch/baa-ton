#!/usr/bin/env node
/**
 * Print (or explicitly write) the local MCP configuration for a harness that
 * will act as the Baa-ton root. The default path is intentionally stdout-only.
 */
import { lstat, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolsDirectory = dirname(fileURLToPath(import.meta.url));
const bridge = resolve(join(toolsDirectory, "mcp-server.mjs"));
const extension = resolve(join(toolsDirectory, "index.ts"));
const harnesses = new Set(["claude", "codex", "opencode", "pi"]);
function usage() {
  return `Usage: node ${join(toolsDirectory, "root-setup.mjs")} --harness claude|codex|opencode|pi [--write]\n\nDefault behavior prints commands and configuration only. --write writes only the selected harness' normal local configuration: .mcp.json for Claude, ~/.codex/config.toml for Codex (when it does not already exist), or opencode.json for OpenCode. Pi has no file write path; load the extension when starting Pi.`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function currentIdentity() {
  const configured = process.env.HERDR_PLUGIN_CONFIG_DIR ?? process.env.HERDR_PLUGIN_STATE_DIR;
  return {
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID ?? "<workspace-id-from-current-Herdr-pane>",
    HERDR_PANE_ID: process.env.HERDR_PANE_ID ?? "<pane-id-from-current-Herdr-pane>",
    HERDR_PLUGIN_CONFIG_DIR:
      configured ??
      join(
        homedir(),
        ".config",
        "herdr",
        "plugins",
        "herdr-orchestrator-controller",
      ),
  };
}

function identityWarnings(identity) {
  const warnings = [];
  if (process.env.HERDR_ENV !== "1")
    warnings.push("Run the printed command from a Herdr-managed pane (HERDR_ENV=1).");
  for (const key of ["HERDR_WORKSPACE_ID", "HERDR_PANE_ID"])
    if (identity[key].startsWith("<"))
      warnings.push(`${key} is unavailable; do not configure a root until this helper runs in the target Herdr pane.`);
  return warnings;
}

function explicitEnv(identity) {
  return [
    `--env HERDR_ENV=${shellQuote(identity.HERDR_ENV)}`,
    `--env HERDR_WORKSPACE_ID=${shellQuote(identity.HERDR_WORKSPACE_ID)}`,
    `--env HERDR_PANE_ID=${shellQuote(identity.HERDR_PANE_ID)}`,
    `--env HERDR_PLUGIN_CONFIG_DIR=${shellQuote(identity.HERDR_PLUGIN_CONFIG_DIR)}`,
  ].join(" \\\n  ");
}

// Claude Code's `mcp add` takes repeated -e KEY=value flags (its --env alias
// takes the same form). Kept distinct from explicitEnv/codex's --env syntax
// in case the two CLIs' flag grammars diverge further later.
function explicitEnvFlags(identity) {
  return [
    `-e HERDR_ENV=${shellQuote(identity.HERDR_ENV)}`,
    `-e HERDR_WORKSPACE_ID=${shellQuote(identity.HERDR_WORKSPACE_ID)}`,
    `-e HERDR_PANE_ID=${shellQuote(identity.HERDR_PANE_ID)}`,
    `-e HERDR_PLUGIN_CONFIG_DIR=${shellQuote(identity.HERDR_PLUGIN_CONFIG_DIR)}`,
  ].join(" \\\n  ");
}

function exportCommand(identity) {
  return `export HERDR_ENV=${shellQuote(identity.HERDR_ENV)} HERDR_WORKSPACE_ID=${shellQuote(identity.HERDR_WORKSPACE_ID)} HERDR_PANE_ID=${shellQuote(identity.HERDR_PANE_ID)} HERDR_PLUGIN_CONFIG_DIR=${shellQuote(identity.HERDR_PLUGIN_CONFIG_DIR)}`;
}

function opencodeConfig(identity) {
  return JSON.stringify(
    {
      mcp: {
        "herdr-orchestrator": {
          type: "local",
          command: ["node", bridge],
          environment: identity,
        },
      },
    },
    null,
    2,
  );
}

function printInstructions(harness, identity) {
  const harnessLabel = {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    pi: "Pi",
  }[harness] ?? harness;
  console.log("Baa-ton root setup");
  console.log(`Current Herdr pane: workspace=${identity.HERDR_WORKSPACE_ID}, pane=${identity.HERDR_PANE_ID}`);
  for (const warning of identityWarnings(identity)) console.log(`WARNING: ${warning}`);
  console.log("");
  console.log(`Harness: ${harnessLabel}`);
  console.log("1. Apply this one-time integration:");
  if (harness === "claude") {
    console.log([
      `  claude mcp add --transport stdio herdr-orchestrator \\`,
      `  ${explicitEnvFlags(identity)} \\`,
      `  -- node ${shellQuote(bridge)}`,
    ].join("\n"));
  } else if (harness === "codex") {
    console.log([
      `  codex mcp add herdr-orchestrator \\`,
      `  ${explicitEnv(identity)} \\`,
      `  -- node ${shellQuote(bridge)}`,
    ].join("\n"));
  } else if (harness === "opencode") {
    console.log("Merge this project-local MCP entry into opencode.json, then restart OpenCode:");
    console.log(opencodeConfig(identity));
  } else {
    // Pi has no separate MCP config file of its own to carry the identity in
    // (it loads the extension in-process), so it is the one harness that
    // still genuinely needs the pane identity exported into its own shell.
    console.log(`  ${exportCommand(identity)}`);
    console.log(`Pi is already wired through the installed extension: ${shellQuote(extension)}`);
  }
  console.log("");
  if (harness === "pi")
    console.log("2. Call herdr_bootstrap_root in this session.");
  else {
    console.log(`2. Restart ${harnessLabel} in this same Herdr pane so the connection loads.`);
    console.log("3. Call herdr_bootstrap_root in the restarted session.");
  }
  console.log("After bootstrap succeeds, report the root identity and wait for the user's task. Do not initialize a goal during setup.");
}

async function ensureRegularFile(path) {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink())
      throw new Error(`${path} must be a regular, non-symlink file.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function readJsonObject(path) {
  try {
    await ensureRegularFile(path);
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJsonConfig(path, value) {
  await ensureRegularFile(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  console.log(`Wrote ${path}`);
}

async function writeConfiguration(harness, identity) {
  if (process.env.HERDR_ENV !== "1")
    throw new Error("--write requires running in a HERDR_ENV=1 pane.");
  if (identity.HERDR_WORKSPACE_ID.startsWith("<") || identity.HERDR_PANE_ID.startsWith("<"))
    throw new Error("--write requires HERDR_WORKSPACE_ID and HERDR_PANE_ID from the current Herdr pane.");
  if (!isAbsolute(identity.HERDR_PLUGIN_CONFIG_DIR))
    throw new Error("--write requires an absolute HERDR_PLUGIN_CONFIG_DIR.");
  if (harness === "claude") {
    const path = resolve(process.cwd(), ".mcp.json");
    const config = await readJsonObject(path);
    config.mcpServers = {
      ...(config.mcpServers ?? {}),
      "herdr-orchestrator": { command: "node", args: [bridge], env: identity },
    };
    await writeJsonConfig(path, config);
    return;
  }
  if (harness === "opencode") {
    const path = resolve(process.cwd(), "opencode.json");
    const config = await readJsonObject(path);
    config.mcp = {
      ...(config.mcp ?? {}),
      "herdr-orchestrator": {
        type: "local",
        command: ["node", bridge],
        environment: identity,
      },
    };
    await writeJsonConfig(path, config);
    return;
  }
  if (harness === "codex") {
    const path = join(homedir(), ".codex", "config.toml");
    try {
      await lstat(path);
      throw new Error(`${path} already exists; use the printed codex mcp add command so Codex merges its TOML safely.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(path);
    // The parent is a normal Codex config location. Do not create it merely
    // for stdout mode; --write explicitly opts into this write.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const toml = [
      "[mcp_servers.herdr-orchestrator]",
      'command = "node"',
      `args = [${JSON.stringify(bridge)}]`,
      `env = { HERDR_ENV = ${JSON.stringify(identity.HERDR_ENV)}, HERDR_WORKSPACE_ID = ${JSON.stringify(identity.HERDR_WORKSPACE_ID)}, HERDR_PANE_ID = ${JSON.stringify(identity.HERDR_PANE_ID)}, HERDR_PLUGIN_CONFIG_DIR = ${JSON.stringify(identity.HERDR_PLUGIN_CONFIG_DIR)} }`,
      "",
    ].join("\n");
    await writeFile(path, toml, { mode: 0o600 });
    console.log(`Wrote ${path}`);
    return;
  }
  console.log("Pi uses its installed extension and has no root-setup config file to write.");
}

async function main() {
  let harness;
  let write = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      return;
    }
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg === "--harness") {
      harness = args[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!harness || !harnesses.has(harness))
    throw new Error("--harness must be one of claude, codex, opencode, or pi.");
  const identity = currentIdentity();
  printInstructions(harness, identity);
  if (write) await writeConfiguration(harness, identity);
}

main().catch((error) => {
  console.error(`root-setup: ${error instanceof Error ? error.message : String(error)}`);
  console.error(usage());
  process.exitCode = 2;
});
