#!/usr/bin/env node
/**
 * Interactive Baa-ton project wizard, built on @earendil-works/pi-tui.
 *
 * Layout: a persistent banner + "Step n/5 - <title>" header, a body region
 * that swaps per step, and a footer hint line. Steps: project directory,
 * harness selection, detection results (read-only), profile configuration
 * (harness/model/thinking per task profile), and a summary/confirm step.
 * Nothing is written until step 5's explicit confirm.
 *
 * `setup.mjs` delegates here for CLI-compatible automation use; this file is
 * the interactive entry point humans should run directly.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Container,
  Input,
  Key,
  matchesKey,
  SettingsList,
  Text,
  truncateToWidth,
  TruncatedText,
  TuiMainScreen,
  ProcessTerminal,
} from "@earendil-works/pi-tui";

import {
  HARNESSES,
  detectHarnesses,
  loadDefaults,
  ensureProjectBaa,
  instructionCandidates,
  installProjectSkills,
  updateManagedReference,
  buildSetupConfig,
  writeJsonAtomic,
  readJson,
  checkoutDirectory,
} from "./setup-core.mjs";
import { readClaudeDefaults, readCodexDefaults, readPiDefaults, readOpencodeDefaults } from "./harness-detect.mjs";
import { defaultLaunchProfiles } from "./profile-defaults.mjs";
import { bannerLines, bannerText } from "./banner.mjs";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const STEP_TITLES = [
  "Project directory",
  "Harness selection",
  "Detection results",
  "Profile configuration",
  "Summary and confirm",
];

function identity(text) {
  return text;
}

const PLAIN_SETTINGS_THEME = {
  label: (text) => text,
  value: (text) => text,
  description: identity,
  cursor: ">",
  hint: identity,
};

export function usage() {
  return `Usage: node install-tui.mjs [options]

Options:
  --project-root <dir>       Project directory for .baa-ton/config.json (default: cwd)
  --prompt-project           Ask for the project directory (default: the supplied project root)
  --instructions-path <file> Add/update the managed BAA.md reference in this file
  --harness <name>           Select a harness (repeatable: pi, claude, codex, opencode)
  --non-interactive          Use detected harnesses and computed profile defaults, no wizard
  --accept-defaults          Run the interactive wizard but skip profile editing (step 4)
  --config-only              Skip straight to profile configuration for an installed project
  --quiet                    Print only errors (for installer use)
  --help                     Show this help

The wizard detects installed harnesses, lets you confirm them, shows what each
harness's default model/thinking detection actually found, lets you configure
an exact provider/model/thinking value per task profile, and never claims that
an exact model/profile is qualified until Baa-ton live-qualifies it at dispatch.
Run it from the target Herdr pane when configuring a root harness.`;
}

function parseArgs(args) {
  const options = {
    projectRoot: process.cwd(),
    promptProject: false,
    instructionPaths: [],
    harnesses: [],
    nonInteractive: false,
    quiet: false,
    acceptDefaults: false,
    configOnly: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--non-interactive") options.nonInteractive = true;
    else if (arg === "--prompt-project") options.promptProject = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--accept-defaults") options.acceptDefaults = true;
    else if (arg === "--config-only") options.configOnly = true;
    else if (arg === "--project-root") options.projectRoot = resolve(args[++index] ?? "");
    else if (arg === "--instructions-path") options.instructionPaths.push(resolve(args[++index] ?? ""));
    else if (arg === "--harness") options.harnesses.push(args[++index] ?? "");
    else throw new Error(`Unknown argument: ${arg}`);
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

function selectedHarnessIds(options, detected) {
  const known = new Set(HARNESSES.map((harness) => harness.id));
  for (const harness of options.harnesses)
    if (!known.has(harness)) throw new Error(`Unknown harness ${JSON.stringify(harness)}.`);
  if (options.harnesses.length) return [...new Set(options.harnesses)];
  return detected.filter((harness) => harness.detected).map((harness) => harness.id);
}

async function detectSelectedHarnesses(selected, projectRoot) {
  const results = {};
  if (selected.includes("claude")) results.claude = readClaudeDefaults();
  if (selected.includes("codex")) results.codex = readCodexDefaults();
  if (selected.includes("opencode")) results.opencode = readOpencodeDefaults();
  if (selected.includes("pi")) results.pi = await readPiDefaults({ projectRoot });
  return results;
}

function unconfiguredProfiles(defaults, computed) {
  return Object.keys(defaults.profiles).filter((name) => !computed[name]);
}

/**
 * Writes the config: BAA.md, managed instruction references, project skills,
 * then the .baa-ton/config.json with per-profile agentKind/launchProfile.
 * Delegates every side effect to setup-core.mjs; never reimplements it here.
 */
function performWrites({ projectRoot, detected, selected, instructionFiles, defaults, resolvedProfiles }) {
  const installedBaaPath = resolve(process.env.BAA_TON_BAA_PATH ?? join(checkoutDirectory, "BAA.md"));
  const baaPath = ensureProjectBaa(projectRoot, installedBaaPath);
  for (const path of instructionFiles) updateManagedReference(path, baaPath);
  const skills = installProjectSkills({ projectRoot, selected, baaPath });
  const configPath = join(projectRoot, ".baa-ton", "config.json");
  const config = buildSetupConfig({
    projectRoot,
    baaPath,
    detected,
    selected,
    instructionFiles,
    defaults,
    skills: skills.map((skill) => skill.path),
  });
  for (const [name, resolved] of Object.entries(resolvedProfiles)) {
    config.profiles[name] = { ...config.profiles[name], agentKind: resolved.agentKind, launchProfile: resolved.launchProfile };
  }
  writeJsonAtomic(configPath, config);
  return { baaPath, skills, configPath, config };
}

// ---------------------------------------------------------------------------
// Non-interactive / accept-defaults path (also used by the TTY guard)
// ---------------------------------------------------------------------------

async function runNonInteractive(options) {
  const defaults = loadDefaults();
  const projectRoot = resolve(options.projectRoot);
  if (!isAbsolute(projectRoot)) throw new Error("--project-root must resolve to an absolute path.");

  if (options.configOnly) {
    const configPath = join(projectRoot, ".baa-ton", "config.json");
    const config = readJson(configPath, undefined);
    if (!config) throw new Error(`--config-only requires an existing ${configPath}; run the full wizard first.`);
    const selected = config.selectedHarnesses ?? [];
    const detectionResults = await detectSelectedHarnesses(selected, projectRoot);
    const computed = defaultLaunchProfiles(selected, detectionResults, defaults.profiles);
    const { configPath: writtenPath } = performConfigOnlyWriteDirect({ projectRoot, resolvedProfiles: computed, existingConfig: config });
    if (!options.quiet) {
      console.log(`Baa-ton profile defaults refreshed at ${writtenPath}`);
      reportUnconfigured(defaults, computed);
    }
    return;
  }

  const detected = detectHarnesses();
  const selected = selectedHarnessIds(options, detected);
  const installedBaaPath = resolve(process.env.BAA_TON_BAA_PATH ?? join(checkoutDirectory, "BAA.md"));
  const baaPath = ensureProjectBaa(projectRoot, installedBaaPath);
  const instructionFiles = options.instructionPaths.length ? options.instructionPaths : instructionCandidates(projectRoot, selected);
  for (const path of instructionFiles) updateManagedReference(path, baaPath);
  const skills = installProjectSkills({ projectRoot, selected, baaPath });
  const detectionResults = await detectSelectedHarnesses(selected, projectRoot);
  const computed = defaultLaunchProfiles(selected, detectionResults, defaults.profiles);
  const configPath = join(projectRoot, ".baa-ton", "config.json");
  const config = buildSetupConfig({
    projectRoot,
    baaPath,
    detected,
    selected,
    instructionFiles,
    defaults,
    skills: skills.map((skill) => skill.path),
  });
  for (const [name, resolved] of Object.entries(computed))
    config.profiles[name] = { ...config.profiles[name], agentKind: resolved.agentKind, launchProfile: resolved.launchProfile };
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
    }
    console.log("\nTask profiles:");
    for (const [name, profile] of Object.entries(defaults.profiles)) {
      const resolved = computed[name];
      const suffix = resolved ? ` -> ${resolved.agentKind}/${resolved.launchProfile.model} (${resolved.launchProfile.thinking})` : " -> unconfigured";
      console.log(`  ${name}: ${profile.description}${suffix}`);
    }
    reportUnconfigured(defaults, computed);
    console.log(`Run from the target Herdr pane for root setup: node ${join(checkoutDirectory, "packages/herdr-tools/root-setup.mjs")} --harness <name>`);
  }
  // install.sh/install.ps1 no longer render their own banner; this keeps it
  // always shown at the end of the non-interactive installer path too,
  // matching the old unconditional welcome()/Welcome call.
  console.log(`\n${bannerText()}`);
}

function performConfigOnlyWriteDirect({ projectRoot, resolvedProfiles, existingConfig }) {
  const configPath = join(projectRoot, ".baa-ton", "config.json");
  const config = { ...existingConfig, profiles: { ...existingConfig.profiles } };
  for (const [name, resolved] of Object.entries(resolvedProfiles))
    config.profiles[name] = { ...config.profiles[name], agentKind: resolved.agentKind, launchProfile: resolved.launchProfile };
  writeJsonAtomic(configPath, config);
  return { configPath, config };
}

function reportUnconfigured(defaults, computed) {
  const remaining = unconfiguredProfiles(defaults, computed);
  if (remaining.length)
    console.log(`\nProfiles left unconfigured (no usable detection for any selected harness): ${remaining.join(", ")}. Dispatch fails closed for these until configured.`);
  console.log("\nExact provider/model/thinking/auth values remain user configuration and are live-qualified at dispatch.");
}

// ---------------------------------------------------------------------------
// Interactive wizard
// ---------------------------------------------------------------------------

class Checklist {
  constructor(tui, items) {
    this.tui = tui;
    this.items = items;
    this.cursor = 0;
    this.selected = new Set(items.filter((item) => item.checked).map((item) => item.id));
    this.onDone = undefined;
    this.onCancel = undefined;
  }

  handleInput(data) {
    if (matchesKey(data, Key.up)) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, Key.down)) this.cursor = Math.min(this.items.length - 1, this.cursor + 1);
    else if (matchesKey(data, Key.space)) {
      const id = this.items[this.cursor].id;
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
    } else if (matchesKey(data, Key.enter)) {
      this.onDone?.([...this.selected]);
      return;
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
      return;
    } else return;
    this.tui.requestRender();
  }

  render(width) {
    const lines = this.items.map((item, index) => {
      const mark = this.selected.has(item.id) ? "x" : " ";
      const pointer = index === this.cursor ? ">" : " ";
      const status = item.detected ? `detected: ${item.detected.version}` : "not detected";
      return truncateToWidth(`${pointer} [${mark}] ${item.label} (${status})`, width);
    });
    lines.push("");
    lines.push(truncateToWidth("space: toggle   enter: confirm   esc/ctrl+c: quit without writing", width));
    return lines;
  }
}

function formatOption(harnessId, entry) {
  return `${harnessId}/${entry.model} (${entry.thinking})`;
}

function buildProfileOptions(selectedHarnessIds, detectionResults) {
  const options = [];
  for (const harnessId of selectedHarnessIds) {
    const detection = detectionResults[harnessId];
    if (!detection) continue;
    const models = detection.catalog.length ? detection.catalog.map((entry) => entry.id) : detection.defaultModel ? [detection.defaultModel] : [];
    for (const modelId of models) {
      const catalogEntry = detection.catalog.find((entry) => entry.id === modelId);
      const levels = catalogEntry?.thinkingLevels?.length ? catalogEntry.thinkingLevels : THINKING_LEVELS;
      for (const thinking of levels) options.push(formatOption(harnessId, { model: modelId, thinking }));
    }
  }
  options.push("custom...");
  return options;
}

function parseOption(value, harnessToProvider) {
  const match = value.match(/^([\w-]+)\/(.+) \(([\w-]+)\)$/);
  if (!match) return undefined;
  const [, harnessId, model, thinking] = match;
  const provider = harnessToProvider[harnessId];
  if (!provider) return undefined;
  return { agentKind: harnessId, launchProfile: { provider, model, thinking, auth: "subscription" } };
}

async function runWizard(options) {
  const isRealTty = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (!isRealTty || options.nonInteractive) return runNonInteractive(options);

  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  const header = new Container();
  const body = new Container();
  const footer = new TruncatedText("");
  for (const line of bannerLines()) header.addChild(new Text(line, 0, 0));
  const stepLine = new TruncatedText("");
  header.addChild(stepLine);
  tui.addChild(header);
  tui.addChild(body);
  tui.addChild(footer);

  let aborted = false;
  const abort = () => {
    aborted = true;
    tui.stop();
  };
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) abort();
  });

  function setStep(index, hint) {
    stepLine.setText(`Step ${index}/5 - ${STEP_TITLES[index - 1]}`);
    footer.setText(hint ?? "");
    tui.requestRender();
  }

  function swapBody(component) {
    for (const child of [...(body.children ?? [])]) body.removeChild(child);
    body.addChild(component);
    tui.setFocus(component);
    tui.requestRender();
  }

  const defaults = loadDefaults();
  const defaultProjectRoot = resolve(options.projectRoot);
  if (!isAbsolute(defaultProjectRoot)) throw new Error("--project-root must resolve to an absolute path.");

  let projectRoot = defaultProjectRoot;
  let selected;
  let detectionResults = {};
  let resolvedProfiles = {};
  let existingConfig;

  try {
    tui.start();

    if (!options.configOnly && options.promptProject) {
      projectRoot = await new Promise((resolvePromise) => {
        setStep(1, "Enter to accept, Esc/Ctrl+C to quit without writing");
        const input = new Input();
        input.setValue(defaultProjectRoot);
        input.onSubmit = (value) => {
          const candidate = resolve(expandHome((value ?? "").trim() || defaultProjectRoot));
          if (!projectDirectoryIsUsable(candidate)) {
            footer.setText(`Not a directory: ${candidate}`);
            tui.requestRender();
            return;
          }
          resolvePromise(candidate);
        };
        swapBody(input);
      });
    }
    if (aborted) return { aborted };

    if (options.configOnly) {
      const configPath = join(projectRoot, ".baa-ton", "config.json");
      existingConfig = readJson(configPath, undefined);
      if (!existingConfig) throw new Error(`--config-only requires an existing ${configPath}; run the full wizard first.`);
      selected = existingConfig.selectedHarnesses ?? [];
    } else {
      const detected = detectHarnesses();
      selected = await new Promise((resolvePromise) => {
        setStep(2, "space: toggle   enter: confirm   esc/ctrl+c: quit without writing");
        const items = detected.map((harness) => ({
          id: harness.id,
          label: harness.label,
          detected: harness.detected,
          checked: Boolean(harness.detected),
        }));
        const checklist = new Checklist(tui, items);
        checklist.onDone = (ids) => resolvePromise(ids);
        checklist.onCancel = () => { abort(); resolvePromise([]); };
        swapBody(checklist);
      });
    }
    if (aborted) return { aborted };

    detectionResults = await detectSelectedHarnesses(selected, projectRoot);

    if (!options.configOnly) {
      await new Promise((resolvePromise) => {
        setStep(3, "Enter to continue, esc/ctrl+c to quit without writing");
        const summary = new Container();
        for (const harnessId of selected) {
          const detection = detectionResults[harnessId];
          const lines = [
            `${harnessId}: source=${detection?.source ?? "n/a"}, model=${detection?.defaultModel ?? "(none)"}, thinking=${detection?.defaultThinking ?? "(none)"}`,
            ...((detection?.warnings ?? []).map((warning) => `  warning: ${warning}`)),
          ];
          summary.addChild(new Text(lines.join("\n"), 0, 0));
        }
        const proceed = new Input();
        proceed.onSubmit = () => resolvePromise();
        summary.addChild(proceed);
        swapBody(summary);
        tui.setFocus(proceed);
      });
    }
    if (aborted) return { aborted };

    const computedDefaults = defaultLaunchProfiles(selected, detectionResults, defaults.profiles);
    resolvedProfiles = computedDefaults;

    if (!options.acceptDefaults) {
      resolvedProfiles = await new Promise((resolvePromise) => {
        setStep(4, "Enter/Space to cycle, Esc to finish, Ctrl+C to quit without writing");
        const harnessToProvider = Object.fromEntries(HARNESSES.map((h) => [h.id, { claude: "claude-code", codex: "codex", pi: "pi", opencode: "opencode" }[h.id]]));
        const working = { ...computedDefaults };
        const items = Object.entries(defaults.profiles).map(([name, profile]) => {
          const current = working[name];
          const currentValue = current ? formatOption(current.agentKind, current.launchProfile) : "unconfigured";
          return {
            id: name,
            label: `${name} (${profile.description})`,
            currentValue,
            values: [...buildProfileOptions(selected, detectionResults), "unconfigured"],
          };
        });
        // Escape is SettingsList's documented "cancel" key; here it means
        // "finish editing this step" (proceed to the summary), not abort.
        // A full abort is still available globally via the Ctrl+C listener.
        const settings = new SettingsList(
          items,
          items.length,
          PLAIN_SETTINGS_THEME,
          (id, newValue) => {
            if (newValue === "unconfigured") {
              delete working[id];
              return;
            }
            if (newValue === "custom...") return; // free-text override left to manual config.json edit
            const parsed = parseOption(newValue, harnessToProvider);
            if (parsed) working[id] = parsed;
          },
          () => resolvePromise(working),
        );
        swapBody(settings);
      });
    }
    if (aborted) return { aborted };

    const summaryLines = Object.entries(resolvedProfiles).map(
      ([name, resolved]) => `${name}: ${resolved.agentKind}/${resolved.launchProfile.model} (${resolved.launchProfile.thinking})`,
    );
    const missing = unconfiguredProfiles(defaults, resolvedProfiles);
    const confirmed = await new Promise((resolvePromise) => {
      setStep(5, "Type 'write' to save, 'quit' to exit without writing");
      const text = new Text(
        [
          `Project: ${projectRoot}`,
          `Selected harnesses: ${selected.join(", ") || "none"}`,
          "",
          "Profiles:",
          ...summaryLines,
          missing.length ? `Unconfigured (fails closed at dispatch): ${missing.join(", ")}` : "All profiles configured.",
        ].join("\n"),
        0,
        0,
      );
      const confirmInput = new Input();
      confirmInput.onSubmit = (value) => {
        const answer = (value ?? "").trim().toLowerCase();
        if (answer === "write" || answer === "w") resolvePromise(true);
        else if (answer === "quit" || answer === "q") { abort(); resolvePromise(false); }
      };
      const container = new Container();
      container.addChild(text);
      container.addChild(confirmInput);
      swapBody(container);
      tui.setFocus(confirmInput);
    });
    if (aborted || !confirmed) return { aborted: true };

    let writeResult;
    if (options.configOnly) {
      writeResult = performConfigOnlyWriteDirect({ projectRoot, resolvedProfiles, existingConfig });
    } else {
      const detected = detectHarnesses();
      const instructionFiles = options.instructionPaths.length ? options.instructionPaths : instructionCandidates(projectRoot, selected);
      writeResult = performWrites({ projectRoot, detected, selected, instructionFiles, defaults, resolvedProfiles });
    }
    tui.stop();
    if (!options.quiet) console.log(`Baa-ton configuration written to ${writeResult.configPath}`);
    return { aborted: false };
  } finally {
    tui.stop();
  }
}

export async function runInstallTui(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const isRealTty = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (!isRealTty || options.nonInteractive) {
    await runNonInteractive(options);
    return;
  }
  const result = await runWizard(options);
  if (result?.aborted) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runInstallTui(process.argv.slice(2)).catch((error) => {
    console.error(`baa-ton install-tui: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 2;
  });
}
