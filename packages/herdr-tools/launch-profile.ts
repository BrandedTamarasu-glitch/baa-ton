export const LAUNCH_PROFILE_SCHEMA_VERSION = 1 as const;

export type LaunchProfile = {
  provider: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  auth: "subscription";
};

export type LaunchProfileVersion = typeof LAUNCH_PROFILE_SCHEMA_VERSION;

/** Shape validation only. Provider IDs and thinking support belong to adapters. */
export function validateLaunchProfile(
  input: unknown,
  label = "launchProfile",
): LaunchProfile {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error(
      `An explicit launchProfile (provider, model, thinking, auth) is required for ${label}; no model substitution is allowed.`,
    );
  const profile = input as LaunchProfile;
  if (
    Object.keys(profile).sort().join(",") !== "auth,model,provider,thinking" ||
    typeof profile.provider !== "string" ||
    !profile.provider ||
    typeof profile.model !== "string" ||
    !profile.model ||
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      profile.thinking,
    ) ||
    profile.auth !== "subscription"
  )
    throw new Error(`Invalid ${label}.`);
  return { ...profile };
}
