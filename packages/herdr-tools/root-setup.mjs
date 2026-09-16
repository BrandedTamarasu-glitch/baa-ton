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
// Keep this text aligned with the non-Pi bridge bootstrap response. It is
// duplicated rather than importing mcp-server.mjs because importing the bridge
// starts its stdio server and loads the Pi extension.
const ROOT_BRIEFING = [
  "ROOT BRIEFING",
  "You are the sole Baa-ton parent executor. The durable manifest is authoritative; inspect it before making workflow decisions.",
  "Delegate only with herdr_plan, then herdr_dispatch. Every child is a new Herdr-created session; never create Pi subagents, background jobs, or detached work.",
  "Treat child lifecycle, parent-question-required, parent-approval-required, and blocker records as durable signals. Children persist requests and Herdr wakes the root; do not poll or ask the user to operate a child pane or Pi goal UI. Persist a truthful goal state when waiting, blocked, paused, or complete.",
  "Push, merge, PR, deploy, production mutation, and Herdr resource closure require explicit user approval. Close only extension-owned resources with evidence.",
].join("\n");

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
  console.log(ROOT_BRIEFING);
  console.log("");
  console.log(`Current pane identity used by this setup: ${JSON.stringify(identity)}`);
  for (const warning of identityWarnings(identity)) console.log(`WARNING: ${warning}`);
  console.log("");
  console.log(`Harness setup (${harness}):`);
  console.log(`  ${exportCommand(identity)}`);
  if (harness === "claude") {
    console.log("  # Claude's MCP child inherits the environment of this pane.");
    console.log(
      `  claude mcp add --transport stdio herdr-orchestrator -- node ${shellQuote(bridge)}`,
    );
    console.log("  claude");
  } else if (harness === "codex") {
    console.log("  # Codex MCP children do not inherit pane identity; persist every key explicitly.");
    console.log(`  codex mcp add herdr-orchestrator \\\n  ${explicitEnv(identity)} \\\n  -- node ${shellQuote(bridge)}`);
    console.log("  codex");
  } else if (harness === "opencode") {
    console.log("  # Merge this project-local snippet into opencode.json, then restart OpenCode:");
    console.log("  ");
    console.log(opencodeConfig(identity));
    console.log("  opencode");
  } else {
    console.log("  # Pi uses the extension directly; no MCP registration is needed:");
    console.log(`  pi --extension ${shellQuote(extension)}`);
    console.log("  # In Pi, call herdr_bootstrap_root, then initialize the parent goal.");
  }
  console.log("");
  console.log("Environment flow:");
  console.log(
    harness === "codex"
      ? "  Codex receives HERDR_ENV, HERDR_WORKSPACE_ID, HERDR_PANE_ID, and HERDR_PLUGIN_CONFIG_DIR in its MCP server configuration."
      : "  The harness and its MCP/extension process inherit the current pane's Herdr identity; keep the harness in this pane.",
  );
  console.log("");
  console.log("After starting the harness, explicitly call herdr_bootstrap_root before herdr_goal or herdr_plan.");
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
      "herdr-orchestrator": { command: "node", args: [bridge] },
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
