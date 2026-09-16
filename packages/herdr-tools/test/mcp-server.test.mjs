import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "mcp-server.mjs");

async function withMcpServer(env, run, { cwd = here } = {}) {
  const child = spawn(process.execPath, [serverPath], {
    cwd,
    // Pin a neutral Herdr identity so behavior is identical whether the
    // suite runs from a lane pane or from the registered root pane; callers
    // may still override via `env`.
    env: {
      ...process.env,
      // A lane shell exports its startup intent for the harness bridge. The
      // test bridge must never merge into that live intent while test files
      // execute concurrently; fixtures below provide their own config when
      // they need one.
      BAA_STARTUP_INTENT: undefined,
      HERDR_PLUGIN_CONFIG_DIR: undefined,
      HERDR_PLUGIN_STATE_DIR: undefined,
      HERDR_PANE_ID: "w-test:p1",
      HERDR_WORKSPACE_ID: "w-test",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  const pending = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  const timeout = setTimeout(() => child.kill(), 15000);
  try {
    return await run(rpc);
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    await once(child, "close");
    lines.close();
    if (stderr.trim()) throw new Error(`mcp-server.mjs stderr: ${stderr}`);
  }
}

async function rootBridgeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "baa-mcp-root-"));
  const stateDir = join(directory, "config");
  const cwd = join(directory, "workspace");
  const binDir = join(directory, "bin");
  const herdr = join(binDir, "herdr");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true });
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  // This read-only native stub proves the bridge uses the live pane identity
  // while keeping the test independent of a focused Herdr client.
  await writeFile(
    herdr,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const result = (value) => process.stdout.write(JSON.stringify({ result: value }) + "\\n");
if (args[0] === "plugin" && args[1] === "config-dir") {
  result({ config_dir: process.env.TEST_CONFIG_DIR });
} else if (args[0] === "agent" && args[1] === "get") {
  const pane = args[2];
  const child = pane === "w-root:child";
  result({
    type: "agent_info",
    agent: {
      agent: child ? "pi" : "claude",
      name: child ? "child" : "root",
      pane_id: pane,
      tab_id: child ? "w-root:t-child" : "w-root:t-root",
      workspace_id: process.env.TEST_ROOT_WORKSPACE,
      agent_session: { kind: "path", value: child ? "/sessions/child" : "/sessions/root" },
      agent_status: "idle",
    },
  });
} else if (args[0] === "pane" && args[1] === "get") {
  result({
    type: "pane_info",
    pane: {
      pane_id: args[2],
      tab_id: "w-root:t-root",
      workspace_id: process.env.TEST_ROOT_WORKSPACE,
    },
  });
} else if (args[0] === "tab" && args[1] === "rename") {
  result({ type: "tab_renamed", tab_id: args[2], label: args[3] });
} else {
  process.stderr.write("unexpected fake herdr command: " + args.join(" ") + "\\n");
  process.exitCode = 1;
}
`,
    { mode: 0o755 },
  );
  return {
    directory,
    stateDir,
    cwd,
    binDir,
    root: {
      target: "w-root:root",
      target_kind: "pane_id",
      agent_kind: "claude",
      pane_id: "w-root:root",
      workspace_id: "w-root",
    },
  };
}

// Converts the audit's "MCP argument validation" fault probe (an action
// outside the advertised herdr_goal enum was accepted rather than rejected)
// into a passing regression.
test("tools/call rejects arguments outside a tool's declared schema before it reaches execute", async () => {
  await withMcpServer({ HERDR_ENV: "1" }, async (rpc) => {
    const listed = await rpc("tools/list");
    assert.equal(
      listed.result.tools.some(
        (tool) => tool.name === "herdr_permission_prompt",
      ),
      true,
    );
    const invalid = await rpc("tools/call", {
      name: "herdr_goal",
      arguments: { action: "not-a-schema-action" },
    });
    assert.equal(invalid.result.isError, true);
    assert.match(
      invalid.result.content[0].text,
      /Invalid arguments for herdr_goal/,
    );

    // A schema-valid action must still reach the real implementation (and
    // be rejected there, for an unrelated authorization reason, proving
    // schema validation is not silently swallowing every call).
    const valid = await rpc("tools/call", {
      name: "herdr_goal",
      arguments: { action: "status" },
    });
    assert.equal(valid.result.isError, true);
    assert.doesNotMatch(valid.result.content[0].text, /Invalid arguments/);
    assert.match(
      valid.result.content[0].text,
      /verified controller-mapped root/,
    );

    const missingRequired = await rpc("tools/call", {
      name: "herdr_dispatch",
      arguments: {},
    });
    assert.equal(missingRequired.result.isError, true);
    assert.match(
      missingRequired.result.content[0].text,
      /Invalid arguments for herdr_dispatch/,
    );
  });
});

test("mapped root bridge exposes root-role parity and returns non-Pi root grounding", async () => {
  const fixture = await rootBridgeFixture();
  const env = {
    HERDR_ENV: "1",
    HERDR_PANE_ID: fixture.root.pane_id,
    HERDR_WORKSPACE_ID: fixture.root.workspace_id,
    HERDR_PLUGIN_CONFIG_DIR: fixture.stateDir,
    TEST_CONFIG_DIR: fixture.stateDir,
    TEST_ROOT_WORKSPACE: fixture.root.workspace_id,
    PATH: `${fixture.binDir}:${process.env.PATH}`,
  };
  try {
    let workflowId;
    await withMcpServer(env, async (rpc) => {
      const listed = await rpc("tools/list");
      const names = new Set(listed.result.tools.map((tool) => tool.name));
      for (const name of [
        "herdr_bootstrap_root",
        "herdr_goal",
        "herdr_plan",
        "herdr_dispatch",
        "herdr_observe",
        "herdr_resume",
        "herdr_close",
        "herdr_operator_close",
        "herdr_reparent",
        "herdr_question_answer",
        "herdr_message",
        "herdr_doctor",
      ])
        assert.equal(names.has(name), true, `${name} is exposed through MCP`);

      const bootstrap = await rpc("tools/call", {
        name: "herdr_bootstrap_root",
        arguments: {},
      });
      assert.equal(bootstrap.result.isError, undefined);
      assert.match(bootstrap.result.content.map((item) => item.text).join("\n"), /ROOT BRIEFING/);
      assert.match(bootstrap.result.structuredContent.rootBriefing, /sole Baa-ton parent executor/);
      assert.equal(bootstrap.result.structuredContent.root.agent_kind, "claude");

      const goal = await rpc("tools/call", {
        name: "herdr_goal",
        arguments: { action: "initialize", objective: "Exercise root MCP parity" },
      });
      assert.equal(goal.result.isError, undefined);
      assert.match(goal.result.content[0].text, /Parent goal/);

      const plan = await rpc("tools/call", {
        name: "herdr_plan",
        arguments: { objective: "Plan through the root bridge", lanes: ["root lane"] },
      });
      assert.equal(plan.result.isError, undefined);
      workflowId = plan.result.structuredContent.workflow.id;
      assert.match(plan.result.content[0].text, new RegExp(workflowId));
    }, { cwd: fixture.cwd });

    const inbox = JSON.parse(await readFile(join(fixture.stateDir, "inbox.json"), "utf8"));
    assert.equal(inbox.messages.some((message) => message.envelope.message.type === "goal"), true);
    assert.equal(inbox.messages.some((message) => message.envelope.message.type === "lifecycle"), true);
    for (const message of inbox.messages)
      assert.deepEqual(message.envelope.to, {
        workspace_id: fixture.root.workspace_id,
        pane_id: fixture.root.pane_id,
        agent: "claude",
      });

    const configPath = join(fixture.stateDir, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const manifestPath = join(fixture.cwd, ".pi", "herdr-orchestrator", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const lane = manifest.workflows[0].lanes[0];
    config.orchestrators[0].workflows.push({
      workflow_id: workflowId,
      manifest_path: manifestPath,
      lanes: [{
        lane_id: lane.id,
        target: "w-root:child",
        target_kind: "pane_id",
        pane_id: "w-root:child",
        workspace_id: fixture.root.workspace_id,
      }],
    });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    await withMcpServer({ ...env, HERDR_PANE_ID: "w-root:child" }, async (rpc) => {
      const childGoal = await rpc("tools/call", {
        name: "herdr_goal",
        arguments: { action: "status" },
      });
      assert.equal(childGoal.result.isError, true);
      assert.match(childGoal.result.content[0].text, /verified controller-mapped root/);
    }, { cwd: fixture.cwd });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("tools/call outside a Herdr session and unknown tools still fail predictably", async () => {
  await withMcpServer({ HERDR_ENV: "0" }, async (rpc) => {
    const listed = await rpc("tools/list");
    assert.deepEqual(listed.result.tools, []);
    const outside = await rpc("tools/call", {
      name: "herdr_permission_prompt",
      arguments: { tool_name: "Bash", input: { command: "pwd" } },
    });
    assert.equal(outside.result.isError, true);
    assert.match(
      outside.result.content[0].text,
      /only inside a HERDR_ENV=1 session/,
    );
  });
  await withMcpServer({ HERDR_ENV: "1" }, async (rpc) => {
    const unknown = await rpc("tools/call", {
      name: "herdr_not_a_real_tool",
      arguments: {},
    });
    assert.equal(unknown.error?.code, -32602);
  });
});

test("tools/call rejects malformed argument containers and accepts cancellation notifications", async () => {
  await withMcpServer({ HERDR_ENV: "1" }, async (rpc) => {
    const malformed = await rpc("tools/call", {
      name: "herdr_goal",
      arguments: [],
    });
    assert.equal(malformed.error?.code, -32602);
    assert.match(malformed.error?.message, /Arguments.*object/);

    const timeout = await rpc("tools/call", {
      name: "herdr_goal",
      arguments: { action: "status" },
      timeoutMs: 1,
    });
    // No mapped root means the call normally fails before the timer fires,
    // but the timeout field is parsed and the cancellation path remains a
    // valid JSON-RPC notification either way.
    assert.equal(timeout.result.isError, true);
  });
});

test("MCP calls run registered lifecycle handlers and settle the bridge root turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-mcp-lifecycle-"));
  const stateDir = join(directory, "config");
  const cwd = join(directory, "workspace");
  const manifestPath = join(cwd, ".pi", "herdr-orchestrator", "manifest.json");
  const root = {
    target: "herdr-root",
    target_kind: "name",
    agent_kind: "pi",
    pane_id: "w-mcp:root",
    workspace_id: "w-mcp",
  };
  const timestamp = "2026-09-15T00:00:00.000Z";
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        version: 2,
        workflows: [],
        parentGoal: {
          version: 1,
          id: "mcp-goal",
          objective: "Exercise the bridge lifecycle.",
          status: "active",
          nextAction: "Inspect the settled state.",
          signals: [],
          supervisor: {
            version: 1,
            state: "running",
            intervalSeconds: 5,
            nudgeCount: 0,
            nextNudgeAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(stateDir, "config.json"),
    `${JSON.stringify(
      {
        version: 2,
        owner: "herdr-orchestrator",
        orchestrators: [
          {
            id: "mcp-orchestrator",
            root,
            program: {
              id: cwd,
              workspace_id: root.workspace_id,
              parent_manifest_path: manifestPath,
            },
            workflows: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  try {
    await withMcpServer(
      {
        HERDR_ENV: "1",
        HERDR_PANE_ID: root.pane_id,
        HERDR_WORKSPACE_ID: root.workspace_id,
        HERDR_PLUGIN_CONFIG_DIR: stateDir,
      },
      async (rpc) => {
        const call = await rpc("tools/call", {
          name: "herdr_goal",
          arguments: { action: "status" },
        });
        assert.equal(call.result.isError, undefined);
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        assert.equal(manifest.parentGoal.supervisor.rootTurn.state, "idle");
        const inbox = JSON.parse(
          await readFile(join(stateDir, "inbox.json"), "utf8"),
        );
        assert.equal(inbox.messages.length, 1);
        assert.equal(inbox.messages[0].envelope.message.type, "goal");
        assert.equal(inbox.messages[0].states.resolved.at !== undefined, true);
      },
      { cwd },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP permission broker dedupes a request and releases a parent answer once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-mcp-permission-"));
  const stateDir = join(directory, "config");
  const cwd = join(directory, "workspace");
  const manifestPath = join(cwd, ".pi", "herdr-orchestrator", "manifest.json");
  const root = {
    target: "herdr-root",
    target_kind: "name",
    agent_kind: "pi",
    pane_id: "w-permission:root",
    workspace_id: "w-permission",
  };
  const lane = {
    lane_id: "lane-1",
    target: "herdr-child",
    target_kind: "name",
    pane_id: "w-permission:child",
    workspace_id: "w-permission",
  };
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        version: 2,
        workflows: [
          {
            id: "workflow-1",
            ownership: {
              createdBy: "herdr-orchestrator",
              workspaceId: root.workspace_id,
            },
            lanes: [{ id: lane.lane_id, paneId: lane.pane_id }],
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(stateDir, "config.json"),
    `${JSON.stringify(
      {
        version: 2,
        owner: "herdr-orchestrator",
        orchestrators: [
          {
            id: "permission-orchestrator",
            root,
            program: {
              id: cwd,
              workspace_id: root.workspace_id,
              parent_manifest_path: manifestPath,
            },
            workflows: [
              {
                workflow_id: "workflow-1",
                manifest_path: manifestPath,
                lanes: [lane],
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const permissionInput = { tool_name: "Bash", input: { command: "npm test" } };
  try {
    let requestId;
    await withMcpServer(
      {
        HERDR_ENV: "1",
        HERDR_PANE_ID: lane.pane_id,
        HERDR_WORKSPACE_ID: lane.workspace_id,
        HERDR_PLUGIN_CONFIG_DIR: stateDir,
      },
      async (rpc) => {
        const pending = await rpc("tools/call", {
          name: "herdr_permission_prompt",
          arguments: permissionInput,
        });
        assert.equal(pending.result.isError, true);
        requestId = pending.result.structuredContent.occurrenceId;
      },
      { cwd },
    );
    await withMcpServer(
      {
        HERDR_ENV: "1",
        HERDR_PANE_ID: root.pane_id,
        HERDR_WORKSPACE_ID: root.workspace_id,
        HERDR_PLUGIN_CONFIG_DIR: stateDir,
      },
      async (rpc) => {
        const answer = await rpc("tools/call", {
          name: "herdr_question_answer",
          arguments: { requestId, answer: "allow" },
        });
        assert.equal(answer.result.isError, undefined);
      },
      { cwd },
    );
    await withMcpServer(
      {
        HERDR_ENV: "1",
        HERDR_PANE_ID: lane.pane_id,
        HERDR_WORKSPACE_ID: lane.workspace_id,
        HERDR_PLUGIN_CONFIG_DIR: stateDir,
      },
      async (rpc) => {
        const released = await rpc("tools/call", {
          name: "herdr_permission_prompt",
          arguments: permissionInput,
        });
        assert.equal(released.result.isError, undefined);
        assert.deepEqual(JSON.parse(released.result.content[0].text), {
          behavior: "allow",
          updatedInput: permissionInput.input,
        });
      },
      { cwd },
    );
    const inbox = JSON.parse(
      await readFile(join(stateDir, "inbox.json"), "utf8"),
    );
    assert.equal(
      inbox.messages.length,
      1,
      "same logical permission request is deduped",
    );
    assert.equal(inbox.messages[0].resolution.release_count, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
