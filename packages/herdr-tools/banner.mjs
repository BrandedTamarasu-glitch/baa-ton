/**
 * Baa-ton ASCII banner, shared between install.sh, install.ps1, and
 * install-tui.mjs so it is defined in exactly one place.
 */

export const BANNER_LINES = [
  ",-----.    ,---.    ,---.         ,--------. ,-----. ,--.  ,--.",
  "|  |) /_  /  O  \\  /  O  \\ ,-----.'--.  .--''  .-.  '|  ,'.|  |",
  "|  .-.  \\|  .-.  ||  .-.  |'-----'   |  |   |  | |  ||  |' '  |",
  "|  '--' /|  | |  ||  | |  |          |  |   '  '-'  '|  | `   |",
  "`------' `--' `--'`--' `--'          `--'    `-----' `--'  `--'",
  "",
  "───────────────────🐕  🐑  🐑  🐑  🐑  🐑  🐑──────────────────",
  "",
  "                 your agent herd is ready",
];

export const BANNER_LINES_ASCII = [
  ",-----.    ,---.    ,---.         ,--------. ,-----. ,--.  ,--.",
  "|  |) /_  /  O  \\  /  O  \\ ,-----.'--.  .--''  .-.  '|  ,'.|  |",
  "|  .-.  \\|  .-.  ||  .-.  |'-----'   |  |   |  | |  ||  |' '  |",
  "|  '--' /|  | |  ||  | |  |          |  |   '  '-'  '|  | `   |",
  "`------' `--' `--'`--' `--'          `--'    `-----' `--'  `--'",
  "",
  "------------------- (o) (o) (o) (o) (o) (o) (o) -----------------",
  "",
  "                 your agent herd is ready",
];

/**
 * Best-effort detection of a legacy Windows console (or an explicit
 * override) that cannot render the emoji/box-drawing banner cleanly,
 * matching the heuristic is-unicode-supported uses: Windows Terminal
 * (WT_SESSION) and known terminal-program integrations (TERM_PROGRAM) are
 * assumed capable; anything else on win32 without either is treated as a
 * legacy console.
 */
export function shouldUseAsciiBanner(env = process.env, platform = process.platform) {
  if (env.BAA_TON_ASCII === "1") return true;
  if (platform !== "win32") return false;
  return !env.WT_SESSION && !env.TERM_PROGRAM;
}

export function bannerLines(env = process.env, platform = process.platform) {
  return shouldUseAsciiBanner(env, platform) ? BANNER_LINES_ASCII : BANNER_LINES;
}

export function bannerText(env = process.env, platform = process.platform) {
  return bannerLines(env, platform).join("\n");
}
