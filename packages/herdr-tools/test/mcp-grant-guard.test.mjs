import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { referencedMcpServers, assertMcpServersGranted } = await jiti.import("../index.ts");

// Regression coverage for the bug that produced this guard: 9 dispatched
// lanes were planned referencing mcp__claude_ai_CIC_Connect_MCP_-_Desktop__*
// tools with no matching mcpServers entry. --strict-mcp-config scopes each
// lane to herdr-orchestrator plus whatever mcpServers lists, so all 9 failed
// closed identically instead of being caught at plan time.

test("referencedMcpServers extracts server keys from mcp__<server>__<tool> references", () => {
  assert.deepEqual(
    referencedMcpServers(
      "Call mcp__claude_ai_CIC_Connect_MCP_-_Desktop__ticket_get_full_context, " +
        "then mcp__claude_ai_CIC_Connect_MCP_-_Desktop__ticket_attachments_list.",
    ),
    ["claude_ai_CIC_Connect_MCP_-_Desktop"],
  );
});

test("referencedMcpServers ignores the always-available herdr-orchestrator server", () => {
  assert.deepEqual(referencedMcpServers("Use mcp__herdr-orchestrator__herdr_message."), []);
});

test("referencedMcpServers returns nothing for an objective naming no MCP tools", () => {
  assert.deepEqual(referencedMcpServers("Fix the off-by-one in the paginator."), []);
});

test("assertMcpServersGranted throws when the objective names a server not granted", () => {
  assert.throws(
    () =>
      assertMcpServersGranted(
        "lane-6",
        "Call mcp__claude_ai_CIC_Connect_MCP_-_Desktop__ticket_get_full_context on ticketId X.",
        undefined,
      ),
    /Lane lane-6 objective references mcp__claude_ai_CIC_Connect_MCP_-_Desktop__\* tools, but mcpServers does not grant "claude_ai_CIC_Connect_MCP_-_Desktop"/,
  );
});

test("assertMcpServersGranted passes once the referenced server is granted", () => {
  assert.doesNotThrow(() =>
    assertMcpServersGranted(
      "lane-6",
      "Call mcp__gsd-tickets__ticket_get_full_context on ticketId X.",
      { "gsd-tickets": { type: "http", url: "https://example.test/mcp" } },
    ),
  );
});

test("assertMcpServersGranted passes for an objective that names no MCP tools", () => {
  assert.doesNotThrow(() =>
    assertMcpServersGranted("lane-1", "Fix the off-by-one in the paginator.", undefined),
  );
});
