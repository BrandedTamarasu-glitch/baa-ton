import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { LaunchProfile } from "./launch-profile.js";
import {
  PROTOCOL_OPERATIONS,
  type HarnessLaunchAdapter,
  type ProtocolOperation,
  type StartupProof,
} from "./harness-adapter.js";

export const CODEX_PROVIDER = "openai-codex";

export type CodexAdapterPaths = {
  /** Absolute path to the shared stdio MCP bridge. */
  bridge: string;
  /** Absolute path to the notify attestation helper. */
  attestHelper: string;
};

function codexBinaryAvailable(): boolean {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry && existsSync(join(resolve(entry), "codex"))) return true;
  }
  return false;
}

function filterProtocolOperations(operations: unknown): ProtocolOperation[] {
  const known = new Set<string>(Object.values(PROTOCOL_OPERATIONS));
  if (!Array.isArray(operations)) return [];
  return operations.filter(
    (operation): operation is ProtocolOperation =>
      typeof operation === "string" && known.has(operation),
  );
}

/** Codex lanes run on the same openai-codex subscription as Pi. The startup
 * proof turn is a handshake positional prompt; Codex's `notify` hook writes
 * the attestation (thread-id) when that turn completes, and the MCP bridge
 * merges the live protocol operations. MCP children do not inherit pane env,
 * so the intent path is passed explicitly through mcp_servers env config. */
export function codexLaunchAdapter(paths: CodexAdapterPaths): HarnessLaunchAdapter {
  return {
    version: 1,
    kind: "codex",
    capabilities: {
      startupAttestation: true,
      supportsSessionPersistence: true,
      supportsNativeSessionIdentity: true,
    },
    // Honest capability reporting: session identity is integrated, but Codex
    // lifecycle state in Herdr is screen-derived.
    lifecycle: "screen",
    preflight(profile: LaunchProfile): void {
      if (profile.provider !== CODEX_PROVIDER)
        throw new Error(
          "Only the openai-codex subscription launch adapter is qualified in this prerequisite.",
        );
      if (!profile.model)
        throw new Error("Exact model id is required; no alias substitution.");
      if (!codexBinaryAvailable())
        throw new Error(
          "codex CLI not found on PATH; install and authenticate Codex before dispatch.",
        );
      // Reasoning effort maps 1:1 onto model_reasoning_effort; a rejected
      // value makes codex exit before attestation, failing dispatch closed.
    },
    launchArguments(profile: LaunchProfile, _source: string, context?: { startupIntentPath?: string }): string[] {
      const intentPath = context?.startupIntentPath;
      if (!intentPath)
        throw new Error("Codex launch requires the startup intent path.");
      return [
        "--model",
        profile.model,
        "-s",
        "workspace-write",
        "-c",
        `model_reasoning_effort=${profile.thinking}`,
        "-c",
        `notify=["node","${paths.attestHelper}"]`,
        "-c",
        'mcp_servers.herdr-orchestrator.command="node"',
        "-c",
        `mcp_servers.herdr-orchestrator.args=["${paths.bridge}"]`,
        "-c",
        `mcp_servers.herdr-orchestrator.env.BAA_STARTUP_INTENT="${intentPath}"`,
        // Handshake positional prompt: the startup-proof turn. Assignment is
        // delivered only after its notify attestation verifies.
        "Reply with exactly: READY",
      ];
    },
    verifyStartup(nativeAgent: unknown, attestation: unknown): StartupProof {
      const agent = nativeAgent as {
        agent?: string;
        pane_id?: string;
        workspace_id?: string;
        agent_session?: { kind?: string; value?: string };
      };
      const hello = attestation as {
        paneId?: string;
        workspaceId?: string;
        nonce?: string;
        source?: string;
        profile?: LaunchProfile;
        operations?: unknown;
        sessionId?: string;
      };
      if (!agent || !hello || agent.agent !== "codex")
        throw new Error("Codex native identity mismatch; no work assigned.");
      const kind = agent.agent_session?.kind;
      const value = agent.agent_session?.value;
      if (kind !== "path" && kind !== "id")
        throw new Error("Codex native session reference missing; no work assigned.");
      if (typeof value !== "string" || !value)
        throw new Error("Codex native session reference missing; no work assigned.");
      if (typeof hello.sessionId !== "string" || !hello.sessionId)
        throw new Error("Codex attestation lacks thread identity; no work assigned.");
      // Native identity is either the thread id itself (kind id) or a rollout
      // file path embedding it (kind path); both must bind to the attestation.
      const attested = kind === "id" ? value === hello.sessionId : value.includes(hello.sessionId);
      if (!attested)
        throw new Error(
          "Codex session attestation does not match native identity; no work assigned.",
        );
      if (agent.pane_id !== hello.paneId || agent.workspace_id !== hello.workspaceId)
        throw new Error("Codex startup binding mismatch; no work assigned.");
      return {
        paneId: hello.paneId!,
        workspaceId: hello.workspaceId!,
        nonce: hello.nonce!,
        source: hello.source!,
        profile: hello.profile!,
        operations: filterProtocolOperations(hello.operations),
        session: { kind, value },
      };
    },
  };
}
