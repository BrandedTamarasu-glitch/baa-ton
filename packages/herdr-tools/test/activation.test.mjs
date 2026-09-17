import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  realpath,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { activateTask } from "../activate-task.mjs";
import { handleActivation } from "../../controller/activation.mjs";
import { acknowledgeActivation } from "../activation-ack.mjs";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

test("authorized isolated task migration preserves other mappings and is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-activation-"));
  try {
    const cwd = join(directory, "task"),
      source = join(directory, "source"),
      configDir = join(directory, "config"),
      extensionLink = join(directory, "extension");
    const oldExtensionTarget =
      process.platform === "win32" ? "C:\\old\\source" : "/old/source";
    await Promise.all([cwd, source, configDir].map((path) => mkdir(path)));
    await symlink(oldExtensionTarget, extensionLink);
    const child = {
      lane_id: "lane",
      target: "w17:p1",
      target_kind: "pane_id",
      pane_id: "w17:p1",
      workspace_id: "w17",
    };
    const oldWorkflow = {
      workflow_id: "old",
      manifest_path: join(directory, "old-manifest.json"),
      pi_goal_pause_detection: false,
      lanes: [child],
    };
    const untouched = {
      ...oldWorkflow,
      workflow_id: "untouched",
      lanes: [
        { ...child, target: "w16:p1", pane_id: "w16:p1", workspace_id: "w16" },
      ],
    };
    const config = {
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [
        {
          id: "old-root",
          root: {
            target: "w12:p1",
            target_kind: "pane_id",
            pane_id: "w12:p1",
            workspace_id: "w12",
            agent_kind: "pi",
          },
          program: { id: "/old/task", workspace_id: "w12" },
          workflows: [oldWorkflow, untouched],
        },
      ],
    };
    await writeFile(join(configDir, "config.json"), JSON.stringify(config), {
      mode: 0o600,
    });
    const options = {
      cwd,
      source,
      configDir,
      extensionLink,
      expectedSessionPath: "/sessions/astra",
      pane: {
        agent: "pi",
        pane_id: "w17:p1",
        workspace_id: "w17",
        agent_session: { kind: "path", value: "/sessions/astra" },
      },
    };
    assert.equal((await activateTask(options)).dryRun, true);
    assert.equal(await readlink(extensionLink), oldExtensionTarget);
    const result = await activateTask({ ...options, execute: true });
    assert.equal(result.activated, true);
    const after = JSON.parse(
      await readFile(join(configDir, "config.json"), "utf8"),
    );
    assert.deepEqual(after.orchestrators[0].workflows, [untouched]);
    assert.equal(after.orchestrators[1].root.pane_id, "w17:p1");
    assert.deepEqual(result.plan.retiredMappings[0].workflow, oldWorkflow);
    assert.equal(
      (await activateTask({ ...options, execute: true })).alreadyActivated,
      true,
    );
    await assert.rejects(
      activateTask({
        ...options,
        expectedSessionPath: "/wrong",
        execute: true,
      }),
      /native session/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const lostResponse of [false, true])
  test(`native idle activation is one-shot and identity-fenced (lost response: ${lostResponse})`, async () => {
    const configDir = await mkdtemp(join(tmpdir(), "baa-reload-"));
    try {
      const identity = {
        paneId: "w17:p1",
        workspaceId: "w17",
        sessionPath: "/sessions/astra",
        source: "/source/index.ts",
      };
      const journal = {
        version: 1,
        id: "activation",
        operation: "reload-pi-runtime",
        status: "pending",
        ...identity,
      };
      await writeFile(
        join(configDir, "activation.json"),
        JSON.stringify(journal),
        { mode: 0o600 },
      );
      const agent = {
        agent: "pi",
        pane_id: identity.paneId,
        workspace_id: identity.workspaceId,
        agent_status: "working",
        agent_session: { kind: "path", value: identity.sessionPath },
      };
      const event = { data: { ...agent, agent_status: "idle" } };
      let prompts = 0;
      const api = {
        request: async (method, params) => {
          if (method === "agent.get") return { agent };
          assert.equal(method, "agent.prompt");
          assert.equal(params.text, "/reload");
          prompts++;
          if (lostResponse) throw new Error("response lost");
          return {};
        },
      };
      await handleActivation(configDir, event, api);
      assert.equal(prompts, 0);
      agent.agent_status = "idle";
      agent.agent_session.value = "/replacement";
      await handleActivation(configDir, event, api);
      assert.equal(prompts, 0);
      agent.agent_session.value = identity.sessionPath;
      await Promise.all([
        handleActivation(configDir, event, api),
        handleActivation(configDir, event, api),
      ]);
      await handleActivation(configDir, event, api);
      assert.equal(prompts, 1);
      assert.equal(
        await acknowledgeActivation(
          configDir,
          { ...identity, source: "/wrong" },
          async () => agent,
        ),
        undefined,
      );
      assert.equal(
        (await acknowledgeActivation(configDir, identity, async () => agent))
          .id,
        "activation",
      );
      assert.equal(
        await acknowledgeActivation(configDir, identity, async () => agent),
        undefined,
      );
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

test("a pending reload activation is acknowledged on agent_start, since session_start never fires on /reload", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "baa-reload-ack-"));
  const saved = Object.fromEntries(
    [
      "HERDR_ENV",
      "HERDR_PANE_ID",
      "HERDR_WORKSPACE_ID",
      "HERDR_PLUGIN_CONFIG_DIR",
    ].map((key) => [key, process.env[key]]),
  );
  try {
    const source = await realpath(
      fileURLToPath(new URL("../index.ts", import.meta.url)),
    );
    const identity = {
      paneId: "w1:p1",
      workspaceId: "w1",
      sessionPath: "/sessions/astra",
      source,
    };
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({
        version: 2,
        owner: "herdr-orchestrator",
        orchestrators: [
          {
            id: "root-1",
            root: {
              target: "root-name",
              target_kind: "name",
              pane_id: identity.paneId,
              workspace_id: identity.workspaceId,
              agent_kind: "pi",
            },
            program: { id: "/prog", workspace_id: identity.workspaceId },
            workflows: [],
          },
        ],
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(configDir, "activation.json"),
      JSON.stringify({
        version: 1,
        id: "reload-ack-test",
        operation: "reload-pi-runtime",
        status: "sending",
        ...identity,
      }),
      { mode: 0o600 },
    );
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_PANE_ID: identity.paneId,
      HERDR_WORKSPACE_ID: identity.workspaceId,
      HERDR_PLUGIN_CONFIG_DIR: configDir,
    });
    const handlers = new Map();
    const messages = [];
    extension({
      on: (event, handler) => handlers.set(event, handler),
      registerTool() {},
      registerCommand() {},
      sendMessage: (message) => messages.push(message),
      getActiveTools: () => [],
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
                  pane_id: identity.paneId,
                  workspace_id: identity.workspaceId,
                  agent_status: "idle",
                  agent_session: { kind: "path", value: identity.sessionPath },
                },
              },
            }),
          };
        throw new Error(`unexpected herdr ${args.join(" ")}`);
      },
    });
    const ctx = {
      cwd: join(configDir, "unmapped-cwd"),
      hasUI: false,
      sessionManager: { getSessionFile: () => identity.sessionPath },
    };
    // The reload path: no session_start fires at all, only the agent_start
    // that begins the first turn after the reloaded runtime comes back up.
    await handlers.get("agent_start")({}, ctx);
    const journal = JSON.parse(
      await readFile(join(configDir, "activation.json"), "utf8"),
    );
    assert.equal(journal.status, "acknowledged");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].customType, "herdr-runtime-activated");
    // Idempotent: a later agent_start (the next ordinary turn) must not
    // re-acknowledge or resend the activation message.
    await handlers.get("agent_start")({}, ctx);
    assert.equal(messages.length, 1);
  } finally {
    for (const [key, value] of Object.entries(saved))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
    await rm(configDir, { recursive: true, force: true });
  }
});
