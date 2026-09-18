/**
 * Advisory, best-effort default-model/thinking detection per harness.
 *
 * Every exported function is safe to call unconditionally: failures never
 * throw, they are captured as `warnings` on the returned result instead.
 * Paths and the exec function are injectable so tests can use fixtures
 * instead of this machine's real home-directory files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const toolsDirectory = dirname(fileURLToPath(import.meta.url));

function emptyResult(source) {
  return { defaultModel: undefined, defaultThinking: undefined, catalog: [], source, warnings: [] };
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stripTrailingBracket(id) {
  return typeof id === "string" ? id.replace(/\s*\[1m\]\s*$/, "").trim() : id;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

export function readClaudeDefaults({ settingsPath, catalogPath } = {}) {
  const result = emptyResult("static");
  const catalogFile = catalogPath ?? join(toolsDirectory, "harness-catalog.json");
  let catalogEntry;
  try {
    catalogEntry = readJsonFile(catalogFile).claude;
  } catch (error) {
    result.warnings.push(`Could not read harness catalog: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  result.catalog = (catalogEntry.models ?? []).map((id) => ({
    id,
    label: id,
    thinkingLevels: catalogEntry.thinkingLevels ?? [],
  }));

  const path = settingsPath ?? join(homedir(), ".claude", "settings.json");
  if (!existsSync(path)) {
    result.warnings.push(`No Claude settings.json found at ${path}; using static catalog only.`);
    return result;
  }
  let settings;
  try {
    settings = readJsonFile(path);
  } catch (error) {
    result.warnings.push(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  const alias = stripTrailingBracket(settings.model);
  if (alias) {
    const resolved = catalogEntry.aliases?.[alias] ?? (catalogEntry.models?.includes(alias) ? alias : undefined);
    if (resolved) {
      result.defaultModel = resolved;
      result.source = "file";
    } else {
      result.warnings.push(`Unrecognized Claude model alias ${JSON.stringify(alias)} in ${path}; falling back to static catalog.`);
    }
  }
  if (typeof settings.effortLevel === "string") result.defaultThinking = settings.effortLevel;
  return result;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function codexHomeDefault() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function readSimpleToml(text) {
  // config.toml here is flat key = value pairs before the first [table]; a
  // targeted line-scan is sufficient and avoids adding a TOML dependency.
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) break; // stop at the first table header
    const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!match) continue;
    let [, key, value] = match;
    value = value.trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function codexCatalogFromModels(models) {
  return (models ?? []).map((model) => ({
    id: model.slug,
    label: model.display_name ?? model.slug,
    thinkingLevels: (model.supported_reasoning_levels ?? []).map((level) => level.effort),
  }));
}

export function readCodexDefaults({ codexHome, execFileSyncImpl = execFileSync } = {}) {
  const result = emptyResult("static");
  const home = codexHome ?? codexHomeDefault();
  const configPath = join(home, "config.toml");
  if (existsSync(configPath)) {
    try {
      const values = readSimpleToml(readFileSync(configPath, "utf8"));
      if (values.model) result.defaultModel = values.model;
      if (values.model_reasoning_effort) result.defaultThinking = values.model_reasoning_effort;
      if (values.model) result.source = "file";
    } catch (error) {
      result.warnings.push(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    result.warnings.push(`No Codex config.toml found at ${configPath}.`);
  }

  try {
    const output = execFileSyncImpl("codex", ["debug", "models"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const parsed = JSON.parse(output);
    result.catalog = codexCatalogFromModels(parsed.models);
    result.source = result.defaultModel ? "file" : "cli";
    return result;
  } catch (error) {
    result.warnings.push(`\`codex debug models\` unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const cachePath = join(home, "models_cache.json");
  if (existsSync(cachePath)) {
    try {
      const cache = readJsonFile(cachePath);
      result.catalog = codexCatalogFromModels(cache.models);
      if (result.source !== "file") result.source = "file";
      result.warnings.push(`Used cached model list from ${cachePath} (live \`codex debug models\` failed).`);
    } catch (error) {
      result.warnings.push(`Could not read ${cachePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    result.warnings.push(`No cached model list found at ${cachePath}.`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pi
// ---------------------------------------------------------------------------

function piCatalogFromCliText(text) {
  const catalog = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^-+$/.test(line)) continue;
    const match = line.match(/^([\w./-]+)\s{2,}(.+)$/);
    if (match) catalog.push({ id: match[1], label: match[2].trim(), thinkingLevels: [] });
  }
  return catalog;
}

export async function readPiDefaults({ homeDirectory, projectRoot, execFileSyncImpl = execFileSync, importModelRuntime } = {}) {
  const result = emptyResult("static");
  const home = homeDirectory ?? homedir();
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  const projectSettingsPath = projectRoot ? join(projectRoot, ".pi", "settings.json") : undefined;

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = readJsonFile(settingsPath);
      result.source = "file";
    } catch (error) {
      result.warnings.push(`Could not read ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    result.warnings.push(`No Pi settings.json found at ${settingsPath}.`);
  }
  if (projectSettingsPath && existsSync(projectSettingsPath)) {
    try {
      settings = { ...settings, ...readJsonFile(projectSettingsPath) };
      result.source = "file";
    } catch (error) {
      result.warnings.push(`Could not read ${projectSettingsPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  result.defaultModel = settings.defaultModel;
  result.defaultThinking = settings.defaultThinkingLevel;
  const defaultProvider = settings.defaultProvider;
  if (defaultProvider && defaultProvider !== "openai-codex")
    result.warnings.push(`Pi defaultProvider is ${JSON.stringify(defaultProvider)}, not "openai-codex"; returning the openai-codex catalog anyway since that is what Baa-ton launches through.`);

  try {
    const loadRuntime = importModelRuntime ?? (() => import("@earendil-works/pi-coding-agent"));
    const module = await loadRuntime();
    const ModelRuntime = module.ModelRuntime;
    if (ModelRuntime?.create) {
      const runtime = await ModelRuntime.create();
      const available = await runtime.getAvailable();
      result.catalog = (available ?? []).map((entry) => ({
        id: entry.id ?? entry.model,
        label: entry.label ?? entry.id ?? entry.model,
        thinkingLevels: entry.thinkingLevels ?? [],
      }));
      result.source = result.source === "static" ? "sdk" : result.source;
      return result;
    }
  } catch (error) {
    result.warnings.push(`pi-coding-agent ModelRuntime unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const output = execFileSyncImpl("pi", ["--offline", "--list-models"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    result.catalog = piCatalogFromCliText(output);
    result.source = result.source === "static" ? "cli" : result.source;
  } catch (error) {
    result.warnings.push(`\`pi --offline --list-models\` unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

export function readOpencodeDefaults({ configDirectory, stateDirectory, execFileSyncImpl = execFileSync } = {}) {
  const result = emptyResult("static");
  const configDir = configDirectory ?? join(homedir(), ".config", "opencode");
  const jsonPath = join(configDir, "opencode.json");
  const jsoncPath = join(configDir, "opencode.jsonc");
  const configPath = existsSync(jsonPath) ? jsonPath : existsSync(jsoncPath) ? jsoncPath : undefined;

  if (configPath) {
    try {
      const text = readFileSync(configPath, "utf8").replace(/\/\/.*$/gm, "");
      const config = JSON.parse(text);
      if (config.model) {
        result.defaultModel = config.model;
        result.source = "file";
      }
    } catch (error) {
      result.warnings.push(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    result.warnings.push(`No opencode.json(c) found under ${configDir}.`);
  }

  if (!result.defaultModel) {
    const stateDir = stateDirectory ?? join(homedir(), ".local", "state", "opencode");
    const modelStatePath = join(stateDir, "model.json");
    if (existsSync(modelStatePath)) {
      try {
        const state = readJsonFile(modelStatePath);
        const recentOpenai = (state.recent ?? []).find((entry) => entry.providerID === "openai");
        if (recentOpenai) {
          result.defaultModel = `${recentOpenai.providerID}/${recentOpenai.modelID}`;
          result.source = "file";
          result.warnings.push(`Using most-recent openai/* entry from ${modelStatePath} as a hinted default; this is undocumented last-used state, not a declared default.`);
        }
      } catch (error) {
        result.warnings.push(`Could not read ${modelStatePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      result.warnings.push(`No recent-model state found at ${modelStatePath}.`);
    }
  }

  try {
    const modelsOutput = execFileSyncImpl("opencode", ["models"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    result.catalog = modelsOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((id) => ({ id, label: id, thinkingLevels: [] }));
  } catch (error) {
    result.warnings.push(`\`opencode models\` unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    execFileSyncImpl("opencode", ["providers", "list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
  } catch (error) {
    result.warnings.push(`\`opencode providers list\` unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;
}
