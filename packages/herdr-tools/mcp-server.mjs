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
import { Value } from "typebox/value";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const createJiti = require("jiti");
const jiti = createJiti(fileURLToPath(import.meta.url), {
  alias: { typebox: require.resolve("typebox") },
});
const extension = await jiti.import(join(root, "index.ts"));

// The bridge must expose the same installed model registry the interactive
// runtime uses, so launch-profile preflight validates against real catalog
// and auth state instead of a fabricated context. The package exports map
// does not expose internals, so resolve them by absolute file path.
const { existsSync } = await import("node:fs");
let packageRoot = null;
for (let dir = root; dir !== dirname(dir); dir = dirname(dir)) {
  const candidate = join(
    dir,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  if (existsSync(join(candidate, "package.json"))) {
    packageRoot = candidate;
    break;
  }
}
if (!packageRoot)
  throw new Error(
    "pi-coding-agent package not found for the MCP bridge model registry.",
  );
const { pathToFileURL } = await import("node:url");
const importDist = (name) =>
  import(pathToFileURL(join(packageRoot, "dist", name)).href);
const { ModelRuntime } = await importDist("core/model-runtime.js");
const { ModelRegistry } = await importDist("core/model-registry.js");
const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
const modelRegistry = new ModelRegistry(modelRuntime);
await modelRegistry.refresh();
const tools = new Map();
extension.default({
  on() {},
  registerTool(definition) {
    if (definition.name.startsWith("herdr_"))
      tools.set(definition.name, definition);
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
      child.on("error", (error) =>
        resolveResult({ stdout, stderr: error.message, code: 1 }),
      );
    });
    return result;
  },
});

const ctx = {
  get cwd() {
    return process.cwd();
  },
  mode: "json",
  hasUI: false,
  modelRegistry,
  ui: {
    confirm: async () => false,
    notify: () => {},
  },
};

/** When spawned as a dispatched lane's MCP server, merge the live protocol
 * operations into the lane's startup attestation. The host harness's
 * SessionStart hook merges session identity into the same file; both merge
 * atomically, so write order does not matter. */
if (process.env.BAA_STARTUP_INTENT && process.env.HERDR_ENV === "1") {
  const { mergeAttestation } = await import(join(root, "attest-merge.mjs"));
  const { mapPiToolNamesToProtocolOperations } = await jiti.import(
    join(root, "pi-launch-adapter.ts"),
  );
  try {
    await mergeAttestation(process.env.BAA_STARTUP_INTENT, {
      operations: mapPiToolNamesToProtocolOperations([...tools.keys()]),
    });
  } catch (error) {
    console.error(
      `startup-attestation merge failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

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
    try {
      request = JSON.parse(line);
    } catch {
      error(null, -32700, "Invalid JSON-RPC request.");
      continue;
    }
    const { id, method, params = {} } = request;
    if (method === "initialize") {
      result(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "herdr-orchestrator", version: "0.1.0" },
      });
    } else if (method === "notifications/initialized") {
      // JSON-RPC notification: intentionally no response.
    } else if (method === "tools/list") {
      result(id, {
        tools: isHerdrSession() ? [...tools.values()].map(toolDefinition) : [],
      });
    } else if (method === "tools/call") {
      if (!isHerdrSession()) {
        result(id, {
          content: [
            {
              type: "text",
              text: "Herdr Orchestrator tools are available only inside a HERDR_ENV=1 session.",
            },
          ],
          isError: true,
        });
        continue;
      }
      const definition = tools.get(params.name);
      if (!definition) {
        error(id, -32602, `Unknown tool: ${params.name}`);
        continue;
      }
      const args = params.arguments ?? {};
      // Every harness must see the same validated surface: reject arguments
      // outside the tool's declared schema (an out-of-enum action, a missing
      // required field) before it ever reaches the shared execute path,
      // instead of letting the implementation's own ad hoc checks decide.
      if (!Value.Check(definition.parameters, args)) {
        const issues = [...Value.Errors(definition.parameters, args)]
          .slice(0, 5)
          .map((issue) => `${issue.path || "(root)"} ${issue.message}`)
          .join("; ");
        result(id, {
          content: [
            {
              type: "text",
              text: `Invalid arguments for ${params.name}: ${issues || "schema validation failed"}`,
            },
          ],
          isError: true,
        });
        continue;
      }
      try {
        const output = await definition.execute(
          "mcp",
          args,
          undefined,
          undefined,
          ctx,
        );
        result(id, {
          content: output.content ?? [],
          structuredContent: output.details,
        });
      } catch (caught) {
        result(id, {
          content: [
            {
              type: "text",
              text: caught instanceof Error ? caught.message : String(caught),
            },
          ],
          isError: true,
        });
      }
    } else {
      error(id, -32601, `Unsupported method: ${method}`);
    }
  }
});
