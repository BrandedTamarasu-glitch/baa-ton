// Foreground integration fixture. Executes registered tools/hooks, never an agent.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { default: extension } = await require("jiti")(import.meta.url).import(
  "../../index.ts",
);
const tools = new Map(),
  hooks = new Map();
extension({
  on: (name, handler) => hooks.set(name, handler),
  registerTool: (tool) => tools.set(tool.name, tool),
  registerCommand() {},
  async exec(_cmd, args) {
    if (args[0] === "agent" && args[1] === "get")
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          result: {
            type: "agent_info",
            agent: {
              agent: "pi",
              pane_id: "w1:p1",
              workspace_id: "w1",
              agent_status: "working",
            },
          },
        }),
      };
    throw new Error("No terminal mutation is permitted in this fixture");
  },
});
const ctx = { cwd: process.cwd(), mode: "json", hasUI: false };
const response =
  process.argv[2] === "pause"
    ? await tools
        .get("herdr_goal")
        .execute(
          "pause-operation",
          { action: "pause", pauseReason: "User pause during questions" },
          undefined,
          undefined,
          ctx,
        )
    : await hooks.get("tool_call")(
        {
          toolName: "ask_user_question",
          input: { questions: [{ question: "May I proceed?" }] },
        },
        ctx,
      );
process.stdout.write(JSON.stringify(response) + "\n");
