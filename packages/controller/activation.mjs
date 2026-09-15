import {
  lstat,
  readFile,
  writeFile,
  rename,
  mkdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** One-shot installation handoff owned by the existing Herdr hook lifecycle.
 * No timer, child process, supervisor or terminal polling is created. */
export async function handleActivation(configDir, event, api) {
  const path = join(configDir, "activation.json");
  let journal;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o022)
      throw new Error("Unsafe activation journal");
    journal = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (
    journal.version !== 1 ||
    journal.operation !== "reload-pi-runtime" ||
    journal.status !== "pending"
  )
    return undefined;
  if (
    event.data?.pane_id !== journal.paneId ||
    event.data?.workspace_id !== journal.workspaceId ||
    event.data?.agent !== "pi" ||
    event.data?.agent_status !== "idle"
  )
    return undefined;
  const live = await api.request("agent.get", { target: journal.paneId });
  const agent = (live.result ?? live).agent;
  if (
    agent?.agent !== "pi" ||
    agent?.pane_id !== journal.paneId ||
    agent?.workspace_id !== journal.workspaceId ||
    agent?.agent_status !== "idle" ||
    agent?.agent_session?.kind !== "path" ||
    agent.agent_session.value !== journal.sessionPath
  )
    return { accepted: true, activation: "identity-or-readiness-mismatch" };
  const lock = `${path}.lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      return { accepted: true, activation: "already-claimed" };
    throw error;
  }
  try {
    const current = JSON.parse(await readFile(path, "utf8"));
    if (current.id !== journal.id || current.status !== "pending")
      return { accepted: true, activation: "already-claimed" };
    // Sending remains latched even if the response is lost. Reloaded adapter
    // acknowledges this operation; timeout never authorizes retyping /reload.
    current.status = "sending";
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(current), { mode: 0o600 });
    await rename(temporary, path);
    try {
      await api.request("agent.prompt", {
        target: journal.paneId,
        text: "/reload",
      });
    } catch {
      return {
        accepted: true,
        activation: "submission-uncertain",
        id: journal.id,
      };
    }
    return { accepted: true, activation: "reload-submitted", id: journal.id };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Called only by the reloaded, controller-mapped root adapter. */
export async function acknowledgeActivation(configDir, identity, readNative) {
  const path = join(configDir, "activation.json");
  let journal;
  try {
    journal = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (
    journal.status !== "sending" ||
    journal.version !== 1 ||
    journal.operation !== "reload-pi-runtime" ||
    !["paneId", "workspaceId", "sessionPath", "source"].every(
      (key) => journal[key] === identity[key],
    )
  )
    return undefined;
  const agent = await readNative(journal.paneId);
  if (
    agent?.agent !== "pi" ||
    agent.pane_id !== journal.paneId ||
    agent.workspace_id !== journal.workspaceId ||
    agent.agent_session?.kind !== "path" ||
    agent.agent_session.value !== journal.sessionPath
  )
    return undefined;
  // Claim atomically; no competing hook writes after submitting the reload.
  const lock = `${path}.ack-lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") return undefined;
    throw error;
  }
  try {
    const current = JSON.parse(await readFile(path, "utf8"));
    if (current.id !== journal.id || current.status !== "sending")
      return undefined;
    current.status = "acknowledged";
    current.acknowledgedAt = new Date().toISOString();
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(current), { mode: 0o600 });
    await rename(temporary, path);
    return { id: current.id, workspaceId: current.workspaceId };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
