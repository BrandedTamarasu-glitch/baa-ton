#!/usr/bin/env node
/**
 * Installs Baa-ton's optional native Herdr sidebar rows without modifying any
 * other plugin's source. Rows are fenced inside each existing agent renderer so
 * they survive ordinary config edits and can be repaired after another plugin
 * regenerates its own rows.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const START = "# >>> baa-ton goal rows";
const END = "# <<< baa-ton goal rows";
const AGENTS = new Set([
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline",
  "omp", "mastracode", "opencode", "copilot", "kimi", "kiro", "droid",
  "amp", "grok", "hermes", "kilo", "qodercli", "qwen", "maki", "muse",
]);

export function herdrConfigPath(env = process.env) {
  if (env.HERDR_CONFIG_PATH) return env.HERDR_CONFIG_PATH;
  if (process.platform === "win32")
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "herdr", "config.toml");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr", "config.toml");
}

function matchingBracket(text, open) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unterminated agent sidebar row array.");
}

function goalRows() {
  return [
    '[{ token = "$herdr_role", fg = "#89b4fa", bold = true, dim = false }]',
    '[{ token = "$herdr_workflow", fg = "#a99e92", bold = false, dim = false }]',
    '[{ token = "$herdr_goal_status", fg = "#c78a1f", bold = true, dim = false }]',
    '[{ token = "$herdr_goal_next_1", fg = "#a99e92", bold = false, dim = false }]',
    '[{ token = "$herdr_goal_next_2", fg = "#a99e92", bold = false, dim = false }]',
    '[{ token = "$herdr_goal_next_3", fg = "#a99e92", bold = false, dim = false }]',
  ];
}

function goalBlock() {
  return `\n    ${START}\n    ${goalRows().join(",\n    ")}\n    ${END}`;
}

export function configureSidebar(text) {
  const section = /^\[ui\.sidebar\.agents\.rows_by_agent\]\s*$/m.exec(text);
  if (!section)
    throw new Error("Herdr sidebar rows_by_agent is absent; Baa-ton will not replace another renderer's layout.");
  const sectionStart = section.index + section[0].length;
  const nextSection = /^\[[^\n]+\]\s*$/gm;
  nextSection.lastIndex = sectionStart;
  const sectionEnd = nextSection.exec(text)?.index ?? text.length;
  const body = text.slice(sectionStart, sectionEnd);
  const assignment = /^([A-Za-z0-9_-]+)\s*=\s*\[/gm;
  const replacements = [];
  let match;
  while ((match = assignment.exec(body))) {
    if (!AGENTS.has(match[1])) continue;
    const open = sectionStart + match.index + match[0].lastIndexOf("[");
    const close = matchingBracket(text, open);
    if (close > sectionEnd) throw new Error(`Agent row ${match[1]} escapes its TOML section.`);
    const content = text.slice(open + 1, close);
    if (content.includes(START) && content.includes(END)) continue;
    const trimmed = content.trimEnd();
    const separator = trimmed.trim() ? "," : "";
    replacements.push({
      start: open + 1,
      end: close,
      value: `${trimmed}${separator}${goalBlock()}\n  `,
    });
  }
  if (replacements.length === 0) return { text, changed: false };
  let next = text;
  for (const replacement of replacements.reverse())
    next = `${next.slice(0, replacement.start)}${replacement.value}${next.slice(replacement.end)}`;
  return { text: next, changed: true };
}

export async function applySidebar(path = herdrConfigPath()) {
  const original = await readFile(path, "utf8");
  const result = configureSidebar(original);
  if (!result.changed) return { changed: false, path };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.baa-ton-sidebar.tmp`);
  try {
    await writeFile(temporary, result.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return { changed: true, path };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] !== "--apply")
    throw new Error("Usage: sidebar-configure.mjs --apply");
  const result = await applySidebar();
  process.stdout.write(`Baa-ton sidebar ${result.changed ? "configured" : "already configured"}: ${result.path}\n`);
}
