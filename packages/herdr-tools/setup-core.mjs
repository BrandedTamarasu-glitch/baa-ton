#!/usr/bin/env node
/**
 * Harness-neutral Baa-ton project setup primitives.
 *
 * Detection is advisory. The selected harness and exact launch profile are
 * persisted for the user, while dispatch still performs live qualification.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolsDirectory = dirname(fileURLToPath(import.meta.url));
const checkoutDirectory = resolve(join(toolsDirectory, "../.."));
const defaultsPath = join(toolsDirectory, "task-profiles.json");
const BAA_REFERENCE_START = "<!-- baa-ton:start -->";
const BAA_REFERENCE_END = "<!-- baa-ton:end -->";
const BAA_CONFIG_DIRECTORY = ".baa-ton";
const BAA_CONFIG_NAME = "config.json";
const START_SKILL_START = "<!-- baa-ton:start-skill:start -->";
const START_SKILL_END = "<!-- baa-ton:start-skill:end -->";
const LEGACY_SETUP_SKILL_START = "<!-- baa-ton:setup-skill:start -->";
const LEGACY_SETUP_SKILL_END = "<!-- baa-ton:setup-skill:end -->";
const PROJECT_SKILLS = ["baa-ton-start", "baa-ton-configure", "baa-ton-update", "baa-ton-uninstall"];

const START_SKILL_DIRECTORIES = {
  pi: [".pi", "skills"],
  claude: [".claude", "skills"],
  codex: [".codex", "skills"],
  opencode: [".opencode", "skills"],
};

export const HARNESSES = [
  { id: "pi", label: "Pi", binary: "pi", instructionFile: null },
  { id: "claude", label: "Claude Code", binary: "claude", instructionFile: "CLAUDE.md" },
  { id: "codex", label: "Codex", binary: "codex", instructionFile: "AGENTS.md" },
  { id: "opencode", label: "OpenCode", binary: "opencode", instructionFile: "AGENTS.md" },
];

export function detectCommand(binary) {
  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const location = execFileSync(locator, [binary], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split(/\r?\n/)[0];
    if (!location) return undefined;
    let version = "unknown version";
    try {
      version = execFileSync(binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .trim()
        .split(/\r?\n/)[0] || version;
    } catch {
      // Detection remains useful when a CLI has no --version or needs a TTY.
    }
    return { location, version };
  } catch {
    return undefined;
  }
}

export function detectHarnesses() {
  return HARNESSES.map((harness) => ({ ...harness, detected: detectCommand(harness.binary) }));
}

export function loadDefaults() {
  return JSON.parse(readFileSync(defaultsPath, "utf8"));
}

export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function managedReferenceBlock(baaPath) {
  return [
    BAA_REFERENCE_START,
    `Read and follow the Baa-ton operating contract at \`${baaPath}\` before planning, delegating, or acting as a root.`,
    BAA_REFERENCE_END,
  ].join("\n");
}

export function updateManagedReference(path, baaPath) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = managedReferenceBlock(baaPath);
  const pattern = new RegExp(`${escapeRegExp(BAA_REFERENCE_START)}[\\s\\S]*?${escapeRegExp(BAA_REFERENCE_END)}\\n?`);
  const next = pattern.test(existing)
    ? existing.replace(pattern, `${block}\n`)
    : `${existing.trimEnd()}${existing.trimEnd() ? "\n\n" : ""}${block}\n`;
  if (next !== existing) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, next);
  }
  return { path, changed: next !== existing };
}

export function projectSkillPath(projectRoot, harnessId, skillName) {
  const directory = START_SKILL_DIRECTORIES[harnessId];
  if (!directory) throw new Error(`Unknown harness ${JSON.stringify(harnessId)}.`);
  if (!PROJECT_SKILLS.includes(skillName)) throw new Error(`Unknown Baa-ton skill ${JSON.stringify(skillName)}.`);
  return join(projectRoot, ...directory, skillName, "SKILL.md");
}

export function startSkillPath(projectRoot, harnessId) {
  return projectSkillPath(projectRoot, harnessId, "baa-ton-start");
}

export function configureSkillPath(projectRoot, harnessId) {
  return projectSkillPath(projectRoot, harnessId, "baa-ton-configure");
}

export function updateSkillPath(projectRoot, harnessId) {
  return projectSkillPath(projectRoot, harnessId, "baa-ton-update");
}

export function uninstallSkillPath(projectRoot, harnessId) {
  return projectSkillPath(projectRoot, harnessId, "baa-ton-uninstall");
}

export function startSkillContent({ harness, baaPath, projectRoot }) {
  const rootSetupPath = join(checkoutDirectory, "packages", "herdr-tools", "root-setup.mjs");
  const setupPath = join(checkoutDirectory, "packages", "herdr-tools", "setup.mjs");
  return [
    "---",
    "name: baa-ton-start",
    "description: Start or repair Baa-ton in the current Herdr project after installation.",
    "---",
    START_SKILL_START,
    "",
    "# Start Baa-ton",
    "",
    `Use this skill when Baa-ton is installed but the current ${harness} session does not have its root tools connected, or when Baa-ton needs to be repaired. The target project is \`${projectRoot}\`.`,
    "",
    `1. Read \`${baaPath}\` and confirm this is the intended Herdr pane.`,
    `2. Run: \`node "${rootSetupPath}" --harness ${harness}\`.`,
    "3. Follow the helper's one-time integration instruction and restart this harness in the same pane if it requests a restart.",
    "4. Call `herdr_bootstrap_root` and verify the returned workspace and pane identity.",
    "5. Report that the root is ready and wait for the user's task. Do not initialize a goal until the user gives the objective.",
    "",
    `If project configuration must be changed, rerun the project wizard with \`node "${setupPath}" --project-root "${projectRoot}"\`; do not guess model, auth, or thinking settings.`,
    START_SKILL_END,
    "",
  ].join("\n");
}

export function configureSkillContent({ baaPath, projectRoot }) {
  const installTuiPath = join(checkoutDirectory, "packages", "herdr-tools", "install-tui.mjs");
  const wizardCommand = `node \\"${installTuiPath}\\" --project-root \\"${projectRoot}\\" --config-only`;
  return [
    "---",
    "name: baa-ton-configure",
    "description: Configure Baa-ton worker profiles and exact harness model settings for this project.",
    "---",
    START_SKILL_START,
    "",
    "# Configure Baa-ton",
    "",
    `Use this skill when the user wants to change which harness, model, thinking level, or authentication choice Baa-ton uses for a worker type. Read \`${baaPath}\` and \`${join(projectRoot, ".baa-ton", "config.json")}\` first.`,
    "",
    "1. Ask the user which they want: (a) a quick tweak made directly in this conversation, or (b) the full profile picker (harness -> model -> thinking, with live per-template previews) in its own terminal.",
    "2. For (a): ask for exact provider, model, thinking, and auth values when they are not already known -- never invent a model ID or silently substitute one -- then update the matching profile's `agentKind` and exact `launchProfile` (`provider`, `model`, `thinking`, `auth`) in `.baa-ton/config.json` and show the resulting mapping.",
    `3. For (b): check \`test "\${HERDR_ENV:-}" = 1\`. If that fails (not running inside Herdr), tell the user to run \`node "${installTuiPath}" --project-root "${projectRoot}" --config-only\` themselves in a terminal -- do not run a full-screen interactive wizard in this pane.`,
    "4. If inside Herdr, open it in a fresh tab (the wizard's banner and dividers need full width, not a cramped split):",
    `   \`herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "${projectRoot}" --label "Baa-ton configure" --focus\`, read the new pane id from \`.result.root_pane.pane_id\`, then \`herdr pane run <pane_id> "${wizardCommand}"\`.`,
    "5. Tell the user the picker opened in a new tab and to close it (or say so here) when done. Do not read its output back into this conversation or assume it finished -- it is a separate interactive session.",
    "6. Do not bootstrap a root, initialize a goal, plan work, or dispatch a lane as part of configuration.",
    START_SKILL_END,
    "",
  ].join("\n");
}

export function uninstallSkillContent() {
  const isWindows = process.platform === "win32";
  const uninstallScriptPath = join(checkoutDirectory, isWindows ? "uninstall.ps1" : "uninstall.sh");
  const uninstallCommand = isWindows
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${uninstallScriptPath}"`
    : `bash "${uninstallScriptPath}"`;
  const uninstallCommandEscaped = isWindows
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File \\"${uninstallScriptPath}\\"`
    : `bash \\"${uninstallScriptPath}\\"`;
  return [
    "---",
    "name: baa-ton-uninstall",
    "description: Uninstall Baa-ton from this machine.",
    "---",
    START_SKILL_START,
    "",
    "# Uninstall Baa-ton",
    "",
    "Use this skill only when the user explicitly asks to uninstall or remove Baa-ton. This removes the shared Baa-ton checkout, Pi extension link, and Herdr controller registration for the whole machine, not just this project -- project files (`BAA.md`, `.baa-ton/config.json`, project-local skills) are untouched. For \"stop using this harness/model here\" instead of a full removal, use `baa-ton-configure`.",
    "",
    "1. Confirm with the user that they want to remove Baa-ton from this machine entirely, not just reconfigure this project.",
    `2. Check \`test "\${HERDR_ENV:-}" = 1\`. If that fails (not running inside Herdr), tell the user to run this themselves in a terminal: \`${uninstallCommand}\`.`,
    "3. If inside Herdr, open it in a fresh tab (the uninstaller prompts its own y/N confirmation):",
    `   \`herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "${checkoutDirectory}" --label "Baa-ton uninstall" --focus\`, read the new pane id from \`.result.root_pane.pane_id\`, then \`herdr pane run <pane_id> "${uninstallCommandEscaped}"\`.`,
    "4. Tell the user the uninstaller opened in a new tab and to confirm there. Never pass -Force/--force on the user's behalf -- let the script's own confirmation stand.",
    START_SKILL_END,
    "",
  ].join("\n");
}

export function updateSkillContent({ projectRoot }) {
  const setupPath = join(checkoutDirectory, "packages", "herdr-tools", "setup.mjs");
  return [
    "---",
    "name: baa-ton-update",
    "description: Update the Baa-ton checkout and refresh this project's harness integrations.",
    "---",
    START_SKILL_START,
    "",
    "# Update Baa-ton",
    "",
    `Use this skill only when the user asks to update Baa-ton. The project is \`${projectRoot}\`.`,
    "",
    "1. Preserve the project's `BAA.md`, `.baa-ton/config.json`, instruction files, and user-authored skills.",
    `2. Update the checkout with \`git -C "${checkoutDirectory}" pull --ff-only\`. If the checkout has local changes or the fast-forward fails, stop and report it.`,
    // npm's --prefix only changes where node_modules/package-lock end up; it
    // does not redirect which package.json npm reads dependencies from --
    // that still comes from the shell's cwd, so `npm --prefix "<dir>"
    // install` run from an unrelated directory fails looking for a
    // package.json that isn't there. cd into the checkout first instead.
    `3. Install dependency changes: \`cd "${checkoutDirectory}" && npm install --no-audit --no-fund\`.`,
    `4. Refresh the project integrations with \`node "${setupPath}" --project-root "${projectRoot}" --non-interactive\`.`,
    "5. Report the new checkout commit and any preserved or changed project configuration. Restart the harness only if its integration requires it.",
    "6. Do not reset active Herdr roots, retire resources, initialize goals, plan work, or dispatch lanes as part of an update.",
    START_SKILL_END,
    "",
  ].join("\n");
}

function installStartSkill(path, content) {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (!existing.includes(START_SKILL_START) || !existing.includes(START_SKILL_END))
      return { path, changed: false, skipped: true };
    if (existing === content) return { path, changed: false, skipped: false };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  return { path, changed: true, skipped: false };
}

function removeLegacySetupSkill(projectRoot, harness) {
  const directory = START_SKILL_DIRECTORIES[harness];
  const path = join(projectRoot, ...directory, "baa-ton-setup", "SKILL.md");
  if (!existsSync(path)) return false;
  const existing = readFileSync(path, "utf8");
  if (!existing.includes(LEGACY_SETUP_SKILL_START) || !existing.includes(LEGACY_SETUP_SKILL_END)) return false;
  rmSync(path, { force: true });
  return true;
}

export function installProjectSkills({ projectRoot, selected, baaPath }) {
  for (const harness of Object.keys(START_SKILL_DIRECTORIES)) removeLegacySetupSkill(projectRoot, harness);
  const content = {
    "baa-ton-start": (harness) => startSkillContent({ harness, baaPath, projectRoot }),
    "baa-ton-configure": () => configureSkillContent({ baaPath, projectRoot }),
    "baa-ton-update": () => updateSkillContent({ projectRoot }),
    "baa-ton-uninstall": () => uninstallSkillContent(),
  };
  return selected.flatMap((harness) => PROJECT_SKILLS.map((skillName) => installStartSkill(
    projectSkillPath(projectRoot, harness, skillName),
    content[skillName](harness),
  )));
}

export function ensureProjectBaa(projectRoot, installedBaaPath) {
  const projectBaaPath = join(projectRoot, "BAA.md");
  if (!existsSync(projectBaaPath)) copyFileSync(installedBaaPath, projectBaaPath);
  return resolve(projectBaaPath);
}

export function instructionCandidates(projectRoot, selected) {
  const candidates = [];
  for (const harness of HARNESSES.filter((item) => selected.includes(item.id))) {
    if (!harness.instructionFile) continue;
    const projectPath = join(projectRoot, harness.instructionFile);
    if (existsSync(projectPath)) candidates.push(projectPath);
    const globalPath = join(homedir(), harness.instructionFile);
    if (existsSync(globalPath)) candidates.push(globalPath);
  }
  return [...new Set(candidates)];
}

export function buildSetupConfig({ projectRoot, baaPath, detected, selected, instructionFiles, defaults, skills = [] }) {
  const configPath = join(projectRoot, BAA_CONFIG_DIRECTORY, BAA_CONFIG_NAME);
  const existing = readJson(configPath, {});
  delete existing.setupSkills;
  delete existing.startSkills;
  if (existing.version !== undefined && existing.version !== 1)
    throw new Error(`Unsupported Baa-ton config version at ${configPath}.`);
  const profiles = { ...Object.fromEntries(Object.entries(defaults.profiles).map(([name, profile]) => [
    name,
    {
      description: profile.description,
      readOnly: profile.readOnly,
      thinking: profile.thinking,
      costPreference: profile.costPreference,
      contextPreference: profile.contextPreference,
      preferredHarnesses: profile.preferredHarnesses,
    },
  ])), ...(existing.profiles ?? {}) };
  return {
    ...existing,
    version: 1,
    baaPath,
    detectedHarnesses: detected.filter((harness) => harness.detected).map((harness) => ({
      id: harness.id,
      label: harness.label,
      binary: harness.binary,
      location: harness.detected.location,
      version: harness.detected.version,
    })),
    selectedHarnesses: selected,
    instructionFiles,
    skills,
    profiles,
  };
}

export { checkoutDirectory, toolsDirectory, defaultsPath, BAA_CONFIG_DIRECTORY, BAA_CONFIG_NAME };
