import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const contractPath = resolve("packages/herdr-tools/contract.ts");
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const {
  nativeSessionFromPersistenceHandle,
  toPersistenceHandle,
} = await jiti.import("../contract.ts");
const allowedExternal = (specifier) =>
  specifier.startsWith("node:") || specifier === "typebox";

async function assertNeutralImportGraph(entryPath) {
  const pending = [entryPath];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const source = await readFile(current, "utf8");
    const imports = [
      ...source.matchAll(
        /(?:from|import\s*\()\s*["']([^"']+)["']/g,
      ),
    ];
    for (const match of imports) {
      const specifier = match[1];
      assert.equal(
        specifier.startsWith(".") || allowedExternal(specifier),
        true,
        `neutral contract import graph contains a non-neutral dependency: ${current} -> ${specifier}`,
      );
      if (specifier.startsWith(".")) {
        const base = resolve(
          dirname(current),
          specifier.replace(/\.js$/, ".ts"),
        );
        pending.push(base);
      }
    }
  }
}

test("general persistence handles retain the legacy native-session view", () => {
  const legacy = { kind: "id", value: "session-123" };
  const persisted = toPersistenceHandle(legacy, "codex");
  assert.deepEqual(persisted, {
    provider: "codex",
    sessionId: "session-123",
    nativeHandle: legacy,
  });
  assert.deepEqual(nativeSessionFromPersistenceHandle(persisted), legacy);
});

test("contract module imports without a harness SDK in a bare Node process", async () => {
  await assertNeutralImportGraph(contractPath);
  const script = `
    import { createRequire } from "node:module";
    const require = createRequire(process.cwd() + "/package.json");
    const jiti = require("jiti")(import.meta.url);
    await jiti.import(process.argv[1]);
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, contractPath],
    { encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `bare import failed:\n${result.stdout}\n${result.stderr}`,
  );
});

test("neutrality regression rejects a planted Pi import", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baa-contract-neutrality-"));
  try {
    const planted = join(directory, "contract.ts");
    const source = await readFile(contractPath, "utf8");
    await writeFile(
      planted,
      `${source}\nimport type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n`,
    );
    await assert.rejects(
      assertNeutralImportGraph(planted),
      /contains a non-neutral dependency/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
