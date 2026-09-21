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

// Neither Pi's SDK catalog nor OpenCode's CLI catalog carries a priority
// signal, and both harnesses' cost data turned out to be unusable as a
// stand-in: Pi's cost reflects reseller billing, not capability
// (gpt-5.3-codex-spark priced above gpt-5.6-luna despite being the
// intended cheap/subscription pick), and OpenCode reports flat $0 for
// every one of its openai-routed entries (subscription access, no
// metering exposed at all -- there's no numeric signal there whatsoever).
//
// Both harnesses can route through the same underlying OpenAI/Codex model
// family though (Pi via its "openai-codex" provider, OpenCode via its
// "openai" provider), so it gets ONE hand-curated tier map, verified
// against Zach's actual usage the same way Claude's static catalog is
// (see harness-catalog.json) -- not inferred from either harness's live
// data. Deliberately small: only the models actually worth auto-picking
// get a tier; anything else (older generations, other providers/models)
// stays reachable only via the manual per-profile picker.
//
// This needs re-verifying whenever the model lineup moves -- see
// github.com/zachristmas/baa-ton#7 for the planned scheduled job to catch
// that drift instead of relying on someone noticing a bad pick.
const CODEX_FAMILY_PROVIDER = { pi: "openai-codex", opencode: "openai" };
const CODEX_FAMILY_TIER = {
  "gpt-5.6-luna": "cheap",
  "gpt-5.6-terra": "build",
  "gpt-5.6-sol": "frontier",
  "gpt-6-astra": "flagship",
};
// "quick" specifically gets the pre-5.6 gpt-5.3-codex-spark instead of the
// generic "cheap" tier's gpt-5.6-luna -- it runs on a flat subscription
// rather than being billed at its sticker price, so it's cheaper in
// practice despite being an older generation. "sustained" is also tier
// "cheap" but stays on the generic luna pick; this is a profile-specific
// override, not a tier-wide one.
const CODEX_FAMILY_PROFILE_OVERRIDE = {
  quick: "gpt-5.3-codex-spark",
};

/** Look up a harness's catalog entry for this profile/tier in the hand-curated Codex-family map (see above), matching on the id with any "provider/" prefix stripped (OpenCode's ids are "openai/gpt-5.6-sol"; Pi's are bare). */
function pickCodexFamilyModel(detection, profileName, tier, provider) {
  const targetId = CODEX_FAMILY_PROFILE_OVERRIDE[profileName] ?? Object.keys(CODEX_FAMILY_TIER).find((id) => CODEX_FAMILY_TIER[id] === tier);
  if (!targetId) return undefined;
  return (detection.catalog ?? []).find(
    (entry) => entry.provider === provider && (entry.id ?? "").replace(/^[^/]+\//, "") === targetId,
  );
}

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

// Per-profile-category MODEL tier, resolved against a harness's live
// catalog ranking (see modelForProfile) rather than a hardcoded model name
// -- a Codex catalog pull on 2026-09-18 found gpt-5.6-sol and gpt-6-astra
// tied for the top rank, proving pure position-based auto-pick alone can't
// disambiguate "the" frontier model; tier boundaries are the durable part,
// specific names are not. See github.com/zachristmas/baa-ton/issues/7 for
// the follow-up: verify these tier assumptions against live catalogs.
//
// The top rank itself splits into two: "flagship" (Fable, Astra) is
// materially more expensive to run than "frontier" (Opus, Sol) even though
// both are top-tier -- Fable is ~2x Opus's weight/API price per the
// research this was drafted from. Only deep-review reaches for flagship;
// planning/review default to the cheaper frontier pick.
const PROFILE_MODEL_TIER = {
  planning: "frontier",
  quick: "cheap",
  balanced: "build",
  implementation: "build",
  sustained: "cheap",
  review: "frontier",
  "deep-review": "flagship",
};

function isUsable(detection) {
  return Boolean(detection) && detection.source !== "static" && !!detection.defaultModel;
}

const LEGACY_DESCRIPTION = /previous.generation|legacy|deprecated|superseded|retiring|retired/i;

/**
 * Catalog entries with a real live rank (priority) that aren't hidden,
 * sorted best-ranked first. `priority` alone can't be trusted as a stable
 * frontier/build/cheap signal -- live pulls have shown the same model's
 * priority number shift between calls and models appear/disappear from one
 * pull to the next -- so a model whose own description flags it as a
 * legacy/superseded fallback (e.g. "proven previous-generation model") is
 * excluded from ranking, unless excluding it would leave nothing at all.
 */
function rankedCatalog(detection) {
  const withRank = (detection.catalog ?? []).filter(
    (entry) => typeof entry.priority === "number" && entry.visibility !== "hide",
  );
  const current = withRank.filter((entry) => !LEGACY_DESCRIPTION.test(entry.description ?? ""));
  const entries = current.length > 0 ? current : withRank;
  if (entries.length === 0) return undefined;
  return [...entries].sort((a, b) => a.priority - b.priority);
}

// A model's own description calling it out as the single most-capable
// option (Astra: "our most capable model for complex, demanding work") is
// a real signal distinguishing it from a merely-top-ranked peer (Sol:
// "frontier agentic coding model") -- used only to split a tie at the top
// rank, never to hardcode which specific model name wins.
const FLAGSHIP_DESCRIPTION = /most capable|complex,? demanding|flagship/i;

/** Split whatever's tied for the lowest (best) priority into flagship (pricier) vs frontier (cheaper). */
function splitTopTier(ranked) {
  const topPriority = ranked[0].priority;
  const tiedAtTop = ranked.filter((entry) => entry.priority === topPriority);
  if (tiedAtTop.length <= 1) return { frontier: ranked[0], flagship: ranked[0] };
  const flagship = tiedAtTop.find((entry) => FLAGSHIP_DESCRIPTION.test(entry.description ?? "")) ?? tiedAtTop[tiedAtTop.length - 1];
  const frontier = tiedAtTop.find((entry) => entry !== flagship) ?? ranked[0];
  return { frontier, flagship };
}

function pickCatalogEntryForTier(ranked, tier) {
  if (!ranked || ranked.length === 0) return undefined;
  if (tier === "cheap") return ranked[ranked.length - 1];
  if (tier === "frontier" || tier === "flagship") {
    const split = splitTopTier(ranked);
    return tier === "flagship" ? split.flagship : split.frontier;
  }
  // "build": the middle of the ranked list; with only two ranked entries,
  // lean toward the cheaper one -- everyday work, not the flagship.
  const midIndex = ranked.length === 2 ? 1 : Math.floor(ranked.length / 2);
  return ranked[midIndex];
}

/**
 * Which model a profile should use from a harness's detection, preferring
 * (in order): an explicit hand-curated `tier` on a catalog entry (safe for
 * a static, maintained list like Claude's -- no live volatility to guard
 * against); tier-based inference from a live catalog's own priority
 * ranking (Codex's case, where no one can hand-curate); the hand-curated
 * Codex-family tier map (see CODEX_FAMILY_TIER above -- Pi and OpenCode's
 * catalogs carry no usable signal of their own); the harness's single
 * detected default when none of the above apply.
 */
function modelForProfile(profileName, detection, harnessId, tierOverride) {
  const tier = tierOverride ?? PROFILE_MODEL_TIER[profileName];
  if (tier) {
    const explicit = (detection.catalog ?? []).find((entry) => entry.tier === tier);
    if (explicit) return { modelId: explicit.id, thinkingLevels: explicit.thinkingLevels };
    const picked = pickCatalogEntryForTier(rankedCatalog(detection), tier);
    if (picked) return { modelId: picked.id, thinkingLevels: picked.thinkingLevels };
    const familyProvider = CODEX_FAMILY_PROVIDER[harnessId];
    if (familyProvider) {
      const pickedFromFamily = pickCodexFamilyModel(detection, profileName, tier, familyProvider);
      if (pickedFromFamily) return { modelId: pickedFromFamily.id, thinkingLevels: pickedFromFamily.thinkingLevels };
    }
  }
  return { modelId: detection.defaultModel, thinkingLevels: catalogThinkingLevels(detection, detection.defaultModel) };
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
    const { modelId, thinkingLevels } = modelForProfile(profileName, detection, harnessId);
    const thinking = nearestSupportedThinking(preferredEffort, thinkingLevels ?? undefined) ?? detection.defaultThinking ?? preferredEffort;
    profiles[profileName] = {
      agentKind: harnessId,
      launchProfile: {
        provider,
        model: modelId,
        thinking,
        auth: "subscription",
      },
    };
  }
  return profiles;
}

function allProfilesOnHarness(harnessId, detection, taskProfilesDefaults) {
  const provider = HARNESS_TO_PROVIDER[harnessId];
  if (!provider || !isUsable(detection)) return undefined;
  const profiles = {};
  for (const [profileName, profileDefaults] of Object.entries(taskProfilesDefaults)) {
    const preferredEffort = PROFILE_EFFORT_PREFERENCE[profileName] ?? profileDefaults.thinking ?? "medium";
    const { modelId, thinkingLevels } = modelForProfile(profileName, detection, harnessId);
    const thinking = nearestSupportedThinking(preferredEffort, thinkingLevels ?? undefined) ?? detection.defaultThinking ?? preferredEffort;
    profiles[profileName] = {
      agentKind: harnessId,
      launchProfile: { provider, model: modelId, thinking, auth: "subscription" },
    };
  }
  return profiles;
}

/**
 * A template built from an explicit per-profile harness preference order,
 * instead of task-profiles.json's own preferredHarnesses. Each profile
 * still gets its own PROFILE_EFFORT_PREFERENCE rung, snapped to whatever
 * the picked harness's catalog actually supports.
 *
 * @param {(profileName: string) => string[]} roleOrder
 */
function buildRoleBasedTemplate(selectedHarnessIds, detectionResults, taskProfilesDefaults, roleOrder) {
  const profiles = {};
  for (const [profileName, profileDefaults] of Object.entries(taskProfilesDefaults)) {
    const picked = pickHarnessForProfile(profileName, selectedHarnessIds, detectionResults, roleOrder(profileName));
    if (!picked) continue;
    const { harnessId, detection } = picked;
    const provider = HARNESS_TO_PROVIDER[harnessId];
    if (!provider) continue;
    const preferredEffort = PROFILE_EFFORT_PREFERENCE[profileName] ?? profileDefaults.thinking ?? "medium";
    const { modelId, thinkingLevels } = modelForProfile(profileName, detection, harnessId);
    const thinking = nearestSupportedThinking(preferredEffort, thinkingLevels ?? undefined) ?? detection.defaultThinking ?? preferredEffort;
    profiles[profileName] = {
      agentKind: harnessId,
      launchProfile: { provider, model: modelId, thinking, auth: "subscription" },
    };
  }
  return Object.keys(profiles).length ? profiles : undefined;
}

// Cross-vendor review has direction (arXiv 2607.21656, Jul 2026): Claude
// reviewing Codex-generated drafts lifted pass rate 71.6% -> 89.7%; Codex
// reviewing Claude regressed. So the review/deep-review roles prefer Claude
// even when Codex did the building.
const CLAUDE_REVIEWS_CODEX_BUILDS_ORDER = {
  planning: ["claude", "codex", "pi", "opencode"],
  quick: ["codex", "pi", "opencode", "claude"],
  balanced: ["codex", "pi", "opencode", "claude"],
  implementation: ["codex", "pi", "opencode", "claude"],
  sustained: ["codex", "pi", "opencode", "claude"],
  review: ["claude", "codex", "pi", "opencode"],
  "deep-review": ["claude", "codex", "pi", "opencode"],
};

// "Fastest"/"max quality" force both the effort AND the model tier for
// every profile, rather than each profile's own role-based tier -- the
// whole point is picking the cheapest (or priciest) model everywhere, not
// just dialing effort on whatever model a role would normally get.
function allProfilesAtEffort(effort, tier, selectedHarnessIds, detectionResults, taskProfilesDefaults) {
  const profiles = {};
  for (const [profileName, profileDefaults] of Object.entries(taskProfilesDefaults)) {
    const picked = pickHarnessForProfile(profileName, selectedHarnessIds, detectionResults, profileDefaults.preferredHarnesses);
    if (!picked) continue;
    const { harnessId, detection } = picked;
    const provider = HARNESS_TO_PROVIDER[harnessId];
    if (!provider) continue;
    const { modelId, thinkingLevels } = modelForProfile(profileName, detection, harnessId, tier);
    const thinking = nearestSupportedThinking(effort, thinkingLevels ?? undefined) ?? detection.defaultThinking ?? effort;
    profiles[profileName] = {
      agentKind: harnessId,
      launchProfile: { provider, model: modelId, thinking, auth: "subscription" },
    };
  }
  return Object.keys(profiles).length ? profiles : undefined;
}

/**
 * Prebuilt starting points a user can cycle through before fine-tuning
 * individual profiles: the existing spread-across-harnesses recommendation,
 * one "everything on this harness" option per usable selected harness, and
 * fastest/highest-quality-everywhere extremes. Never invents a model ID --
 * a template is only included when it actually resolves at least one
 * profile from real detection data.
 *
 * @param {string[]} selectedHarnessIds
 * @param {Record<string, ReturnType<typeof import("./harness-detect.mjs").readClaudeDefaults>>} detectionResults
 * @param {Record<string, {preferredHarnesses: string[], thinking?: string}>} taskProfilesDefaults
 * @returns {{id: string, label: string, profiles: Record<string, object>}[]}
 */
export function buildProfileTemplates(selectedHarnessIds, detectionResults, taskProfilesDefaults) {
  const templates = [
    {
      id: "recommended",
      label: "Recommended (spread across selected harnesses)",
      profiles: defaultLaunchProfiles(selectedHarnessIds, detectionResults, taskProfilesDefaults),
    },
  ];

  for (const harnessId of selectedHarnessIds) {
    const profiles = allProfilesOnHarness(harnessId, detectionResults[harnessId], taskProfilesDefaults);
    if (profiles) templates.push({ id: `all-${harnessId}`, label: `Everything on ${harnessId}`, profiles });
  }

  const fastest = allProfilesAtEffort("low", "cheap", selectedHarnessIds, detectionResults, taskProfilesDefaults);
  if (fastest) templates.push({ id: "fastest", label: "Fastest everywhere (cheapest model, low effort)", profiles: fastest });

  const maxQuality = allProfilesAtEffort("max", "frontier", selectedHarnessIds, detectionResults, taskProfilesDefaults);
  if (maxQuality) templates.push({ id: "max-quality", label: "Maximum quality everywhere (frontier model, max effort)", profiles: maxQuality });

  // Only meaningfully different from "recommended" when both are selected
  // and usable; skip it otherwise rather than show a near-duplicate.
  if (selectedHarnessIds.includes("claude") && selectedHarnessIds.includes("codex")) {
    const crossVendor = buildRoleBasedTemplate(
      selectedHarnessIds,
      detectionResults,
      taskProfilesDefaults,
      (name) => CLAUDE_REVIEWS_CODEX_BUILDS_ORDER[name] ?? [],
    );
    if (crossVendor) {
      templates.push({
        id: "claude-reviews-codex-builds",
        label: "Claude plans & reviews, Codex builds (cross-vendor review pattern)",
        profiles: crossVendor,
      });
    }
  }

  // pi and Codex share the same underlying OpenAI-family model catalog in
  // this codebase (pi's provider is Codex-only), but pi's harness overhead
  // is a fraction of Codex CLI's for the identical model. Only meaningfully
  // different from "recommended" when pi is actually selected and usable.
  if (selectedHarnessIds.includes("pi")) {
    const lean = buildRoleBasedTemplate(
      selectedHarnessIds,
      detectionResults,
      taskProfilesDefaults,
      () => ["pi", "codex", "claude", "opencode"],
    );
    if (lean) templates.push({ id: "lean-pi", label: "Lean (prefer pi's lower overhead over Codex/Claude Code)", profiles: lean });
  }

  return templates;
}
