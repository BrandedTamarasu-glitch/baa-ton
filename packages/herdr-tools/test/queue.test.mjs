import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { default: extension } = await jiti.import("../index.ts");

async function fixture({ queue = [], workflows = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-queue-"));
  const cwd = join(directory, "task");
  const configDir = join(directory, "config");
  const manifestDir = join(cwd, ".baa-ton", "herdr-orchestrator");
  const manifestPath = join(manifestDir, "manifest.json");
  const root = {
    target: "w1:p1",
    target_kind: "pane_id",
    pane_id: "w1:p1",
    workspace_id: "w1",
    agent_kind: "pi",
  };
  await mkdir(manifestDir, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    manifestPath,
    `${JSON.stringify({ version: 2, workflows, ...(queue ? { queue: { version: 1, items: queue } } : {}) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(configDir, "config.json"),
    `${JSON.stringify({
      version: 2,
      owner: "herdr-orchestrator",
      orchestrators: [{
        id: "root",
        root,
        program: { id: cwd, workspace_id: "w1" },
        workflows: [],
      }],
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const saved = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONFIG_DIR"].map(
      (key) => [key, process.env[key]],
    ),
  );
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: root.pane_id,
    HERDR_WORKSPACE_ID: root.workspace_id,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
  });
  await writeFile(join(cwd, "root-session.jsonl"), JSON.stringify({ type: "session", id: "01a0b04d-0bef-7207-b486-d51d62f0e3dc", cwd }) + "\n");
  const tools = new Map();
  extension({
    on() {},
    registerTool(descriptor) { tools.set(descriptor.name, descriptor); },
    registerCommand() {},
    async exec(_command, args) {
      if (args[0] === "agent" && args[1] === "get")
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({ result: {
            type: "agent_info",
            agent: {
              agent: "pi",
              name: "root",
              pane_id: args[2],
              workspace_id: "w1",
              agent_session: { kind: "path", value: join(cwd, "root-session.jsonl") },
            },
          } }),
        };
      throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
    },
  });
  return {
    cwd,
    manifestPath,
    configDir,
    tools,
    ctx: { cwd, hasUI: false, mode: "json", sessionManager: { getSessionId: () => "01a0b04d-0bef-7207-b486-d51d62f0e3dc", getSessionFile: () => join(cwd, "root-session.jsonl") } },
    activate() {
      Object.assign(process.env, {
        HERDR_ENV: "1",
        HERDR_PANE_ID: root.pane_id,
        HERDR_WORKSPACE_ID: root.workspace_id,
        HERDR_PLUGIN_CONFIG_DIR: configDir,
      });
    },
    async manifest() { return JSON.parse(await readFile(manifestPath, "utf8")); },
    async cleanup() {
      for (const [key, value] of Object.entries(saved))
        value === undefined ? delete process.env[key] : (process.env[key] = value);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const call = (fixture, name, params) =>
  fixture.tools.get(name).execute(name, params, undefined, undefined, fixture.ctx);

function itemFrom(result) {
  return result.details.queueItem ?? result.details.item ?? result.details.head;
}

test("queue enqueue is durable, versioned, and deduplicates a recent objective", async () => {
  const f = await fixture({ queue: [] });
  try {
    const first = await call(f, "herdr_queue", {
      action: "enqueue",
      objective: "Implement the queue",
      files: ["packages/herdr-tools/index.ts"],
      notes: "Keep the root in charge.",
    });
    const second = await call(f, "herdr_queue", {
      action: "enqueue",
      objective: "Implement the queue",
    });
    assert.equal(second.details.deduplicated, true);
    assert.equal(first.details.queueItem.id, second.details.queueItem.id);
    const manifest = await f.manifest();
    assert.equal(manifest.queue.version, 1);
    assert.equal(manifest.queue.items.length, 1);
    assert.deepEqual(manifest.queue.items[0].files, ["packages/herdr-tools/index.ts"]);
    assert.equal(manifest.queue.items[0].state, "pending");
  } finally {
    await f.cleanup();
  }
});

test("queue dequeue preserves ordering and reports dependency/file blockers", async () => {
  const f = await fixture({ queue: [] });
  try {
    const first = itemFrom(await call(f, "herdr_queue", {
      action: "enqueue", objective: "First change", files: ["src/shared.ts"], notes: "Scope the first change.",
    }));
    const second = itemFrom(await call(f, "herdr_queue", {
      action: "enqueue", objective: "Second change", files: ["src/shared.ts"], after: [first.id],
    }));
    const firstPlan = await call(f, "herdr_plan", {
      queueItemId: first.id,
      lanes: ["Do the first change"],
    });
    assert.equal(firstPlan.details.workflow.objective, "First change");
    assert.equal(firstPlan.details.workflow.notes, "Scope the first change.");
    assert.ok(firstPlan.details.workflow.evidence.some((entry) => entry.text.includes(first.id)));
    const blocked = await call(f, "herdr_queue", { action: "dequeue" });
    assert.equal(blocked.details.item, undefined);
    assert.deepEqual(blocked.details.blockers.dependencies, [{ id: first.id, state: "dispatched" }]);
    assert.deepEqual(blocked.details.blockers.files, [{ itemId: first.id, files: ["src/shared.ts"] }]);
    await call(f, "herdr_queue", { action: "update", queueItemId: first.id, state: "verified", evidence: "Reviewed first change." });
    await call(f, "herdr_queue", { action: "update", queueItemId: first.id, state: "landed", evidence: "First change landed." });
    const ready = await call(f, "herdr_queue", { action: "dequeue" });
    assert.equal(ready.details.item.id, second.id);
    assert.equal((await f.manifest()).queue.items[0].state, "landed");
  } finally {
    await f.cleanup();
  }
});

test("queues remain isolated to each root manifest", async () => {
  const first = await fixture({ queue: [] });
  const second = await fixture({ queue: [] });
  try {
    first.activate();
    const firstItem = itemFrom(await call(first, "herdr_queue", {
      action: "enqueue", objective: "Root one work",
    }));
    second.activate();
    const secondItem = itemFrom(await call(second, "herdr_queue", {
      action: "enqueue", objective: "Root two work",
    }));
    assert.equal((await first.manifest()).queue.items[0].id, firstItem.id);
    assert.equal((await first.manifest()).queue.items[0].objective, "Root one work");
    assert.equal((await second.manifest()).queue.items[0].id, secondItem.id);
    assert.equal((await second.manifest()).queue.items[0].objective, "Root two work");
  } finally {
    await second.cleanup();
    await first.cleanup();
  }
});

test("queue update records verified/landed and dropped evidence, and list exposes states", async () => {
  const f = await fixture({ queue: [] });
  try {
    const item = itemFrom(await call(f, "herdr_queue", {
      action: "enqueue", objective: "Drop this item",
    }));
    const dropped = await call(f, "herdr_queue", {
      action: "update", queueItemId: item.id, state: "dropped", evidence: "Superseded by existing work.",
    });
    assert.equal(dropped.details.queueItem.state, "dropped");
    assert.equal(dropped.details.queueItem.evidence, "Superseded by existing work.");
    const list = await call(f, "herdr_queue", { action: "list" });
    assert.equal(list.details.items[0].state, "dropped");
    assert.equal(list.details.blockers.dependencies.length, 0);
  } finally {
    await f.cleanup();
  }
});
