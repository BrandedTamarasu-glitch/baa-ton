import type { LaunchProfile } from "./launch-profile.js";

export type NativeSessionRef = { kind: "path" | "id"; value: string };
export type StartupProof = {
  paneId: string;
  workspaceId: string;
  nonce: string;
  source: string;
  profile: LaunchProfile;
  tools: string[];
  session: NativeSessionRef;
};

/** Versioned boundary. No Pi context, TUI or screen-parser types in this contract. */
export interface HarnessLaunchAdapter {
  version: 1;
  kind: string;
  capabilities: {
    sessionIdentity: "native";
    lifecycle: "native" | "screen" | "unavailable";
    startupAttestation: boolean;
  };
  preflight(profile: LaunchProfile): void | Promise<void>;
  launchArguments(profile: LaunchProfile, source: string): string[];
  /** Must compare native identity with the harness's startup attestation.
   * Screen-derived idle alone is never startup attestation. */
  verifyStartup(nativeAgent: unknown, attestation: unknown): StartupProof;
}

export class HarnessAdapterRegistry {
  private readonly adapters = new Map<string, HarnessLaunchAdapter>();
  register(adapter: HarnessLaunchAdapter): void {
    if (
      adapter.version !== 1 ||
      !adapter.kind ||
      this.adapters.has(adapter.kind)
    )
      throw new Error("Invalid or duplicate harness launch adapter.");
    this.adapters.set(adapter.kind, adapter);
  }
  resolve(kind: string): HarnessLaunchAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter?.capabilities.startupAttestation)
      throw new Error(
        `Harness ${kind} has no qualified startup adapter; detection support is not launch qualification.`,
      );
    return adapter;
  }
  capabilities() {
    return [...this.adapters.values()].map(
      ({ kind, version, capabilities }) => ({ kind, version, ...capabilities }),
    );
  }
}
