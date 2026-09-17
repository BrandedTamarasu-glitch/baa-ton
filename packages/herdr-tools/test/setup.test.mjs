import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSetupConfig,
  installSetupSkills,
  managedReferenceBlock,
  setupSkillContent,
  setupSkillPath,
  updateManagedReference,
} from "../setup.mjs";
import { resolveTaskProfile, taskProfileConfigPath } from "../profile-config.mjs";

test("managed BAA references are idempotent and replace stale paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-setup-"));
  try {
    const path = join(directory, "AGENTS.md");
    await writeFile(path, "# Project\n\nExisting instructions.\n");
    updateManagedReference(path, "/one/BAA.md");
    const first = await readFile(path, "utf8");
    assert.match(first, /\/one\/BAA\.md/);
    updateManagedReference(path, "/two/BAA.md");
    const second = await readFile(path, "utf8");
    assert.match(second, /\/two\/BAA\.md/);
    assert.doesNotMatch(second, /\/one\/BAA\.md/);
    updateManagedReference(path, "/two/BAA.md");
    assert.equal(await readFile(path, "utf8"), second);
    assert.equal(second.match(/baa-ton:start/g).length, 1);
    assert.match(second, /Existing instructions\./);
    assert.match(second, new RegExp(managedReferenceBlock("/two/BAA.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup config preserves exact user profiles while adding defaults", async () => {
  const defaults = {
    profiles: {
      planning: {
        description: "Plan.",
        readOnly: true,
        thinking: "high",
        costPreference: "medium",
        contextPreference: "large",
        preferredHarnesses: ["claude"],
      },
    },
  };
  const config = buildSetupConfig({
    projectRoot: "/project",
    baaPath: "/install/BAA.md",
    detected: [{ id: "claude", label: "Claude Code", binary: "claude", detected: { location: "/bin/claude", version: "test" } }],
    selected: ["claude"],
    instructionFiles: ["/project/CLAUDE.md"],
    defaults,
  });
  assert.deepEqual(config.selectedHarnesses, ["claude"]);
  assert.equal(config.profiles.planning.readOnly, true);
});

test("selected harnesses receive idempotent project-local setup skills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-skills-"));
  try {
    const selected = ["pi", "claude", "codex", "opencode"];
    const first = installSetupSkills({
      projectRoot: directory,
      selected,
      baaPath: join(directory, "BAA.md"),
    });
    assert.deepEqual(first.map((skill) => skill.skipped), [false, false, false, false]);
    for (const harness of selected) {
      const path = setupSkillPath(directory, harness);
      const content = await readFile(path, "utf8");
      assert.match(content, /name: baa-ton-setup/);
      assert.match(content, new RegExp(`--harness ${harness}`));
      assert.equal(content, setupSkillContent({
        harness,
        baaPath: join(directory, "BAA.md"),
        projectRoot: directory,
      }));
    }
    const second = installSetupSkills({
      projectRoot: directory,
      selected,
      baaPath: join(directory, "BAA.md"),
    });
    assert.deepEqual(second.map((skill) => skill.changed), [false, false, false, false]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configured task profile resolves an exact launch profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-profile-"));
  try {
    await mkdir(join(directory, ".baa-ton"));
    await writeFile(
      taskProfileConfigPath(directory),
      JSON.stringify({
        version: 1,
        profiles: {
          planning: {
            agentKind: "claude",
            launchProfile: {
              provider: "claude-code",
              model: "claude-sonnet-5",
              thinking: "high",
              auth: "subscription",
            },
          },
        },
      }),
    );
    const profile = resolveTaskProfile(directory, "planning");
    assert.equal(profile.agentKind, "claude");
    assert.equal(profile.readOnly, true);
    assert.deepEqual(profile.launchProfile, {
      provider: "claude-code",
      model: "claude-sonnet-5",
      thinking: "high",
      auth: "subscription",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unconfigured task profile fails closed instead of guessing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-profile-missing-"));
  try {
    assert.throws(
      () => resolveTaskProfile(directory, "sustained"),
      /no exact launchProfile/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
