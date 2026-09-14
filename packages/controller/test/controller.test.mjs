import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ControllerError,
  JsonLineHerdrClient,
  handleHook,
  hookResponse,
  runSupervisorLoop,
  runSupervisorTick,
  validateConfig,
} from "../controller.mjs";

const ROOT = {
  target: "bb029-root",
  target_kind: "name",
  agent_kind: "pi",
  pane_id: "w-root:p1",
  workspace_id: "w-root",
};
const CHILD = {
  lane_id: "lane-child",
  target: "bb029-writer",
  target_kind: "name",
  pane_id: "w-child:p1",
  workspace_id: "w-child",
};

async function createFixture({
  root = ROOT,
  child = CHILD,
  piGoalPauseDetection = true,
  parentGoal,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-controller-"));
  const stateDir = join(directory, "state");
  const manifestPath = join(
    directory,
    "workflow",
    ".pi",
    "herdr-orchestrator",
    "manifest.json",
  );
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  const manifest = {
    version: 2,
    ...(parentGoal ? { parentGoal } : {}),
    workflows: [
      {
        id: "herdr-bb029",
        ownership: {
          createdBy: "herdr-orchestrator",
          workspaceId: child.workspace_id,
        },
        lanes: [
          {
            id: child.lane_id,
            paneId: child.pane_id,
            agentName: child.target,
          },
        ],
      },
    ],
  };
  const config = {
    version: 1,
    owner: "herdr-orchestrator",
    root,
    workflows: [
      {
        workflow_id: "herdr-bb029",
        manifest_path: manifestPath,
        pi_goal_pause_detection: piGoalPauseDetection,
        lanes: [child],
      },
    ],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(
    join(stateDir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    directory,
    stateDir,
    manifestPath,
    async manifest() {
      return JSON.parse(await readFile(manifestPath, "utf8"));
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function startHerdrMock(respond) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-controller-socket-"));
  const socketPath = join(directory, "api.sock");
  const requests = [];
  const server = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(input.slice(0, newline));
      requests.push(request);
      const reply = await respond(request);
      socket.end(`${JSON.stringify({ id: request.id, ...reply })}\n`);
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  return {
    socketPath,
    requests,
    async close() {
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function rootAgentInfo() {
  return {
    result: {
      type: "agent_info",
      agent: {
        agent: ROOT.agent_kind,
        name: ROOT.target,
        pane_id: ROOT.pane_id,
        workspace_id: ROOT.workspace_id,
        agent_status: "idle",
      },
    },
  };
}

function statusEvent(status, agent = "pi") {
  return {
    event: "pane_agent_status_changed",
    data: {
      type: "pane_agent_status_changed",
      pane_id: CHILD.pane_id,
      workspace_id: CHILD.workspace_id,
      agent_status: status,
      agent,
    },
  };
}

function rootStatusEvent(status, agent = "pi") {
  return {
    event: "pane_agent_status_changed",
    data: {
      type: "pane_agent_status_changed",
      pane_id: ROOT.pane_id,
      workspace_id: ROOT.workspace_id,
      agent_status: status,
      agent,
    },
  };
}

function outputEvent(revision = 1) {
  return {
    event: "pane_output_changed",
    data: {
      type: "pane_output_changed",
      pane_id: CHILD.pane_id,
      workspace_id: CHILD.workspace_id,
      revision,
    },
  };
}

function client(mock) {
  return new JsonLineHerdrClient(mock.socketPath, 1_000);
}

function requestsFor(mock, method) {
  return mock.requests.filter((request) => request.method === method);
}

function parsePluginManifest(raw) {
  const top = {};
  const events = [];
  let current = top;
  for (const untrimmed of raw.split(/\r?\n/)) {
    const line = untrimmed.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[events]]" || line === "[[startup]]") {
      current = {};
      (line === "[[events]]" ? events : (top.startup ??= [])).push(current);
      continue;
    }
    const match =
      /^(id|name|version|min_herdr_version|description|platforms|on|command) = (.+)$/.exec(
        line,
      );
    assert.ok(match, `unsupported or malformed manifest line: ${line}`);
    current[match[1]] = JSON.parse(match[2]);
  }
  return { top, events };
}

test("manifest has the required ID, compatible version floor, and supported event hooks", async () => {
  const raw = await readFile(
    new URL("../herdr-plugin.toml", import.meta.url),
    "utf8",
  );
  const manifest = parsePluginManifest(raw);
  assert.deepEqual(manifest.top, {
    id: "herdr-orchestrator-controller",
    name: "herdr-orchestrator-controller",
    version: "0.1.0",
    min_herdr_version: "0.9.0",
    description:
      "Durable, root-only event controller for Herdr Orchestrator workflows.",
    platforms: ["linux", "macos", "windows"],
    startup: [
      {
        platforms: ["linux", "macos"],
        command: ["sh", "supervisor.sh"],
      },
      {
        platforms: ["windows"],
        command: ["node", "controller.mjs", "supervisor"],
      },
    ],
  });
  const startupScript = await readFile(
    new URL("../supervisor.sh", import.meta.url),
    "utf8",
  );
  assert.match(startupScript, /volta" which node/);
  assert.match(startupScript, /exec "\$\{node_bin\}" controller\.mjs supervisor/);
  assert.deepEqual(manifest.events, [
    {
      on: "pane.agent_status_changed",
      command: ["node", "controller.mjs", "hook"],
    },
  ]);
});

test("legacy v1 config migrates to one isolated orchestrator record", () => {
  const manifestPath = "/tmp/shared/.pi/herdr-orchestrator/manifest.json";
  const secondChild = {
    lane_id: "lane-child-2",
    target: "bb029-reviewer",
    target_kind: "name",
    pane_id: "w-child-2:p1",
    workspace_id: "w-child-2",
  };
  const config = validateConfig({
    version: 1,
    owner: "herdr-orchestrator",
    root: ROOT,
    workflows: [
      {
        workflow_id: "herdr-bb029",
        manifest_path: manifestPath,
        lanes: [CHILD],
      },
      {
        workflow_id: "herdr-bb030",
        manifest_path: manifestPath,
        lanes: [secondChild],
      },
    ],
  });
  assert.deepEqual(
    config.orchestrators[0].workflows.map((workflow) => workflow.manifest_path),
    [manifestPath, manifestPath],
  );
});

test("isolated v2 records route wakes and root activity to only their own root", async () => {
  const fixture = await createFixture({
    parentGoal: {
      version: 1, id: "parent-a", objective: "A", status: "active", nextAction: "A", signals: [],
      supervisor: { version: 1, state: "running", intervalSeconds: 5, nudgeCount: 0, nextNudgeAt: null, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" },
      createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  const rootB = { target: "root-b", target_kind: "name", agent_kind: "pi", pane_id: "w-b:p1", workspace_id: "w-b" };
  const childB = { lane_id: "lane-b", target: "child-b", target_kind: "name", pane_id: "w-b-child:p1", workspace_id: "w-b-child" };
  const secondManifestPath = join(fixture.directory, "second", "manifest.json");
  await mkdir(dirname(secondManifestPath), { recursive: true });
  await writeFile(secondManifestPath, `${JSON.stringify({ version: 2, parentGoal: { version: 1, id: "parent-b", objective: "B", status: "active", nextAction: "B", signals: [], supervisor: { version: 1, state: "running", intervalSeconds: 5, nudgeCount: 0, nextNudgeAt: null, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" }, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" }, workflows: [{ id: "herdr-b", ownership: { createdBy: "herdr-orchestrator" }, lanes: [{ id: childB.lane_id, paneId: childB.pane_id, agentName: childB.target }] }] })}\n`);
  const configPath = join(fixture.stateDir, "config.json");
  await writeFile(configPath, `${JSON.stringify({ version: 2, owner: "herdr-orchestrator", orchestrators: [
    { id: "a", root: ROOT, program: { id: "program-a", workspace_id: ROOT.workspace_id }, workflows: [{ workflow_id: "herdr-bb029", manifest_path: fixture.manifestPath, lanes: [CHILD] }] },
    { id: "b", root: rootB, program: { id: "program-b", workspace_id: rootB.workspace_id }, workflows: [{ workflow_id: "herdr-b", manifest_path: secondManifestPath, lanes: [childB] }] },
  ] }, null, 2)}\n`, { mode: 0o600 });
  const prompts = [];
  const herdr = { async request(method, params) {
    if (method === "agent.get") {
      const root = params.target === ROOT.target ? ROOT : rootB;
      return { type: "agent_info", agent: { agent: "pi", name: root.target, pane_id: root.pane_id, workspace_id: root.workspace_id, agent_status: "idle" } };
    }
    if (method === "agent.prompt") { prompts.push(params.target); return {}; }
    throw new Error(`Unexpected ${method}`);
  } };
  try {
    await handleHook({ eventName: "pane.agent_status_changed", eventJson: statusEvent("done"), stateDir: fixture.stateDir, herdr });
    assert.deepEqual(prompts, [ROOT.target], "a child event never wakes another root");
    await handleHook({ eventName: "pane.agent_status_changed", eventJson: { event: "pane_agent_status_changed", data: { type: "pane_agent_status_changed", pane_id: rootB.pane_id, workspace_id: rootB.workspace_id, agent_status: "working" } }, stateDir: fixture.stateDir, herdr });
    assert.equal((await fixture.manifest()).parentGoal.supervisor.rootActivity, undefined, "root B activity never mutates record A");
    const second = JSON.parse(await readFile(secondManifestPath, "utf8"));
    assert.equal(second.parentGoal.supervisor.rootActivity.status, "working");
  } finally { await fixture.cleanup(); }
});

test("socket validation accepts POSIX sockets and Windows named pipes", () => {
  const posix = new JsonLineHerdrClient("/tmp/herdr-controller.sock");
  const windowsPipe = "\\\\.\\pipe\\herdr-controller";
  const windows = new JsonLineHerdrClient(windowsPipe);
  assert.equal(posix.socketPath, "/tmp/herdr-controller.sock");
  assert.equal(windows.socketPath, windowsPipe);
  assert.throws(
    () => new JsonLineHerdrClient("relative.sock"),
    /absolute POSIX socket path or Windows named pipe/,
  );
});

test("malformed events fail closed, unrelated events are ignored, and ambiguity is rejected", async () => {
  const fixture = await createFixture();
  const mock = await startHerdrMock(() => {
    throw new Error("a rejected event must not reach Herdr");
  });
  try {
    await assert.rejects(
      handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: {
          event: "pane_agent_status_changed",
          data: { type: "pane_agent_status_changed" },
        },
        stateDir: fixture.stateDir,
        herdr: client(mock),
      }),
      ControllerError,
    );
    await assert.rejects(
      handleHook({
        eventName: "pane.output_changed",
        eventJson: outputEvent(),
        stateDir: fixture.stateDir,
        herdr: client(mock),
      }),
      /Unsupported plugin event hook/,
    );
    const ignored = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: {
        ...statusEvent("done"),
        data: { ...statusEvent("done").data, pane_id: "w-unmapped:p1" },
      },
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.deepEqual(ignored, {
      accepted: true,
      ignored: true,
      reason: "unmapped_event",
    });

    const configPath = join(fixture.stateDir, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.workflows.push({
      ...config.workflows[0],
      workflow_id: "herdr-bb030",
    });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    await assert.rejects(
      handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: statusEvent("done"),
        stateDir: fixture.stateDir,
        herdr: client(mock),
      }),
      /matches multiple explicit owner\/workflow\/child-lane mappings/,
    );
    assert.equal(mock.requests.length, 0);
    const manifest = await fixture.manifest();
    assert.equal(manifest.workflows[0].eventController, undefined);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("missing config is an inert hook while malformed config still fails closed", async () => {
  const fixture = await createFixture();
  let requests = 0;
  const herdr = {
    async request() {
      requests += 1;
      throw new Error("a config-only hook must not call Herdr");
    },
  };
  try {
    await rm(join(fixture.stateDir, "config.json"));
    const ignored = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("done"),
      stateDir: fixture.stateDir,
      herdr,
    });
    assert.deepEqual(ignored, {
      accepted: true,
      ignored: true,
      reason: "missing_config",
    });
    assert.equal(requests, 0);
    assert.equal(
      (await fixture.manifest()).workflows[0].eventController,
      undefined,
      "a missing config must not mutate a workflow manifest",
    );

    await writeFile(join(fixture.stateDir, "config.json"), "{invalid\n", {
      mode: 0o600,
    });
    await assert.rejects(
      handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: statusEvent("done"),
        stateDir: fixture.stateDir,
        herdr,
      }),
      /Controller config is not valid JSON/,
    );
    assert.equal(requests, 0, "malformed config must fail before a Herdr call");
  } finally {
    await fixture.cleanup();
  }
});

test("protocol-22 named Pi root accepts agent kind events while serializing duplicates", async () => {
  const fixture = await createFixture();
  let promptCount = 0;
  const mock = await startHerdrMock(async (request) => {
    if (request.method === "agent.get") {
      assert.equal(request.params.target, "bb029-root");
      return rootAgentInfo();
    }
    if (request.method === "agent.prompt") {
      promptCount += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
      return {
        result: { type: "agent_prompted", agent: { name: ROOT.target } },
      };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const [first, second] = await Promise.all([
      handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: statusEvent("done"),
        stateDir: fixture.stateDir,
        herdr: client(mock),
      }),
      handleHook({
        eventName: "pane.agent_status_changed",
        eventJson: statusEvent("done"),
        stateDir: fixture.stateDir,
        herdr: client(mock),
      }),
    ]);
    assert.equal(first.accepted, true);
    assert.equal(second.accepted, true);
    assert.deepEqual([first.deduplicated, second.deduplicated].sort(), [
      false,
      true,
    ]);
    assert.equal(promptCount, 1);
    const prompts = requestsFor(mock, "agent.prompt");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].params.target, ROOT.target);
    assert.equal(
      Object.hasOwn(prompts[0].params, "wait"),
      false,
      "root wake never uses a foreground wait",
    );
    assert.notEqual(
      prompts[0].params.target,
      CHILD.target,
      "a child is never prompted",
    );
    const manifest = await fixture.manifest();
    const events = manifest.workflows[0].eventController.events;
    assert.equal(events.length, 1);
    assert.equal(events[0].classification, "done");
    assert.equal(events[0].wake.status, "delivered");
    assert.equal(events[0].wake.attempts, 1);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("a new actionable lane event advances the thin parent goal once", async () => {
  const fixture = await createFixture({
    parentGoal: {
      version: 1,
      id: "parent-bb029",
      objective: "Complete BB-029 safely.",
      status: "waiting-for-event",
      nextAction: "Wait for a durable controller event.",
      signals: [],
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.get") return rootAgentInfo();
    if (request.method === "agent.prompt") return { result: {} };
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    await handleHook({ eventName: "pane.agent_status_changed", eventJson: statusEvent("done"), stateDir: fixture.stateDir, herdr: client(mock) });
    await handleHook({ eventName: "pane.agent_status_changed", eventJson: statusEvent("done"), stateDir: fixture.stateDir, herdr: client(mock) });
    const goal = (await fixture.manifest()).parentGoal;
    assert.equal(goal.status, "action-required");
    assert.equal(goal.signals.length, 1, "duplicate hooks do not duplicate goal signals");
    assert.equal(goal.signals[0].classification, "done");
    assert.match(goal.nextAction, /Review durable done event/);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("the Herdr-owned supervisor nudges only a due running parent goal and records delivery", async () => {
  const fixture = await createFixture({
    parentGoal: {
      version: 1,
      id: "parent-bb029",
      objective: "Complete BB-029 safely.",
      status: "active",
      nextAction: "Review the next dependency-ready lane.",
      signals: [],
      supervisor: {
        version: 1,
        state: "running",
        intervalSeconds: 15,
        nudgeCount: 0,
        nextNudgeAt: "2026-09-14T00:00:00.000Z",
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      },
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.get") return rootAgentInfo();
    if (request.method === "agent.prompt") {
      assert.equal(Object.hasOwn(request.params, "wait"), false);
      assert.match(request.params.text, /Parent goal parent-bb029 remains active/);
      assert.match(request.params.text, /Continue the active goal autonomously through as many safe local actions as needed/);
      assert.doesNotMatch(request.params.text, /take at most one allowed parent action/);
      return { result: { type: "agent_prompted" } };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const first = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:00:00.000Z",
    });
    assert.deepEqual(first.results, [
      { manifestPath: fixture.manifestPath, status: "delivered" },
    ]);
    const goal = (await fixture.manifest()).parentGoal;
    assert.equal(goal.supervisor.nudgeCount, 1);
    assert.equal(goal.supervisor.lastDelivery.status, "delivered");
    assert.equal(goal.supervisor.nextNudgeAt, "2026-09-14T00:00:15.000Z");
    const second = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:00:01.000Z",
    });
    assert.equal(second.results[0].status, "not-due");
    assert.equal(requestsFor(mock, "agent.prompt").length, 1);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("the supervisor records root activity and defers a due nudge until the root is idle", async () => {
  const fixture = await createFixture({
    parentGoal: {
      version: 1,
      id: "parent-bb029",
      objective: "Complete BB-029 safely.",
      status: "active",
      nextAction: "Review the next dependency-ready lane.",
      signals: [],
      supervisor: {
        version: 1,
        state: "running",
        intervalSeconds: 5,
        nudgeCount: 0,
        nextNudgeAt: "2026-09-14T00:00:00.000Z",
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      },
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  let rootStatus = "working";
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.get") {
      const info = rootAgentInfo();
      info.result.agent.agent_status = rootStatus;
      return info;
    }
    if (request.method === "agent.prompt")
      return { result: { type: "agent_prompted" } };
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const deferred = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:00:00.000Z",
    });
    assert.equal(deferred.results[0].status, "root-not-idle");
    let goal = (await fixture.manifest()).parentGoal;
    assert.deepEqual(goal.supervisor.rootActivity, {
      status: "working",
      observedAt: "2026-09-14T00:00:00.000Z",
    });
    assert.equal(goal.supervisor.nextNudgeAt, "2026-09-14T00:00:05.000Z");
    assert.equal(requestsFor(mock, "agent.prompt").length, 0);

    const rootActivity = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: rootStatusEvent("idle"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(rootActivity.rootActivity[0].status, "recorded");
    assert.deepEqual(hookResponse(rootActivity), {
      accepted: true,
      rootActivity: rootActivity.rootActivity,
    }, "a root-activity hook response never reads a lane record identity");
    goal = (await fixture.manifest()).parentGoal;
    assert.equal(goal.supervisor.rootActivity.status, "idle");

    rootStatus = "idle";
    const delivered = await runSupervisorTick({
      stateDir: fixture.stateDir,
      herdr: client(mock),
      timestamp: "2026-09-14T00:00:05.000Z",
    });
    assert.equal(delivered.results[0].status, "delivered");
    assert.equal(requestsFor(mock, "agent.prompt").length, 1);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("the supervisor lease allows only one process loop and releases for restart", async () => {
  const fixture = await createFixture();
  try {
    const first = await runSupervisorLoop({
      stateDir: fixture.stateDir,
      configDir: fixture.stateDir,
    });
    assert.equal(first.started, true);
    const duplicate = await runSupervisorLoop({
      stateDir: fixture.stateDir,
      configDir: fixture.stateDir,
    });
    assert.deepEqual(
      { started: duplicate.started, reason: duplicate.reason },
      { started: false, reason: "supervisor_already_running" },
      "a plugin restart must not create a second supervisor loop",
    );
    await first.stop();
    const restarted = await runSupervisorLoop({
      stateDir: fixture.stateDir,
      configDir: fixture.stateDir,
    });
    assert.equal(restarted.started, true, "a stopped supervisor can restart");
    await restarted.stop();
  } finally {
    await fixture.cleanup();
  }
});

test("separate startup state directories still admit one live supervisor", async () => {
  const fixture = await createFixture();
  const secondStateDir = join(fixture.directory, "state-second");
  await mkdir(secondStateDir, { mode: 0o700 });
  try {
    const first = await runSupervisorLoop({
      stateDir: fixture.stateDir,
      configDir: fixture.stateDir,
    });
    assert.equal(first.started, true);
    const duplicate = await runSupervisorLoop({
      stateDir: secondStateDir,
      configDir: fixture.stateDir,
    });
    assert.deepEqual(
      { started: duplicate.started, reason: duplicate.reason },
      { started: false, reason: "supervisor_already_running" },
      "per-invocation state directories must share the plugin-config lease",
    );
    await first.stop();
    const restarted = await runSupervisorLoop({
      stateDir: secondStateDir,
      configDir: fixture.stateDir,
    });
    assert.equal(restarted.started, true);
    await restarted.stop();
  } finally {
    await fixture.cleanup();
  }
});

test("stopping keeps the supervisor lease through an in-flight tick", async () => {
  const fixture = await createFixture({
    parentGoal: {
      version: 1,
      id: "parent-bb029",
      objective: "Complete BB-029 safely.",
      status: "active",
      nextAction: "Review the next dependency-ready lane.",
      signals: [],
      supervisor: {
        version: 1,
        state: "running",
        intervalSeconds: 15,
        nudgeCount: 0,
        nextNudgeAt: new Date(Date.now() - 1_000).toISOString(),
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      },
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  let allowGet;
  const getStarted = new Promise((resolveGetStarted) => {
    allowGet = resolveGetStarted;
  });
  let releaseGet;
  const getMayFinish = new Promise((resolveGetMayFinish) => {
    releaseGet = resolveGetMayFinish;
  });
  const herdr = {
    async request(method) {
      if (method === "agent.get") {
        allowGet();
        await getMayFinish;
        return rootAgentInfo().result;
      }
      if (method === "agent.prompt") return { type: "agent_prompted" };
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  try {
    const first = await runSupervisorLoop({
      stateDir: fixture.stateDir,
      configDir: fixture.stateDir,
      herdr,
    });
    await getStarted;
    const stopping = first.stop();
    const duplicate = await runSupervisorLoop({
      stateDir: fixture.stateDir,
      configDir: fixture.stateDir,
      herdr,
    });
    assert.equal(duplicate.started, false, "restart cannot overlap an in-flight tick");
    releaseGet();
    await stopping;
    const restarted = await runSupervisorLoop({
      stateDir: fixture.stateDir,
      configDir: fixture.stateDir,
      herdr,
    });
    assert.equal(restarted.started, true, "lease releases only after the tick settles");
    await restarted.stop();
  } finally {
    await fixture.cleanup();
  }
}, { timeout: 25_000 });

test("the supervisor waits one normal interval after startup before nudging restored panes", async () => {
  const fixture = await createFixture({
    parentGoal: {
      version: 1,
      id: "parent-bb029",
      objective: "Complete BB-029 safely.",
      status: "active",
      nextAction: "Review the next dependency-ready lane.",
      signals: [],
      supervisor: {
        version: 1,
        state: "running",
        intervalSeconds: 15,
        nudgeCount: 0,
        nextNudgeAt: "2026-09-14T00:00:00.000Z",
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      },
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
  });
  let calls = 0;
  try {
    const loop = await runSupervisorLoop({
      stateDir: fixture.stateDir,
      configDir: fixture.stateDir,
      herdr: { async request() { calls += 1; throw new Error("must not run at startup"); } },
    });
    assert.equal(loop.started, true);
    assert.equal(calls, 0, "startup grants Herdr one full settle interval");
    await loop.stop();
  } finally {
    await fixture.cleanup();
  }
});

test("the supervisor never overwrites waiting, paused, blocked, or completed parent goals", async () => {
  for (const status of ["waiting-for-event", "paused", "blocked", "completed"]) {
    const fixture = await createFixture({
      parentGoal: {
        version: 1,
        id: "parent-bb029",
        objective: "Complete BB-029 safely.",
        status,
        nextAction: "Wait.",
        signals: [],
        supervisor: {
          version: 1,
          state: status === "paused" ? "paused" : "running",
          intervalSeconds: 15,
          nudgeCount: 0,
          nextNudgeAt: "2026-09-14T00:00:00.000Z",
          ...(status === "paused" ? { pauseReason: "Waiting for Zach." } : {}),
          createdAt: "2026-09-14T00:00:00.000Z",
          updatedAt: "2026-09-14T00:00:00.000Z",
        },
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      },
    });
    try {
      const result = await runSupervisorTick({
        stateDir: fixture.stateDir,
        herdr: { async request() { throw new Error("terminal goals must not wake"); } },
        timestamp: "2026-09-14T00:00:00.000Z",
      });
      assert.equal(result.results[0].status, "not-active");
      const goal = (await fixture.manifest()).parentGoal;
      assert.equal(goal.status, status, "a stale tick must not overwrite parent lifecycle state");
      assert.equal(goal.supervisor.lastDelivery, undefined, "inactive goals are never nudged");
    } finally {
      await fixture.cleanup();
    }
  }
});

test("an unavailable root leaves a durable pending event that an identical hook may deliver later", async () => {
  const fixture = await createFixture();
  let rootAvailable = false;
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.get")
      return rootAvailable
        ? rootAgentInfo()
        : { error: { code: "agent_not_found", message: "root is gone" } };
    if (request.method === "agent.prompt")
      return {
        result: { type: "agent_prompted", agent: { name: ROOT.target } },
      };
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const pending = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("blocked"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(pending.record.wake.status, "pending");
    assert.equal(requestsFor(mock, "agent.prompt").length, 0);
    let manifest = await fixture.manifest();
    let events = manifest.workflows[0].eventController.events;
    assert.equal(events.length, 1);
    assert.equal(events[0].classification, "blocked");
    assert.match(events[0].wake.reason, /root_unavailable/);

    rootAvailable = true;
    const delivered = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("blocked"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(delivered.deduplicated, true);
    assert.equal(delivered.record.wake.status, "delivered");
    assert.equal(requestsFor(mock, "agent.prompt").length, 1);
    manifest = await fixture.manifest();
    events = manifest.workflows[0].eventController.events;
    assert.equal(
      events.length,
      1,
      "a retry updates the existing durable event record",
    );
    assert.equal(events[0].wake.attempts, 2);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("a non-Pi named root receives done and blocked wakes without Pi semantics", async () => {
  const root = {
    target: "codex-review-root",
    target_kind: "name",
    agent_kind: "codex",
    pane_id: "w-codex-root:p1",
    workspace_id: "w-codex-root",
  };
  const child = {
    lane_id: "lane-claude-review",
    target: "claude-review-worker",
    target_kind: "name",
    pane_id: "w-claude-child:p1",
    workspace_id: "w-claude-child",
  };
  const fixture = await createFixture({
    root,
    child,
    piGoalPauseDetection: false,
  });
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.get") {
      assert.equal(request.params.target, root.target);
      return {
        result: {
          type: "agent_info",
          agent: {
            agent: root.agent_kind,
            name: root.target,
            pane_id: root.pane_id,
            workspace_id: root.workspace_id,
            agent_status: "idle",
          },
        },
      };
    }
    if (request.method === "agent.prompt") {
      assert.equal(request.params.target, root.target);
      assert.equal(Object.hasOwn(request.params, "wait"), false);
      return {
        result: { type: "agent_prompted", agent: { name: root.target } },
      };
    }
    throw new Error(`Non-Pi state hooks must not call ${request.method}`);
  });
  const eventFor = (agent_status) => ({
    event: "pane_agent_status_changed",
    data: {
      type: "pane_agent_status_changed",
      pane_id: child.pane_id,
      workspace_id: child.workspace_id,
      agent_status,
      agent: "claude",
    },
  });
  try {
    await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: eventFor("done"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: eventFor("blocked"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    const working = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: eventFor("working"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(working.record.classification, "unclassified");
    assert.equal(working.record.wake.status, "not-required");
    assert.deepEqual(
      requestsFor(mock, "agent.prompt").map((request) => request.params.target),
      [root.target, root.target],
    );
    assert.equal(requestsFor(mock, "agent.read").length, 0);
    const events = (await fixture.manifest()).workflows[0].eventController
      .events;
    assert.deepEqual(
      events.map((event) => event.classification),
      ["done", "blocked", "unclassified"],
    );
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("a documented pane-ID root target is accepted without an agent name", async () => {
  const root = {
    target: "w-pane-root:p1",
    target_kind: "pane_id",
    agent_kind: "pi",
    pane_id: "w-pane-root:p1",
    workspace_id: "w-pane-root",
  };
  const child = {
    lane_id: "lane-pane-child",
    target: "w-pane-child:p1",
    target_kind: "pane_id",
    pane_id: "w-pane-child:p1",
    workspace_id: "w-pane-child",
  };
  const fixture = await createFixture({ root, child });
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.get") {
      assert.equal(request.params.target, root.pane_id);
      return {
        result: {
          type: "agent_info",
          agent: {
            agent: "pi",
            name: null,
            pane_id: root.pane_id,
            workspace_id: root.workspace_id,
            agent_status: "idle",
          },
        },
      };
    }
    if (request.method === "agent.prompt") {
      assert.equal(request.params.target, root.pane_id);
      assert.equal(Object.hasOwn(request.params, "wait"), false);
      return { result: { type: "agent_prompted", agent: { name: null } } };
    }
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const result = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: {
        event: "pane_agent_status_changed",
        data: {
          type: "pane_agent_status_changed",
          pane_id: child.pane_id,
          workspace_id: child.workspace_id,
          agent_status: "done",
          agent: "pi",
        },
      },
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    assert.equal(result.record.wake.status, "delivered");
    assert.equal(result.record.agent_target, child.target);
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});

test("supported working and idle status hooks classify an opt-in paused Pi goal", async () => {
  const fixture = await createFixture();
  const mock = await startHerdrMock((request) => {
    if (request.method === "agent.read") {
      assert.equal(request.params.target, CHILD.target);
      assert.equal(request.params.source, "recent_unwrapped");
      assert.equal(request.params.lines, 120);
      return {
        result: {
          type: "pane_read",
          read: {
            pane_id: CHILD.pane_id,
            text: "pi-goal-bb029 paused after a parent question; do not continue without /goal-resume.",
          },
        },
      };
    }
    if (request.method === "agent.get") return rootAgentInfo();
    if (request.method === "agent.prompt")
      return {
        result: { type: "agent_prompted", agent: { name: ROOT.target } },
      };
    throw new Error(`Unexpected method: ${request.method}`);
  });
  try {
    const working = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("working"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    const idle = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: statusEvent("idle"),
      stateDir: fixture.stateDir,
      herdr: client(mock),
    });
    for (const result of [working, idle]) {
      assert.equal(result.record.classification, "goal-paused");
      assert.deepEqual(result.record.source.goal_ids, ["pi-goal-bb029"]);
      assert.equal(result.record.wake.status, "delivered");
    }
    assert.equal(requestsFor(mock, "agent.read").length, 2);
    assert.deepEqual(
      requestsFor(mock, "agent.prompt").map((request) => request.params.target),
      [ROOT.target, ROOT.target],
    );
  } finally {
    await mock.close();
    await fixture.cleanup();
  }
});
