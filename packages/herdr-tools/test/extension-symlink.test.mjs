import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const checkoutRoot = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "..",
  "..",
);
// Pi bundles core extension dependencies (typebox) for extensions; bare jiti
// does not, so alias the checkout's copy for the symlinked-load test.
const jiti = require("jiti")(import.meta.url, {
  alias: {
    typebox: join(
      checkoutRoot,
      "node_modules",
      "typebox",
      "build",
      "index.mjs",
    ),
  },
});

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("the extension loads through a symlink the way Pi installs it", async () => {
  // Regression for the 2026-09-16 incident: a relative cross-package import
  // (../controller/controller.mjs) resolved against the symlink directory and
  // broke every lane launched after it landed. Pi loads extensions from
  // ~/.pi/agent/extensions/<symlink>; this test reproduces that layout.
  const directory = await mkdtemp(join(tmpdir(), "baa-symlink-load-"));
  try {
    await mkdir(join(directory, "herdr-orchestrator-link"), { recursive: true });
    const link = join(directory, "herdr-orchestrator");
    await symlink(packageRoot, link);
    const loaded = await jiti.import(join(link, "index.ts"));
    assert.equal(typeof loaded.default, "function");
    assert.equal(typeof loaded.routeChildMessageFallbackProbe, "undefined");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
