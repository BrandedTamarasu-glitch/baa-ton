#!/usr/bin/env node
/**
 * Interactive, harness-neutral Baa-ton setup.
 *
 * Detection is advisory. The selected harness and exact launch profile are
 * persisted for the user, while dispatch still performs live qualification.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const PROJECT_SKILLS = ["baa-ton-start", "baa-ton-configure", "baa-ton-update"];

const START_SKILL_DIRECTORIES = {
  pi: [".pi", "agent", "skills"],
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

function usage() {
  return `Usage: node ${join(toolsDirectory, "setup.mjs")} [options]

Options:
  --project-root <dir>       Project directory for .baa-ton/config.json (default: cwd)
  --prompt-project           Ask for the project directory (default: the supplied project root)
  --instructions-path <file> Add/update the managed BAA.md reference in this file
  --harness <name>           Select a harness (repeatable: pi, claude, codex, opencode)
  --non-interactive          Use detected harnesses without opening the checkbox TUI
  --quiet                    Print only errors (for installer use)
  --help                     Show this help

The wizard detects installed harnesses, lets you confirm them, records the
profile defaults, and never claims that an exact model/profile is qualified.
Run it from the target Herdr pane when configuring a root harness.`;
}

function detectCommand(binary) {
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

function loadDefaults() {
  return JSON.parse(readFileSync(defaultsPath, "utf8"));
}

function parseArgs(args) {
  const options = {
    projectRoot: process.cwd(),
    promptProject: false,
    instructionPaths: [],
    harnesses: [],
    nonInteractive: false,
    quiet: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--non-interactive") {
      options.nonInteractive = true;
    } else if (arg === "--prompt-project") {
      options.promptProject = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--project-root") {
      options.projectRoot = resolve(args[++index] ?? "");
    } else if (arg === "--instructions-path") {
      options.instructionPaths.push(resolve(args[++index] ?? ""));
    } else if (arg === "--harness") {
      options.harnesses.push(args[++index] ?? "");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function projectDirectoryIsUsable(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function expandHome(path) {
  return path.replace(/^~(?=$|[\\/])/, homedir());
}

async function promptProjectRoot(defaultRoot) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return defaultRoot;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await new Promise((resolveAnswer) => {
        readline.question(`Project directory [${defaultRoot}]: `, resolveAnswer);
      });
      const candidate = resolve(expandHome(answer.trim() || defaultRoot));
      if (projectDirectoryIsUsable(candidate)) return candidate;
      console.log(`Not a directory: ${candidate}`);
    }
  } finally {
    readline.close();
  }
}

function openInteractiveHarnesses(detected) {
  const available = detected.filter((harness) => harness.detected);
  if (!process.stdin.isTTY || !process.stdout.isTTY || !available.length)
    return undefined;
  const selected = new Set(available.map((harness) => harness.id));
  let cursor = 0;
  const input = process.stdin;
  const render = () => {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write("Baa-ton setup — select harness integrations (space, arrows, enter)\n\n");
    available.forEach((harness, index) => {
      const mark = selected.has(harness.id) ? "x" : " ";
      const pointer = index === cursor ? ">" : " ";
      process.stdout.write(`${pointer} [${mark}] ${harness.label} — ${harness.detected.version}\n`);
    });
    process.stdout.write("\nPi uses the extension; other selections use their MCP/instruction integration.\n");
  };
  return new Promise((resolveSelection) => {
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const finish = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stdout.write("\x1b[2J\x1b[H");
      resolveSelection([...selected]);
    };
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      while (buffer) {
        let key = buffer[0];
        if (buffer.startsWith("\u001b[A") || buffer.startsWith("\u001bOA")) {
          key = "up";
          buffer = buffer.slice(3);
        } else if (buffer.startsWith("\u001b[B") || buffer.startsWith("\u001bOB")) {
          key = "down";
          buffer = buffer.slice(3);
        } else {
          buffer = buffer.slice(1);
        }
        if (key === "\u0003" || key === "q") return finish();
        if (key === "\u0009" || key === "down") cursor = Math.min(cursor + 1, available.length - 1);
        else if (key === "up") cursor = Math.max(cursor - 1, 0);
        else if (key === " ") {
          const id = available[cursor].id;
          if (selected.has(id)) selected.delete(id);
          else selected.add(id);
        } else if (key === "\r" || key === "\n") return finish();
      }
      render();
    };
    input.on("data", onData);
    render();
  });
}

function selectedHarnessIds(options, detected) {
  const known = new Set(HARNESSES.map((harness) => harness.id));
  for (const harness of options.harnesses)
    if (!known.has(harness)) throw new Error(`Unknown harness ${JSON.stringify(harness)}.`);
  if (options.harnesses.length) return [...new Set(options.harnesses)];
  return detected.filter((harness) => harness.detected).map((harness) => harness.id);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJsonAtomic(path, value) {
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
    `2. Run: \`node \"${rootSetupPath}\" --harness ${harness}\`.`,
    "3. Follow the helper's one-time integration instruction and restart this harness in the same pane if it requests a restart.",
    "4. Call `herdr_bootstrap_root` and verify the returned workspace and pane identity.",
    "5. Report that the root is ready and wait for the user's task. Do not initialize a goal until the user gives the objective.",
    "",
    `If project configuration must be changed, rerun the project wizard with \`node \"${setupPath}\" --project-root \"${projectRoot}\"\`; do not guess model, auth, or thinking settings.`,
    START_SKILL_END,
    "",
  ].join("\n");
}

export function configureSkillContent({ baaPath, projectRoot }) {
  const setupPath = join(checkoutDirectory, "packages", "herdr-tools", "setup.mjs");
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
    "1. Review the existing task profiles and preserve any user customizations.",
    "2. Ask for exact provider, model, thinking, and auth values when they are not already known. Never invent a model ID or silently substitute one.",
    "3. Update the matching profile's `agentKind` and exact `launchProfile` (`provider`, `model`, `thinking`, `auth`) in `.baa-ton/config.json`.",
    "4. Show the resulting worker/profile mapping and explain that Baa-ton will live-qualify it before dispatch.",
    "5. Do not bootstrap a root, initialize a goal, plan work, or dispatch a lane as part of configuration.",
    "",
    `If harness selection also needs changing, rerun the project wizard with \`node "${setupPath}" --project-root "${projectRoot}"\`.`,
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
    `3. Install dependency changes with \`npm --prefix "${checkoutDirectory}" install --no-audit --no-fund\`.`,
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
  };
  return selected.flatMap((harness) => PROJECT_SKILLS.map((skillName) => installStartSkill(
    projectSkillPath(projectRoot, harness, skillName),
    content[skillName](harness),
  )));
}

function ensureProjectBaa(projectRoot, installedBaaPath) {
  const projectBaaPath = join(projectRoot, "BAA.md");
  if (!existsSync(projectBaaPath)) copyFileSync(installedBaaPath, projectBaaPath);
  return resolve(projectBaaPath);
}

function instructionCandidates(projectRoot, selected) {
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const defaultProjectRoot = resolve(options.projectRoot);
  const projectRoot = options.promptProject && !options.nonInteractive
    ? await promptProjectRoot(defaultProjectRoot)
    : defaultProjectRoot;
  if (!isAbsolute(projectRoot)) throw new Error("--project-root must resolve to an absolute path.");
  const defaults = loadDefaults();
  const detected = detectHarnesses();
  const interactiveSelection = options.nonInteractive ? undefined : await openInteractiveHarnesses(detected);
  const selected = interactiveSelection ?? selectedHarnessIds(options, detected);
  const installedBaaPath = resolve(process.env.BAA_TON_BAA_PATH ?? join(checkoutDirectory, "BAA.md"));
  const baaPath = ensureProjectBaa(projectRoot, installedBaaPath);
  const instructionFiles = options.instructionPaths.length
    ? options.instructionPaths
    : instructionCandidates(projectRoot, selected);
  for (const path of instructionFiles) updateManagedReference(path, baaPath);
  const skills = installProjectSkills({ projectRoot, selected, baaPath });
  const configPath = join(projectRoot, BAA_CONFIG_DIRECTORY, BAA_CONFIG_NAME);
  const config = buildSetupConfig({
    projectRoot,
    baaPath,
    detected,
    selected,
    instructionFiles,
    defaults,
    skills: skills.map((skill) => skill.path),
  });
  writeJsonAtomic(configPath, config);

  if (options.quiet) {
    console.log(`Project ready at ${projectRoot}. Configure worker profiles and model choices in ${configPath}.`);
  } else {
    console.log(`Baa-ton setup recorded at ${configPath}`);
    console.log(`Project contract: ${baaPath}`);
    console.log(`Selected harnesses: ${selected.length ? selected.join(", ") : "none"}`);
    if (instructionFiles.length) console.log(`Updated BAA.md references: ${instructionFiles.join(", ")}`);
    else console.log("No AGENTS.md or CLAUDE.md selected; pass --instructions-path to add the managed reference.");
    if (skills.length) {
      const installed = skills.filter((skill) => !skill.skipped).map((skill) => skill.path);
      const skipped = skills.filter((skill) => skill.skipped).map((skill) => skill.path);
      if (installed.length) console.log(`Installed Baa-ton skills: ${installed.join(", ")}`);
      if (skipped.length) console.log(`Preserved existing skill files: ${skipped.join(", ")}`);
      console.log("A selected harness can invoke the `baa-ton-start` skill later to start or repair Baa-ton.");
    }
    console.log("\nTask profiles:");
    for (const [name, profile] of Object.entries(defaults.profiles))
      console.log(`  ${name}: ${profile.description}`);
    console.log("\nExact provider/model/thinking/auth values remain user configuration and are live-qualified at dispatch.");
    console.log(`Run from the target Herdr pane for root setup: node ${join(checkoutDirectory, "packages/herdr-tools/root-setup.mjs")} --harness <name>`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    console.error(`baa-ton setup: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 2;
  });
