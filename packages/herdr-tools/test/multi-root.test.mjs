import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { handleHook, validateConfig } from "../../controller/controller.mjs";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

function root(paneId, workspaceId) {
  return {
    target: paneId,
    target_kind: "pane_id",
    pane_id: paneId,
    workspace_id: workspaceId,
    agent_kind: "pi",
  };
}

function lane(laneId, paneId, workspaceId) {
  return {
    lane_id: laneId,
    target: paneId,
    target_kind: "pane_id",
    pane_id: paneId,
    workspace_id: workspaceId,
  };
}

async function fixture({ withLane = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-multi-root-"));
  const cwdA = join(directory, "root-a");
  const cwdB = join(directory, "root-b");
  const configDir = join(directory, "config");
  const manifestA = join(cwdA, ".pi", "herdr-orchestrator", "manifest.json");
  const manifestB = join(cwdB, ".pi", "herdr-orchestrator", "manifest.json");
  const rootA = root("w-a:root", "w-a");
  const laneA = lane("lane-a", "w-a:child", "w-a");
  const workflowA = {
    workflow_id: "workflow-a",
    manifest_path: manifestA,
    lanes: [laneA],
  };
  const orchestratorA = {
    id: "root-a",
    root: rootA,
    program: {
      id: cwdA,
      workspace_id: rootA.workspace_id,
      parent_manifest_path: manifestA,
    },
    workflows: withLane ? [workflowA] : [],
  };
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await mkdir(join(cwdA, ".pi", "herdr-orchestrator"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    join(configDir, "config.json"),
    `${JSON.stringify(
      {
        version: 2,
        owner: "herdr-orchestrator",
        orchestrators: [orchestratorA],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    manifestA,
    `${JSON.stringify(
      withLane
        ? {
            version: 2,
            workflows: [
              {
                id: workflowA.workflow_id,
                ownership: { createdBy: "herdr-orchestrator" },
                lanes: [
                  {
                    id: laneA.lane_id,
                    paneId: laneA.pane_id,
                    agentName: "child-a",
                  },
                ],
              },
            ],
          }
        : { version: 2, workflows: [] },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const keys = [
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_PLUGIN_CONFIG_DIR",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const calls = [];
  const tools = new Map();
  const setIdentity = (paneId, workspaceId) => {
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_PANE_ID: paneId,
      HERDR_WORKSPACE_ID: workspaceId,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
    });
  };
  const register = () => {
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
                  workspace_id: process.env.HERDR_WORKSPACE_ID,
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
                  tab_id: `${process.env.HERDR_WORKSPACE_ID}:tab`,
                  workspace_id: process.env.HERDR_WORKSPACE_ID,
                },
              },
            }),
            stderr: "",
            code: 0,
          };
        if (args[0] === "tab" && args[1] === "rename")
          return {
            stdout: JSON.stringify({ result: { type: "tab_renamed" } }),
            stderr: "",
            code: 0,
          };
        throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
      },
    });
  };
  setIdentity(rootA.pane_id, rootA.workspace_id);
  register();
  return {
    directory,
    cwdA,
    cwdB,
    configDir,
    manifestA,
    manifestB,
    rootA,
    laneA,
    tools,
    calls,
    setIdentity,
    context: (cwd) => ({ cwd, hasUI: false, mode: "json", modelRegistry: {} }),
    async cleanup() {
      for (const [key, value] of Object.entries(saved))
        value === undefined ? delete process.env[key] : (process.env[key] = value);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function configAt(configDir) {
  return JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
}

async function bootstrap(fixtureData, cwd, args = {}) {
  return fixtureData.tools
    .get("herdr_bootstrap_root")
    .execute("bootstrap", args, undefined, undefined, fixtureData.context(cwd));
}

test("add appends a concurrent root and preserves existing config and manifests", async () => {
  const f = await fixture({ withLane: true });
  try {
    f.setIdentity("w-b:root", "w-b");
    const before = await configAt(f.configDir);
    const result = await bootstrap(f, f.cwdB, { add: true });
    assert.equal(result.details.add, true);
    assert.equal(result.details.alreadyRegistered, false);

    const after = await configAt(f.configDir);
    assert.equal(after.orchestrators.length, 2);
    assert.deepEqual(after.orchestrators[0], before.orchestrators[0]);
    assert.deepEqual(after.orchestrators[1], {
      id: `orchestrator:w-b:w-b:root:${f.cwdB}`,
      root: root("w-b:root", "w-b"),
      program: {
        id: f.cwdB,
        workspace_id: "w-b",
        parent_manifest_path: f.manifestB,
      },
      workflows: [],
    });
    assert.equal(result.details.manifestReset, false);
    assert.deepEqual(JSON.parse(await readFile(f.manifestA, "utf8")), {
      version: 2,
      workflows: [
        {
          id: "workflow-a",
          ownership: { createdBy: "herdr-orchestrator" },
          lanes: [
            { id: "lane-a", paneId: "w-a:child", agentName: "child-a" },
          ],
        },
      ],
    });
    assert.deepEqual(JSON.parse(await readFile(f.manifestB, "utf8")), {
      version: 2,
      workflows: [],
    });
    assert.equal(
      f.calls.some(
        (args) =>
          args[0] === "tab" &&
          args[1] === "rename" &&
          args[3] === "🐕 pi·w-b",
      ),
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test("add on the same pane and checkout is idempotent", async () => {
  const f = await fixture();
  try {
    f.setIdentity("w-b:root", "w-b");
    await bootstrap(f, f.cwdB, { add: true });
    const before = await configAt(f.configDir);
    const result = await bootstrap(f, f.cwdB, { add: true });
    assert.equal(result.details.alreadyRegistered, true);
    assert.deepEqual(await configAt(f.configDir), before);
  } finally {
    await f.cleanup();
  }
});

test("add refuses a registered child pane", async () => {
  const f = await fixture({ withLane: true });
  try {
    f.setIdentity(f.laneA.pane_id, f.laneA.workspace_id);
    await assert.rejects(
      bootstrap(f, f.cwdB, { add: true }),
      /already a registered child lane.*cannot claim root authority/i,
    );
  } finally {
    await f.cleanup();
  }
});

test("add refuses to replace a different checkout on the same pane", async () => {
  const f = await fixture();
  try {
    f.setIdentity(f.rootA.pane_id, f.rootA.workspace_id);
    await assert.rejects(
      bootstrap(f, f.cwdB, { add: true }),
      new RegExp(
        `already registered.*orchestrator root-a.*cwd ${f.cwdA}.*requires reset=true`,
        "i",
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("add requires both a distinct pane and a distinct workspace", async () => {
  const f = await fixture();
  try {
    f.setIdentity("w-a:other-root", "w-a");
    await assert.rejects(
      bootstrap(f, f.cwdB, { add: true }),
      /requires both a distinct pane and a distinct workspace/i,
    );
  } finally {
    await f.cleanup();
  }
});

test("the legacy no-add path still requires reset to replace existing state", async () => {
  const f = await fixture();
  try {
    f.setIdentity("w-b:root", "w-b");
    await assert.rejects(
      bootstrap(f, f.cwdB),
      /Controller config or parent manifest has existing state.*reset=true/i,
    );
    const result = await bootstrap(f, f.cwdB, { reset: true });
    assert.equal(result.details.reset, true);
    const after = await configAt(f.configDir);
    assert.equal(after.orchestrators.length, 1);
    assert.equal(after.orchestrators[0].root.pane_id, "w-b:root");
    assert.deepEqual(JSON.parse(await readFile(f.manifestB, "utf8")), {
      version: 2,
      workflows: [],
    });
  } finally {
    await f.cleanup();
  }
});

test("controller routes colliding workflow IDs by child pane to separate manifests", async () => {
  const f = await fixture();
  try {
    const manifestB = f.manifestB;
    const rootB = root("w-b:root", "w-b");
    const laneB = lane("lane-b", "w-b:child", "w-b");
    const sharedWorkflow = (manifestPath, mappedLane) => ({
      workflow_id: "workflow-shared",
      manifest_path: manifestPath,
      lanes: [mappedLane],
    });
    const config = {
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [
        {
          id: "root-a",
          root: f.rootA,
          program: { id: f.cwdA, workspace_id: f.rootA.workspace_id },
          workflows: [sharedWorkflow(f.manifestA, f.laneA)],
        },
        {
          id: "root-b",
          root: rootB,
          program: { id: f.cwdB, workspace_id: rootB.workspace_id },
          workflows: [sharedWorkflow(manifestB, laneB)],
        },
      ],
    };
    assert.equal(validateConfig(config).orchestrators.length, 2);
    await mkdir(join(f.cwdB, ".pi", "herdr-orchestrator"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      manifestB,
      `${JSON.stringify(
        {
          version: 2,
          workflows: [
            {
              id: "workflow-shared",
              ownership: { createdBy: "herdr-orchestrator" },
              lanes: [
                { id: "lane-b", paneId: "w-b:child", agentName: "child-b" },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(f.configDir, "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      { mode: 0o600 },
    );
    const prompts = [];
    const herdr = {
      async request(method, params) {
        if (method === "agent.get")
          return {
            type: "agent_info",
            agent: {
              agent: "pi",
              name: "root-b",
              pane_id: rootB.pane_id,
              workspace_id: rootB.workspace_id,
            },
          };
        if (method === "agent.prompt") {
          prompts.push(params.target);
          return {};
        }
        throw new Error(`Unexpected controller request ${method}`);
      },
    };
    const result = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: {
        event: "pane_agent_status_changed",
        data: {
          type: "pane_agent_status_changed",
          pane_id: laneB.pane_id,
          workspace_id: laneB.workspace_id,
          agent_status: "done",
        },
      },
      stateDir: f.configDir,
      configDir: f.configDir,
      herdr,
    });
    assert.equal(result.record.workflow_id, "workflow-shared");
    assert.deepEqual(prompts, [rootB.pane_id]);
    const afterA = JSON.parse(await readFile(f.manifestA, "utf8"));
    const afterB = JSON.parse(await readFile(manifestB, "utf8"));
    assert.deepEqual(afterA.workflows, []);
    assert.equal(afterB.workflows[0].eventController.events.length, 1);
  } finally {
    await f.cleanup();
  }
});
