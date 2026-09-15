import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

// Converts the audit's "concurrent completion and parent pause" fault probe
// (docs/audit-probes/herdr-native.mjs) into a corrected-behavior regression,
// exercised against herdr_observe rather than herdr_complete: observe() is
// the one writer the audit's Sources list names that still loaded the
// manifest once and saved the whole object back after several unlocked,
// potentially slow `herdr agent get`/`agent read` calls. A concurrent parent
// pause landing mid-observation must survive the eventual observe() save.
test("a parent pause during herdr_observe's unlocked reads is never overwritten by the observation save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-manifest-tx-"));
  const parent = join(directory, "parent");
  const configDir = join(directory, "config");
  const manifestFile = join(
    parent,
    ".pi",
    "herdr-orchestrator",
    "manifest.json",
  );
  const root = {
    target: "root",
    target_kind: "name",
    pane_id: "w-root:p1",
    workspace_id: "w-root",
    agent_kind: "pi",
  };
  const lane = {
    id: "lane-1",
    paneId: "w-child:p1",
    agentName: "child",
    relationshipId: "rel-tx",
    agentKind: "pi",
    status: "running",
  };
  const time = "2026-09-15T00:00:00.000Z";
  const goal = {
    version: 1,
    id: "tx-goal",
    objective: "Observe safely",
    status: "active",
    nextAction: "Work",
    signals: [],
    createdAt: time,
    updatedAt: time,
    supervisor: {
      version: 1,
      state: "running",
      intervalSeconds: 5,
      nudgeCount: 0,
      nextNudgeAt: time,
      createdAt: time,
      updatedAt: time,
    },
  };
  const manifest = {
    version: 2,
    parentGoal: goal,
    workflows: [
      {
        id: "tx-workflow",
        cwd: parent,
        ownership: { createdBy: "herdr-orchestrator", workspaceId: "w-root" },
        lanes: [lane],
        evidence: [],
        status: "running",
        outcome: "running",
      },
    ],
  };
  const config = {
    version: 2,
    owner: "herdr-orchestrator",
    orchestrators: [
      {
        id: "tx",
        root,
        program: { id: parent, workspace_id: root.workspace_id },
        workflows: [
          {
            workflow_id: "tx-workflow",
            manifest_path: manifestFile,
            lanes: [
              {
                lane_id: lane.id,
                target: lane.agentName,
                target_kind: "name",
                pane_id: lane.paneId,
                workspace_id: "w-child",
              },
            ],
          },
        ],
      },
    ],
  };
  for (const path of [
    parent,
    configDir,
    join(parent, ".pi/herdr-orchestrator"),
  ])
    await mkdir(path, { recursive: true });
  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify(config, null, 2),
    { mode: 0o600 },
  );
  const saved = Object.fromEntries(
    [
      "HERDR_ENV",
      "HERDR_PANE_ID",
      "HERDR_WORKSPACE_ID",
      "HERDR_PLUGIN_CONFIG_DIR",
    ].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: root.pane_id,
    HERDR_WORKSPACE_ID: root.workspace_id,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
  });
  const tools = new Map();
  let gate;
  extension({
    on() {},
    registerTool(descriptor) {
      tools.set(descriptor.name, descriptor);
    },
    registerCommand() {},
    async exec(_command, args) {
      if (args[0] === "agent" && args[1] === "get") {
        if (args[2] === lane.agentName && gate) {
          const g = gate;
          gate = undefined;
          g.started();
          await g.wait;
        }
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              type: "agent_info",
              agent: {
                name: lane.agentName,
                agent: "pi",
                pane_id: lane.paneId,
                workspace_id: "w-child",
                agent_status: "done",
              },
            },
          }),
        };
      }
      if (args[0] === "agent" && args[1] === "read")
        return { code: 0, stderr: "", stdout: "no goal markers here" };
      throw new Error(`unexpected herdr ${args.join(" ")}`);
    },
  });
  const ctx = { cwd: parent, hasUI: false, mode: "json" };
  const call = (name, args) =>
    tools.get(name).execute("tx-test", args, undefined, undefined, ctx);
  try {
    let release, started;
    const reached = new Promise((resolve) => (started = resolve));
    gate = { started, wait: new Promise((resolve) => (release = resolve)) };
    const inFlight = call("herdr_observe", { workflowId: "tx-workflow" });
    await reached;
    await call("herdr_goal", {
      action: "pause",
      pauseReason: "User paused during observation",
    });
    assert.equal(
      JSON.parse(await readFile(manifestFile, "utf8")).parentGoal.status,
      "paused",
      "the pause must have actually landed before observation resumes",
    );
    release();
    const observed = await inFlight;
    assert.equal(
      observed.details.workflow.status,
      "awaiting-explicit-outcome",
      "native Herdr done is readiness telemetry, not task success",
    );
    const final = JSON.parse(await readFile(manifestFile, "utf8"));
    assert.equal(
      final.parentGoal.status,
      "paused",
      "observe()'s eventual save must not revert a pause it never touched",
    );
    assert.equal(final.workflows[0].status, "awaiting-explicit-outcome");
    assert.equal(final.workflows[0].lanes[0].herdrState, "done");
  } finally {
    for (const [key, value] of Object.entries(saved))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
    await rm(directory, { recursive: true, force: true });
  }
});
