import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { dispatchTask } = await jiti.import("../dispatch-task.ts");
const { piLaunchAdapter } = await jiti.import("../pi-launch-adapter.ts");
const { HarnessAdapterRegistry } = await jiti.import("../harness-adapter.ts");
const profile = {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  thinking: "high",
  auth: "subscription",
};
async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "baa-dispatch-"));
  const calls = [],
    panes = new Map();
  const launchProfile = options.profile ?? profile;
  let number = 0,
    registered = false;
  let state = {
    id: "wf",
    status: "planned",
    outcome: "planned",
    cwd: "/different/checkout",
    taskBinding: { workspaceId: "task-space", rootPaneId: "root-pane" },
    launchProfile,
    lanes: [1, 2].map((i) => ({
      id: `lane-${i}`,
      agentKind: options.adapter?.kind ?? "pi",
      status: "planned",
    })),
    ownership: { createdBy: "herdr-orchestrator", tabIds: [], paneIds: [] },
    evidence: [],
  };
  const ctx = {
    modelRegistry: {
      find: (provider, model) =>
        provider === launchProfile.provider && model === launchProfile.model
          ? {
              reasoning: true,
              thinkingLevelMap: options.thinkingLevelMap ?? {
                high: "high",
                xhigh: "xhigh",
                max: "max",
              },
            }
          : undefined,
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => options.oauth !== false,
    },
  };
  const registry = new HarnessAdapterRegistry();
  registry.register(options.adapter ?? piLaunchAdapter(ctx, "/native/pi.ts"));
  const ports = {
    directory,
    source: "/source/index.ts",
    adapter: (kind) => registry.resolve(kind),
    busyRetryDelayMs: 1,
    update: async (_id, change) => {
      change(state);
      return structuredClone(state);
    },
    verifyRoot: async (w) => {
      if (w.taskBinding?.workspaceId !== "task-space")
        throw new Error("root workspace mismatch");
    },
    authorize: async () => true,
    register: async () => {
      calls.push(["register"]);
      if (options.noRouting) throw new Error("routing unavailable");
      registered = true;
    },
    contract: (_w, lane) => `assignment:${lane.id}`,
    async run(args) {
      calls.push(args);
      if (args[0] === "workspace" && args[1] === "get") {
        if (options.missingWorkspace) throw new Error("workspace_not_found");
        return { result: { workspace: { workspace_id: "task-space" } } };
      }
      if (args[0] === "tab" && args[1] === "create") {
        assert.equal(args[args.indexOf("--workspace") + 1], "task-space");
        assert.equal(args[args.indexOf("--cwd") + 1], "/different/checkout");
        const paneId = `opaque-pane-${++number}`,
          tabId = `opaque-tab-${number}`;
        panes.set(paneId, {
          paneId,
          tabId,
          intentPath: args[args.indexOf("--env") + 1].slice(
            "BAA_STARTUP_INTENT=".length,
          ),
        });
        return {
          result: { tab: { tab_id: tabId }, root_pane: { pane_id: paneId } },
        };
      }
      if (args[0] === "pane" && args[1] === "get") {
        const p = panes.get(args[2]);
        return {
          result: {
            pane: {
              pane_id: p.paneId,
              tab_id: p.tabId,
              workspace_id: options.wrongWorkspace ? "other" : "task-space",
            },
          },
        };
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        const p = panes.get(args[3]);
        p.processInfoCalls = (p.processInfoCalls ?? 0) + 1;
        if (p.processInfoCalls <= (options.shellInits ?? 0))
          return {
            result: {
              process_info: {
                foreground_processes: [{ pid: 999, name: "bash" }],
              },
            },
          };
        return {
          result: {
            process_info: {
              shell_pid: 123,
              foreground_processes: [{ pid: 123, name: "zsh" }],
            },
          },
        };
      }
      if (args[0] === "agent" && args[1] === "start") {
        assert.equal(
          registered,
          true,
          "route is established before start, not after assignment",
        );
        assert.equal(args[args.indexOf("--model") + 1], launchProfile.model);
        assert.equal(
          args[args.indexOf("--provider") + 1],
          launchProfile.provider,
        );
        assert.equal(
          args[args.indexOf("--thinking") + 1],
          launchProfile.thinking,
        );
        const p = panes.get(args[args.indexOf("--pane") + 1]);
        if (options.busy) {
          options.busy = false;
          throw new Error("agent_pane_busy");
        }
        if (options.busyAlways) throw new Error("agent_pane_busy");
        const intent = JSON.parse(await readFile(p.intentPath, "utf8"));
        const hello = {
          nonce: intent.nonce,
          paneId: p.paneId,
          workspaceId: "task-space",
          source: ports.source,
          sessionPath: `/sessions/${p.paneId}.jsonl`,
          profile: launchProfile,
          tools: ["herdr_complete", "herdr_plan", "herdr_dispatch"],
        };
        options.changeHello?.(hello);
        p.session = hello.sessionId ?? hello.sessionPath;
        await writeFile(`${p.intentPath}.ready`, JSON.stringify(hello));
        return {};
      }
      if (args[0] === "agent" && args[1] === "get") {
        const p = panes.get(args[2]);
        return {
          result: {
            agent: {
              pane_id: p.paneId,
              workspace_id: "task-space",
              agent: options.adapter?.kind ?? "pi",
              agent_session: {
                kind: options.adapter ? "id" : "path",
                value: options.unrelatedSession
                  ? "/sessions/unrelated"
                  : p.session,
              },
            },
          },
        };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        assert.equal(registered, true);
        assert.ok(
          state.lanes.every((l) => l.nativeSession),
          "all startup proofs precede every assignment",
        );
        if (options.lostPrompt)
          throw new Error("socket_timeout after submitted");
        return {};
      }
      throw new Error(
        `Forbidden/unexpected native mutation: ${args.join(" ")}`,
      );
    },
  };
  return {
    options,
    get state() {
      return state;
    },
    set state(value) {
      state = value;
    },
    calls,
    ctx,
    ports,
    run: () => dispatchTask(structuredClone(state), true, ports),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("opaque IDs and different checkout still produce only tabs in one designated workspace", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run()).dispatched, true);
    assert.equal(f.state.ownership.workspaceId, "task-space");
    assert.equal(f.state.ownership.paneIds.length, 2);
    assert.equal(f.calls.filter((c) => c[1] === "prompt").length, 2);
    assert.equal(
      f.calls.some((c) => c[0] === "workspace" && c[1] !== "get"),
      false,
    );
  } finally {
    await f.close();
  }
});
test("shell-init race and a busy rejection self-heal within one dispatch", async () => {
  const f = await fixture({ busy: true, shellInits: 3 });
  try {
    assert.equal((await f.run()).dispatched, true);
    assert.equal(f.state.ownership.paneIds.length, 2);
    assert.equal(
      f.calls.filter((c) => c[0] === "tab" && c[1] === "create").length,
      2,
    );
    assert.equal(f.calls.filter((c) => c[1] === "prompt").length, 2);
  } finally {
    await f.close();
  }
});
test("persistent busy still fails closed and remains retryable in the same tabs", async () => {
  const f = await fixture({ busyAlways: true });
  try {
    await assert.rejects(f.run(), /agent_pane_busy/);
    assert.equal(
      f.calls.some((c) => c[1] === "prompt"),
      false,
    );
    const ids = [...f.state.ownership.paneIds];
    f.options.busyAlways = false;
    assert.equal((await f.run()).dispatched, true);
    assert.deepEqual(f.state.ownership.paneIds, ids);
    assert.equal(
      f.calls.filter((c) => c[0] === "tab" && c[1] === "create").length,
      2,
    );
  } finally {
    await f.close();
  }
});
for (const [label, options, message] of [
  ["missing workspace", { missingWorkspace: true }, /workspace_not_found/],
  ["workspace drift", { wrongWorkspace: true }, /outside its designated/],
  ["routing unavailable", { noRouting: true }, /routing unavailable/],
  ["unrelated replacement", { unrelatedSession: true }, /mismatch/],
  [
    "model mismatch",
    { changeHello: (h) => (h.profile = { ...profile, model: "not-luna" }) },
    /mismatch/,
  ],
  ["missing tools", { changeHello: (h) => (h.tools = []) }, /mismatch/],
  ["API-key fallback", { oauth: false }, /subscription authentication/],
])
  test(`${label} fails closed before work assignment`, async () => {
    const f = await fixture(options);
    try {
      await assert.rejects(f.run(), message);
      assert.equal(
        f.calls.some((c) => c[1] === "prompt"),
        false,
      );
    } finally {
      await f.close();
    }
  });
test("uncertain assignment retry does not type a second prompt or create replacement topology", async () => {
  const f = await fixture({ lostPrompt: true });
  try {
    await assert.rejects(f.run(), /socket_timeout/);
    await assert.rejects(f.run(), /submission is uncertain/);
    assert.equal(f.calls.filter((c) => c[1] === "prompt").length, 1);
    assert.equal(
      f.calls.filter((c) => c[0] === "tab" && c[1] === "create").length,
      2,
    );
  } finally {
    await f.close();
  }
});
test("thinking high fails closed when absent from the installed model map", async () => {
  const f = await fixture({
    thinkingLevelMap: { minimal: "minimal", xhigh: "xhigh", max: "max" },
  });
  try {
    await assert.rejects(f.run(), /Thinking level high is unsupported/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.state.ownership.paneIds, []);
  } finally {
    await f.close();
  }
});

test("thinking xhigh still dispatches with the minimal/xhigh/max model map", async () => {
  const f = await fixture({
    profile: { ...profile, thinking: "xhigh" },
    thinkingLevelMap: { minimal: "minimal", xhigh: "xhigh", max: "max" },
  });
  try {
    assert.equal((await f.run()).dispatched, true);
    assert.equal(f.calls.filter((c) => c[1] === "prompt").length, 2);
  } finally {
    await f.close();
  }
});

test("unqualified harnesses and unsupported exact profiles never launch", async () => {
  const f = await fixture();
  try {
    f.state.lanes[0].agentKind = "claude";
    await assert.rejects(f.run(), /no qualified startup adapter/);
    f.state.lanes[0].agentKind = "pi";
    f.state.launchProfile = { ...profile, model: "made-up" };
    await assert.rejects(f.run(), /Exact installed model not found/);
    f.state.launchProfile = { ...profile, provider: "openai" };
    await assert.rejects(f.run(), /subscription launch adapter/);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("a non-Pi ID-session adapter plugs into unchanged dispatch sequencing", async () => {
  // Synthetic adapter contract proof; NOT live Codex qualification.
  let preflights = 0,
    proofs = 0;
  const adapter = {
    version: 1,
    kind: "codex",
    capabilities: {
      sessionIdentity: "native",
      lifecycle: "screen",
      startupAttestation: true,
    },
    preflight: () => {
      preflights++;
    },
    launchArguments: (p) => [
      "--model",
      p.model,
      "--provider",
      p.provider,
      "--thinking",
      p.thinking,
    ],
    verifyStartup: (native, hello) => {
      assert.equal(native.agent, "codex");
      assert.equal(native.agent_session.kind, "id");
      assert.equal(native.agent_session.value, hello.sessionId);
      proofs++;
      return { ...hello, session: { kind: "id", value: hello.sessionId } };
    },
  };
  const f = await fixture({
    adapter,
    changeHello: (h) => {
      h.sessionId = `native-id:${h.paneId}`;
      delete h.sessionPath;
    },
  });
  try {
    await f.run();
    assert.equal(preflights, 2);
    assert.equal(proofs, 2);
    assert.ok(
      f.state.lanes.every(
        (l) => l.nativeSession.kind === "id" && !l.agentSessionPath,
      ),
    );
    assert.equal(f.calls.filter((c) => c[1] === "prompt").length, 2);
    assert.equal(
      f.calls.some((c) => c[0] === "workspace" && c[1] !== "get"),
      false,
    );
  } finally {
    await f.close();
  }
});
