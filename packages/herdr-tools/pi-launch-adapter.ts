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
  // Empirically settled by a 2026-09-15 live probe: Pi and the backend
  // accept thinking levels absent from the catalog map (gpt-5.6-luna served
  // a turn at "high" though its map lists only minimal/xhigh/max). The map is
  // an enumeration for UI cycling, not a support boundary. Only an explicit
  // null entry declares a level unsupported; absent levels are trusted to
  // runtime attestation, which fails the startup handshake unless the session
  // actually reports the requested level.
  const map = model.thinkingLevelMap;
  if (
    (!model.reasoning && profile.thinking !== "off") ||
    map?.[profile.thinking] === null
  )
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
