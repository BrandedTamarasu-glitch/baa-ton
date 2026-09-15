import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import net from "node:net";
const snapshot = process.argv[2];
const require = createRequire(join(snapshot, "package.json"));
const jiti = require("jiti")(join(snapshot, "package.json"), {
  alias: { typebox: require.resolve("typebox") },
});
const extension = await jiti.import(
  join(snapshot, "packages/herdr-tools/index.ts"),
);
const { runSupervisorTick, handleHook, JsonLineHerdrClient } = await import(
  join(snapshot, "packages/controller/controller.mjs")
);
const directory = await mkdtemp(join(tmpdir(), "baa-audit-fixture-"));
const parent = join(directory, "parent"),
  child = join(directory, "child"),
  configDir = join(directory, "config");
const manifestPath = join(parent, ".pi/herdr-orchestrator/manifest.json");
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
  relationshipId: "rel-audit",
  agentKind: "pi",
  status: "running",
};
const mapping = {
  workflow_id: "audit-workflow",
  manifest_path: manifestPath,
  pi_goal_pause_detection: false,
  lanes: [
    {
      lane_id: lane.id,
      target: lane.agentName,
      target_kind: "name",
      pane_id: lane.paneId,
      workspace_id: "w-child",
      relationship_id: lane.relationshipId,
    },
  ],
};
const time = "2026-09-15T00:00:00.000Z";
const goal = {
  version: 1,
  id: "audit-goal",
  objective: "Audit",
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
      id: "audit-workflow",
      cwd: child,
      ownership: { createdBy: "herdr-orchestrator", workspaceId: "w-child" },
      lanes: [lane],
      evidence: [],
      status: "running",
      outcome: "running",
    },
  ],
};
for (const path of [
  parent,
  child,
  configDir,
  join(parent, ".pi/herdr-orchestrator"),
])
  await mkdir(path, { recursive: true });
await writeFile(manifestPath, JSON.stringify(manifest));
await writeFile(
  join(configDir, "config.json"),
  JSON.stringify({
    version: 2,
    owner: "herdr-orchestrator",
    orchestrators: [
      {
        id: "audit",
        root,
        program: {
          id: parent,
          workspace_id: root.workspace_id,
          parent_manifest_path: manifestPath,
        },
        workflows: [mapping],
      },
    ],
  }),
  { mode: 0o600 },
);
Object.assign(process.env, {
  HERDR_ENV: "1",
  HERDR_PANE_ID: lane.paneId,
  HERDR_WORKSPACE_ID: "w-child",
  HERDR_PLUGIN_CONFIG_DIR: configDir,
});
const tools = new Map();
let prompts = 0,
  gate;
const identity = (name, pane, workspace) => ({
  result: {
    type: "agent_info",
    agent: {
      name,
      agent: "pi",
      pane_id: pane,
      workspace_id: workspace,
      agent_status: "idle",
    },
  },
});
extension.default({
  on() {},
  registerTool(d) {
    tools.set(d.name, d);
  },
  registerCommand() {},
  async exec(_command, args) {
    if (args[0] === "plugin") return { stdout: configDir, stderr: "", code: 0 };
    if (args[0] === "agent" && args[1] === "get") {
      if (args[2] === lane.paneId && gate) {
        const g = gate;
        gate = undefined;
        g.started();
        await g.wait;
      }
      return {
        stdout: JSON.stringify(
          args[2] === lane.paneId
            ? identity("child", lane.paneId, "w-child")
            : identity("root", root.pane_id, root.workspace_id),
        ),
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "agent" && args[1] === "prompt") {
      prompts++;
      return { stdout: "{}", stderr: "", code: 0 };
    }
    throw new Error("unexpected " + args.join(" "));
  },
});
const ctx = { cwd: parent, hasUI: false, mode: "json" };
const call = (name, args, context = ctx) =>
  tools.get(name).execute("audit", args, undefined, undefined, context);
const observations = [];
try {
  await assert.rejects(
    call(
      "herdr_complete",
      { workflowId: "audit-workflow", summary: "done" },
      { ...ctx, cwd: child },
    ),
    /Unknown Herdr workflow/,
  );
  observations.push({
    probe: "different-cwd completion",
    result:
      "reproduced: mapped child cannot find authoritative parent manifest",
  });
  await call("herdr_complete", {
    workflowId: "audit-workflow",
    summary: "done",
  });
  await call("herdr_complete", {
    workflowId: "audit-workflow",
    summary: "done",
  });
  assert.equal(prompts, 2);
  observations.push({
    probe: "completion retry idempotency",
    result: "reproduced: two identical calls send two parent prompts",
  });
  await writeFile(manifestPath, JSON.stringify(manifest));
  let release, started;
  const reached = new Promise((r) => (started = r));
  gate = { started, wait: new Promise((r) => (release = r)) };
  const inFlight = call("herdr_complete", {
    workflowId: "audit-workflow",
    summary: "done",
  });
  await reached;
  process.env.HERDR_PANE_ID = root.pane_id;
  process.env.HERDR_WORKSPACE_ID = root.workspace_id;
  await call("herdr_goal", {
    action: "pause",
    pauseReason: "User paused during child completion",
  });
  assert.equal(
    JSON.parse(await readFile(manifestPath, "utf8")).parentGoal.status,
    "paused",
  );
  release();
  await inFlight;
  assert.equal(
    JSON.parse(await readFile(manifestPath, "utf8")).parentGoal.status,
    "active",
  );
  observations.push({
    probe: "concurrent durable state",
    result:
      "reproduced: unlocked child completion overwrites a newer persisted parent pause with stale active state",
  });

  await writeFile(manifestPath, JSON.stringify(manifest));
  const processMcp = spawn(
    process.execPath,
    [join(snapshot, "packages/herdr-tools/mcp-server.mjs")],
    { cwd: parent, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  processMcp.stderr.on("data", (b) => (stderr += b));
  const lines = createInterface({ input: processMcp.stdout });
  let nextId = 0;
  const requests = new Map();
  lines.on("line", (l) => {
    const m = JSON.parse(l);
    requests.get(m.id)?.(m);
    requests.delete(m.id);
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      requests.set(id, resolve);
      processMcp.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  const timeout = setTimeout(() => processMcp.kill(), 15000);
  try {
    const list = await rpc("tools/list");
    observations.push({
      probe: "MCP tool surface",
      tools: list.result.tools.map((x) => x.name),
    });
    const invalid = await rpc("tools/call", {
      name: "herdr_goal",
      arguments: { action: "not-a-schema-action" },
    });
    assert.notEqual(invalid.result.isError, true);
    observations.push({
      probe: "MCP schema validation",
      result: "reproduced: invalid action outside advertised enum succeeds",
    });
    await rpc("tools/call", {
      name: "herdr_goal",
      arguments: { action: "start" },
    });
    const current = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(current.parentGoal.supervisor.rootTurn.state, "active");
    const tick = await runSupervisorTick({
      stateDir: configDir,
      timestamp: "2026-12-15T00:00:00.000Z",
      herdr: {
        async request() {
          throw new Error("must not probe without trusted idle");
        },
      },
    });
    assert.equal(tick.results[0].status, "root-turn-not-idle");
    observations.push({
      probe: "MCP lifecycle parity",
      result:
        "reproduced: MCP goal write leaves active rootTurn; bridge discards all lifecycle callbacks, so no settled transition is possible",
    });
  } finally {
    clearTimeout(timeout);
    processMcp.stdin.end();
    await once(processMcp, "close");
    lines.close();
  }
  if (stderr) observations.push({ stderr });

  await writeFile(manifestPath, JSON.stringify(manifest));
  let eventPrompts = 0;
  const eventsApi = {
    async request(method) {
      if (method === "agent.get")
        return identity("root", root.pane_id, root.workspace_id).result;
      if (method === "agent.prompt") eventPrompts++;
      return {};
    },
  };
  const event = (status, pane = lane.paneId, workspace = "w-child") => ({
    event: "pane_agent_status_changed",
    data: {
      type: "pane_agent_status_changed",
      pane_id: pane,
      workspace_id: workspace,
      agent: "pi",
      agent_status: status,
    },
  });
  const hook = (e, api = eventsApi) =>
    handleHook({
      stateDir: configDir,
      eventName: "pane.agent_status_changed",
      eventJson: e,
      herdr: api,
    });
  await hook(event("blocked"));
  await hook(event("working"));
  const secondBlock = await hook(event("blocked"));
  assert.equal(eventPrompts, 1);
  assert.equal(secondBlock.deduplicated, true);
  observations.push({
    probe: "lifecycle dedupe identity",
    result:
      "reproduced: blocked -> working -> blocked produces only one wake; later genuine blocker collapses into the first occurrence",
  });
  await writeFile(manifestPath, JSON.stringify(manifest));
  eventPrompts = 0;
  const missingApi = {
    async request() {
      return { type: "agent_info", agent: { pane_id: "wrong" } };
    },
  };
  const pending = await hook(event("blocked"), missingApi);
  assert.equal(pending.record.wake.status, "pending");
  await hook(event("idle", root.pane_id, root.workspace_id));
  await runSupervisorTick({
    stateDir: configDir,
    herdr: eventsApi,
    timestamp: "2026-12-15T00:00:00.000Z",
  });
  assert.equal(eventPrompts, 0);
  observations.push({
    probe: "pending event recovery",
    result:
      "reproduced: root becomes idle again but pending child wake stays undelivered; supervisor ignores the action-required goal",
  });

  const idleManifest = structuredClone(manifest);
  idleManifest.parentGoal.supervisor.rootTurn = {
    state: "idle",
    runId: "audit-run",
    paneId: root.pane_id,
    workspaceId: root.workspace_id,
    updatedAt: time,
  };
  await writeFile(manifestPath, JSON.stringify(idleManifest));
  let timedOutPrompts = 0;
  const socketPath = join(directory, "api.sock");
  const server = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]);
      if (request.method === "agent.prompt") {
        timedOutPrompts++;
        return;
      }
      socket.end(
        JSON.stringify({
          id: request.id,
          result: identity("root", root.pane_id, root.workspace_id).result,
        }) + "\n",
      );
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
    const api = new JsonLineHerdrClient(socketPath, 50);
    const firstTimeout = await runSupervisorTick({
      stateDir: configDir,
      herdr: api,
      timestamp: time,
    });
    const secondTimeout = await runSupervisorTick({
      stateDir: configDir,
      herdr: api,
      timestamp: "2026-09-15T00:00:05.000Z",
    });
    assert.equal(firstTimeout.results[0].status, "pending");
    assert.equal(secondTimeout.results[0].status, "pending");
    assert.equal(timedOutPrompts, 2);
    observations.push({
      probe: "ambiguous socket delivery",
      result:
        "reproduced: server receives prompt but response times out; controller labels pending and sends it again at next tick",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(JSON.stringify(observations, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
