#!/usr/bin/env node
/** Claude Code SessionStart hook: writes the lane's startup attestation.
 * Invoked by Claude with hook JSON on stdin ({session_id, transcript_path, ...}).
 * Merges lane identity into <BAA_STARTUP_INTENT>.ready. Claude may start an
 * MCP server lazily, so seed the stable protocol contract here as well; the
 * MCP bridge merges the same live operations when it starts. Both writers
 * merge atomically. */
import { readFile } from "node:fs/promises";
import { mergeAttestation } from "./attest-merge.mjs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  try {
    const intentPath = process.env.BAA_STARTUP_INTENT;
    if (!intentPath) process.exit(0);
    const intent = JSON.parse(await readFile(intentPath, "utf8"));
    if (
      process.env.HERDR_PANE_ID !== intent.paneId ||
      process.env.HERDR_WORKSPACE_ID !== intent.workspaceId
    ) {
      console.error("Startup binding differs from this pane/workspace.");
      process.exit(1);
    }
    let hook = {};
    try {
      hook = JSON.parse(input);
    } catch {
      hook = {};
    }
    const identity = {};
    if (typeof hook.transcript_path === "string" && hook.transcript_path)
      identity.sessionPath = hook.transcript_path;
    if (typeof hook.session_id === "string" && hook.session_id)
      identity.sessionId = hook.session_id;
    if (!identity.sessionPath && !identity.sessionId) {
      console.error("SessionStart hook payload lacks session identity.");
      process.exit(1);
    }
    await mergeAttestation(`${intentPath}`, {
      version: 1,
      nonce: intent.nonce,
      paneId: intent.paneId,
      workspaceId: intent.workspaceId,
      source: intent.source,
      profile: intent.profile,
      harness: "claude",
      operations: ["plan", "dispatch", "complete"],
      ...identity,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
});
