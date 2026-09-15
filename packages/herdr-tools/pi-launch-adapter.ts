import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LaunchProfile } from "./launch-profile.js";
import type { HarnessLaunchAdapter, StartupProof } from "./harness-adapter.js";

export function verifyAvailableProfile(
  profile: LaunchProfile,
  ctx: ExtensionContext,
): void {
  if (profile.provider !== "openai-codex")
    throw new Error(
      "Only the openai-codex subscription launch adapter is qualified in this prerequisite.",
    );
  const model = ctx.modelRegistry?.find(profile.provider, profile.model);
  if (!model)
    throw new Error(
      `Exact installed model not found: ${profile.provider}/${profile.model}.`,
    );
  const map = model.thinkingLevelMap;
  const hasThinkingLevel =
    map != null &&
    Object.hasOwn(map, profile.thinking) &&
    map[profile.thinking] != null;
  if ((!model.reasoning && profile.thinking !== "off") || !hasThinkingLevel)
    throw new Error(
      `Thinking level ${profile.thinking} is unsupported by ${profile.model}.`,
    );
  if (
    !ctx.modelRegistry.hasConfiguredAuth(model) ||
    !ctx.modelRegistry.isUsingOAuth(model)
  )
    throw new Error(
      "Requested subscription authentication is not configured; API-key fallback is forbidden.",
    );
}

export function verifyActualProfile(
  profile: LaunchProfile,
  ctx: ExtensionContext,
): void {
  verifyAvailableProfile(profile, ctx);
  if (
    ctx.model?.provider !== profile.provider ||
    ctx.model?.id !== profile.model ||
    ctx.thinkingLevel !== profile.thinking
  )
    throw new Error(
      "Startup provider/model/thinking mismatch; no assignment may be delivered.",
    );
}

export function piLaunchAdapter(
  ctx: ExtensionContext,
  nativeIntegration: string,
): HarnessLaunchAdapter {
  return {
    version: 1,
    kind: "pi",
    capabilities: {
      sessionIdentity: "native",
      lifecycle: "native",
      startupAttestation: true,
    },
    preflight: (profile) => verifyAvailableProfile(profile, ctx),
    launchArguments: (profile, source) => [
      "--provider",
      profile.provider,
      "--model",
      profile.model,
      "--thinking",
      profile.thinking,
      "--no-extensions",
      "-e",
      nativeIntegration,
      "-e",
      source,
    ],
    verifyStartup(nativeAgent: unknown, attestation: unknown): StartupProof {
      const agent = nativeAgent as {
        agent?: string;
        pane_id?: string;
        workspace_id?: string;
        agent_session?: { kind?: string; value?: string };
      };
      const hello = attestation as Omit<StartupProof, "session"> & {
        sessionPath?: string;
      };
      if (
        !agent ||
        !hello ||
        agent.agent !== "pi" ||
        agent.agent_session?.kind !== "path" ||
        typeof hello.sessionPath !== "string" ||
        agent.agent_session.value !== hello.sessionPath ||
        agent.pane_id !== hello.paneId ||
        agent.workspace_id !== hello.workspaceId
      )
        throw new Error(
          "Pi native-session/startup attestation mismatch; no work assigned.",
        );
      return { ...hello, session: { kind: "path", value: hello.sessionPath } };
    },
  };
}
