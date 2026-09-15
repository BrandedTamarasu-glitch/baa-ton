import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { codexLaunchAdapter, CODEX_PROVIDER } = await jiti.import(
  "../codex-launch-adapter.ts",
);
const here = dirname(fileURLToPath(import.meta.url));
const helperPath = join(here, "..", "codex-startup-attest.mjs");
const profile = {
  provider: CODEX_PROVIDER,
  model: "gpt-5.6-luna",
  thinking: "xhigh",
  auth: "subscription",
};

test("codex launchArguments wires model, effort, notify, mcp env, and handshake", () => {
  const adapter = codexLaunchAdapter({
    bridge: "/bridge/mcp-server.mjs",
    attestHelper: "/bridge/codex-startup-attest.mjs",
  });
  adapter.preflight(profile);
  const args = adapter.launchArguments(profile, "/src/index.ts", {
    startupIntentPath: "/intents/lane.json",
  });
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-luna");
  assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
  const effort = args[args.indexOf("-c") + 1];
  assert.match(effort, /^model_reasoning_effort=xhigh$/);
  const flat = args.join(" ");
  assert.match(flat, /notify=\["node","\/bridge\/codex-startup-attest\.mjs"\]/);
  assert.match(
    flat,
    /mcp_servers\.herdr-orchestrator\.env\.BAA_STARTUP_INTENT="\/intents\/lane\.json"/,
  );
  assert.equal(args[args.length - 1], "Reply with exactly: READY");
  assert.throws(
    () => adapter.launchArguments(profile, "/src/index.ts"),
    /startup intent path/,
  );
});

test("codex preflight rejects foreign providers", () => {
  const adapter = codexLaunchAdapter({ bridge: "/b.js", attestHelper: "/a.js" });
  assert.throws(
    () => adapter.preflight({ ...profile, provider: "claude-code" }),
    /openai-codex subscription launch adapter/,
  );
});

test("codex verifyStartup binds thread identity for id and path sessions", () => {
  const adapter = codexLaunchAdapter({ bridge: "/b.js", attestHelper: "/a.js" });
  const attestation = {
    paneId: "w17:p9",
    workspaceId: "w17",
    nonce: "n",
    source: "/src/index.ts",
    profile,
    sessionId: "01a0a686-0a6d",
    operations: ["plan", "dispatch", "complete", "junk"],
  };
  const byId = adapter.verifyStartup(
    {
      agent: "codex",
      pane_id: "w17:p9",
      workspace_id: "w17",
      agent_session: { kind: "id", value: "01a0a686-0a6d" },
    },
    attestation,
  );
  assert.equal(byId.session.kind, "id");
  assert.deepEqual(byId.operations, ["plan", "dispatch", "complete"]);
  const byPath = adapter.verifyStartup(
    {
      agent: "codex",
      pane_id: "w17:p9",
      workspace_id: "w17",
      agent_session: {
        kind: "path",
        value: "/~/.codex/sessions/2026/09/15/rollout-01a0a686-0a6d.jsonl",
      },
    },
    attestation,
  );
  assert.equal(byPath.session.kind, "path");
  assert.throws(
    () =>
      adapter.verifyStartup(
        {
          agent: "codex",
          pane_id: "w17:p9",
          workspace_id: "w17",
          agent_session: { kind: "id", value: "some-other-thread" },
        },
        attestation,
      ),
    /does not match native identity/,
  );
});

test("codex rollout fallback fences identity when Herdr exposes no agent_session", async () => {
  const root = await mkdtemp(join(tmpdir(), "baa-codex-sessions-"));
  try {
    const day = join(root, "2026", "09", "15");
    await mkdir(day, { recursive: true });
    const threadId = "01a0a697-9dcc-4f1e";
    const rollout = join(day, `rollout-2026-09-15T12-00-00-${threadId}.jsonl`);
    await writeFile(rollout, "{}", { mode: 0o600 });
    const adapter = codexLaunchAdapter({
      bridge: "/b.js",
      attestHelper: "/a.js",
      sessionRoot: root,
    });
    const attestation = {
      paneId: "w17:p9",
      workspaceId: "w17",
      nonce: "n",
      source: "/src/index.ts",
      profile,
      sessionId: threadId,
      operations: ["plan", "complete"],
    };
    const native = {
      agent: "codex",
      pane_id: "w17:p9",
      workspace_id: "w17",
      // Herdr 0.9.0 codex agents expose no agent_session at all.
    };
    const proof = adapter.verifyStartup(native, attestation);
    assert.equal(proof.session.kind, "path");
    assert.equal(proof.session.value, rollout);
    await writeFile(
      join(day, `rollout-2026-09-15T13-00-00-${threadId}.jsonl`),
      "{}",
      { mode: 0o600 },
    );
    assert.throws(
      () => adapter.verifyStartup(native, attestation),
      /no durable rollout/,
    );
    await rm(rollout, { force: true });
    await rm(join(day, `rollout-2026-09-15T13-00-00-${threadId}.jsonl`), {
      force: true,
    });
    assert.throws(
      () => adapter.verifyStartup(native, attestation),
      /no durable rollout/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("codex notify helper attests thread identity and fails closed on binding mismatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-codex-helper-"));
  try {
    const intentPath = join(directory, "intent.json");
    await writeFile(
      intentPath,
      JSON.stringify({
        version: 1,
        nonce: "nonce-9",
        paneId: "w17:p9",
        workspaceId: "w17",
        source: "/src/index.ts",
        profile,
      }),
      { mode: 0o600 },
    );
    const run = (paneId, payload) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [helperPath, payload], {
          env: {
            ...process.env,
            BAA_STARTUP_INTENT: intentPath,
            HERDR_PANE_ID: paneId,
            HERDR_WORKSPACE_ID: "w17",
          },
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(stderr || `exit ${code}`)),
        );
      });
    await run(
      "w17:p9",
      JSON.stringify({
        type: "agent-turn-complete",
        "thread-id": "01a0a686-0a6d",
        cwd: "/repo",
      }),
    );
    const ready = JSON.parse(await readFile(`${intentPath}.ready`, "utf8"));
    assert.equal(ready.harness, "codex");
    assert.equal(ready.sessionId, "01a0a686-0a6d");
    assert.equal(ready.nonce, "nonce-9");
    await assert.rejects(
      run(
        "w17:p8",
        JSON.stringify({ type: "agent-turn-complete", "thread-id": "x" }),
      ),
      /pane\/workspace/,
    );
    await assert.rejects(
      run("w17:p9", JSON.stringify({ type: "other-event" })),
      /session identity/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
