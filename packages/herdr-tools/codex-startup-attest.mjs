#!/usr/bin/env node
/** Codex `notify` hook: writes the lane's startup attestation.
 * Codex invokes: node <this-script> '<json payload>' where the payload's
 * agent-turn-complete event carries the thread-id (session identity) and cwd.
 * The handshake turn ("Reply with exactly: READY") is the startup proof turn;
 * real assignment follows only after this attestation verifies. */
import { readFile } from "node:fs/promises";
import { mergeAttestation } from "./attest-merge.mjs";

async function main() {
  const intentPath = process.env.BAA_STARTUP_INTENT;
  if (!intentPath) process.exit(0);
  let payload;
  try {
    payload = JSON.parse(process.argv[2] ?? "{}");
  } catch {
    console.error("notify payload is not valid JSON; not attesting.");
    process.exit(1);
  }
  if (
    payload.type !== "agent-turn-complete" ||
    typeof payload["thread-id"] !== "string"
  ) {
    console.error("notify payload lacks session identity; not attesting.");
    process.exit(1);
  }
  let intent;
  try {
    intent = JSON.parse(await readFile(intentPath, "utf8"));
  } catch {
    console.error("startup intent is not readable JSON; not attesting.");
    process.exit(1);
  }
  if (
    process.env.HERDR_PANE_ID !== intent.paneId ||
    process.env.HERDR_WORKSPACE_ID !== intent.workspaceId
  ) {
    console.error("Startup binding differs from this pane/workspace.");
    process.exit(1);
  }
  await mergeAttestation(intentPath, {
    version: 1,
    harness: "codex",
    nonce: intent.nonce,
    paneId: intent.paneId,
    workspaceId: intent.workspaceId,
    source: intent.source,
    profile: intent.profile,
    sessionId: payload["thread-id"],
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
