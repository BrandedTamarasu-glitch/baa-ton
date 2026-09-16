import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { opencodeLaunchAdapter, OPENCODE_PROVIDER } = await jiti.import(
  "../opencode-launch-adapter.ts",
);
const profile = {
  provider: OPENCODE_PROVIDER,
  model: "gpt-5.6-luna",
  thinking: "xhigh",
  auth: "subscription",
};

test("opencode adapter generates project config, plugin, and model mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "baa-opencode-adapter-"));
  const scratch = join(root, ".pi", "herdr-orchestrator");
  try {
    const adapter = opencodeLaunchAdapter({ scratchDirectory: scratch });
    assert.equal(adapter.startupHandshake, "Reply with exactly: READY");
    assert.equal(adapter.capabilities.supportsLiveCapabilityDiscovery, false);
    assert.equal(adapter.capabilities.supportsStartupHandshake, true);
    assert.equal(adapter.discoverCatalog, undefined);
    adapter.preflight(profile);
    const args = adapter.launchArguments(
      profile,
      join(root, "packages", "herdr-tools", "index.ts"),
      { startupIntentPath: join(scratch, "lane.json") },
    );
    assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5.6-luna");
    const config = JSON.parse(
      await readFile(join(root, "opencode.json"), "utf8"),
    );
    assert.equal(config.model, "openai/gpt-5.6-luna");
    assert.equal(config.agent.build.options.reasoningEffort, "xhigh");
    assert.equal(config.mcp["herdr-orchestrator"].command[0], "node");
    assert.match(
      config.mcp["herdr-orchestrator"].command[1],
      /mcp-server\.mjs$/,
    );
    assert.equal(config.permission.bash["git push"], "deny");
    assert.equal(config.permission.bash["git merge"], "deny");
    const plugin = await readFile(
      join(scratch, "opencode-attest-plugin.ts"),
      "utf8",
    );
    assert.match(plugin, /BAA_STARTUP_INTENT/);
    assert.match(plugin, /mergeAttestation/);
    assert.throws(
      () => adapter.launchArguments(profile, "/src/index.ts"),
      /startup intent path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opencode verifyStartup binds session identity and filters operations", () => {
  const adapter = opencodeLaunchAdapter({ scratchDirectory: "/tmp" });
  const attestation = {
    paneId: "w17:p9",
    workspaceId: "w17",
    nonce: "n",
    source: "/src/index.ts",
    profile,
    sessionId: "ses_123",
    operations: ["plan", "dispatch", "complete"],
  };
  const proof = adapter.verifyStartup(
    {
      agent: "opencode",
      pane_id: "w17:p9",
      workspace_id: "w17",
      agent_session: { kind: "id", value: "ses_123" },
    },
    attestation,
  );
  assert.deepEqual(proof.operations, ["plan", "dispatch", "complete"]);
  assert.throws(
    () =>
      adapter.verifyStartup(
        {
          agent: "opencode",
          pane_id: "w17:p9",
          workspace_id: "w17",
          agent_session: { kind: "id", value: "ses_other" },
        },
        attestation,
      ),
    /does not match native identity/,
  );
});
