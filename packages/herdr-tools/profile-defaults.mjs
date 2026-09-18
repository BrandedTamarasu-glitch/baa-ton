/**
 * Pure computation of default per-profile launch profiles from detection
 * results. Never invents a model ID: a profile is only populated when a
 * selected harness has usable (non-static-only) detection data, and it is
 * omitted entirely when none does.
 */

const HARNESS_TO_PROVIDER = {
  claude: "claude-code",
  codex: "codex",
  pi: "pi",
  opencode: "opencode",
};

const EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"];

// Per-profile-category thinking preference, expressed as a position on the
// effort ladder each harness's catalog/detection actually supports.
const PROFILE_EFFORT_PREFERENCE = {
  planning: "high",
  quick: "low",
  balanced: "medium",
  implementation: "high",
  sustained: "low",
  review: "high",
  "deep-review": "max",
};

function isUsable(detection) {
  return Boolean(detection) && detection.source !== "static" && !!detection.defaultModel;
}

function nearestSupportedThinking(preferred, supportedLevels) {
  if (!supportedLevels || supportedLevels.length === 0) return preferred;
  if (supportedLevels.includes(preferred)) return preferred;
  const preferredIndex = EFFORT_LADDER.indexOf(preferred);
  if (preferredIndex === -1) return supportedLevels[0];
  // Walk outward from the preferred rung to the nearest level the harness supports.
  for (let distance = 1; distance < EFFORT_LADDER.length; distance += 1) {
    const lower = EFFORT_LADDER[preferredIndex - distance];
    if (lower && supportedLevels.includes(lower)) return lower;
    const higher = EFFORT_LADDER[preferredIndex + distance];
    if (higher && supportedLevels.includes(higher)) return higher;
  }
  return supportedLevels[0];
}

function pickHarnessForProfile(profileName, selectedHarnessIds, detectionResults, preferredHarnesses) {
  const order = (preferredHarnesses ?? []).filter((id) => selectedHarnessIds.includes(id));
  for (const id of selectedHarnessIds) if (!order.includes(id)) order.push(id);
  for (const harnessId of order) {
    const detection = detectionResults[harnessId];
    if (isUsable(detection)) return { harnessId, detection };
  }
  return undefined;
}

function catalogThinkingLevels(detection, modelId) {
  const entry = detection.catalog?.find((item) => item.id === modelId);
  return entry?.thinkingLevels?.length ? entry.thinkingLevels : undefined;
}

/**
 * @param {string[]} selectedHarnessIds
 * @param {Record<string, ReturnType<typeof import("./harness-detect.mjs").readClaudeDefaults>>} detectionResults
 * @param {Record<string, {preferredHarnesses: string[]}>} taskProfilesDefaults
 */
export function defaultLaunchProfiles(selectedHarnessIds, detectionResults, taskProfilesDefaults) {
  const profiles = {};
  for (const [profileName, profileDefaults] of Object.entries(taskProfilesDefaults)) {
    const picked = pickHarnessForProfile(
      profileName,
      selectedHarnessIds,
      detectionResults,
      profileDefaults.preferredHarnesses,
    );
    if (!picked) continue;
    const { harnessId, detection } = picked;
    const provider = HARNESS_TO_PROVIDER[harnessId];
    if (!provider) continue;
    const preferredEffort = PROFILE_EFFORT_PREFERENCE[profileName] ?? profileDefaults.thinking ?? "medium";
    const supportedLevels = catalogThinkingLevels(detection, detection.defaultModel);
    const thinking = nearestSupportedThinking(preferredEffort, supportedLevels ?? undefined) ?? detection.defaultThinking ?? preferredEffort;
    profiles[profileName] = {
      agentKind: harnessId,
      launchProfile: {
        provider,
        model: detection.defaultModel,
        thinking,
        auth: "subscription",
      },
    };
  }
  return profiles;
}
