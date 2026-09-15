import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

test("planning records a versioned scoped goal graph and per-lane profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-goals-"));
  const cwd = join(directory, "task");
  const configDir = join(directory, "config");
  const manifestDir = join(cwd, ".pi", "herdr-orchestrator");
  const manifestPath = join(manifestDir, "manifest.json");
  const saved = Object.fromEntries(
    [
      "HERDR_ENV",
      "HERDR_PANE_ID",
      "HERDR_WORKSPACE_ID",
      "HERDR_PLUGIN_CONFIG_DIR",
    ].map((key) => [key, process.env[key]]),
  );
  try {
    await mkdir(manifestDir, { recursive: true });
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({
        version: 2,
        owner: "herdr-orchestrator",
        orchestrators: [
          {
            id: "root",
            root: {
              target: "w1:p1",
              target_kind: "pane_id",
              pane_id: "w1:p1",
              workspace_id: "w1",
              agent_kind: "pi",
            },
            program: { id: cwd, workspace_id: "w1" },
            workflows: [],
          },
        ],
      }),
      { mode: 0o600 },
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
        if (args[0] === "agent" && args[1] === "get")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              result: {
                type: "agent_info",
                agent: {
                  agent: "pi",
                  pane_id: "w1:p1",
                  workspace_id: "w1",
                  agent_session: { kind: "path", value: "/sessions/root" },
                },
              },
            }),
          };
        throw new Error(`unexpected herdr ${args.join(" ")}`);
      },
    });
    const fallback = {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinking: "high",
      auth: "subscription",
    };
    const laneProfile = { ...fallback, thinking: "xhigh" };
    const result = await tools.get("herdr_plan").execute(
      "plan",
      {
        objective: "Build the scoped graph",
        launchProfile: fallback,
        lanes: [
          { objective: "Prepare", launchProfile: laneProfile },
          { objective: "Use preparation", dependencies: ["lane-1"] },
        ],
      },
      undefined,
      undefined,
      { cwd, hasUI: false, mode: "json" },
    );
    const workflow = result.details.workflow;
    assert.equal(workflow.goalSchemaVersion, 1);
    assert.equal(workflow.launchProfileVersion, 1);
    assert.equal(workflow.goals.length, 3);
    assert.equal(workflow.goals[0].ownership.authority, "authorized-root");
    assert.equal(workflow.goals[1].ownership.authority, "lane");
    assert.equal(workflow.goals[1].ownership.laneId, "lane-1");
    assert.deepEqual(workflow.goals[2].dependencies, [workflow.goals[1].id]);
    assert.equal(workflow.lanes[0].launchProfile.thinking, "xhigh");
    assert.equal(workflow.lanes[0].launchProfileVersion, 1);
    assert.equal(workflow.lanes[1].launchProfile, undefined);
    assert.deepEqual(
      JSON.parse(await readFile(manifestPath, "utf8")).workflows[0].goals,
      workflow.goals,
    );
  } finally {
    for (const [key, value] of Object.entries(saved))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
    await rm(directory, { recursive: true, force: true });
  }
});
