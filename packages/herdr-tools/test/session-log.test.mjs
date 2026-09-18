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
  workspace_id: "session-log-workspace",
  agent_kind: "pi",
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "baa-session-log-"));
  const cwd = join(directory, "parent");
  const worktree = join(directory, "lane-worktree");
  const manifestPath = join(cwd, ".pi", "herdr-orchestrator", "manifest.json");
  const configDir = join(directory, "config");
  const first = "2026-09-15T00:00:01.000Z";
  const second = "2026-09-15T00:00:02.000Z";
  const third = "2026-09-15T00:00:03.000Z";
  const workflow = {
    id: "session-log-workflow",
    objective: "Read durable session activity.",
    status: "running",
    outcome: "running",
    cwd,
    worktree,
    lanes: [
      {
        id: "lane-1",
        objective: "Track one lane.",
        readOnly: false,
        agentKind: "pi",
        agentName: "child-session-log",
        paneId: "lane-pane",
        tabId: "lane-tab",
        status: "running",
        persistenceHandle: {
          provider: "pi",
          sessionId: "/sessions/child-session-log.jsonl",
        },
        sessionLog: {
          kind: "lane",
          sessionRef: {
            provider: "pi",
            sessionId: "/sessions/child-session-log.jsonl",
          },
          startedAt: "2026-09-15T00:00:00.000Z",
          status: "dispatched",
          workflowId: "session-log-workflow",
          laneId: "lane-1",
          paneId: "lane-pane",
          tabId: "lane-tab",
          workspaceId: root.workspace_id,
          worktree,
        },
      },
    ],
    eventController: {
      version: 1,
      events: [
        { pane_id: "lane-pane", lane_id: "lane-1", received_at: first },
        { pane_id: "lane-pane", lane_id: "lane-1", received_at: second },
      ],
    },
    ownership: {
      createdBy: "herdr-orchestrator",
      workspaceId: root.workspace_id,
      tabIds: ["lane-tab"],
      paneIds: ["lane-pane"],
    },
    evidence: [],
  };
  const manifest = {
    version: 2,
    sessionLog: {
      kind: "root",
      sessionRef: {
        provider: "pi",
        sessionId: "/sessions/root-session.jsonl",
      },
      startedAt: "2026-09-15T00:00:00.000Z",
      lastResponseAt: "2026-09-15T00:00:00.500Z",
      status: "idle",
      paneId: root.pane_id,
      workspaceId: root.workspace_id,
    },
    workflows: [workflow],
  };
  await mkdir(join(cwd, ".pi", "herdr-orchestrator"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(worktree);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map(
      (key) => [key, process.env[key]],
    ),
  );
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: root.pane_id,
    HERDR_WORKSPACE_ID: root.workspace_id,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
  });
  let gone = false;
  let agentStatus = "working";
  const tools = new Map();
  extension({
    on() {},
    registerTool(descriptor) {
      tools.set(descriptor.name, descriptor);
    },
    registerCommand() {},
    async exec(command, args) {
      assert.equal(command, "herdr");
      if (args[0] === "agent" && args[1] === "get") {
        if (gone) throw new Error("agent_not_found");
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            result: {
              type: "agent_info",
              agent: {
                name: "child-session-log",
                agent: "pi",
                pane_id: "lane-pane",
                workspace_id: root.workspace_id,
                agent_status: agentStatus,
                agent_session: {
                  kind: "path",
                  value: "/sessions/child-session-log.jsonl",
                },
              },
            },
          }),
        };
      }
      if (args[0] === "agent" && args[1] === "read")
        return { code: 0, stderr: "", stdout: "working on the lane" };
      throw new Error(`unexpected Herdr command: ${args.join(" ")}`);
    },
  });
  return {
    cwd,
    worktree,
    manifestPath,
    tools,
    setGone(value) {
      gone = value;
    },
    setAgentStatus(value) {
      agentStatus = value;
    },
    async cleanup() {
      for (const [key, value] of Object.entries(saved))
        value === undefined ? delete process.env[key] : (process.env[key] = value);
      await rm(directory, { recursive: true, force: true });
    },
    async addEvent() {
      const current = JSON.parse(await readFile(manifestPath, "utf8"));
      current.workflows[0].eventController.events.push({
        pane_id: "lane-pane",
        lane_id: "lane-1",
        received_at: third,
      });
      await writeFile(manifestPath, JSON.stringify(current));
    },
  };
}

const context = (cwd) => ({ cwd, hasUI: false, mode: "json", modelRegistry: {} });

 test("observe reports root and lane traces from the ledger, including later events", async () => {
  const f = await fixture();
  try {
    const observe = f.tools.get("herdr_observe");
    const first = await observe.execute(
      "observe-1",
      { workflowId: "session-log-workflow" },
      undefined,
      undefined,
      context(f.cwd),
    );
    assert.equal(first.details.sessionLog.length, 2);
    const lane = first.details.sessionLog.find((entry) => entry.kind === "lane");
    assert.equal(lane.lastResponseAt, "2026-09-15T00:00:02.000Z");
    assert.equal(lane.status, "working");
    assert.equal(lane.sessionRef.sessionId, "/sessions/child-session-log.jsonl");

    await f.addEvent();
    const second = await observe.execute(
      "observe-2",
      { workflowId: "session-log-workflow" },
      undefined,
      undefined,
      context(f.cwd),
    );
    const updatedLane = second.details.sessionLog.find((entry) => entry.kind === "lane");
    assert.equal(updatedLane.lastResponseAt, "2026-09-15T00:00:03.000Z");
    assert.equal(updatedLane.status, "working");
  } finally {
    await f.cleanup();
  }
});

test("session trace remains readable after its worktree and lane agent are gone", async () => {
  const f = await fixture();
  try {
    await rm(f.worktree, { recursive: true, force: true });
    f.setGone(true);
    const result = await f.tools.get("herdr_observe").execute(
      "observe-gone",
      { workflowId: "session-log-workflow" },
      undefined,
      undefined,
      context(f.cwd),
    );
    const lane = result.details.sessionLog.find((entry) => entry.kind === "lane");
    assert.equal(lane.status, "gone");
    assert.equal(lane.worktree, f.worktree);
    assert.equal(lane.paneId, "lane-pane");
    const stored = JSON.parse(await readFile(f.manifestPath, "utf8"));
    assert.equal(stored.workflows[0].lanes[0].sessionLog.sessionRef.sessionId, "/sessions/child-session-log.jsonl");
    assert.equal(stored.workflows[0].lanes[0].sessionLog.status, "gone");
  } finally {
    await f.cleanup();
  }
});

test("observe preserves a retryable dispatch failure when lane telemetry is unknown", async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(f.manifestPath, "utf8"));
    manifest.workflows[0].status = "dispatch-failed";
    manifest.workflows[0].outcome = "unknown";
    manifest.workflows[0].retry = {
      state: "retryable",
      attempt: 1,
      retryCommand: "herdr_dispatch session-log-workflow execute=true",
      failedStage: "startup-proof",
      error: "startup proof mismatch",
    };
    await writeFile(f.manifestPath, JSON.stringify(manifest));
    f.setAgentStatus("idle");

    const result = await f.tools.get("herdr_observe").execute(
      "observe-retryable-failure",
      { workflowId: "session-log-workflow" },
      undefined,
      undefined,
      context(f.cwd),
    );
    assert.equal(result.details.workflow.status, "dispatch-failed");
    assert.equal(result.details.workflow.retry.state, "retryable");
    assert.equal(
      JSON.parse(await readFile(f.manifestPath, "utf8")).workflows[0].status,
      "dispatch-failed",
    );
  } finally {
    await f.cleanup();
  }
});
