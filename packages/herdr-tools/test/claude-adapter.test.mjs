import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { claudeLaunchAdapter, CLAUDE_PERMISSION_PROMPT_TOOL, CLAUDE_PROVIDER } =
  await jiti.import("../claude-launch-adapter.ts");
const { mergeAttestation } = await import("../attest-merge.mjs");
const here = dirname(fileURLToPath(import.meta.url));
const helperPath = join(here, "..", "claude-startup-attest.mjs");
const profile = {
  provider: CLAUDE_PROVIDER,
  model: "claude-sonnet-5",
  thinking: "high",
  auth: "subscription",
};

test("launchArguments emits exact model/effort and generated settings/mcp config", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "baa-claude-adapter-"));
  try {
    const adapter = claudeLaunchAdapter({
      bridge: "/bridge/mcp-server.mjs",
      attestHelper: "/bridge/claude-startup-attest.mjs",
      scratchDirectory: scratch,
    });
    adapter.preflight(profile);
    assert.equal(adapter.startupHandshake, undefined);
    assert.equal(adapter.capabilities.supportsLiveCapabilityDiscovery, false);
    assert.equal(adapter.capabilities.supportsStartupHandshake, false);
    assert.equal(adapter.discoverCatalog, undefined);
    const args = adapter.launchArguments(profile);
    assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-5");
    assert.equal(args[args.indexOf("--effort") + 1], "high");
    const settings = JSON.parse(
      await readFile(args[args.indexOf("--settings") + 1], "utf8"),
    );
    const mcp = JSON.parse(
      await readFile(args[args.indexOf("--mcp-config") + 1], "utf8"),
    );
    assert.match(
      settings.hooks.SessionStart[0].hooks[0].command,
      /claude-startup-attest\.mjs/,
    );
    assert.ok(
      settings.permissions.deny.some((rule) => /^Bash\(git push/.test(rule)),
    );
    assert.ok(
      settings.permissions.deny.some((rule) => /^Bash\(git merge/.test(rule)),
    );
    assert.equal(
      mcp.mcpServers["herdr-orchestrator"].args[0],
      "/bridge/mcp-server.mjs",
    );
    assert.equal(args.includes("--permission-prompt-tool"), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("permission broker launch flag is opt-in and preserves the exact tool name", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "baa-claude-permission-"));
  try {
    const adapter = claudeLaunchAdapter({
      bridge: "/bridge/mcp-server.mjs",
      attestHelper: "/bridge/claude-startup-attest.mjs",
      scratchDirectory: scratch,
      permissionPromptTool: CLAUDE_PERMISSION_PROMPT_TOOL,
    });
    const args = adapter.launchArguments(profile);
    const flag = args.indexOf("--permission-prompt-tool");
    assert.equal(
      args.slice(flag, flag + 2).join(" "),
      `--permission-prompt-tool ${CLAUDE_PERMISSION_PROMPT_TOOL}`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("permission broker can be enabled by an explicit default-off environment opt-in", () => {
  const previous = process.env.BAA_CLAUDE_PERMISSION_PROMPT_TOOL;
  process.env.BAA_CLAUDE_PERMISSION_PROMPT_TOOL = "1";
  try {
    const adapter = claudeLaunchAdapter({
      bridge: "/b.js",
      attestHelper: "/a.js",
      scratchDirectory: "/tmp",
    });
    const args = adapter.launchArguments(profile);
    assert.deepEqual(
      args.slice(
        args.indexOf("--permission-prompt-tool"),
        args.indexOf("--permission-prompt-tool") + 2,
      ),
      ["--permission-prompt-tool", CLAUDE_PERMISSION_PROMPT_TOOL],
    );
  } finally {
    if (previous === undefined)
      delete process.env.BAA_CLAUDE_PERMISSION_PROMPT_TOOL;
    else process.env.BAA_CLAUDE_PERMISSION_PROMPT_TOOL = previous;
  }
});

test("permission broker rejects an empty opt-in value", () => {
  const adapter = claudeLaunchAdapter({
    bridge: "/b.js",
    attestHelper: "/a.js",
    scratchDirectory: "/tmp",
    permissionPromptTool: " ",
  });
  assert.throws(() => adapter.launchArguments(profile), /non-empty string/);
});

test("preflight rejects foreign providers", () => {
  const adapter = claudeLaunchAdapter({
    bridge: "/b.js",
    attestHelper: "/a.js",
    scratchDirectory: "/tmp",
  });
  assert.throws(
    () => adapter.preflight({ ...profile, provider: "openai-codex" }),
    /claude-code subscription launch adapter/,
  );
});

test("verifyStartup matches native session identity and filters unknown operations", () => {
  const adapter = claudeLaunchAdapter({
    bridge: "/b.js",
    attestHelper: "/a.js",
    scratchDirectory: "/tmp",
  });
  const native = {
    agent: "claude",
    pane_id: "w17:p9",
    workspace_id: "w17",
    agent_session: { kind: "path", value: "/claude/sessions/x.jsonl" },
  };
  const attestation = {
    paneId: "w17:p9",
    workspaceId: "w17",
    nonce: "n",
    source: "/source/index.ts",
    profile,
    sessionPath: "/claude/sessions/x.jsonl",
    operations: ["plan", "dispatch", "complete", "not-an-operation"],
  };
  const proof = adapter.verifyStartup(native, attestation);
  assert.equal(proof.session.kind, "path");
  assert.equal(proof.session.value, "/claude/sessions/x.jsonl");
  assert.deepEqual(proof.operations, ["plan", "dispatch", "complete"]);
  assert.throws(
    () =>
      adapter.verifyStartup(native, {
        ...attestation,
        sessionPath: "/claude/sessions/other.jsonl",
      }),
    /does not match native identity/,
  );
});

test("SessionStart helper merges lane identity and preserves bridge operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-claude-helper-"));
  try {
    const intentPath = join(directory, "intent.json");
    await writeFile(
      intentPath,
      JSON.stringify({
        version: 1,
        nonce: "nonce-1",
        paneId: "w17:p9",
        workspaceId: "w17",
        source: "/source/index.ts",
        profile,
      }),
      { mode: 0o600 },
    );
    // Bridge writes its operations first; the hook must preserve them.
    await mergeAttestation(intentPath, { operations: ["plan", "complete"] });
    const { spawn } = require("node:child_process");
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [helperPath], {
        env: {
          ...process.env,
          BAA_STARTUP_INTENT: intentPath,
          HERDR_PANE_ID: "w17:p9",
          HERDR_WORKSPACE_ID: "w17",
        },
      });
      child.stderr.on("data", (chunk) => reject(new Error(String(chunk))));
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
      );
      child.stdin.end(
        JSON.stringify({
          session_id: "abc",
          transcript_path: "/claude/projects/p/abc.jsonl",
        }),
      );
    });
    const ready = JSON.parse(await readFile(`${intentPath}.ready`, "utf8"));
    assert.equal(ready.sessionPath, "/claude/projects/p/abc.jsonl");
    assert.equal(ready.sessionId, "abc");
    assert.equal(ready.nonce, "nonce-1");
    assert.equal(ready.source, "/source/index.ts");
    assert.deepEqual(ready.profile, profile);
    assert.deepEqual(ready.operations, ["plan", "complete"]);
    // Wrong pane binding must fail closed.
    await assert.rejects(
      new Promise((_, reject) => {
        const child = spawn(process.execPath, [helperPath], {
          env: {
            ...process.env,
            BAA_STARTUP_INTENT: intentPath,
            HERDR_PANE_ID: "w17:p8",
            HERDR_WORKSPACE_ID: "w17",
          },
        });
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error("expected failure")),
        );
        child.stdin.end("{}");
      }),
      /expected failure/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
