import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleHook } from "../../controller/controller.mjs";
import { readStore, storePath } from "../inbox/index.mjs";

function event(status, paneId = "root:p2") {
  return {
    event: "pane_agent_status_changed",
    data: {
      type: "pane_agent_status_changed",
      pane_id: paneId,
      workspace_id: "root",
      agent_status: status,
    },
  };
}

async function fixture({ blocked = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-queue-controller-"));
  const manifestPath = join(directory, "task", ".baa-ton", "herdr-orchestrator", "manifest.json");
  const stateDir = join(directory, "state");
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const origin = {
    version: 1, id: "queue-aaaaaaaa", objective: "Finished predecessor",
    files: ["src/old.ts"], after: [], state: "landed",
    createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:01.000Z",
    workflowId: "workflow-queue",
  };
  const blocker = {
    version: 1, id: "queue-bbbbbbbb", objective: "Still running overlap",
    files: ["src/shared.ts"], after: [], state: "dispatched",
    createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:01.000Z",
  };
  const head = {
    version: 1, id: "queue-cccccccc", objective: "Dispatch the next queue change",
    files: [blocked ? "src/shared.ts" : "src/new.ts"], after: [], state: "pending",
    createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:01.000Z",
  };
  const manifest = {
    version: 2,
    parentGoal: {
      version: 1, id: "parent-queue", objective: "Work the queue",
      status: "waiting-for-event", nextAction: "Wait for a durable event.", signals: [],
      createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z",
    },
    queue: { version: 1, items: blocked ? [origin, blocker, head] : [origin, head] },
    workflows: [{
      id: "workflow-queue", status: "completed", outcome: "completed",
      queueItemId: origin.id, ownership: { createdBy: "herdr-orchestrator" },
      lanes: [{
        id: "lane-1", paneId: "root:p2", status: "completed",
        completionReceipt: { id: "incarnation-1", summary: "done", delivery: "delivered" },
      }],
    }],
  };
  const root = { target: "root:p1", target_kind: "pane_id", pane_id: "root:p1", workspace_id: "root", agent_kind: "pi" };
  const child = { lane_id: "lane-1", target: "root:p2", target_kind: "pane_id", pane_id: "root:p2", workspace_id: "root" };
  const config = {
    version: 2, owner: "herdr-orchestrator",
    orchestrators: [{
      id: "root", root, program: { id: join(directory, "task"), workspace_id: "root", parent_manifest_path: manifestPath },
      workflows: [{ workflow_id: "workflow-queue", manifest_path: manifestPath, lanes: [child] }],
    }],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(stateDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const prompts = [];
  const herdr = {
    async request(method, params) {
      if (method === "agent.get")
        return { type: "agent_info", agent: {
          agent: "pi", name: "root", pane_id: params.target, workspace_id: "root", agent_status: "idle",
        } };
      if (method === "agent.prompt") { prompts.push(params.text); return {}; }
      if (method === "pane.report_metadata") return {};
      throw new Error(`Unexpected controller method ${method}`);
    },
  };
  return {
    stateDir, manifestPath, prompts, herdr,
    async manifest() { return JSON.parse(await readFile(manifestPath, "utf8")); },
    async cleanup() { await rm(directory, { recursive: true, force: true }); },
  };
}

test("a landed queue workflow sends one clear-head review wake with a stable logical key", async () => {
  const f = await fixture();
  try {
    const first = await handleHook({ eventName: "pane.agent_status_changed", eventJson: event("done"), stateDir: f.stateDir, configDir: f.stateDir, herdr: f.herdr });
    const second = await handleHook({ eventName: "pane.agent_status_changed", eventJson: event("done"), stateDir: f.stateDir, configDir: f.stateDir, herdr: f.herdr });
    assert.equal(first.queueWake.status, "delivered");
    assert.equal(second.queueWake.deduplicated, true);
    assert.equal(f.prompts.length, 1);
    assert.match(f.prompts[0], /queue head now dispatchable: queue-cccccccc dispatch-next-queue-change/);
    assert.equal((await f.manifest()).parentGoal.status, "review-requested");
    const inbox = await readStore(storePath({ stateDir: f.stateDir }));
    assert.equal(inbox.messages.filter((message) => message.envelope.message.type === "queue-head").length, 1);
    assert.equal(inbox.messages.find((message) => message.envelope.message.type === "queue-head").logical_key.startsWith("queue-head:root:"), true);
  } finally {
    await f.cleanup();
  }
});

test("a queue head blocked by an undischarged overlapping item does not wake", async () => {
  const f = await fixture({ blocked: true });
  try {
    const result = await handleHook({ eventName: "pane.agent_status_changed", eventJson: event("done"), stateDir: f.stateDir, configDir: f.stateDir, herdr: f.herdr });
    assert.equal(result.queueWake.status, "blocked");
    assert.deepEqual(result.queueWake.blockers.files, [{ itemId: "queue-bbbbbbbb", files: ["src/shared.ts"] }]);
    assert.deepEqual(f.prompts, []);
    assert.equal((await f.manifest()).parentGoal.status, "waiting-for-event");
  } finally {
    await f.cleanup();
  }
});
