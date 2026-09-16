import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

const root = {
  target: "root-pane",
  target_kind: "pane_id",
  pane_id: "root-pane",
  workspace_id: "task-space",
  agent_kind: "pi",
};

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-lane-retire-"));
  const cwd = join(directory, "checkout");
  const configDir = join(directory, "config");
  const manifestDir = join(cwd, ".pi", "herdr-orchestrator");
  const manifestPath = join(manifestDir, "manifest.json");
  const workflowId = options.workflowId ?? "workflow-lane-retire";
  const tabIds = options.tabIds ?? ["task-tab-1", "task-tab-2"];
  const lanes = options.lanes ?? tabIds.map((_, index) => ({
    id: `lane-${index + 1}`,
    objective: `Lane ${index + 1}`,
    readOnly: false,
    agentKind: "pi",
    status: "completion-reported",
    paneId: `lane-pane-${index + 1}`,
    tabId: tabIds[index],
  }));
  const workflow = {
    id: workflowId,
    objective: "Retire completed task lanes.",
    outcome: "unknown",
    status: "completion-reported",
    lanes,
    taskBinding: {
      workspaceId: options.taskWorkspaceId ?? "task-space",
      rootPaneId: options.rootPaneId ?? "root-pane",
      rootSessionPath: "root-session",
    },
    herdr: {},
    agent: {},
    agentKind: "pi",
    cwd,
    worktree: null,
    goalSchemaVersion: 1,
    rootGoalId: `goal-${workflowId}`,
    goals: [],
    evidence: [],
    ownership: {
      createdBy: "herdr-orchestrator",
      workspaceId: options.ownershipWorkspaceId ?? "task-space",
      tabIds,
      paneIds: lanes.map((lane) => lane.paneId),
    },
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
  await mkdir(manifestDir, { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    manifestPath,
    `${JSON.stringify({ version: 2, workflows: [workflow] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(configDir, "config.json"),
    `${JSON.stringify({
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [{
        id: "lane-retire-test-root",
        root,
        program: {
          id: cwd,
          workspace_id: root.workspace_id,
          parent_manifest_path: manifestPath,
        },
        workflows: [],
      }],
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    directory,
    cwd,
    configDir,
    manifestPath,
    workflowId,
    tabIds,
    liveTabs: new Set(options.liveTabs ?? tabIds),
    calls: [],
    failTabs: new Set(options.failTabs ?? []),
    tabWorkspace: options.tabWorkspace ?? "task-space",
  };
}

function setupEnvironment(data, paneId = root.pane_id) {
  const keys = [
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_PLUGIN_CONFIG_DIR",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: paneId,
    HERDR_WORKSPACE_ID: root.workspace_id,
    HERDR_PLUGIN_CONFIG_DIR: data.configDir,
  });
  return () => {
    for (const [key, value] of Object.entries(saved))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
  };
}

function registeredTools(data) {
  const tools = new Map();
  extension({
    on() {},
    registerTool(descriptor) {
      tools.set(descriptor.name, descriptor);
    },
    registerCommand() {},
    async exec(_command, args) {
      data.calls.push(args);
      if (args[0] === "plugin" && args[1] === "config-dir")
        return { code: 0, stderr: "", stdout: data.configDir };
      if (args[0] === "agent" && args[1] === "get")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              type: "agent_info",
              agent: {
                name: "root",
                agent: "pi",
                pane_id: "root-pane",
                workspace_id: "task-space",
              },
            },
          }),
        };
      if (args[0] === "tab" && args[1] === "list") {
        const workspaceId = args[args.indexOf("--workspace") + 1];
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              tabs: [...data.liveTabs].map((tabId) => ({
                tab_id: tabId,
                workspace_id: data.tabWorkspace,
              })),
              workspace_id: workspaceId,
            },
          }),
        };
      }
      if (args[0] === "tab" && args[1] === "close") {
        const tabId = args[2];
        if (data.failTabs.has(tabId)) throw new Error(`close failed for ${tabId}`);
        data.liveTabs.delete(tabId);
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({ result: { tab_id: tabId, closed: true } }),
        };
      }
      if (args[0] === "workspace" && args[1] === "close")
        throw new Error("workspace close must never be called by lane retirement");
      throw new Error(`unexpected herdr ${args.join(" ")}`);
    },
  });
  return tools;
}

const context = (cwd) => ({ cwd, hasUI: false, mode: "json", modelRegistry: {} });
const params = (workflowId, overrides = {}) => ({
  workflowId,
  evidence: ["parent verified all lane receipts"],
  execute: true,
  ...overrides,
});

async function close(data, tools, overrides = {}) {
  return tools.get("herdr_close").execute(
    "lane-retire-test",
    params(data.workflowId, overrides),
    undefined,
    undefined,
    context(data.cwd),
  );
}

async function cleanup(data, restore) {
  restore();
  await rm(data.directory, { recursive: true, force: true });
}

test("lane retirement dry-run and execute close only recorded task tabs", async () => {
  const data = await fixture();
  const restore = setupEnvironment(data);
  try {
    const tools = registeredTools(data);
    const dryRun = await close(data, tools, { execute: false });
    assert.equal(dryRun.details.dryRun, true);
    assert.deepEqual(dryRun.details.tabIds, data.tabIds);
    assert.deepEqual(dryRun.details.commands, data.tabIds.map((id) => `herdr tab close ${id}`));
    assert.deepEqual(data.calls.filter((args) => args[0] === "tab" && args[1] === "close"), []);

    const result = await close(data, tools);
    assert.equal(result.details.laneRetired, true);
    assert.deepEqual(result.details.closedTabIds, data.tabIds);
    assert.deepEqual(result.details.remainingTabIds, []);
    assert.equal(result.details.workspaceRetained, true);
    assert.deepEqual([...data.liveTabs], []);
    assert.equal(data.calls.some((args) => args[0] === "workspace" && args[1] === "close"), false);
    assert.ok(result.details.workflow.laneRetirement);
    assert.equal(result.details.workflow.laneRetirement.status, "retired");
    assert.equal(result.details.routesRetired, true);
    assert.ok(result.details.workflow.evidence.some((entry) => entry.kind === "lane-retirement-routes-retired"));
    const controllerConfig = JSON.parse(await readFile(join(data.configDir, "config.json"), "utf8"));
    const routed = controllerConfig.orchestrators.flatMap((record) =>
      record.workflows.map((workflow) => workflow.workflow_id),
    );
    assert.equal(routed.includes(data.workflowId), false, "retired workflow routes are removed");
    assert.ok(result.details.workflow.evidence.some((entry) => entry.kind === "lane-retirement-completed"));
    const stored = JSON.parse(await readFile(data.manifestPath, "utf8"));
    assert.ok(stored.workflows[0].laneRetirement);
    assert.deepEqual(stored.workflows[0].ownership.tabIds, data.tabIds);
  } finally {
    await cleanup(data, restore);
  }
});

test("lane retirement is idempotent and does not double-close", async () => {
  const data = await fixture();
  const restore = setupEnvironment(data);
  try {
    const tools = registeredTools(data);
    const first = await close(data, tools);
    const closeCalls = data.calls.filter((args) => args[0] === "tab" && args[1] === "close").length;
    const second = await close(data, tools);
    assert.equal(second.details.alreadyRetired, true);
    assert.equal(second.details.laneRetired, true);
    assert.equal(data.calls.filter((args) => args[0] === "tab" && args[1] === "close").length, closeCalls);
    assert.equal(second.details.workflow.laneRetirement.status, "retired");
    assert.equal(first.details.workflow.laneRetirement.completedAt, second.details.workflow.laneRetirement.completedAt);
  } finally {
    await cleanup(data, restore);
  }
});

test("lane retirement refuses a non-root caller", async () => {
  const data = await fixture();
  const restore = setupEnvironment(data, "child-pane");
  try {
    await assert.rejects(
      close(data, registeredTools(data)),
      /lane retirement is root-only.*verified controller-mapped root/i,
    );
  } finally {
    await cleanup(data, restore);
  }
});

test("lane retirement refuses missing evidence", async () => {
  const data = await fixture();
  const restore = setupEnvironment(data);
  try {
    await assert.rejects(
      close(data, registeredTools(data), { evidence: [] }),
      /lane retirement requires at least one evidence item/i,
    );
  } finally {
    await cleanup(data, restore);
  }
});

test("lane retirement refuses a non-terminal lane", async () => {
  const data = await fixture({
    lanes: [
      {
        id: "lane-1",
        objective: "Still running",
        readOnly: false,
        agentKind: "pi",
        status: "working",
        paneId: "lane-pane-1",
        tabId: "task-tab-1",
      },
      {
        id: "lane-2",
        objective: "Done",
        readOnly: false,
        agentKind: "pi",
        status: "completed",
        paneId: "lane-pane-2",
        tabId: "task-tab-2",
      },
    ],
  });
  const restore = setupEnvironment(data);
  try {
    await assert.rejects(
      close(data, registeredTools(data)),
      /every lane to be terminal.*lane-1/i,
    );
  } finally {
    await cleanup(data, restore);
  }
});

test("lane retirement refuses a tab outside the root task workspace", async () => {
  const data = await fixture({ tabWorkspace: "other-workspace" });
  const restore = setupEnvironment(data);
  try {
    await assert.rejects(
      close(data, registeredTools(data)),
      /tab task-tab-1 is not in the root's task workspace task-space/i,
    );
    assert.equal(data.calls.some((args) => args[0] === "tab" && args[1] === "close"), false);
  } finally {
    await cleanup(data, restore);
  }
});

test("lane retirement records partial close failures durably for retry", async () => {
  const data = await fixture({ failTabs: ["task-tab-2"] });
  const restore = setupEnvironment(data);
  try {
    const tools = registeredTools(data);
    const partial = await close(data, tools);
    assert.equal(partial.details.laneRetired, false);
    assert.equal(partial.details.partialFailure, true);
    assert.deepEqual(partial.details.closedTabIds, ["task-tab-1"]);
    assert.deepEqual(partial.details.failedTabIds, ["task-tab-2"]);
    assert.deepEqual(partial.details.remainingTabIds, ["task-tab-2"]);
    assert.deepEqual([...data.liveTabs], ["task-tab-2"]);
    assert.ok(partial.details.workflow.evidence.some((entry) => entry.kind === "lane-retirement-tab-closed"));
    assert.ok(partial.details.workflow.evidence.some((entry) => entry.kind === "lane-retirement-tab-failed"));
    const stored = JSON.parse(await readFile(data.manifestPath, "utf8"));
    assert.equal(stored.workflows[0].laneRetirement.status, "partial");
    assert.deepEqual(stored.workflows[0].laneRetirement.closedTabIds, ["task-tab-1"]);
    assert.deepEqual(stored.workflows[0].laneRetirement.failedTabIds, ["task-tab-2"]);
    assert.deepEqual(stored.workflows[0].laneRetirement.pendingTabIds, ["task-tab-2"]);
    assert.equal(stored.workflows[0].outcome, "unknown");
  } finally {
    await cleanup(data, restore);
  }
});

test("lane retirement retries only the durable remainder", async () => {
  const data = await fixture({ failTabs: ["task-tab-2"] });
  const restore = setupEnvironment(data);
  try {
    const tools = registeredTools(data);
    await close(data, tools);
    data.failTabs.clear();
    const retry = await close(data, tools);
    assert.equal(retry.details.laneRetired, true);
    assert.deepEqual(retry.details.closedTabIds, data.tabIds);
    assert.deepEqual(
      data.calls.filter((args) => args[0] === "tab" && args[1] === "close").map((args) => args[2]),
      ["task-tab-1", "task-tab-2", "task-tab-2"],
    );
    assert.equal(retry.details.workflow.laneRetirement.status, "retired");
    assert.deepEqual(retry.details.workflow.laneRetirement.failedTabIds, []);
  } finally {
    await cleanup(data, restore);
  }
});
