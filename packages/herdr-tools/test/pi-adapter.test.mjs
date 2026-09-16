import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { piLaunchAdapter } = await jiti.import("../pi-launch-adapter.ts");

const profile = {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  thinking: "high",
  auth: "subscription",
};

const modelRegistry = {
  refresh: async () => ({ errors: new Map() }),
  find: () => ({
    reasoning: true,
    thinkingLevelMap: { high: "high" },
  }),
  hasConfiguredAuth: () => true,
  isUsingOAuth: () => true,
};

test("Pi native resume targets the exact persisted session path", () => {
  const adapter = piLaunchAdapter(
    { modelRegistry },
    "/native/herdr-agent-state.ts",
  );
  const session = {
    provider: "pi",
    sessionId: "/Users/test/.pi/agent/sessions/lane.jsonl",
  };
  assert.equal(adapter.capabilities.supportsSessionResume, true);
  assert.equal(adapter.resumeSessionId(session), session.sessionId);
  assert.deepEqual(
    adapter.resumeArguments(profile, session, "/source/index.ts"),
    [
      "--session",
      session.sessionId,
      "--provider",
      profile.provider,
      "--model",
      profile.model,
      "--thinking",
      profile.thinking,
      "--no-extensions",
      "-e",
      "/native/herdr-agent-state.ts",
      "-e",
      "/source/index.ts",
    ],
  );
});
