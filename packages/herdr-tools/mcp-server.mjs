#!/usr/bin/env node
/**
 * Local stdio MCP bridge for the Herdr Orchestrator workflow tools.
 *
 * It deliberately reuses the registered tool implementations so every harness
 * has the same validation, root gates, and durable manifest behavior. This
 * process is not a dispatcher or background worker.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const createJiti = require("jiti");
const jiti = createJiti(fileURLToPath(import.meta.url), {
  alias: { typebox: require.resolve("typebox") },
});
const extension = await jiti.import(join(root, "index.ts"));
const tools = new Map();
extension.default({
  on() {},
  registerTool(definition) {
    if (definition.name.startsWith("herdr_")) tools.set(definition.name, definition);
  },
  registerCommand() {},
  async exec(command, args) {
    const result = await new Promise((resolveResult) => {
      const child = require("node:child_process").spawn(command, args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolveResult({ stdout, stderr, code }));
      child.on("error", (error) => resolveResult({ stdout, stderr: error.message, code: 1 }));
    });
    return result;
  },
});

const ctx = {
  get cwd() { return process.cwd(); },
  mode: "json",
  hasUI: false,
  ui: {
    confirm: async () => false,
    notify: () => {},
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}
function isHerdrSession() {
  return process.env.HERDR_ENV === "1";
}
function toolDefinition(definition) {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.parameters,
  };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch { error(null, -32700, "Invalid JSON-RPC request."); continue; }
    const { id, method, params = {} } = request;
    if (method === "initialize") {
      result(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "herdr-orchestrator", version: "0.1.0" } });
    } else if (method === "notifications/initialized") {
      // JSON-RPC notification: intentionally no response.
    } else if (method === "tools/list") {
      result(id, { tools: isHerdrSession() ? [...tools.values()].map(toolDefinition) : [] });
    } else if (method === "tools/call") {
      if (!isHerdrSession()) {
        result(id, { content: [{ type: "text", text: "Herdr Orchestrator tools are available only inside a HERDR_ENV=1 session." }], isError: true });
        continue;
      }
      const definition = tools.get(params.name);
      if (!definition) { error(id, -32602, `Unknown tool: ${params.name}`); continue; }
      try {
        const output = await definition.execute("mcp", params.arguments ?? {}, undefined, undefined, ctx);
        result(id, { content: output.content ?? [], structuredContent: output.details });
      } catch (caught) {
        result(id, { content: [{ type: "text", text: caught instanceof Error ? caught.message : String(caught) }], isError: true });
      }
    } else {
      error(id, -32601, `Unsupported method: ${method}`);
    }
  }
});
