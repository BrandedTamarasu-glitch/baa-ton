import { spawn as defaultSpawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 5_000;

function parentCommand(pid, platform) {
  if (platform === "win32")
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$process = Get-CimInstance -ClassName Win32_Process -Filter \"ProcessId = ${pid}\"; if ($null -eq $process) { exit 3 }; $process.ParentProcessId`,
      ],
    };
  return { command: "ps", args: ["-o", "ppid=", "-p", String(pid)] };
}

/**
 * Resolve one process's immediate parent without assuming that an MCP
 * stdio server is a direct child of its harness. Windows MCP launches may
 * include cmd.exe/node wrapper hops; POSIX uses the equivalent ps query.
 */
export async function liveProcessParentPid(
  pid,
  {
    spawnProcess = defaultSpawn,
    platform = process.platform,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid <= 0)
    throw new Error("A positive process id is required for parent lookup.");
  const { command, args } = parentCommand(numericPid, platform);
  const output = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, {
        shell: false,
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
      reject(new Error(`Timed out resolving the parent of process ${numericPid}.`));
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
          new Error(
            `Unable to resolve the parent of process ${numericPid}: ${error.message}`,
          ),
        ),
      ),
    );
    child.on("close", (code) =>
      finish(() =>
        code === 0
          ? resolve(stdout)
          : reject(
              new Error(
                `Parent lookup for process ${numericPid} failed: ${(stderr || stdout)
                  .trim()
                  .slice(0, 1000)}`,
              ),
            ),
      ),
    );
  });
  const parentPid = Number.parseInt(String(output).trim(), 10);
  return Number.isSafeInteger(parentPid) && parentPid > 0
    ? parentPid
    : undefined;
}
