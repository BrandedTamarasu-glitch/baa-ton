import type { LaunchProfile } from "./launch-profile.js";

export const PROTOCOL_OPERATIONS = {
  plan: "plan",
  dispatch: "dispatch",
  complete: "complete",
} as const;
export type ProtocolOperation =
  (typeof PROTOCOL_OPERATIONS)[keyof typeof PROTOCOL_OPERATIONS];

/** Operations every verified lane must expose before it can receive work. */
export const STARTUP_PROOF_REQUIRED_OPERATIONS = [
  PROTOCOL_OPERATIONS.plan,
  PROTOCOL_OPERATIONS.dispatch,
  PROTOCOL_OPERATIONS.complete,
] as const satisfies readonly ProtocolOperation[];

export type NativeSessionRef = { kind: "path" | "id"; value: string };
export type HarnessLifecycle = "native" | "screen" | "unavailable";

/**
 * Boolean capabilities are intentionally open-ended so a harness can publish
 * new provider features without changing this contract version. The lifecycle
 * tier is metadata rather than a boolean and stays explicit on the adapter.
 */
export type HarnessCapabilityFlags = Record<string, boolean | undefined> & {
  startupAttestation: boolean;
  supportsSessionPersistence: boolean;
};

export type StartupProof = {
  paneId: string;
  workspaceId: string;
  nonce: string;
  source: string;
  profile: LaunchProfile;
  operations: ProtocolOperation[];
  session: NativeSessionRef;
};

/** Versioned boundary. No Pi context, TUI or screen-parser types in this contract. */
export interface HarnessLaunchAdapter {
  version: 1;
  kind: string;
  capabilities: HarnessCapabilityFlags;
  /** Honest lifecycle reporting: native, screen-derived, or unavailable. */
  lifecycle: HarnessLifecycle;
  preflight(profile: LaunchProfile): void | Promise<void>;
  launchArguments(
    profile: LaunchProfile,
    source: string,
    context?: LaunchContext,
  ): string[];
  /** Must compare native identity with the harness's startup attestation.
   * Screen-derived idle alone is never startup attestation. */
  verifyStartup(nativeAgent: unknown, attestation: unknown): StartupProof;
}

export const REQUIRED_ADAPTER_CAPABILITIES = [
  "startupAttestation",
  "supportsSessionPersistence",
] as const;

/** Extra per-lane launch facts adapters may need. Optional so existing v1
 * adapters are unaffected; versioned with the contract. */
export type LaunchContext = {
  startupIntentPath?: string;
};

export type RequiredAdapterCapability =
  (typeof REQUIRED_ADAPTER_CAPABILITIES)[number];

export function missingRequiredAdapterCapabilities(
  adapter: Pick<HarnessLaunchAdapter, "capabilities"> | undefined,
): RequiredAdapterCapability[] {
  if (!adapter?.capabilities) return [...REQUIRED_ADAPTER_CAPABILITIES];
  return REQUIRED_ADAPTER_CAPABILITIES.filter(
    (name) => adapter.capabilities[name] !== true,
  );
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
    const missing = missingRequiredAdapterCapabilities(adapter);
    if (!adapter || adapter.version !== 1 || missing.length > 0)
      throw new Error(
        `Harness ${kind} has no qualified startup adapter; detection support is not launch qualification${
          missing.length ? ` (missing required capability flags: ${missing.join(", ")})` : ""
        }.`,
      );
    return adapter;
  }
  capabilities() {
    return [...this.adapters.values()].map(
      ({ kind, version, capabilities, lifecycle }) => ({
        kind,
        version,
        ...capabilities,
        lifecycle,
      }),
    );
  }
}
