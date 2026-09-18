import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProfileTemplates, defaultLaunchProfiles } from "../profile-defaults.mjs";
import { defaultTaskProfiles } from "../profile-config.mjs";

const TASK_PROFILES = defaultTaskProfiles();

test("a selected harness with real detection data produces a concrete launchProfile", () => {
  const detectionResults = {
    claude: {
      defaultModel: "claude-sonnet-5",
      defaultThinking: "medium",
      catalog: [{ id: "claude-sonnet-5", label: "Sonnet", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] }],
      source: "file",
      warnings: [],
    },
  };
  const result = defaultLaunchProfiles(["claude"], detectionResults, TASK_PROFILES);
  assert.deepEqual(result.planning, {
    agentKind: "claude",
    launchProfile: { provider: "claude-code", model: "claude-sonnet-5", thinking: "high", auth: "subscription" },
  });
  assert.equal(result.quick.launchProfile.thinking, "low");
  assert.equal(result["deep-review"].launchProfile.thinking, "max");
  for (const profile of Object.values(result)) {
    assert.equal(profile.launchProfile.auth, "subscription");
    assert.equal(profile.launchProfile.model, "claude-sonnet-5");
  }
});

test("a harness with only a warning/no data is skipped in favor of another selected harness", () => {
  const detectionResults = {
    claude: { defaultModel: undefined, defaultThinking: undefined, catalog: [], source: "static", warnings: ["no settings.json"] },
    codex: {
      defaultModel: "gpt-5.6-terra",
      defaultThinking: "high",
      catalog: [{ id: "gpt-5.6-terra", label: "Terra", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] }],
      source: "file",
      warnings: [],
    },
  };
  const result = defaultLaunchProfiles(["claude", "codex"], detectionResults, TASK_PROFILES);
  assert.equal(result.planning.agentKind, "codex");
  assert.equal(result.planning.launchProfile.provider, "codex");
  assert.equal(result.planning.launchProfile.model, "gpt-5.6-terra");
});

test("no selected harness has usable data means the profile is omitted entirely, never invented", () => {
  const detectionResults = {
    claude: { defaultModel: undefined, defaultThinking: undefined, catalog: [], source: "static", warnings: ["no settings.json"] },
    codex: { defaultModel: undefined, defaultThinking: undefined, catalog: [], source: "static", warnings: ["no config.toml"] },
  };
  const result = defaultLaunchProfiles(["claude", "codex"], detectionResults, TASK_PROFILES);
  assert.deepEqual(result, {});
});

test("thinking level snaps to the nearest level the harness catalog actually supports", () => {
  const detectionResults = {
    codex: {
      defaultModel: "gpt-5.6-sol",
      defaultThinking: "low",
      catalog: [{ id: "gpt-5.6-sol", label: "Sol", thinkingLevels: ["low", "medium"] }],
      source: "cli",
      warnings: [],
    },
  };
  const result = defaultLaunchProfiles(["codex"], detectionResults, TASK_PROFILES);
  // deep-review prefers "max", unsupported here, so it snaps to the closest supported rung.
  assert.equal(result["deep-review"].launchProfile.thinking, "medium");
});

test("buildProfileTemplates offers recommended, per-harness, and effort-extreme templates", () => {
  const detectionResults = {
    claude: {
      defaultModel: "claude-sonnet-5",
      defaultThinking: "medium",
      catalog: [{ id: "claude-sonnet-5", label: "Sonnet", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] }],
      source: "file",
      warnings: [],
    },
    codex: {
      defaultModel: "gpt-5.6-terra",
      defaultThinking: "high",
      catalog: [{ id: "gpt-5.6-terra", label: "Terra", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] }],
      source: "file",
      warnings: [],
    },
  };
  const templates = buildProfileTemplates(["claude", "codex"], detectionResults, TASK_PROFILES);
  const ids = templates.map((t) => t.id);
  assert.deepEqual(ids, ["recommended", "all-claude", "all-codex", "fastest", "max-quality", "claude-reviews-codex-builds"]);

  const allClaude = templates.find((t) => t.id === "all-claude");
  for (const profile of Object.values(allClaude.profiles)) {
    assert.equal(profile.agentKind, "claude");
    assert.equal(profile.launchProfile.model, "claude-sonnet-5");
  }

  const fastest = templates.find((t) => t.id === "fastest");
  for (const profile of Object.values(fastest.profiles)) assert.equal(profile.launchProfile.thinking, "low");

  const maxQuality = templates.find((t) => t.id === "max-quality");
  for (const profile of Object.values(maxQuality.profiles)) assert.equal(profile.launchProfile.thinking, "max");
});

test("defaultLaunchProfiles picks a model tier per profile from a ranked catalog, not just the harness's single default", () => {
  // Shaped like a real `codex debug models` pull (2026-09-18): two models
  // tied at the top rank, a mid-ranked "everyday" model, and a cheap one.
  const detectionResults = {
    codex: {
      defaultModel: "gpt-6-astra",
      defaultThinking: "medium",
      source: "cli",
      warnings: [],
      catalog: [
        { id: "gpt-5.6-sol", label: "Sol", priority: 1, visibility: "list", thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
        { id: "gpt-6-astra", label: "Astra", priority: 1, visibility: "list", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
        { id: "gpt-reserve", label: "Reserve", priority: 3, visibility: "hide", thinkingLevels: ["medium"] },
        { id: "gpt-5.6-terra", label: "Terra", priority: 7, visibility: "list", thinkingLevels: ["low", "medium", "high"] },
        { id: "gpt-5.6-luna", label: "Luna", priority: 8, visibility: "list", thinkingLevels: ["low", "medium", "high", "xhigh"] },
      ],
    },
  };
  const result = defaultLaunchProfiles(["codex"], detectionResults, TASK_PROFILES);
  // planning/review/deep-review want "frontier" -- rank 1, first entry on a tie.
  assert.equal(result.planning.launchProfile.model, "gpt-5.6-sol");
  assert.equal(result.review.launchProfile.model, "gpt-5.6-sol");
  // balanced/implementation want "build" -- the mid-ranked, non-hidden entry.
  assert.equal(result.balanced.launchProfile.model, "gpt-5.6-terra");
  assert.equal(result.implementation.launchProfile.model, "gpt-5.6-terra");
  // quick/sustained want "cheap" -- the lowest-ranked visible entry (never the hidden one).
  assert.equal(result.quick.launchProfile.model, "gpt-5.6-luna");
  assert.equal(result.sustained.launchProfile.model, "gpt-5.6-luna");
});

test("deep-review reaches for the pricier flagship model when the top rank is a tie; planning/review get the cheaper frontier peer", () => {
  // Shaped like the real Codex tie: two models both at the top rank, one
  // describing itself with "most capable"/"complex, demanding work"
  // superlatives (the pricier flagship), the other more modestly.
  const detectionResults = {
    codex: {
      defaultModel: "gpt-6-astra",
      defaultThinking: "medium",
      source: "cli",
      warnings: [],
      catalog: [
        { id: "gpt-5.6-sol", label: "Sol", priority: 1, visibility: "list", description: "Latest frontier agentic coding model.", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
        { id: "gpt-6-astra", label: "Astra", priority: 1, visibility: "list", description: "Our most capable model for complex, demanding work.", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
        { id: "gpt-5.6-terra", label: "Terra", priority: 7, visibility: "list", description: "Balanced agentic coding model for everyday work.", thinkingLevels: ["low", "medium", "high"] },
      ],
    },
  };
  const result = defaultLaunchProfiles(["codex"], detectionResults, TASK_PROFILES);
  assert.equal(result.planning.launchProfile.model, "gpt-5.6-sol");
  assert.equal(result.review.launchProfile.model, "gpt-5.6-sol");
  assert.equal(result["deep-review"].launchProfile.model, "gpt-6-astra");
});

test("modelForProfile falls back to the harness's single default model when its catalog carries no rank", () => {
  const detectionResults = {
    claude: {
      defaultModel: "claude-sonnet-5",
      defaultThinking: "medium",
      source: "file",
      warnings: [],
      catalog: [{ id: "claude-sonnet-5", label: "Sonnet", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] }],
    },
  };
  const result = defaultLaunchProfiles(["claude"], detectionResults, TASK_PROFILES);
  for (const profile of Object.values(result)) assert.equal(profile.launchProfile.model, "claude-sonnet-5");
});

test("modelForProfile sticks to Pi's gpt-5.6+/gpt-6+ generation, ranked by cost within that set, and reserves the pre-5.6 codex-spark for the cheap tier only", () => {
  // Real shape from @earendil-works/pi-coding-agent's ModelRuntime.getAvailable():
  // no priority/tier field anywhere. Cost alone is unreliable across Pi's full
  // catalog (verified live: gpt-5.4 and gpt-5.3-codex-spark are priced ABOVE
  // gpt-5.6-luna despite being older/subscription models, not better ones) --
  // so older generations are excluded from ranking entirely, except spark,
  // which Zach's own usage confirms as the intended cheap pick specifically
  // because it runs on a flat subscription rather than its sticker price.
  const detectionResults = {
    pi: {
      defaultModel: "gpt-5.6-terra",
      defaultThinking: "medium",
      source: "file",
      warnings: [],
      catalog: [
        { id: "gpt-5.3-codex-spark", label: "Spark", provider: "openai-codex", cost: { output: 14 }, thinkingLevels: [] },
        { id: "gpt-5.4", label: "GPT 5.4", provider: "openai-codex", cost: { output: 15 }, thinkingLevels: [] },
        { id: "gpt-5.6-luna", label: "Luna", provider: "openai-codex", cost: { output: 1.2 }, thinkingLevels: [] },
        { id: "gpt-5.6-terra", label: "Terra", provider: "openai-codex", cost: { output: 12 }, thinkingLevels: [] },
        { id: "gpt-5.6-sol", label: "Sol", provider: "openai-codex", cost: { output: 30 }, thinkingLevels: [] },
        { id: "gpt-6-astra", label: "Astra", provider: "openai-codex", cost: { output: 50 }, thinkingLevels: [] },
      ],
    },
  };
  const result = defaultLaunchProfiles(["pi"], detectionResults, TASK_PROFILES);
  assert.equal(result.quick.launchProfile.model, "gpt-5.3-codex-spark");
  assert.equal(result.sustained.launchProfile.model, "gpt-5.3-codex-spark");
  assert.equal(result["deep-review"].launchProfile.model, "gpt-6-astra");
  assert.equal(result.planning.launchProfile.model, "gpt-5.6-sol");
  assert.notEqual(result.planning.launchProfile.model, "gpt-5.4");
});

test("modelForProfile falls back to OpenCode's single default for every profile: its catalog has no priority signal, and its resold per-model pricing doesn't track capability either", () => {
  const detectionResults = {
    opencode: {
      defaultModel: "github-copilot/gpt-5.6-luna",
      defaultThinking: "medium",
      source: "file",
      warnings: [],
      catalog: [
        // Real-world shape: OpenCode's github-copilot resale pricing put the
        // OLDER gpt-5.4 above gpt-5.6-terra -- cost tracks reseller billing
        // here, not capability, so it must not be used to pick a "flagship".
        { id: "github-copilot/gpt-5.4", label: "GPT 5.4", provider: "github-copilot", cost: { output: 15 }, thinkingLevels: [] },
        { id: "github-copilot/gpt-5.6-terra", label: "Terra", provider: "github-copilot", cost: { output: 12 }, thinkingLevels: [] },
        { id: "github-copilot/gpt-5.6-luna", label: "Luna", provider: "github-copilot", cost: { output: 1.2 }, thinkingLevels: [] },
      ],
    },
  };
  const result = defaultLaunchProfiles(["opencode"], detectionResults, TASK_PROFILES);
  for (const profile of Object.values(result)) assert.equal(profile.launchProfile.model, "github-copilot/gpt-5.6-luna");
});

test("buildProfileTemplates adds the cross-vendor review template only when claude and codex are both selected and usable", () => {
  const detectionResults = {
    claude: {
      defaultModel: "claude-sonnet-5",
      defaultThinking: "medium",
      catalog: [{ id: "claude-sonnet-5", label: "Sonnet", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] }],
      source: "file",
      warnings: [],
    },
    codex: {
      defaultModel: "gpt-5.6-terra",
      defaultThinking: "high",
      catalog: [{ id: "gpt-5.6-terra", label: "Terra", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] }],
      source: "file",
      warnings: [],
    },
  };
  const both = buildProfileTemplates(["claude", "codex"], detectionResults, TASK_PROFILES);
  const crossVendor = both.find((t) => t.id === "claude-reviews-codex-builds");
  assert.ok(crossVendor);
  assert.equal(crossVendor.profiles.implementation.agentKind, "codex");
  assert.equal(crossVendor.profiles.review.agentKind, "claude");
  assert.equal(crossVendor.profiles["deep-review"].agentKind, "claude");

  const claudeOnly = buildProfileTemplates(["claude"], { claude: detectionResults.claude }, TASK_PROFILES);
  assert.ok(!claudeOnly.some((t) => t.id === "claude-reviews-codex-builds"));
});

test("buildProfileTemplates adds a lean-pi template only when pi is selected and usable", () => {
  const detectionResults = {
    pi: {
      defaultModel: "gpt-5.6-terra",
      defaultThinking: "high",
      catalog: [{ id: "gpt-5.6-terra", label: "Terra", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] }],
      source: "file",
      warnings: [],
    },
    codex: {
      defaultModel: "gpt-5.6-terra",
      defaultThinking: "high",
      catalog: [{ id: "gpt-5.6-terra", label: "Terra", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] }],
      source: "file",
      warnings: [],
    },
  };
  const withPi = buildProfileTemplates(["pi", "codex"], detectionResults, TASK_PROFILES);
  const lean = withPi.find((t) => t.id === "lean-pi");
  assert.ok(lean);
  for (const profile of Object.values(lean.profiles)) assert.equal(profile.agentKind, "pi");

  const codexOnly = buildProfileTemplates(["codex"], { codex: detectionResults.codex }, TASK_PROFILES);
  assert.ok(!codexOnly.some((t) => t.id === "lean-pi"));
});

test("buildProfileTemplates omits a per-harness template for a harness with no usable detection", () => {
  const detectionResults = {
    claude: { defaultModel: undefined, defaultThinking: undefined, catalog: [], source: "static", warnings: ["no settings.json"] },
    codex: {
      defaultModel: "gpt-5.6-terra",
      defaultThinking: "high",
      catalog: [{ id: "gpt-5.6-terra", label: "Terra", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] }],
      source: "file",
      warnings: [],
    },
  };
  const templates = buildProfileTemplates(["claude", "codex"], detectionResults, TASK_PROFILES);
  const ids = templates.map((t) => t.id);
  assert.ok(!ids.includes("all-claude"));
  assert.ok(ids.includes("all-codex"));
});
