import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

async function fixture({ renameFails = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-labels-"));
  const cwd = join(directory, "workspace");
  const configDir = join(directory, "config");
  const calls = [];
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map(
      (key) => [key, process.env[key]],
    ),
  );
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w-labels:root",
    HERDR_WORKSPACE_ID: "w-labels",
    HERDR_PLUGIN_CONFIG_DIR: configDir,
  });
  const tools = new Map();
  extension({
    on() {},
    registerTool(descriptor) {
      tools.set(descriptor.name, descriptor);
    },
    registerCommand() {},
    async exec(command, args) {
      assert.equal(command, "herdr");
      calls.push(args);
      if (args[0] === "plugin" && args[1] === "config-dir")
        return {
          stdout: JSON.stringify({ result: { config_dir: configDir } }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            result: {
              type: "agent_info",
              agent: {
                agent: "pi",
                name: "root",
                pane_id: args[2],
                workspace_id: "w-labels",
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            result: {
              type: "pane_info",
              pane: {
                pane_id: args[2],
                tab_id: "w-labels:root-tab",
                workspace_id: "w-labels",
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "tab" && args[1] === "rename")
        return renameFails
          ? { stdout: "", stderr: "rename unavailable", code: 1 }
          : {
              stdout: JSON.stringify({ result: { type: "tab_renamed" } }),
              stderr: "",
              code: 0,
            };
      throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
    },
  });
  return {
    cwd,
    configDir,
    calls,
    tools,
    async cleanup() {
      for (const [key, value] of Object.entries(saved))
        value === undefined ? delete process.env[key] : (process.env[key] = value);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("root bootstrap labels the current tab and repeats the idempotent rename", async () => {
  const f = await fixture();
  try {
    const bootstrap = f.tools.get("herdr_bootstrap_root");
    const first = await bootstrap.execute(
      "bootstrap",
      {},
      undefined,
      undefined,
      { cwd: f.cwd, hasUI: false, mode: "json" },
    );
    assert.equal(first.details.alreadyRegistered, false);
    assert.deepEqual(
      f.calls.find((args) => args[0] === "tab" && args[1] === "rename"),
      ["tab", "rename", "w-labels:root-tab", "🐕 pi·w-labels"],
    );
    assert.match(first.details.evidence[0], /labeled 🐕 pi·w-labels/);
    const manifest = JSON.parse(
      await readFile(join(f.cwd, ".baa-ton", "herdr-orchestrator", "manifest.json"), "utf8"),
    );
    assert.equal(manifest.sessionLog.kind, "root");
    assert.equal(manifest.sessionLog.paneId, "w-labels:root");
    assert.equal(manifest.sessionLog.workspaceId, "w-labels");
    assert.equal(manifest.sessionLog.sessionRef.sessionId, "w-labels:w-labels:root");
    assert.equal(manifest.sessionLog.tabId, "w-labels:root-tab");
    assert.ok(manifest.sessionLog.startedAt);
    assert.ok(manifest.sessionLog.lastResponseAt);
    const firstStartedAt = manifest.sessionLog.startedAt;

    const second = await bootstrap.execute(
      "bootstrap-again",
      {},
      undefined,
      undefined,
      { cwd: f.cwd, hasUI: false, mode: "json" },
    );
    assert.equal(second.details.alreadyRegistered, true);
    assert.equal(
      f.calls.filter((args) => args[0] === "tab" && args[1] === "rename").length,
      2,
    );
    const refreshed = JSON.parse(
      await readFile(join(f.cwd, ".baa-ton", "herdr-orchestrator", "manifest.json"), "utf8"),
    );
    assert.equal(refreshed.sessionLog.startedAt, firstStartedAt);
    assert.equal(refreshed.sessionLog.tabId, "w-labels:root-tab");
  } finally {
    await f.cleanup();
  }
});

test("a root tab rename failure is evidence-only and does not fail bootstrap", async () => {
  const f = await fixture({ renameFails: true });
  try {
    const result = await f.tools.get("herdr_bootstrap_root").execute(
      "bootstrap",
      {},
      undefined,
      undefined,
      { cwd: f.cwd, hasUI: false, mode: "json" },
    );
    assert.equal(result.details.alreadyRegistered, false);
    assert.match(result.details.evidence[0], /could not be applied/);
    const config = JSON.parse(
      await readFile(join(f.configDir, "config.json"), "utf8"),
    );
    assert.equal(config.orchestrators[0].root.pane_id, "w-labels:root");
  } finally {
    await f.cleanup();
  }
});
