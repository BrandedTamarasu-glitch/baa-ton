#!/usr/bin/env node
/** Operator-authorized local runtime activation. Not a child orchestration API.
 * --execute must follow explicit user authorization; never launches an agent. */
import {
  lstat,
  readFile,
  writeFile,
  realpath,
  readlink,
  symlink,
  rename,
  mkdir,
  rm,
} from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { validateConfig } from "../controller/controller.mjs";
const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`Invalid JSON in ${label}`, { cause });
  }
}
async function atomic(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function activateTask({
  cwd,
  configDir,
  extensionLink,
  source,
  pane,
  expectedSessionPath,
  execute = false,
}) {
  cwd = await realpath(cwd);
  source = await realpath(source);
  if (
    pane.agent !== "pi" ||
    !pane.pane_id ||
    !pane.workspace_id ||
    pane.agent_session?.kind !== "path" ||
    pane.agent_session.value !== expectedSessionPath
  )
    throw new Error(
      "Current native session does not match the authorized activation participant.",
    );
  const configPath = join(configDir, "config.json");
  const info = await lstat(configPath);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o022)
    throw new Error("Unsafe controller configuration.");
  if (!(await lstat(extensionLink)).isSymbolicLink())
    throw new Error(
      "Activation only replaces an existing extension symlink, never a directory.",
    );
  const oldLink = await readlink(extensionLink);
  const before = await readFile(configPath, "utf8");
  const config = validateConfig(parseJson(before, "controller configuration"));
  const oldChild = config.orchestrators.flatMap((record) =>
    record.workflows
      .filter((w) => w.lanes.some((l) => l.pane_id === pane.pane_id))
      .map((workflow) => ({ record, workflow })),
  );
  if (
    oldChild.length > 1 ||
    oldChild.some(({ workflow }) => workflow.lanes.length !== 1)
  )
    throw new Error(
      "Only a uniquely mapped isolated old lane can be migrated; unrelated lanes must remain intact.",
    );
  const existingRoot = config.orchestrators.find(
    (record) => record.root.pane_id === pane.pane_id,
  );
  if (
    existingRoot &&
    (existingRoot.program.id !== cwd ||
      existingRoot.root.workspace_id !== pane.workspace_id)
  )
    throw new Error(
      "Existing root belongs to another task; refusing reassignment.",
    );
  const plan = {
    version: 1,
    id: randomUUID(),
    operation: "reload-pi-runtime",
    status: "pending",
    paneId: pane.pane_id,
    workspaceId: pane.workspace_id,
    sessionPath: expectedSessionPath,
    source: join(source, "index.ts"),
    cwd,
    previousExtension: oldLink,
    retiredMappings: oldChild.map(({ record, workflow }) => ({
      orchestratorId: record.id,
      workflow,
    })),
  };
  if (!execute) return { dryRun: true, plan };
  const lock = `${configPath}.lock`;
  await mkdir(lock, { mode: 0o700 });
  try {
    if ((await readFile(configPath, "utf8")) !== before)
      throw new Error(
        "Controller changed during activation preflight; retry from a fresh snapshot.",
      );
    const pendingPath = join(configDir, "activation.json");
    try {
      const previous = JSON.parse(await readFile(pendingPath, "utf8"));
      if (
        previous.sessionPath === expectedSessionPath &&
        previous.source === plan.source &&
        ["pending", "sending", "acknowledged"].includes(previous.status)
      )
        return { alreadyActivated: true, plan: previous };
      if (previous.status !== "acknowledged")
        throw new Error("Another activation is pending or uncertain.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await writeFile(join(configDir, `config.before-${plan.id}.json`), before, {
      mode: 0o600,
      flag: "wx",
    });
    // Preserve all other roots/lanes and the old authoritative manifest itself.
    for (const { record, workflow } of oldChild)
      record.workflows = record.workflows.filter(
        (w) => w.workflow_id !== workflow.workflow_id,
      );
    if (!existingRoot)
      config.orchestrators.push({
        id: `orchestrator:${pane.workspace_id}:${pane.pane_id}:${cwd}`,
        root: {
          target: pane.pane_id,
          target_kind: "pane_id",
          pane_id: pane.pane_id,
          workspace_id: pane.workspace_id,
          agent_kind: "pi",
        },
        program: {
          id: cwd,
          workspace_id: pane.workspace_id,
          parent_manifest_path: join(
            cwd,
            ".pi/herdr-orchestrator/manifest.json",
          ),
        },
        workflows: [],
      });
    validateConfig(config);
    const directory = join(cwd, ".pi/herdr-orchestrator");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        join(directory, "manifest.json"),
        JSON.stringify({ version: 2, workflows: [] }),
        { mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await atomic(join(directory, `activation-${plan.id}.json`), plan);
    const temporaryLink = `${extensionLink}.${plan.id}.tmp`;
    await symlink(source, temporaryLink);
    await rename(temporaryLink, extensionLink);
    await atomic(configPath, config);
    await atomic(pendingPath, plan);
    return { activated: true, plan };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.env.HERDR_ENV !== "1")
    throw new Error("Activation requires the current Herdr pane.");
  const { stdout } = await exec("herdr", ["pane", "current", "--current"]);
  const { stdout: configDir } = await exec("herdr", [
    "plugin",
    "config-dir",
    "herdr-orchestrator-controller",
  ]);
  const result = await activateTask({
    cwd: process.cwd(),
    source: here,
    configDir: configDir.trim(),
    extensionLink: join(homedir(), ".pi/agent/extensions/herdr-orchestrator"),
    pane: parseJson(stdout, "native current-pane response").result.pane,
    expectedSessionPath: process.env.PI_SESSION_FILE,
    execute: process.argv.includes("--execute"),
  });
  console.log(JSON.stringify(result, null, 2));
}
