import { spawn as defaultSpawn } from "node:child_process";

export const HERDR_COMMAND = "herdr";
const DEFAULT_TIMEOUT_MS = 35_000;

async function runHerdrCommand(args, {
  spawnProcess = defaultSpawn,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const output = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(HERDR_COMMAND, args, {
        cwd,
        env,
        shell: platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Timed out resolving the live Herdr identity."));
    }, timeoutMs);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      finish(() =>
        reject(
          new Error(`Unable to run Herdr ${args.join(" ")}: ${error.message}`),
        ),
      ),
    );
    child.on("close", (code) =>
      finish(() =>
        code === 0
          ? resolve(stdout)
          : reject(
              new Error(
                `herdr ${args.join(" ")} failed: ${(stderr || stdout)
                  .trim()
                  .slice(0, 2000)}`,
              ),
            ),
      ),
    );
  });
  return output;
}

function parseHerdrJson(output, description) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(
      `herdr ${description} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Run the live agent lookup used to resolve a Claude MCP subprocess.
 * On Windows, shell/PATHEXT resolution lets the unqualified command select
 * either a native herdr.exe or an npm herdr.cmd shim.
 */
export async function liveHerdrAgentList(options = {}) {
  return parseHerdrJson(
    await runHerdrCommand(["agent", "list"], options),
    "agent list",
  );
}

/**
 * Read the process tree currently occupying one Herdr pane. Herdr does not
 * include these PIDs in agent list records, but pane.process-info exposes the
 * foreground process set needed to correlate a long-lived MCP subprocess.
 */
export async function liveHerdrPaneProcessInfo(paneId, options = {}) {
  if (typeof paneId !== "string" || !paneId)
    throw new Error("A pane id is required for live Herdr process lookup.");
  return parseHerdrJson(
    await runHerdrCommand(
      ["pane", "process-info", "--pane", paneId],
      options,
    ),
    `pane process-info --pane ${paneId}`,
  );
}
