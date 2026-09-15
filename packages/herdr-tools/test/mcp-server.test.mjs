import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "mcp-server.mjs");

async function withMcpServer(env, run) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: here,
    // Pin a neutral Herdr identity so behavior is identical whether the
    // suite runs from a lane pane or from the registered root pane; callers
    // may still override via `env`.
    env: {
      ...process.env,
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

// Converts the audit's "MCP argument validation" fault probe (an action
// outside the advertised herdr_goal enum was accepted rather than rejected)
// into a passing regression.
test("tools/call rejects arguments outside a tool's declared schema before it reaches execute", async () => {
  await withMcpServer({ HERDR_ENV: "1" }, async (rpc) => {
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

test("tools/call outside a Herdr session and unknown tools still fail predictably", async () => {
  await withMcpServer({ HERDR_ENV: "0" }, async (rpc) => {
    const outside = await rpc("tools/call", {
      name: "herdr_goal",
      arguments: { action: "status" },
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
