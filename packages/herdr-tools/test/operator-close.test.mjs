import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "baa-operator-close-"));
  const cwd = join(directory, "checkout");
  const configDir = join(directory, "config");
  const manifestDir = join(cwd, ".pi", "herdr-orchestrator");
  const manifestPath = join(manifestDir, "manifest.json");
  const workflowId = "workflow-receipt-blocked";
  const laneId = "lane-1";
  const root = {
    target: "root-pane",
    target_kind: "pane_id",
    pane_id: "root-pane",
    workspace_id: "workspace-1",
    agent_kind: "pi",
  };
  const lane = {
    lane_id: laneId,
    target: "child-pane",
    target_kind: "pane_id",
    pane_id: "child-pane",
    workspace_id: "workspace-1",
    relationship_id: "relationship-1",
  };
  await mkdir(manifestDir, { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        version: 2,
        workflows: [
          {
            id: workflowId,
            objective: "Reconcile the verified codex lane.",
            outcome: "unknown",
            status: "completion-reported",
            lanes: [
              {
                id: laneId,
                objective: "Finish the verified work.",
                readOnly: false,
                agentKind: "codex",
                status: "done",
                relationshipId: lane.relationship_id,
              },
            ],
            herdr: {},
            agent: {},
            agentKind: "codex",
            cwd,
            worktree: null,
            goalSchemaVersion: 1,
            rootGoalId: `goal-${workflowId}`,
            goals: [],
            evidence: [],
            ownership: {
              createdBy: "herdr-orchestrator",
              workspaceId: root.workspace_id,
              tabIds: [],
              paneIds: [lane.pane_id],
            },
            createdAt: "2026-09-15T00:00:00.000Z",
            updatedAt: "2026-09-15T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(configDir, "config.json"),
    `${JSON.stringify(
      {
        version: 2,
        owner: "herdr-orchestrator",
        orchestrators: [
          {
            id: "operator-test-root",
            root,
            program: {
              id: cwd,
              workspace_id: root.workspace_id,
              parent_manifest_path: manifestPath,
            },
            workflows: [
              {
                workflow_id: workflowId,
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
  return { directory, cwd, configDir, manifestPath, workflowId, laneId, root, lane };
}

function setupEnvironment(fixture) {
  const keys = [
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_PLUGIN_CONFIG_DIR",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: fixture.root.pane_id,
    HERDR_WORKSPACE_ID: fixture.root.workspace_id,
    HERDR_PLUGIN_CONFIG_DIR: fixture.configDir,
  });
  return () => {
    for (const [key, value] of Object.entries(saved))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
  };
}

function registeredTools() {
  const tools = new Map();
  extension({
    on() {},
    registerTool(descriptor) {
      tools.set(descriptor.name, descriptor);
    },
    registerCommand() {},
    async exec() {
      throw new Error("operator closure must not call native Herdr");
    },
  });
  return tools;
}

const context = (cwd) => ({ cwd, hasUI: false, mode: "json", modelRegistry: {} });

test("operator closure records reconciliation explicitly without a lane receipt", async () => {
  const fixtureData = await fixture();
  const restore = setupEnvironment(fixtureData);
  try {
    const result = await registeredTools()
      .get("herdr_operator_close")
      .execute(
        "operator-close",
        {
          workflowId: fixtureData.workflowId,
          laneId: fixtureData.laneId,
          who: "zach",
          why: "The Codex bridge died after the parent verified and committed the work.",
          evidence: ["parent commit d3816c8", "focused tests 17/17 passed"],
        },
        undefined,
        undefined,
        context(fixtureData.cwd),
      );
    assert.equal(result.details.operatorClosed, true);
    assert.equal(result.details.laneCompletionReceiptRecorded, false);
    assert.equal(result.details.workflow.outcome, "operator-closed");
    assert.equal(result.details.workflow.status, "operator-closed");
    assert.equal(result.details.workflow.lanes[0].status, "operator-closed");
    assert.equal(result.details.workflow.lanes[0].completionReceipt, undefined);
    assert.deepEqual(result.details.operatorClosure.evidence, [
      "parent commit d3816c8",
      "focused tests 17/17 passed",
    ]);
    assert.match(
      result.details.workflow.evidence.at(-1).text,
      /receipt.*not recorded/i,
    );
    const stored = JSON.parse(await readFile(fixtureData.manifestPath, "utf8"));
    assert.equal(stored.workflows[0].operatorClosure.who, "zach");
    assert.equal(stored.workflows[0].lanes[0].completionReceipt, undefined);
  } finally {
    restore();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("operator closure is root-only, idempotent, and rejects receipt impersonation", async () => {
  const fixtureData = await fixture();
  const restore = setupEnvironment(fixtureData);
  try {
    const tools = registeredTools();
    const params = {
      workflowId: fixtureData.workflowId,
      laneId: fixtureData.laneId,
      who: "zach",
      why: "Verified parent-side reconciliation.",
      evidence: ["commit d3816c8"],
    };
    const first = await tools
      .get("herdr_operator_close")
      .execute("operator-close-1", params, undefined, undefined, context(fixtureData.cwd));
    const second = await tools
      .get("herdr_operator_close")
      .execute("operator-close-2", params, undefined, undefined, context(fixtureData.cwd));
    assert.equal(second.details.operatorClosure.id, first.details.operatorClosure.id);
    assert.equal(
      JSON.parse(await readFile(fixtureData.manifestPath, "utf8"))
        .workflows[0].evidence.filter((entry) => entry.kind === "operator-closure").length,
      1,
    );

    const child = { ...fixtureData.lane, pane_id: "child-pane" };
    await writeFile(
      join(fixtureData.configDir, "config.json"),
      JSON.stringify({
        version: 2,
        owner: "herdr-orchestrator",
        orchestrators: [
          {
            id: "operator-test-root",
            root: fixtureData.root,
            program: { id: fixtureData.cwd, workspace_id: fixtureData.root.workspace_id },
            workflows: [{
              workflow_id: fixtureData.workflowId,
              manifest_path: fixtureData.manifestPath,
              lanes: [child],
            }],
          },
        ],
      }),
    );
    process.env.HERDR_PANE_ID = child.pane_id;
    await assert.rejects(
      tools
        .get("herdr_operator_close")
        .execute("operator-close-child", params, undefined, undefined, context(fixtureData.cwd)),
      /verified controller-mapped root/,
    );
  } finally {
    restore();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("operator closure refuses to replace an existing lane completion receipt", async () => {
  const fixtureData = await fixture();
  const restore = setupEnvironment(fixtureData);
  try {
    const manifest = JSON.parse(await readFile(fixtureData.manifestPath, "utf8"));
    manifest.workflows[0].lanes[0].completionReceipt = {
      id: "lane-receipt-1",
      summary: "already complete",
      delivery: "pending",
    };
    await writeFile(fixtureData.manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      registeredTools()
        .get("herdr_operator_close")
        .execute(
          "operator-close-receipt",
          {
            workflowId: fixtureData.workflowId,
            laneId: fixtureData.laneId,
            who: "zach",
            why: "Attempted reconciliation after a receipt was already stored.",
            evidence: ["lane receipt exists"],
          },
          undefined,
          undefined,
          context(fixtureData.cwd),
        ),
      /cannot replace or duplicate an existing lane completion receipt/i,
    );
  } finally {
    restore();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});
