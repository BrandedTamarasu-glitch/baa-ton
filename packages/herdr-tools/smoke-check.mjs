#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(root, "index.ts"), "utf8");
const readme = await readFile(join(root, "README.md"), "utf8");
const defects = await readFile(join(root, "DEFECTS.md"), "utf8");
const dispatchStart = source.indexOf("  async function dispatch(");
const dispatchEnd = source.indexOf("\n  async function observe(");
assert.ok(
  dispatchStart >= 0 && dispatchEnd > dispatchStart,
  "dispatch function is present",
);
const dispatch = source.slice(dispatchStart, dispatchEnd);

assert.doesNotMatch(
  source,
  /waitForShell|setTimeout\s*\(/,
  "no local sleep remains",
);
assert.match(
  source,
  /async function parentGoal\([\s\S]*?const release = await acquireManifestLock\(cwd\)[\s\S]*?finally[\s\S]*?await release\(\)/,
  "every herdr_goal operation holds the shared manifest lock through its write",
);
assert.match(
  source,
  /\.\$\{MANIFEST_NAME\}\.herdr-orchestrator\.lock/,
  "goal writes use the documented shared manifest sibling lock",
);
const agentStartPattern = /"agent"\s*,\s*"start"/;
assert.doesNotMatch(dispatch, /"pane"\s*,\s*"process-info"/, "does not mistake a process snapshot for readiness");
assert.match(
  dispatch,
  /"agent"\s*,\s*"start"[\s\S]*?"--timeout"\s*,\s*String\s*\(\s*AGENT_START_TIMEOUT_MS\s*\)/,
  "uses bounded server readiness",
);
assert.match(
  dispatch,
  /for \(let readinessAttempt = 1; readinessAttempt <= 3; readinessAttempt \+= 1\)[\s\S]*?agent-readiness-retrying/,
  "uses only the native bounded agent-start readiness gate and persists automatic busy recovery",
);
assert.match(
  dispatch,
  /workspaceId: recordedWorkspaceId,[\s\S]{0,400}await saveManifest\(cwd, manifest\);/,
  "persists each returned workspace before handling its root",
);
assert.match(
  dispatch,
  /recordLaneResources\(workflow, index, tabId, paneId\);[\s\S]{0,180}await saveManifest\(cwd, manifest\);/,
  "persists each returned tab and pane before readiness/start",
);
assert.match(
  dispatch,
  /state: "retryable"/,
  "persists a retryable partial-failure state",
);
const failurePath = dispatch.slice(dispatch.indexOf("catch (error)"));
assert.doesNotMatch(
  failurePath,
  /"workspace", "close"/,
  "partial failure has no cleanup close",
);
assert.match(readme, /Partial dispatch failures/, "README documents recovery behavior");
assert.match(defects, /agent_pane_busy/, "defect ledger records the readiness incident");
assert.match(source, /ROOT_ORCHESTRATOR_ENV/, "root approval designation is enforced");
assert.match(readme, /Non-root callers/, "README documents root mediation");
assert.match(defects, /Child approvals/, "defect ledger records approval mediation");
assert.match(source, /ask_user_question[\s\S]*parent-question-required/, "child questions are guarded");
assert.match(source, /worktreeCwd[\s\S]*plannedCwd/, "planner validates worktree cwd");
assert.match(readme, /Worktree workflows/, "README documents worktree ownership");
assert.match(source, /"worktree"\s*,\s*"open"[\s\S]*?"--workspace"[\s\S]*?"--path"/, "Git flow opens from a registered parent workspace");
assert.match(source, /already_open[\s\S]*?refusing to reuse a workspace/, "Git flow refuses an already-open worktree workspace");
assert.match(defects, /Worktree dispatch/, "defect ledger records worktree metadata retention");
assert.match(source, /SUPPORTED_AGENT_KINDS[\s\S]*?"claude"[\s\S]*?"codex"[\s\S]*?"gemini"[\s\S]*?"--kind"\s*,\s*agentKind/, "dispatch selects a complete compatible lane agent kind");
assert.match(dispatch, /reusableWorkspace[\s\S]*?workspace-reused-for-tabs[\s\S]*?tab",\s*"create"/, "same-cwd non-worktree workflows reuse a durable workspace and create lane tabs");
assert.match(dispatch, /workspace", "get", candidateWorkspaceId[\s\S]*?stale-workspace-binding-recovered/, "dispatch verifies a reusable workspace and clears only a missing agent-free binding");
assert.match(dispatch, /if \(workspaceId && !workflow\.worktree\)[\s\S]*?candidate\.ownership\.workspaceId === workspaceId[\s\S]*?workspaceId = undefined/, "retry clears every persisted shared reference only after missing-workspace recovery");
assert.match(source, /sharedWorkspace[\s\S]*?workspace-retained-for-other-workflows/, "closing a shared workspace is guarded by other non-closed workflow references");
assert.match(readme, /Each lane gets its own Herdr tab/, "README documents workspace/tab/pane topology");
assert.match(source, /RECENT_AGENT_OUTPUT_LINES[\s\S]*goal-paused[\s\S]*?\/goal-resume/, "observation parses bounded paused-goal output and resume sends the goal command");
assert.match(source, /herdr_complete\(\{ workflowId:[\s\S]*?chat-only outcome is insufficient[\s\S]*?fallback-only/, "every generated lane contract requires an explicit durable completion receipt");
assert.match(source, /authorizationPolicy[\s\S]*authorization-policy-granted/, "bounded authorization policy is stored and audited");
assert.match(source, /authorizationPolicy cannot authorize/, "policy rejects capabilities outside the fixed local allowlist");
assert.match(readme, /herdr_resume/, "README documents the resume tool");
assert.match(defects, /Paused-goal evidence/, "defect ledger records paused goals");

const require = createRequire(import.meta.url);
const createJiti = require("jiti");
const jiti = createJiti(fileURLToPath(import.meta.url), {
  alias: { typebox: require.resolve("typebox") },
});
const extension = await jiti.import(join(root, "index.ts"));
const tools = new Map();
const commands = new Map();
const eventHandlers = new Map();
const calls = [];
let failAgentStart = true;
let agentStartAcknowledgment = "json";
const existingAgents = new Map();
let controllerPluginAvailable = true;
let controllerConfigDir = "";
const rootPaneId = "w-root:p1";
const rootWorkspaceId = "w-root";
let goalResumePromptCount = 0;
let worktreeClean = true;
let registeredParentCheckout = "";
let openWorktreeWorkspaceId = null;
let parentWorkspaceMode = "one";
let genericWorkspaceCount = 0;
const missingWorkspaceIds = new Set();
const nextTabNumberByWorkspace = new Map();
extension.default({
  on(event, handler) {
    eventHandlers.set(event, handler);
  },
  registerTool(definition) {
    tools.set(definition.name, definition);
  },
  registerCommand(name, definition) {
    commands.set(name, definition);
  },
  async exec(command, args) {
    if (command === "git") {
      if (args[2] === "rev-parse")
        return { stdout: `${args[1]}\n`, stderr: "", code: 0 };
      assert.deepEqual(
        args.slice(-3),
        ["status", "--porcelain", "--untracked-files=all"],
        "worktree validation checks Git cleanliness synchronously",
      );
      return {
        stdout: worktreeClean ? "" : " M index.ts\n",
        stderr: "",
        code: 0,
      };
    }
    assert.equal(command, "herdr", "dispatch uses only the Herdr CLI");
    calls.push(args);
    const response = (stdout) => ({
      stdout: JSON.stringify(stdout),
      stderr: "",
      code: 0,
    });
    if (args[0] === "plugin" && args[1] === "config-dir") {
      assert.equal(args[2], "herdr-orchestrator-controller");
      if (!controllerPluginAvailable)
        return {
          stdout: "",
          stderr: "plugin_not_linked",
          code: 1,
        };
      return { stdout: `${controllerConfigDir}\n`, stderr: "", code: 0 };
    }
    if (args[0] === "workspace" && args[1] === "close")
      return response({ result: {} });
    if (args[0] === "workspace" && args[1] === "get") {
      if (missingWorkspaceIds.has(args[2]))
        return { stdout: "", stderr: "workspace_not_found", code: 1 };
      return response({ result: { workspace: { workspace_id: args[2] } } });
    }
    if (args[0] === "worktree" && args[1] === "list") {
      const checkoutPath = args[args.indexOf("--cwd") + 1];
      return response({
        result: {
          type: "worktree_list",
          source: {
            repo_key: "repo-smoke",
            repo_root: registeredParentCheckout,
            source_checkout_path: registeredParentCheckout,
            source_workspace_id: "w-parent",
          },
          worktrees: [
            {
              path: checkoutPath,
              open_workspace_id: openWorktreeWorkspaceId,
            },
          ],
        },
      });
    }
    if (args[0] === "workspace" && args[1] === "list") {
      // Herdr's parent workspace may be generic; its repository binding is
      // authoritative in worktree-list.source rather than workspace.worktree.
      const parent = { workspace_id: "w-parent" };
      return response({
        result: {
          workspaces:
            parentWorkspaceMode === "ambiguous"
              ? [{ ...parent }, { ...parent }]
              : [parent],
        },
      });
    }
    if (args[0] === "worktree" && args[1] === "open") {
      assert.equal(
        args[args.indexOf("--workspace") + 1],
        "w-parent",
        "opens from the registered parent workspace",
      );
      openWorktreeWorkspaceId = "w-smoke";
      return response({
        result: {
          type: "worktree_opened",
          already_open: false,
          workspace: { workspace_id: "w-smoke" },
          tab: { tab_id: "w-smoke:t1" },
          root_pane: { pane_id: "w-smoke:p1" },
          worktree: { path: args[args.indexOf("--path") + 1] },
        },
      });
    }
    if (args[0] === "workspace" && args[1] === "create") {
      const workspaceId = `w-generic-${++genericWorkspaceCount}`;
      return response({
        result: {
          workspace: { workspace_id: workspaceId },
          tab: { tab_id: `${workspaceId}:t1` },
          root_pane: { pane_id: `${workspaceId}:p1` },
        },
      });
    }
    if (args[0] === "tab" && args[1] === "create") {
      const workspaceId = args[args.indexOf("--workspace") + 1];
      const number = (nextTabNumberByWorkspace.get(workspaceId) ?? 1) + 1;
      nextTabNumberByWorkspace.set(workspaceId, number);
      return response({
        result: {
          tab: { tab_id: `${workspaceId}:t${number}` },
          root_pane: { pane_id: `${workspaceId}:p${number}` },
        },
      });
    }
    if (args[0] === "tab" && args[1] === "rename")
      return response({ result: {} });
    if (args[0] === "pane" && args[1] === "process-info")
      return response({
        result: {
          process_info: { shell_pid: 99, foreground_process_group_id: 99 },
        },
      });
    if (args[0] === "agent" && args[1] === "get") {
      if (args[2] === rootPaneId)
        return response({
          result: {
            type: "agent_info",
            agent: {
              name: "smoke-root",
              agent: "pi",
              pane_id: rootPaneId,
              workspace_id: rootWorkspaceId,
              agent_status: "idle",
            },
          },
        });
      const agent = existingAgents.get(args[2]);
      if (agent)
        return response({
          result: {
            type: "agent_info",
            agent: {
              name: args[2],
              agent: agent.kind,
              pane_id: agent.paneId,
              workspace_id: agent.workspaceId,
              agent_status: "idle",
              agent_session_path: "/tmp/pi-goal-smoke.jsonl",
              agent_session_id: "pi-goal-smoke",
            },
          },
        });
      return {
        stdout: "",
        stderr: '{"error":{"code":"agent_not_found"}}',
        code: 1,
      };
    }
    if (args[0] === "agent" && args[1] === "read")
      return {
        stdout:
          "pi-goal-bb029 paused after a child-facing question was cancelled; send /goal-resume through Herdr.\n",
        stderr: "",
        code: 0,
      };
    if (args[0] === "agent" && args[1] === "start") {
      if (failAgentStart)
        return {
          stdout: "",
          stderr: '{"error":{"code":"agent_pane_busy"}}',
          code: 1,
        };
      const paneId = args[args.indexOf("--pane") + 1];
      existingAgents.set(args[2], {
        kind: args[args.indexOf("--kind") + 1],
        paneId,
        workspaceId: paneId.slice(0, paneId.lastIndexOf(":p")),
      });
      if (agentStartAcknowledgment === "empty")
        return { stdout: "", stderr: "", code: 0 };
      if (agentStartAcknowledgment === "non-json")
        return { stdout: "agent started\n", stderr: "", code: 0 };
      return response({ result: { agent: { agent_status: "idle" } } });
    }
    if (args[0] === "agent" && args[1] === "prompt") {
      if (args.at(-1) === "/goal-resume") {
        goalResumePromptCount += 1;
        return response({ result: { receipt: "goal-resume accepted" } });
      }
      return response({ result: {} });
    }
    throw new Error(`Unexpected Herdr call: ${args.join(" ")}`);
  },
});
assert.equal(tools.size, 8, "extension registered its workflow tools");
assert.ok(tools.has("herdr_reparent"), "extension registers root handoff");
assert.ok(tools.has("herdr_complete"), "extension registers verified completion receipts");
assert.ok(commands.has("herdr-resume"), "extension registered /herdr-resume");

const testCwd = await mkdtemp(join(tmpdir(), "herdr-orchestrator-smoke-"));
const previousHerdrEnv = process.env.HERDR_ENV;
const previousRootEnv = process.env.HERDR_ORCHESTRATOR_ROOT;
const previousPaneEnv = process.env.HERDR_PANE_ID;
process.env.HERDR_ENV = "1";
process.env.HERDR_PANE_ID = rootPaneId;
controllerConfigDir = join(testCwd, "controller-config");
let confirmationCalls = 0;
const notifications = [];
const ctx = {
  cwd: testCwd,
  mode: "tui",
  hasUI: true,
  ui: {
    confirm: async () => {
      confirmationCalls += 1;
      return true;
    },
    notify: (...args) => notifications.push(args),
  },
};
const headlessRootCtx = { ...ctx, mode: "json", hasUI: false };
const bb029Policy = {
  version: 1,
  scope: { workflow: "BB-029", localOnly: true },
  capabilities: [
    "local-herdr-topology",
    "clean-local-worktrees",
    "foreground-tests",
    "observe-retry-review",
    "durable-ledger",
    "paused-goal-recovery",
  ],
};
try {
  delete process.env.HERDR_ORCHESTRATOR_ROOT;
  await mkdir(controllerConfigDir, { mode: 0o755 });
  await chmod(controllerConfigDir, 0o755);
  const worktreeCwd = join(testCwd, "bb029-writer-worktree");
  const dirtyWorktreeCwd = join(testCwd, "dirty-worktree");
  const ambiguousWorktreeCwd = join(testCwd, "ambiguous-worktree");
  registeredParentCheckout = join(testCwd, "registered-parent-workspace");
  await mkdir(worktreeCwd);
  const normalizedWorktreeCwd = await realpath(worktreeCwd);
  await mkdir(dirtyWorktreeCwd);
  await mkdir(ambiguousWorktreeCwd);
  await assert.rejects(
    tools
      .get("herdr_plan")
      .execute(
        "relative-worktree",
        { objective: "relative", worktreeCwd: "bb029-writer-worktree" },
        undefined,
        undefined,
        ctx,
      ),
    /absolute existing directory/,
  );
  await assert.rejects(
    tools
      .get("herdr_plan")
      .execute(
        "missing-worktree",
        { objective: "missing", worktreeCwd: join(testCwd, "missing") },
        undefined,
        undefined,
        ctx,
      ),
    /does not exist/,
  );
  await assert.rejects(
    tools
      .get("herdr_plan")
      .execute(
        "invalid-agent-kind",
        { objective: "invalid agent", agentKind: "not-a-herdr-harness" },
        undefined,
        undefined,
        ctx,
      ),
    /agentKind must be one of/,
    "the extension fails closed outside the installed Herdr compatibility set",
  );
  await assert.rejects(
    tools.get("herdr_plan").execute(
      "invalid-policy",
      {
        objective: "BB-029 invalid",
        authorizationPolicy: {
          ...bb029Policy,
          capabilities: [...bb029Policy.capabilities, "close"],
        },
      },
      undefined,
      undefined,
      ctx,
    ),
    /cannot authorize close/,
    "a local policy cannot authorize resource closure",
  );
  worktreeClean = false;
  await assert.rejects(
    tools
      .get("herdr_plan")
      .execute(
        "dirty-worktree",
        { objective: "dirty", worktreeCwd: dirtyWorktreeCwd },
        undefined,
        undefined,
        ctx,
      ),
    /worktreeCwd must be clean/,
    "planning rejects a dirty worktree before it can open a workspace",
  );
  worktreeClean = true;
  parentWorkspaceMode = "ambiguous";
  await assert.rejects(
    tools
      .get("herdr_plan")
      .execute(
        "ambiguous-parent",
        { objective: "ambiguous", worktreeCwd: ambiguousWorktreeCwd },
        undefined,
        undefined,
        ctx,
      ),
    /ambiguous worktree dispatch/,
    "planning rejects ambiguous registered parent workspaces",
  );
  parentWorkspaceMode = "one";
  await assert.rejects(
    tools.get("herdr_plan").execute(
      "writer-lanes",
      {
        objective: "writer lanes",
        lanes: ["writer root", "writer tab"],
        worktreeCwd,
      },
      undefined,
      undefined,
      ctx,
    ),
    /every lane declares readOnly: true/,
    "one worktree cannot receive multiple writer lanes",
  );
  const plan = await tools.get("herdr_plan").execute(
    "plan",
    {
      objective: "BB-029 smoke",
      lanes: [
        { objective: "read root", readOnly: true },
        { objective: "read tab", readOnly: true },
      ],
      worktreeCwd,
      authorizationPolicy: bb029Policy,
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(
    plan.details.workflow.cwd,
    normalizedWorktreeCwd,
    "planner records target cwd",
  );
  assert.equal(
    plan.details.workflow.worktree,
    normalizedWorktreeCwd,
    "planner records target worktree",
  );
  assert.deepEqual(
    plan.details.workflow.authorizationPolicy,
    bb029Policy,
    "planner persists the exact validated BB-029 policy",
  );
  assert.equal(
    plan.details.workflow.evidence[0].kind,
    "authorization-policy-installed",
    "policy installation is durable evidence",
  );
  assert.deepEqual(
    plan.details.workflow.worktreeBinding.repoParent,
    {
      workspaceId: "w-parent",
      checkoutPath: registeredParentCheckout,
      repoKey: "repo-smoke",
      repoRoot: registeredParentCheckout,
    },
    "planner durably binds the sole registered parent checkout",
  );
  assert.ok(
    plan.details.workflow.evidence.some(
      (item) => item.kind === "worktree-parent-resolved",
    ),
    "registered parent evidence is durable before dispatch",
  );
  const workflowId = plan.details.workflow.id;
  const childDispatch = await tools
    .get("herdr_dispatch")
    .execute(
      "child-dispatch",
      { workflowId, execute: true },
      undefined,
      undefined,
      ctx,
    );
  const repeatedChildDispatch = await tools
    .get("herdr_dispatch")
    .execute(
      "child-dispatch-repeat",
      { workflowId, execute: true },
      undefined,
      undefined,
      ctx,
    );
  assert.equal(childDispatch.details.parentApprovalRequired, true);
  assert.equal(repeatedChildDispatch.details.parentApprovalRequired, true);
  assert.equal(confirmationCalls, 0, "child dispatch opens no confirmation UI");
  assert.equal(
    calls.filter((args) => args[0] === "worktree" && args[1] === "open").length,
    0,
    "child dispatch opens no Herdr resource",
  );

  const manifestPath = join(
    testCwd,
    ".pi",
    "herdr-orchestrator",
    "manifest.json",
  );
  let manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  let workflow = manifest.workflows[0];
  assert.equal(
    workflow.approvalRequests.length,
    1,
    "child dispatch is deduplicated",
  );
  assert.equal(workflow.approvalRequests[0].action, "dispatch");
  assert.equal(workflow.approvalRequests[0].status, "parent-approval-required");
  assert.equal(
    workflow.cwd,
    normalizedWorktreeCwd,
    "manifest preserves target cwd",
  );
  assert.equal(
    workflow.worktree,
    normalizedWorktreeCwd,
    "manifest preserves target worktree",
  );
  assert.equal(
    childDispatch.details.approvalRequest.id,
    repeatedChildDispatch.details.approvalRequest.id,
    "repeated child dispatch returns the single parent request",
  );

  process.env.HERDR_ORCHESTRATOR_ROOT = "1";
  const initializedGoal = await tools.get("herdr_goal").execute(
    "goal-initialize",
    { action: "initialize", objective: "Complete BB-029 safely." },
    undefined,
    undefined,
    headlessRootCtx,
  );
  assert.equal(initializedGoal.details.goal.supervisor.state, "stopped");
  const runningGoal = await tools.get("herdr_goal").execute(
    "goal-start",
    { action: "start", nudgeIntervalSeconds: 5 },
    undefined,
    undefined,
    headlessRootCtx,
  );
  assert.equal(runningGoal.details.goal.supervisor.state, "running");
  assert.equal(runningGoal.details.goal.supervisor.intervalSeconds, 5);
  assert.deepEqual(runningGoal.details.goal.supervisor.rootActivity?.status, "unknown");
  const pausedGoal = await tools.get("herdr_goal").execute(
    "goal-pause",
    { action: "pause", pauseReason: "Waiting for explicit user direction." },
    undefined,
    undefined,
    headlessRootCtx,
  );
  assert.equal(pausedGoal.details.goal.status, "paused");
  assert.equal(pausedGoal.details.goal.supervisor.pauseReason, "Waiting for explicit user direction.");
  await assert.rejects(
    tools.get("herdr_goal").execute(
      "goal-invalid-pause",
      { action: "pause" },
      undefined,
      undefined,
      headlessRootCtx,
    ),
    /pauseReason is required/,
  );
  await assert.rejects(
    tools
      .get("herdr_dispatch")
      .execute(
        "root-dispatch",
        { workflowId, execute: true },
        undefined,
        undefined,
        headlessRootCtx,
      ),
    /agent_pane_busy/,
  );
  assert.equal(
    confirmationCalls,
    0,
    "preauthorized root dispatch succeeds in headless mode without UI",
  );
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  workflow = manifest.workflows[0];
  assert.deepEqual(workflow.ownership, {
    createdBy: "herdr-orchestrator",
    workspaceId: "w-smoke",
    workspaceOwnerWorkflowId: workflowId,
    tabIds: ["w-smoke:t1"],
    paneIds: ["w-smoke:p1"],
  });
  assert.equal(workflow.lanes[0].paneId, "w-smoke:p1");
  assert.equal(workflow.lanes[0].readiness.initialShellForeground, false);
  assert.equal(workflow.lanes[0].readiness.source, "herdr agent start --timeout");
  assert.equal(workflow.retry.state, "retryable");
  assert.equal(workflow.retry.failedStage, "agent-start");
  assert.equal(workflow.approvalRequests[0].status, "approved");
  assert.ok(
    workflow.evidence.some(
      (item) =>
        item.kind === "authorization-policy-granted" &&
        item.text.includes("Autonomous dispatch"),
    ),
    "root dispatch records its autonomous policy decision",
  );
  const worktreeOpen = calls.find(
    (args) => args[0] === "worktree" && args[1] === "open",
  );
  assert.equal(
    worktreeOpen[worktreeOpen.indexOf("--path") + 1],
    normalizedWorktreeCwd,
    "dispatch opens the recorded worktree checkout",
  );
  assert.equal(
    calls.filter((args) => args[0] === "workspace" && args[1] === "create")
      .length,
    0,
    "Git flow never falls back to generic workspace creation",
  );
  assert.equal(workflow.worktreeBinding.workspaceId, "w-smoke");
  assert.equal(workflow.worktreeBinding.checkoutPath, normalizedWorktreeCwd);
  assert.equal(
    workflow.worktreeBinding.openResult.result.type,
    "worktree_opened",
  );
  assert.ok(
    workflow.evidence.some((item) => item.kind === "worktree-opened"),
    "worktree open result is durable evidence",
  );
  const startIndex = calls.findIndex(
    (args) => args[0] === "agent" && args[1] === "start",
  );
  assert.ok(startIndex >= 0, "uses Herdr native agent-start readiness");
  assert.equal(
    calls.some((args) => args[0] === "pane" && args[1] === "process-info"),
    false,
    "does not use a racy process-info readiness probe",
  );
  assert.equal(
    calls[startIndex].at(-1),
    "60000",
    "agent readiness timeout is bounded",
  );

  worktreeClean = false;
  await assert.rejects(
    tools
      .get("herdr_dispatch")
      .execute(
        "dirty-policy-retry",
        { workflowId, execute: true },
        undefined,
        undefined,
        headlessRootCtx,
      ),
    /worktreeCwd must be clean/,
    "a dirty worktree denies autonomous retry rather than opening UI",
  );
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  workflow = manifest.workflows.find((item) => item.id === workflowId);
  assert.ok(
    workflow.evidence.some(
      (item) =>
        item.kind === "authorization-policy-denied" &&
        item.text.includes("worktreeCwd must be clean"),
    ),
    "dirty-worktree denial is durable evidence",
  );
  worktreeClean = true;
  failAgentStart = false;
  agentStartAcknowledgment = "empty";
  await tools
    .get("herdr_dispatch")
    .execute(
      "root-resume",
      { workflowId, execute: true },
      undefined,
      undefined,
      headlessRootCtx,
    );
  const recovered = JSON.parse(await readFile(manifestPath, "utf8"))
    .workflows[0];
  assert.equal(
    recovered.status,
    "running",
    "explicit retry resumes the recorded workflow",
  );
  assert.equal(recovered.ownership.workspaceId, "w-smoke");
  assert.ok(
    recovered.evidence.some(
      (item) => item.kind === "agent-start-ack-reconciled",
    ),
    "an empty successful agent-start acknowledgement reconciles the live identity",
  );
  const controllerConfigPath = join(controllerConfigDir, "config.json");
  const controllerConfig = JSON.parse(
    await readFile(controllerConfigPath, "utf8"),
  );
  assert.equal(
    (await lstat(controllerConfigDir)).mode & 0o077,
    0,
    "registration securely repairs the linked config directory to 0700",
  );
  assert.equal(
    (await lstat(controllerConfigPath)).mode & 0o077,
    0,
    "automatic controller config write is private",
  );
  assert.equal(controllerConfig.version, 2, "new registrations persist multi-orchestrator config v2");
  assert.deepEqual(
    controllerConfig.orchestrators[0].root,
    {
      target: rootPaneId,
      target_kind: "pane_id",
      agent_kind: "pi",
      pane_id: rootPaneId,
      workspace_id: rootWorkspaceId,
    },
    "registration discovers the current pane target and verified root identity",
  );
  const registeredMapping = controllerConfig.orchestrators[0].workflows.find(
    (item) => item.workflow_id === workflowId,
  );
  assert.deepEqual(
    registeredMapping.lanes,
    recovered.lanes.map((lane) => ({
      lane_id: lane.id,
      target: lane.agentName,
      target_kind: "name",
      pane_id: lane.paneId,
      workspace_id: recovered.ownership.workspaceId,
      relationship_id: lane.relationshipId,
    })),
    "registration writes exact live lane identity and persistent relationship mappings",
  );
  assert.equal(
    recovered.eventControllerRegistration.status,
    "registered",
    "successful dispatch durably records controller registration",
  );
  assert.equal(
    recovered.ownership.tabIds.length,
    2,
    "worktree dispatch retains one tab per read-only lane",
  );
  assert.equal(
    calls.filter((args) => args[0] === "pane" && args[1] === "split").length,
    0,
    "worktree dispatch uses no pane splits",
  );
  const tabCreate = calls.find(
    (args) => args[0] === "tab" && args[1] === "create",
  );
  assert.equal(
    tabCreate[tabCreate.indexOf("--cwd") + 1],
    normalizedWorktreeCwd,
    "dispatch creates each lane tab at the recorded worktree cwd",
  );
  assert.equal(
    calls.filter((args) => args[0] === "worktree" && args[1] === "open").length,
    1,
    "retry does not reopen or replace the recorded worktree workspace",
  );
  assert.equal(
    calls.filter((args) => args[0] === "workspace" && args[1] === "create")
      .length,
    0,
    "Git retries never fall back to a generic replacement workspace",
  );
  assert.equal(
    confirmationCalls,
    0,
    "preauthorized retry continues headlessly without UI",
  );
  assert.ok(
    recovered.evidence.some(
      (item) =>
        item.kind === "authorization-policy-granted" &&
        item.text.includes("Autonomous retry"),
    ),
    "retry records its autonomous policy decision",
  );

  const reparentPreview = await tools
    .get("herdr_reparent")
    .execute(
      "reparent-preview",
      { workflowId },
      undefined,
      undefined,
      headlessRootCtx,
    );
  assert.equal(reparentPreview.details.dryRun, true);
  assert.equal(
    reparentPreview.details.nextRoot.pane_id,
    rootPaneId,
    "root handoff preview verifies the current live root identity",
  );

  const paused = await tools
    .get("herdr_observe")
    .execute("observe-paused", { workflowId }, undefined, undefined, ctx);
  assert.equal(paused.details.state, "goal-paused");
  assert.deepEqual(
    paused.details.observations.map((item) => item.pausedGoalIds),
    [["pi-goal-bb029"], ["pi-goal-bb029"]],
    "bounded agent output detects every paused Pi goal",
  );
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  workflow = manifest.workflows.find((item) => item.id === workflowId);
  assert.equal(workflow.status, "goal-paused");
  assert.equal(
    workflow.evidence.filter((item) => item.kind === "goal-paused").length,
    2,
    "observation persists one durable paused-goal record per lane",
  );

  const resumeDryRun = await tools
    .get("herdr_resume")
    .execute("resume-dry-run", { workflowId }, undefined, undefined, ctx);
  assert.equal(resumeDryRun.details.dryRun, true);
  assert.equal(resumeDryRun.details.commands.length, 2);
  assert.equal(goalResumePromptCount, 0, "dry-run sends no resume command");

  delete process.env.HERDR_ORCHESTRATOR_ROOT;
  const childResume = await tools
    .get("herdr_resume")
    .execute(
      "child-resume",
      { workflowId, execute: true },
      undefined,
      undefined,
      ctx,
    );
  assert.equal(childResume.details.parentApprovalRequired, true);
  assert.equal(confirmationCalls, 0, "child resume opens no confirmation UI");
  assert.equal(
    goalResumePromptCount,
    0,
    "child resume does not prompt an agent",
  );
  const notificationsBeforeChildCommand = notifications.length;
  await commands.get("herdr-resume").handler(`${workflowId} --execute`, ctx);
  assert.equal(
    notifications.length,
    notificationsBeforeChildCommand,
    "child /herdr-resume presents no UI",
  );
  assert.equal(
    goalResumePromptCount,
    0,
    "child /herdr-resume does not prompt an agent",
  );
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  workflow = manifest.workflows.find((item) => item.id === workflowId);
  assert.equal(
    workflow.approvalRequests.filter((item) => item.action === "resume").length,
    1,
    "child resume persists one parent approval request",
  );

  process.env.HERDR_ORCHESTRATOR_ROOT = "1";
  const resumedGoal = await tools
    .get("herdr_resume")
    .execute(
      "root-resume-goal",
      { workflowId, execute: true },
      undefined,
      undefined,
      headlessRootCtx,
    );
  assert.equal(resumedGoal.details.resumed, true);
  assert.equal(
    goalResumePromptCount,
    2,
    "root resumes every paused lane through Herdr",
  );
  assert.equal(
    confirmationCalls,
    0,
    "preauthorized paused-goal recovery continues headlessly without UI",
  );
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  workflow = manifest.workflows.find((item) => item.id === workflowId);
  assert.equal(workflow.status, "goal-resume-requested");
  assert.ok(
    workflow.evidence.some(
      (item) =>
        item.kind === "authorization-policy-granted" &&
        item.text.includes("Autonomous resume"),
    ),
    "paused-goal recovery records its autonomous policy decision",
  );
  assert.equal(
    workflow.evidence.filter((item) => item.kind === "goal-resume-receipt")
      .length,
    2,
    "every root resume receipt is durable",
  );
  assert.ok(
    workflow.lanes.every((lane) =>
      lane.goalResumeReceipts.at(-1).receipt.includes("accepted"),
    ),
    "manifest retains Herdr resume receipts",
  );
  const blockedPush = await eventHandlers.get("tool_call")(
    { toolName: "bash", input: { command: "git push origin main" } },
    headlessRootCtx,
  );
  const blockedClose = await eventHandlers.get("tool_call")(
    { toolName: "bash", input: { command: "herdr workspace close w-smoke" } },
    headlessRootCtx,
  );
  assert.equal(blockedPush.block, true);
  assert.equal(blockedClose.block, true);
  assert.match(blockedPush.reason, /never authorized by the local policy/);

  delete process.env.HERDR_ORCHESTRATOR_ROOT;
  const questionInput = {
    questions: [
      {
        header: "Approval",
        question: "May this child continue?",
        options: [{ label: "Continue", description: "Approve continuation" }],
      },
    ],
  };
  const callsBeforeQuestion = calls.length;
  const childQuestion = await eventHandlers.get("tool_call")(
    { toolName: "ask_user_question", input: questionInput },
    ctx,
  );
  const repeatedChildQuestion = await eventHandlers.get("tool_call")(
    { toolName: "ask_user_question", input: questionInput },
    ctx,
  );
  assert.equal(childQuestion.block, true);
  assert.match(childQuestion.reason, /parent-question-required/);
  assert.equal(repeatedChildQuestion.block, true);
  assert.equal(confirmationCalls, 0, "child question opens no confirmation UI");
  assert.equal(
    calls.length,
    callsBeforeQuestion,
    "child question creates no Herdr resource",
  );
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const questionedWorkflow = manifest.workflows.find(
    (item) => item.id === workflowId,
  );
  assert.equal(
    questionedWorkflow.questionRequests.length,
    1,
    "child question is deduplicated",
  );
  assert.equal(
    questionedWorkflow.questionRequests[0].status,
    "parent-question-required",
  );
  assert.match(
    questionedWorkflow.questionRequests[0].question,
    /May this child continue/,
  );

  process.env.HERDR_ORCHESTRATOR_ROOT = "1";
  agentStartAcknowledgment = "non-json";
  const stalePlan = await tools.get("herdr_plan").execute(
    "stale-workspace-plan",
    {
      objective: "BB-029 stale workspace binding",
      authorizationPolicy: bb029Policy,
    },
    undefined,
    undefined,
    ctx,
  );
  missingWorkspaceIds.add("w-stale");
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const staleWorkflow = manifest.workflows.find(
    (item) => item.id === stalePlan.details.workflow.id,
  );
  staleWorkflow.ownership.workspaceId = "w-stale";
  staleWorkflow.ownership.workspaceOwnerWorkflowId = staleWorkflow.id;
  staleWorkflow.status = "dispatch-failed";
  staleWorkflow.outcome = "unknown";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const genericPlan = await tools.get("herdr_plan").execute(
    "generic-plan",
    {
      objective: "BB-029 generic fallback",
      agentKind: "codex",
      lanes: [
        { objective: "Codex lane" },
        { objective: "Claude lane", agentKind: "claude" },
        { objective: "Gemini lane", agentKind: "gemini" },
      ],
      authorizationPolicy: bb029Policy,
    },
    undefined,
    undefined,
    ctx,
  );
  const genericWorkflowId = genericPlan.details.workflow.id;
  const genericDispatch = await tools
    .get("herdr_dispatch")
    .execute(
      "generic-dispatch",
      { workflowId: genericWorkflowId, execute: true },
      undefined,
      undefined,
      headlessRootCtx,
    );
  assert.equal(genericDispatch.details.dispatched, true);
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const recoveredStaleWorkflow = manifest.workflows.find(
    (item) => item.id === stalePlan.details.workflow.id,
  );
  assert.equal(
    recoveredStaleWorkflow.ownership.workspaceId,
    undefined,
    "a missing reusable workspace binding is cleared before new tab creation",
  );
  assert.ok(
    recoveredStaleWorkflow.evidence.some(
      (item) => item.kind === "stale-workspace-binding-recovered",
    ),
    "stale workspace recovery is durable evidence",
  );
  assert.equal(
    genericDispatch.details.workflow.ownership.workspaceId,
    "w-generic-1",
    "unspecified cwd falls back to a generic workspace",
  );
  assert.equal(
    calls.filter((args) => args[0] === "workspace" && args[1] === "create")
      .length,
    1,
    "only the non-Git workflow uses generic workspace creation",
  );
  assert.equal(
    calls.filter((args) => args[0] === "worktree" && args[1] === "open").length,
    1,
    "generic fallback does not alter the worktree dispatch count",
  );
  assert.deepEqual(
    new Set(
      calls
        .filter((args) => args[0] === "agent" && args[1] === "start")
        .map((args) => args[args.indexOf("--kind") + 1])
        .filter(
          (kind) => kind === "codex" || kind === "claude" || kind === "gemini",
        ),
    ),
    new Set(["codex", "claude", "gemini"]),
    "lane kinds launch Codex, Claude Code, and another installed Herdr harness",
  );
  assert.ok(
    calls.some(
      (args) =>
        args[0] === "agent" &&
        args[1] === "prompt" &&
        typeof args.at(-1) === "string" &&
        args.at(-1).includes("Agent kind: gemini"),
    ),
    "agent-neutral contracts identify the selected kind",
  );
  assert.deepEqual(
    genericDispatch.details.workflow.lanes.map((lane) => lane.agentKind),
    ["codex", "claude", "gemini"],
    "workflow and lane manifests preserve compatible harness kinds",
  );
  assert.equal(
    genericDispatch.details.workflow.ownership.tabIds.length,
    3,
    "generic multi-harness dispatch retains one tab per lane",
  );
  assert.equal(
    genericDispatch.details.workflow.evidence.filter(
      (item) => item.kind === "agent-start-ack-reconciled",
    ).length,
    3,
    "non-JSON successful acknowledgements reconcile every live lane identity",
  );
  const configWithGeneric = JSON.parse(
    await readFile(controllerConfigPath, "utf8"),
  );
  assert.equal(
    configWithGeneric.orchestrators[0].workflows.length,
    2,
    "a second dispatch atomically preserves the unrelated workflow mapping",
  );

  const persistedStalePlan = await tools.get("herdr_plan").execute(
    "persisted-stale-workspace-plan",
    {
      objective: "BB-029 persisted stale workspace retry",
      authorizationPolicy: bb029Policy,
    },
    undefined,
    undefined,
    ctx,
  );
  missingWorkspaceIds.add("w-persisted-stale");
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const persistedStaleWorkflow = manifest.workflows.find(
    (item) => item.id === persistedStalePlan.details.workflow.id,
  );
  persistedStaleWorkflow.ownership.workspaceId = "w-persisted-stale";
  persistedStaleWorkflow.ownership.workspaceOwnerWorkflowId = persistedStaleWorkflow.id;
  persistedStaleWorkflow.status = "dispatch-failed";
  persistedStaleWorkflow.outcome = "unknown";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const persistedStaleDispatch = await tools
    .get("herdr_dispatch")
    .execute(
      "persisted-stale-workspace-dispatch",
      { workflowId: persistedStalePlan.details.workflow.id, execute: true },
      undefined,
      undefined,
      headlessRootCtx,
    );
  assert.equal(persistedStaleDispatch.details.dispatched, true);
  assert.equal(
    persistedStaleDispatch.details.workflow.ownership.workspaceId,
    "w-generic-2",
    "a persisted missing workspace is rebound before tab creation",
  );
  assert.ok(
    persistedStaleDispatch.details.workflow.evidence.some(
      (item) => item.kind === "stale-workspace-binding-recovered",
    ),
    "persisted stale workspace recovery is durable",
  );
  assert.ok(
    calls.some(
      (args) => args[0] === "workspace" && args[1] === "get" && args[2] === "w-persisted-stale",
    ),
    "retry verifies the persisted workspace before attempting tab creation",
  );

  controllerPluginAvailable = false;
  const deferredPlan = await tools.get("herdr_plan").execute(
    "deferred-controller-plan",
    {
      objective: "BB-029 controller unavailable",
      authorizationPolicy: bb029Policy,
    },
    undefined,
    undefined,
    ctx,
  );
  const deferredDispatch = await tools
    .get("herdr_dispatch")
    .execute(
      "deferred-controller-dispatch",
      { workflowId: deferredPlan.details.workflow.id, execute: true },
      undefined,
      undefined,
      headlessRootCtx,
    );
  assert.equal(
    deferredDispatch.details.dispatched,
    true,
    "an unavailable controller plugin never fails a completed dispatch",
  );
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const deferredWorkflow = manifest.workflows.find(
    (item) => item.id === deferredPlan.details.workflow.id,
  );
  assert.equal(
    deferredWorkflow.eventControllerRegistration.status,
    "pending",
    "unavailable controller config leaves a durable registration-pending record",
  );
  assert.equal(
    deferredWorkflow.ownership.workspaceId,
    genericDispatch.details.workflow.ownership.workspaceId,
    "later same-cwd controller work reuses the durable workspace",
  );
  assert.ok(
    deferredWorkflow.evidence.some((item) => item.kind === "workspace-reused-for-tabs"),
    "workspace reuse is durable evidence rather than implicit topology",
  );
  assert.match(
    deferredWorkflow.eventControllerRegistration.reason,
    /(?:plugin config-dir failed|plugin_not_linked)/,
    "pending record retains the unavailable plugin/config reason",
  );
  assert.equal(
    JSON.parse(await readFile(controllerConfigPath, "utf8")).orchestrators[0].workflows.length,
    3,
    "deferral never changes existing controller workflow mappings",
  );
  controllerPluginAvailable = true;
  const recoveredDeferred = await tools
    .get("herdr_observe")
    .execute(
      "recover-deferred-controller-registration",
      { workflowId: deferredPlan.details.workflow.id },
      undefined,
      undefined,
      headlessRootCtx,
    );
  assert.equal(
    recoveredDeferred.details.workflow.eventControllerRegistration.status,
    "registered",
    "root observation retries a durable pending controller registration",
  );
  assert.equal(
    JSON.parse(await readFile(controllerConfigPath, "utf8")).orchestrators[0].workflows.length,
    4,
    "recovered registration adds only its deferred workflow mapping",
  );
  delete process.env.HERDR_ORCHESTRATOR_ROOT;

  const closeWorkflowId = genericWorkflowId;
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const closeWorkflow = manifest.workflows.find(
    (item) => item.id === closeWorkflowId,
  );
  closeWorkflow.status = "completed";
  closeWorkflow.outcome = "completed";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const childClose = await tools
    .get("herdr_close")
    .execute(
      "child-close",
      { workflowId: closeWorkflowId, evidence: ["smoke"], execute: true },
      undefined,
      undefined,
      ctx,
    );
  const repeatedChildClose = await tools
    .get("herdr_close")
    .execute(
      "child-close-repeat",
      { workflowId: closeWorkflowId, evidence: ["smoke"], execute: true },
      undefined,
      undefined,
      ctx,
    );
  assert.equal(childClose.details.parentApprovalRequired, true);
  assert.equal(repeatedChildClose.details.parentApprovalRequired, true);
  assert.equal(confirmationCalls, 0, "child close opens no confirmation UI");
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const requestedClose = manifest.workflows.find(
    (item) => item.id === closeWorkflowId,
  );
  assert.equal(
    requestedClose.approvalRequests.length,
    1,
    "child close is deduplicated",
  );
  assert.equal(requestedClose.approvalRequests[0].action, "close");
  assert.equal(
    requestedClose.approvalRequests[0].status,
    "parent-approval-required",
  );
  assert.ok(
    !calls.some((args) => args[0] === "workspace" && args[1] === "close"),
    "child close does not close a workspace",
  );
  process.env.HERDR_ORCHESTRATOR_ROOT = "1";
  const rootClose = await tools
    .get("herdr_close")
    .execute(
      "root-close",
      { workflowId: closeWorkflowId, evidence: ["smoke"], execute: true },
      undefined,
      undefined,
      ctx,
    );
  assert.equal(rootClose.details.closed, true);
  assert.equal(
    confirmationCalls,
    1,
    "closure remains non-autonomous and requires explicit root confirmation",
  );
  assert.ok(
    !calls.some((args) => args[0] === "workspace" && args[1] === "close"),
    "confirmed close retains a workspace still referenced by another workflow",
  );
  assert.ok(
    rootClose.details.workflow.evidence.some(
      (item) => item.kind === "workspace-retained-for-other-workflows",
    ),
    "retained shared workspace has durable cleanup evidence",
  );
  const configAfterClose = JSON.parse(
    await readFile(controllerConfigPath, "utf8"),
  );
  assert.deepEqual(
    configAfterClose.orchestrators[0].workflows.map((item) => item.workflow_id),
    [workflowId, persistedStalePlan.details.workflow.id, deferredPlan.details.workflow.id],
    "successful close removes only its registered workflow mapping",
  );
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(
    manifest.workflows.find((item) => item.id === closeWorkflowId)
      .eventControllerRegistration.status,
    "removed",
    "successful close durably records controller mapping removal",
  );
} finally {
  if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = previousHerdrEnv;
  if (previousRootEnv === undefined) delete process.env.HERDR_ORCHESTRATOR_ROOT;
  else process.env.HERDR_ORCHESTRATOR_ROOT = previousRootEnv;
  if (previousPaneEnv === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = previousPaneEnv;
  await rm(testCwd, { recursive: true, force: true });
}

process.stdout.write("herdr-orchestrator smoke check passed\n");
