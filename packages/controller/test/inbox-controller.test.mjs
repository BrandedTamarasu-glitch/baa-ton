import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { handleHook } from "../controller.mjs";
import { readStore, storePath } from "../../herdr-tools/inbox/index.mjs";

test("controller persists one coalesced lifecycle inbox message before a wake", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-controller-inbox-"));
  const stateDir = join(directory, "state");
  const manifestPath = join(directory, "workflow", "manifest.json");
  const root = {
    target: "herdr-root",
    target_kind: "name",
    agent_kind: "pi",
    pane_id: "w-shared:root",
    workspace_id: "w-shared",
  };
  const lane = {
    lane_id: "lane-1",
    target: "herdr-child",
    target_kind: "name",
    pane_id: "w-shared:child",
    workspace_id: "w-shared",
  };
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
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
              workspaceId: "w-shared",
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
        version: 1,
        owner: "herdr-orchestrator",
        root,
        workflows: [{ workflow_id: "workflow-1", manifest_path: manifestPath, lanes: [lane] }],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const requests = [];
  const herdr = {
    async request(method, params) {
      requests.push({ method, params });
      if (method === "agent.get")
        return {
          type: "agent_info",
          agent: {
            agent: "pi",
            name: root.target,
            pane_id: root.pane_id,
            workspace_id: root.workspace_id,
          },
        };
      if (method === "agent.prompt") return {};
      throw new Error(`Unexpected Herdr method ${method}`);
    },
  };
  const event = {
    event: "pane_agent_status_changed",
    data: {
      type: "pane_agent_status_changed",
      pane_id: lane.pane_id,
      workspace_id: lane.workspace_id,
      agent_status: "done",
      agent: "pi",
    },
  };
  try {
    const first = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: event,
      stateDir,
      configDir: stateDir,
      herdr,
    });
    const second = await handleHook({
      eventName: "pane.agent_status_changed",
      eventJson: event,
      stateDir,
      configDir: stateDir,
      herdr,
    });
    assert.equal(first.record.wake.status, "delivered");
    assert.equal(second.deduplicated, true);
    assert.equal(requests.filter(({ method }) => method === "agent.prompt").length, 1);
    const inbox = await readStore(storePath({ stateDir }));
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0].envelope.protocol, "herdr-link/1");
    assert.equal(inbox.messages[0].envelope.message.type, "lifecycle-event");
    assert.equal(inbox.messages[0].states.stored.at !== undefined, true);
    assert.equal(inbox.messages[0].states.notified.at !== undefined, true);
    assert.equal(inbox.wake_hints.length, 1, "repeated wake hints are coalesced");
    assert.deepEqual(inbox.wake_hints[0].occurrence_ids, [inbox.messages[0].occurrence_id]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
