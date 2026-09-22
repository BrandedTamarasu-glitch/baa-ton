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

/**
 * Strip // and /* *\/ comments from JSONC text without touching // that
 * appears inside a string value (e.g. a "https://..." URL). A naive
 * /\/\/.*$/ regex treats that in-string // as a comment start and deletes
 * the rest of the line, including the closing quote, corrupting the JSON.
 */
function stripJsonComments(text) {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      result += ch;
      if (ch === "\\") {
        result += next ?? "";
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    result += ch;
  }
  return result;
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
  result.catalog = (catalogEntry.models ?? []).map((entry) => ({
    id: entry.id,
    label: entry.id,
    thinkingLevels: catalogEntry.thinkingLevels ?? [],
    // Explicit, hand-curated (this is a static maintained list, not a live
    // pull) -- see profile-defaults.mjs's modelForProfile, which prefers
    // this over its priority-based inference (built for volatile live
    // catalogs like Codex's, where no one can hand-curate).
    tier: entry.tier,
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
    const resolved = catalogEntry.aliases?.[alias] ?? (catalogEntry.models?.some((entry) => entry.id === alias) ? alias : undefined);
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
  return (models ?? []).map((model) => {
    const entry = {
      id: model.slug,
      label: model.display_name ?? model.slug,
      thinkingLevels: (model.supported_reasoning_levels ?? []).map((level) => level.effort),
    };
    // Preserved (only when actually present) so profile-defaults.mjs can
    // rank models into frontier/build/cheap tiers without hardcoding a
    // model name; absent for any harness catalog that doesn't carry a live
    // rank, or a source (e.g. the models_cache.json fallback) that lacks it.
    if (typeof model.priority === "number") entry.priority = model.priority;
    if (model.visibility !== undefined) entry.visibility = model.visibility;
    // `priority` alone is not a reliable tier signal: a live pull can omit
    // a model entirely between calls and shift another's number (observed
    // live, same session, 2026-09-18 -- gpt-6-astra vanished and gpt-5.6-sol
    // moved from priority 1 to 4). description text calling a model out as
    // legacy is a second, independent signal profile-defaults.mjs uses to
    // exclude stale fallbacks from tier ranking.
    if (typeof model.description === "string") entry.description = model.description;
    return entry;
  });
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
    // shell: true -- on Windows, tools installed via Volta/nvm/etc. resolve
    // to a .cmd shim, and child_process's default (non-shell) spawn cannot
    // execute a .cmd directly: it throws ENOENT even though the command
    // works fine when typed into a real shell. Harmless when the resolved
    // binary is a native .exe (as codex often is); args here are static
    // literals, never user input, so there's no injection surface.
    const output = execFileSyncImpl("codex", ["debug", "models"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      shell: true,
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
      // provider/cost pass through so profile-defaults.mjs can rank pi's
      // catalog by real per-token pricing -- pi's SDK reports no
      // priority/tier field, so without cost every profile fell back to
      // the single detected default (e.g. always gpt-5.6-terra).
      result.catalog = (available ?? []).map((entry) => ({
        id: entry.id ?? entry.model,
        label: entry.label ?? entry.id ?? entry.model,
        thinkingLevels: entry.thinkingLevels ?? [],
        provider: entry.provider,
        cost: entry.cost,
      }));
      result.source = result.source === "static" ? "sdk" : result.source;
      return result;
    }
  } catch (error) {
    result.warnings.push(`pi-coding-agent ModelRuntime unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    // shell: true -- see the comment on the codex exec call above.
    const output = execFileSyncImpl("pi", ["--offline", "--list-models"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      shell: true,
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

/**
 * `opencode models --verbose` prints a "provider/id" header line followed
 * by a pretty-printed JSON object per model -- not one combined JSON
 * document, so it needs a line-oriented parse rather than JSON.parse on the
 * whole output. Pulls out cost and supported reasoning-effort variants; the
 * plain (non-verbose) form gives only bare ids, which left every profile
 * with no way to rank models and made them all fall back to the same
 * single detected default.
 */
function opencodeCatalogFromVerboseText(text) {
  const headerPattern = /^[\w.-]+\/[\w.-]+$/;
  const catalog = [];
  let header = null;
  let buffer = [];
  for (const line of text.split(/\r?\n/)) {
    if (header === null) {
      if (headerPattern.test(line.trim())) header = line.trim();
      continue;
    }
    buffer.push(line);
    if (line === "}") {
      try {
        const model = JSON.parse(buffer.join("\n"));
        catalog.push({
          id: header,
          label: model.name ?? header,
          thinkingLevels: Object.keys(model.variants ?? {}),
          provider: model.providerID,
          cost: model.cost,
        });
      } catch {
        // Malformed block for this one model; skip it rather than losing the whole catalog.
      }
      header = null;
      buffer = [];
    }
  }
  return catalog;
}

export function readOpencodeDefaults({ configDirectory, stateDirectory, execFileSyncImpl = execFileSync } = {}) {
  const result = emptyResult("static");
  const configDir = configDirectory ?? join(homedir(), ".config", "opencode");
  const jsonPath = join(configDir, "opencode.json");
  const jsoncPath = join(configDir, "opencode.jsonc");
  const configPath = existsSync(jsonPath) ? jsonPath : existsSync(jsoncPath) ? jsoncPath : undefined;

  if (configPath) {
    try {
      const text = stripJsonComments(readFileSync(configPath, "utf8"));
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
    // shell: true -- see the comment on the codex exec call above. Verified
    // live on Windows: bare execFileSync("opencode", ...) throws ENOENT for
    // Volta's opencode.cmd shim even though `opencode models` runs fine
    // typed into a real shell; this was silently emptying the catalog and
    // making every profile fall back to the single detected default.
    const modelsOutput = execFileSyncImpl("opencode", ["models", "--verbose"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      shell: true,
    });
    result.catalog = opencodeCatalogFromVerboseText(modelsOutput);
  } catch (error) {
    result.warnings.push(`\`opencode models\` unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    execFileSyncImpl("opencode", ["providers", "list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      shell: true,
    });
  } catch (error) {
    result.warnings.push(`\`opencode providers list\` unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;
}
