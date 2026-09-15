import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** Atomically merge a patch into `<intentPath>.ready`. Both startup-attestation
 * writers (the host harness's SessionStart hook and the MCP bridge) merge into
 * this file, so write order never matters and neither erases the other. */
export async function mergeAttestation(intentPath, patch) {
  const readyPath = `${intentPath}.ready`;
  let current = {};
  try {
    current = JSON.parse(await readFile(readyPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${readyPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...current, ...patch }), {
    mode: 0o600,
  });
  await rename(temporary, readyPath);
  return { ...current, ...patch };
}
