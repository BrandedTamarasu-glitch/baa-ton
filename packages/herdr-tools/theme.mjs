/**
 * Minimal ANSI styling helpers for the installer TUI. No chalk/picocolors
 * dependency -- SGR codes are a handful of constant escape sequences.
 * Respects NO_COLOR (https://no-color.org) and FORCE_COLOR=0.
 *
 * Each style uses its own specific reset code (22 for bold/dim, 23 for
 * italic, 39 for foreground color) rather than a blanket \x1b[0m, so
 * composed styles (e.g. bold + color) don't clobber each other when nested.
 */
const colorsEnabled = process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== "0";

function style(open, close) {
  return colorsEnabled ? (text) => `\x1b[${open}m${text}\x1b[${close}m` : (text) => text;
}

export const bold = style(1, 22);
export const dim = style(2, 22);
export const italic = style(3, 23);
export const cyan = style(36, 39);
export const brightCyan = style(96, 39);
export const green = style(32, 39);
export const brightGreen = style(92, 39);
export const yellow = style(33, 39);
export const magenta = style(35, 39);
export const brightMagenta = style(95, 39);
export const gray = style(90, 39);
export const red = style(31, 39);

/** compose(bold, cyan)("x") applies bold first, then wraps the result in cyan. */
export function compose(...fns) {
  return (text) => fns.reduceRight((value, fn) => fn(value), text);
}

export const colorsEnabledForTesting = colorsEnabled;
