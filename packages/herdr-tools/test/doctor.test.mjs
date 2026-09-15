import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "baa-doctor-"));
  const cwd = join(directory, "task");
  const configDir = join(directory, "config");
  await mkdir(cwd, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  return { directory, cwd, configDir };
}

test("herdr_doctor reports a healthy installation and never mutates the manifest", async () => {
  const { directory, cwd, configDir } = await fixture();
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map(
      (key) => [key, process.env[key]],
    ),
  );
  try {
    const manifestPath = join(cwd, ".pi", "herdr-orchestrator", "manifest.json");
    await mkdir(join(cwd, ".pi", "herdr-orchestrator"), { recursive: true });
    const manifest = { version: 2, workflows: [] };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const before = await readFile(manifestPath, "utf8");
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PLUGIN_CONFIG_DIR: configDir,
    });
    const tools = new Map();
    extension({
      on() {},
      registerTool(descriptor) {
        tools.set(descriptor.name, descriptor);
      },
      registerCommand() {},
      async exec(_command, args) {
        if (args[0] === "plugin" && args[1] === "config-dir")
          return { code: 0, stderr: "", stdout: configDir };
        throw new Error(`unexpected herdr ${args.join(" ")}`);
      },
    });
    const ctx = {
      cwd,
      hasUI: false,
      mode: "json",
      modelRegistry: {
        find: () => ({ reasoning: true, thinkingLevelMap: {} }),
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => true,
      },
    };
    const report = await tools
      .get("herdr_doctor")
      .execute("doctor", {}, undefined, undefined, ctx);
    const checkIds = report.details.checks.map((entry) => entry.id).sort();
    assert.deepEqual(checkIds, [
      "adapter-registry-capability-matrix",
      "extension-source",
      "manifest-store",
      "native-herdr-connectivity",
      "plugin-enablement-and-routing",
    ]);
    assert.equal(report.details.ok, true);
    for (const entry of report.details.checks)
      assert.notEqual(entry.status, "fail", `${entry.id}: ${entry.detail}`);
    const manifestCheck = report.details.checks.find(
      (entry) => entry.id === "manifest-store",
    );
    assert.match(manifestCheck.detail, /Version 2 manifest/);
    const after = await readFile(manifestPath, "utf8");
    assert.equal(after, before, "doctor must never write the manifest");
  } finally {
    for (const [key, value] of Object.entries(saved))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
    await rm(directory, { recursive: true, force: true });
  }
});

test("herdr_doctor fails closed when native Herdr connectivity is unavailable", async () => {
  const { directory, cwd, configDir } = await fixture();
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map(
      (key) => [key, process.env[key]],
    ),
  );
  try {
    const manifestDir = join(cwd, ".pi", "herdr-orchestrator");
    await mkdir(manifestDir, { recursive: true });
    // loadManifest() falls back to {version:2, workflows:[]} for any version
    // other than 1 or 2, so a legacy/future version is invisible today.
    await writeFile(
      join(manifestDir, "manifest.json"),
      JSON.stringify({ version: 2, workflows: [] }),
    );
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PLUGIN_CONFIG_DIR: configDir,
    });
    const tools = new Map();
    extension({
      on() {},
      registerTool(descriptor) {
        tools.set(descriptor.name, descriptor);
      },
      registerCommand() {},
      async exec(_command, args) {
        if (args[0] === "plugin" && args[1] === "config-dir")
          throw new Error("plugin config-dir: no such plugin");
        throw new Error(`unexpected herdr ${args.join(" ")}`);
      },
    });
    const ctx = { cwd, hasUI: false, mode: "json", modelRegistry: {} };
    const report = await tools
      .get("herdr_doctor")
      .execute("doctor", {}, undefined, undefined, ctx);
    assert.equal(report.details.ok, false);
    const connectivity = report.details.checks.find(
      (entry) => entry.id === "native-herdr-connectivity",
    );
    assert.equal(connectivity.status, "fail");
    const routing = report.details.checks.find(
      (entry) => entry.id === "plugin-enablement-and-routing",
    );
    assert.equal(
      routing.status,
      "fail",
      "routing cannot be checked without connectivity",
    );
  } finally {
    for (const [key, value] of Object.entries(saved))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
    await rm(directory, { recursive: true, force: true });
  }
});
