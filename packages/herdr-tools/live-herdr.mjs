import { spawn as defaultSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  delimiter,
  extname,
  isAbsolute,
  join,
} from "node:path";

export const HERDR_COMMAND = "herdr";
export const CONTROLLER_PLUGIN_ID = "herdr-orchestrator-controller";
const DEFAULT_TIMEOUT_MS = 35_000;

function resolveWindowsCommand(command, platform, env) {
  if (platform !== "win32" || isAbsolute(command) || extname(command))
    return command;
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  for (const directory of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

function needsWindowsShell(command, platform) {
  if (platform !== "win32") return false;
  const extension = extname(command).toLowerCase();
  return extension === ".bat" || extension === ".cmd";
}

export function spawnHerdrProcess(
  command,
  args,
  {
    platform = process.platform,
    env = process.env,
    spawnProcess = defaultSpawn,
    ...options
  } = {},
) {
  const resolvedCommand = resolveWindowsCommand(command, platform, env);
  if (!needsWindowsShell(resolvedCommand, platform))
    return spawnProcess(resolvedCommand, args, options);
  return spawnProcess(
    env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", resolvedCommand, ...args],
    options,
  );
}

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
      if (process.env.BAA_DEBUG_WINDOWS_MCP)
        console.error("live-herdr spawn", args.join(" "));
      child = spawnHerdrProcess(HERDR_COMMAND, args, {
        cwd,
        env,
        platform,
        spawnProcess,
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
    child.on("close", () => {
      if (process.env.BAA_DEBUG_WINDOWS_MCP)
        console.error("live-herdr close", args.join(" "));
    });
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

function parseConfigDirectory(output) {
  const text = output.trim();
  if (!text) throw new Error("herdr plugin config-dir returned an empty directory.");
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
    const result = parsed?.result ?? parsed;
    if (typeof result?.config_dir === "string" && result.config_dir)
      return result.config_dir;
  } catch {
    // Native Herdr installations may print the directory directly.
  }
  return text;
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
 * Resolve a plugin's live config directory instead of trusting a harness's
 * project-scoped environment snapshot.
 */
export async function liveHerdrConfigDirectory(
  pluginId = CONTROLLER_PLUGIN_ID,
  options = {},
) {
  return parseConfigDirectory(
    await runHerdrCommand(["plugin", "config-dir", pluginId], options),
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
