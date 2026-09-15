export type LaunchProfile = {
  provider: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  auth: "subscription";
};

/** Shape validation only. Provider IDs and thinking support belong to adapters. */
export function validateLaunchProfile(input: unknown): LaunchProfile {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error(
      "An explicit launchProfile (provider, model, thinking, auth) is required; no model substitution is allowed.",
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
    throw new Error("Invalid launchProfile.");
  return { ...profile };
}
