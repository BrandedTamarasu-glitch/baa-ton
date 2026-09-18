import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultLaunchProfiles } from "../profile-defaults.mjs";
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
