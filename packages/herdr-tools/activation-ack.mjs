import { lstat, readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Called only by the reloaded, controller-mapped root adapter. Lives inside
 * the extension package so relative imports never cross the symlink used to
 * load the extension; the controller-side handoff stays in packages/controller. */
export async function acknowledgeActivation(configDir, identity, readNative) {
  const path = join(configDir, 'activation.json');
  let journal;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022)) return undefined;
    journal = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (journal.status !== 'sending' || journal.version !== 1 || journal.operation !== 'reload-pi-runtime' ||
    !['paneId', 'workspaceId', 'sessionPath', 'source'].every(key => journal[key] === identity[key])) return undefined;
  const agent = await readNative(journal.paneId);
  if (agent?.agent !== 'pi' || agent.pane_id !== journal.paneId || agent.workspace_id !== journal.workspaceId ||
    agent.agent_session?.kind !== 'path' || agent.agent_session.value !== journal.sessionPath) return undefined;
  // Claim atomically; no competing hook writes after submitting the reload.
  const lock = `${path}.ack-lock`;
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') return undefined; throw error; }
  try {
    const current = JSON.parse(await readFile(path, 'utf8'));
    if (current.id !== journal.id || current.status !== 'sending') return undefined;
    current.status = 'acknowledged'; current.acknowledgedAt = new Date().toISOString();
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(current), { mode: 0o600 });
    await rename(temporary, path);
    return { id: current.id, workspaceId: current.workspaceId };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
