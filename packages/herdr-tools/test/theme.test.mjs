import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const themeUrl = pathToFileURL(join(here, "..", "theme.mjs")).href;

function runWithEnv(overrides) {
  const script = `import { bold, dim, cyan, compose } from ${JSON.stringify(themeUrl)};
console.log(JSON.stringify({ bold: bold("x"), dim: dim("x"), composed: compose(bold, cyan)("x") }));`;
  const env = { ...process.env };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  Object.assign(env, overrides);
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env,
  });
  return JSON.parse(output);
}

test("theme styles wrap text with SGR codes and their own specific reset when colors are enabled", () => {
  const result = runWithEnv({});
  assert.equal(result.bold, "\x1b[1mx\x1b[22m");
  assert.equal(result.dim, "\x1b[2mx\x1b[22m");
  // compose(bold, cyan) applies cyan innermost, bold outermost.
  assert.equal(result.composed, "\x1b[1m\x1b[36mx\x1b[39m\x1b[22m");
});

test("NO_COLOR disables all styling", () => {
  const result = runWithEnv({ NO_COLOR: "1" });
  assert.equal(result.bold, "x");
  assert.equal(result.dim, "x");
  assert.equal(result.composed, "x");
});

test("FORCE_COLOR=0 disables all styling", () => {
  const result = runWithEnv({ FORCE_COLOR: "0" });
  assert.equal(result.bold, "x");
});
