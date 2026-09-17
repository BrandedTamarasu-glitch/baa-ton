#!/usr/bin/env node
/**
 * Interactive, harness-neutral Baa-ton setup.
 *
 * Detection is advisory. The selected harness and exact launch profile are
 * persisted for the user, while dispatch still performs live qualification.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
const SETUP_SKILL_START = "<!-- baa-ton:setup-skill:start -->";
const SETUP_SKILL_END = "<!-- baa-ton:setup-skill:end -->";

const SETUP_SKILL_DIRECTORIES = {
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
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--non-interactive") {
      options.nonInteractive = true;
    } else if (arg === "--prompt-project") {
      options.promptProject = true;
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

export function setupSkillPath(projectRoot, harnessId) {
  const directory = SETUP_SKILL_DIRECTORIES[harnessId];
  if (!directory) throw new Error(`Unknown harness ${JSON.stringify(harnessId)}.`);
  return join(projectRoot, ...directory, "baa-ton-setup", "SKILL.md");
}

export function setupSkillContent({ harness, baaPath, projectRoot }) {
  const rootSetupPath = join(checkoutDirectory, "packages", "herdr-tools", "root-setup.mjs");
  const setupPath = join(checkoutDirectory, "packages", "herdr-tools", "setup.mjs");
  return [
    SETUP_SKILL_START,
    "---",
    "name: baa-ton-setup",
    "description: Finish or repair Baa-ton setup in the current Herdr project after installation.",
    "---",
    "",
    "# Baa-ton project setup",
    "",
    `Use this skill when Baa-ton is installed but the current ${harness} session does not have its root tools connected, or when setup needs to be repaired. The target project is \`${projectRoot}\`.`,
    "",
    `1. Read \`${baaPath}\` and confirm this is the intended Herdr pane.`,
    `2. Run: \`node \"${rootSetupPath}\" --harness ${harness}\`.`,
    "3. Follow the helper's one-time integration instruction and restart this harness in the same pane if it requests a restart.",
    "4. Call `herdr_bootstrap_root` and verify the returned workspace and pane identity.",
    "5. Report that the root is ready and wait for the user's task. Do not initialize a goal until the user gives the objective.",
    "",
    `If project configuration must be changed, rerun \`node \"${setupPath}\" --project-root \"${projectRoot}\"\` from a terminal; do not guess model, auth, or thinking settings.`,
    SETUP_SKILL_END,
    "",
  ].join("\n");
}

function installSetupSkill(path, content) {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (!existing.includes(SETUP_SKILL_START) || !existing.includes(SETUP_SKILL_END))
      return { path, changed: false, skipped: true };
    if (existing === content) return { path, changed: false, skipped: false };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  return { path, changed: true, skipped: false };
}

export function installSetupSkills({ projectRoot, selected, baaPath }) {
  return selected.map((harness) => installSetupSkill(
    setupSkillPath(projectRoot, harness),
    setupSkillContent({ harness, baaPath, projectRoot }),
  ));
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

export function buildSetupConfig({ projectRoot, baaPath, detected, selected, instructionFiles, defaults, setupSkills = [] }) {
  const configPath = join(projectRoot, BAA_CONFIG_DIRECTORY, BAA_CONFIG_NAME);
  const existing = readJson(configPath, {});
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
    setupSkills,
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
  const setupSkills = installSetupSkills({ projectRoot, selected, baaPath });
  const configPath = join(projectRoot, BAA_CONFIG_DIRECTORY, BAA_CONFIG_NAME);
  const config = buildSetupConfig({
    projectRoot,
    baaPath,
    detected,
    selected,
    instructionFiles,
    defaults,
    setupSkills: setupSkills.map((skill) => skill.path),
  });
  writeJsonAtomic(configPath, config);

  console.log(`Baa-ton setup recorded at ${configPath}`);
  console.log(`Project contract: ${baaPath}`);
  console.log(`Selected harnesses: ${selected.length ? selected.join(", ") : "none"}`);
  if (instructionFiles.length) console.log(`Updated BAA.md references: ${instructionFiles.join(", ")}`);
  else console.log("No AGENTS.md or CLAUDE.md selected; pass --instructions-path to add the managed reference.");
  if (setupSkills.length) {
    const installed = setupSkills.filter((skill) => !skill.skipped).map((skill) => skill.path);
    const skipped = setupSkills.filter((skill) => skill.skipped).map((skill) => skill.path);
    if (installed.length) console.log(`Installed setup skills: ${installed.join(", ")}`);
    if (skipped.length) console.log(`Preserved existing setup files: ${skipped.join(", ")}`);
    console.log("A selected harness can invoke the `baa-ton-setup` skill later to repair this setup.");
  }
  console.log("\nTask profiles:");
  for (const [name, profile] of Object.entries(defaults.profiles))
    console.log(`  ${name}: ${profile.description}`);
  console.log("\nExact provider/model/thinking/auth values remain user configuration and are live-qualified at dispatch.");
  console.log(`Run from the target Herdr pane for root setup: node ${join(checkoutDirectory, "packages/herdr-tools/root-setup.mjs")} --harness <name>`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    console.error(`baa-ton setup: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 2;
  });
