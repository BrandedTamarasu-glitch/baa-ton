import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, join, resolve } from "node:path";
import type { LaunchProfile } from "./launch-profile.js";
import {
  PROTOCOL_OPERATIONS,
  type HarnessLaunchAdapter,
  type ProtocolOperation,
  type StartupProof,
} from "./harness-adapter.js";

export const CLAUDE_PROVIDER = "claude-code";
export const CLAUDE_PERMISSION_PROMPT_TOOL =
  "mcp__herdr-orchestrator__herdr_permission_prompt";

export type ClaudeAdapterPaths = {
  /** Absolute path to the shared stdio MCP bridge. */
  bridge: string;
  /** Absolute path to the SessionStart attestation helper. */
  attestHelper: string;
  /** Writable directory for generated launch configuration files. */
  scratchDirectory: string;
  /**
   * Optional Claude permission broker tool. Omitted by default so ordinary
   * Claude launches keep their native permission flow.
   */
  permissionPromptTool?: string | false;
};

function claudeBinaryAvailable(): boolean {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry && existsSync(join(resolve(entry), "claude"))) return true;
  }
  return false;
}

/** Conservative lane permissions: read/edit plus foreground test/build/git-read
 * and local commits. Push, merge, and PR creation stay denied — those are the
 * orchestrator's standing policy, not something a lane may self-grant. */
const LANE_PERMISSIONS = {
  allow: [
    "Read",
    "Edit",
    "Glob",
    "Grep",
    "Bash(node:*)",
    "Bash(npm test:*)",
    "Bash(npm run:*)",
    "Bash(npm install:*)",
    "Bash(npx tsc:*)",
    "Bash(tsc:*)",
    "Bash(env:*)",
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git add:*)",
    "Bash(git commit:*)",
    "Bash(ls:*)",
    "Bash(mkdir:*)",
    "Bash(cat:*)",
    "Bash(head:*)",
    "Bash(tail:*)",
    "Bash(wc:*)",
    "Bash(rg:*)",
    "Bash(grep:*)",
    "Bash(sed:*)",
  ],
  deny: [
    "Bash(git push:*)",
    "Bash(git merge:*)",
    "Bash(gh pr create:*)",
    "Bash(herdr workspace close:*)",
  ],
};

export function claudeLaunchAdapter(
  paths: ClaudeAdapterPaths,
): HarnessLaunchAdapter {
  return {
    version: 1,
    kind: "claude",
    capabilities: {
      startupAttestation: true,
      supportsSessionPersistence: true,
      supportsNativeSessionIdentity: true,
    },
    // Honest capability reporting: Herdr's Claude integration exposes session
    // identity, but lifecycle state is screen-derived, not native.
    lifecycle: "screen",
    preflight(profile: LaunchProfile): void {
      if (profile.provider !== CLAUDE_PROVIDER)
        throw new Error(
          "Only the claude-code subscription launch adapter is qualified in this prerequisite.",
        );
      if (!profile.model)
        throw new Error("Exact model id is required; no alias substitution.");
      if (!claudeBinaryAvailable())
        throw new Error(
          "claude CLI not found on PATH; install and authenticate Claude Code before dispatch.",
        );
      // Claude Code's --effort ladder matches our thinking vocabulary exactly.
      // Model validity is proven by runtime attestation: an unknown model makes
      // claude exit before its SessionStart hook writes the handshake, so
      // dispatch fails closed rather than silently substituting a model.
    },
    launchArguments(profile: LaunchProfile): string[] {
      mkdirSync(paths.scratchDirectory, { recursive: true, mode: 0o700 });
      const tag = randomUUID().slice(0, 8);
      const settingsPath = join(
        paths.scratchDirectory,
        `claude-settings-${tag}.json`,
      );
      const mcpConfigPath = join(
        paths.scratchDirectory,
        `claude-mcp-${tag}.json`,
      );
      const settings = {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `node ${JSON.stringify(paths.attestHelper)}`,
                },
              ],
            },
          ],
        },
        permissions: LANE_PERMISSIONS,
      };
      const mcpConfig = {
        mcpServers: {
          "herdr-orchestrator": {
            command: "node",
            args: [paths.bridge],
          },
        },
      };
      writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });
      const args = [
        "--model",
        profile.model,
        "--effort",
        profile.thinking,
        "--settings",
        settingsPath,
        "--mcp-config",
        mcpConfigPath,
        "--strict-mcp-config",
      ];
      const permissionPromptTool =
        paths.permissionPromptTool === undefined
          ? process.env.BAA_CLAUDE_PERMISSION_PROMPT_TOOL === "1"
            ? CLAUDE_PERMISSION_PROMPT_TOOL
            : undefined
          : paths.permissionPromptTool;
      if (
        permissionPromptTool !== undefined &&
        permissionPromptTool !== false
      ) {
        if (
          typeof permissionPromptTool !== "string" ||
          permissionPromptTool.trim() === ""
        )
          throw new Error(
            "permissionPromptTool must be a non-empty string when enabled.",
          );
        args.push("--permission-prompt-tool", permissionPromptTool);
      }
      return args;
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
        operations?: string[];
        sessionPath?: string;
        sessionId?: string;
      };
      if (!agent || !hello || agent.agent !== "claude")
        throw new Error("Claude native identity mismatch; no work assigned.");
      const kind = agent.agent_session?.kind;
      const value = agent.agent_session?.value;
      if (kind !== "path" && kind !== "id")
        throw new Error(
          "Claude native session reference missing; no work assigned.",
        );
      if (typeof value !== "string" || !value)
        throw new Error(
          "Claude native session reference missing; no work assigned.",
        );
      const attested = kind === "path" ? hello.sessionPath : hello.sessionId;
      if (attested !== value)
        throw new Error(
          "Claude session attestation does not match native identity; no work assigned.",
        );
      if (
        agent.pane_id !== hello.paneId ||
        agent.workspace_id !== hello.workspaceId
      )
        throw new Error("Claude startup binding mismatch; no work assigned.");
      const knownOperations = new Set<string>(
        Object.values(PROTOCOL_OPERATIONS),
      );
      const operations = (hello.operations ?? []).filter(
        (operation): operation is ProtocolOperation =>
          typeof operation === "string" && knownOperations.has(operation),
      );
      return {
        paneId: hello.paneId!,
        workspaceId: hello.workspaceId!,
        nonce: hello.nonce!,
        source: hello.source!,
        profile: hello.profile!,
        operations,
        session: { kind, value },
      };
    },
  };
}
