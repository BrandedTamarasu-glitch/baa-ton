import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateTask } from "../activate-task.mjs";
import { handleActivation } from "../../controller/activation.mjs";
import { acknowledgeActivation } from "../activation-ack.mjs";

test("authorized isolated task migration preserves other mappings and is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-activation-"));
  try {
    const cwd = join(directory, "task"),
      source = join(directory, "source"),
      configDir = join(directory, "config"),
      extensionLink = join(directory, "extension");
    await Promise.all([cwd, source, configDir].map((path) => mkdir(path)));
    await symlink("/old/source", extensionLink);
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
    assert.equal(await readlink(extensionLink), "/old/source");
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
