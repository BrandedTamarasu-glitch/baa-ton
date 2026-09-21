import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyHerdrIdentity,
  clearAppliedHerdrIdentity,
  currentAppliedHerdrIdentity,
  resolveHerdrIdentity,
} from "../live-identity.mjs";

test("live Claude session identity overrides a stale project-scoped environment snapshot", async () => {
  let listCalls = 0;
  const identity = await resolveHerdrIdentity({
    env: {
      HERDR_PANE_ID: "w-stale:old",
      HERDR_WORKSPACE_ID: "w-stale",
      CLAUDE_CODE_SESSION_ID: "claude-session-live",
    },
    listAgents: async () => {
      listCalls += 1;
      return {
        id: "cli:agent:list",
        result: {
          type: "agent_list",
          agents: [
            {
              agent: "claude",
              pane_id: "w-live:second",
              workspace_id: "w-live",
              agent_session: {
                agent: "claude",
                kind: "id",
                value: "claude-session-live",
              },
            },
          ],
        },
      };
    },
  });

  assert.deepEqual(identity, {
    paneId: "w-live:second",
    workspaceId: "w-live",
  });
  assert.equal(listCalls, 1);
});

test("the live pane process wins when Claude's MCP session id was regenerated", async () => {
  const identity = await resolveHerdrIdentity({
    env: {
      HERDR_PANE_ID: "w-frozen:old",
      HERDR_WORKSPACE_ID: "w-frozen",
      CLAUDE_CODE_SESSION_ID: "mcp-process-generated-id",
    },
    // The MCP server may start from the Baa-ton package cwd instead of the
    // user's project cwd; PID matching must still see this Claude pane.
    currentCwd: "C:\\Users\\zchri\\.baa-ton\\packages\\herdr-tools",
    currentProcessPids: [4242],
    listAgents: async () => ({
      result: {
        agents: [
          {
            agent: "claude",
            pane_id: "w-live:current",
            workspace_id: "w-live",
            cwd: "C:\\repo",
            agent_session: {
              agent: "claude",
              kind: "id",
              value: "stable-herdr-session-id",
            },
          },
        ],
      },
    }),
    listPaneProcesses: async ({ paneId }) => ({
      result: {
        process_info: {
          foreground_processes:
            paneId === "w-live:current" ? [{ pid: 4242 }] : [],
        },
      },
    }),
  });

  assert.deepEqual(identity, {
    paneId: "w-live:current",
    workspaceId: "w-live",
  });
});

test("the live pane process match walks through wrapper ancestors", async () => {
  const parentByPid = new Map([
    [4440, 66308],
    [66308, 79844],
    [79844, 90888],
  ]);
  const visited = [];
  const identity = await resolveHerdrIdentity({
    env: {
      HERDR_PANE_ID: "w-frozen:old",
      HERDR_WORKSPACE_ID: "w-frozen",
      CLAUDE_CODE_SESSION_ID: "mcp-process-generated-id",
    },
    currentProcessPids: [4440, 66308],
    currentProcessPid: 4440,
    getParentPid: async (pid) => {
      visited.push(pid);
      return parentByPid.get(pid);
    },
    listAgents: async () => ({
      result: {
        agents: [
          {
            agent: "claude",
            pane_id: "w-live:current",
            workspace_id: "w-live",
            cwd: "C:\\cic",
            agent_session: {
              agent: "claude",
              kind: "id",
              value: "stable-herdr-session-id",
            },
          },
        ],
      },
    }),
    listPaneProcesses: async () => ({
      result: {
        process_info: {
          foreground_processes: [{ pid: 90888 }],
        },
      },
    }),
  });

  assert.deepEqual(identity, {
    paneId: "w-live:current",
    workspaceId: "w-live",
  });
  assert.deepEqual(visited, [4440, 66308, 79844]);
});

test("a unique live session skips ancestor lookup after direct process miss", async () => {
  let parentLookups = 0;
  const identity = await resolveHerdrIdentity({
    env: {
      HERDR_PANE_ID: "w-frozen:old",
      HERDR_WORKSPACE_ID: "w-frozen",
      CLAUDE_CODE_SESSION_ID: "stable-live-session",
    },
    currentProcessPids: [4242],
    listAgents: async () => ({
      result: {
        agents: [
          {
            agent: "claude",
            pane_id: "w-live:current",
            workspace_id: "w-live",
            agent_session: {
              agent: "claude",
              kind: "id",
              value: "stable-live-session",
            },
          },
        ],
      },
    }),
    listPaneProcesses: async () => ({
      result: { process_info: { foreground_processes: [] } },
    }),
    getParentPid: async () => {
      parentLookups += 1;
      throw new Error("ancestor lookup should be skipped");
    },
  });

  assert.deepEqual(identity, {
    paneId: "w-live:current",
    workspaceId: "w-live",
  });
  assert.equal(parentLookups, 0);
});

test("a registered live static root remains usable when Claude's session id is absent from Herdr", async () => {
  const identity = await resolveHerdrIdentity({
    env: {
      HERDR_PANE_ID: "w-root:current",
      HERDR_WORKSPACE_ID: "w-root",
      CLAUDE_CODE_SESSION_ID: "mcp-process-generated-id",
    },
    listAgents: async () => ({
      result: {
        agents: [
          {
            agent: "claude",
            pane_id: "w-root:current",
            workspace_id: "w-root",
            agent_session: {
              agent: "claude",
              kind: "id",
              value: "stable-herdr-session-id",
            },
          },
        ],
      },
    }),
    allowStaticFallback: ({ fallback, agents }) =>
      fallback.paneId === "w-root:current" && agents.length === 1,
  });

  assert.deepEqual(identity, {
    paneId: "w-root:current",
    workspaceId: "w-root",
  });
});

test("harnesses without a live Claude session retain their static Herdr identity", async () => {
  for (const harness of ["pi", "codex", "opencode"]) {
    let listCalls = 0;
    const identity = await resolveHerdrIdentity({
      env: {
        HERDR_AGENT_KIND: harness,
        HERDR_PANE_ID: `w-static:${harness}`,
        HERDR_WORKSPACE_ID: `w-${harness}`,
      },
      listAgents: async () => {
        listCalls += 1;
        return { result: { agents: [] } };
      },
    });

    assert.deepEqual(identity, {
      paneId: `w-static:${harness}`,
      workspaceId: `w-${harness}`,
    });
    assert.equal(listCalls, 0, `${harness} must not require a live Claude lookup`);
  }
});

test("a present but unregistered Claude session fails closed instead of using stale pane data", async () => {
  await assert.rejects(
    resolveHerdrIdentity({
      env: {
        HERDR_PANE_ID: "w-stale:old",
        HERDR_WORKSPACE_ID: "w-stale",
        CLAUDE_CODE_SESSION_ID: "missing-session",
      },
      currentProcessPids: [999999, 77640],
      currentCwd: "C:\\cic",
      listAgents: async () => ({ result: { agents: [] } }),
    }),
    (error) => {
      assert.match(error.message, /not present in the live Herdr agent list/);
      assert.match(error.message, /mcp_pid=\d+/);
      assert.match(error.message, /mcp_ppid=\d+/);
      assert.match(error.message, /lookup_pids=999999,77640/);
      assert.match(error.message, /cwd=C:\\cic/);
      assert.match(error.message, /claude_candidates=0/);
      assert.match(error.message, /pid_matches=0/);
      assert.match(error.message, /session_matches=0/);
      return true;
    },
  );
});

test("the bridge-applied identity is reusable only within the matching live session", () => {
  const env = {
    CLAUDE_CODE_SESSION_ID: "claude-session-live",
    HERDR_PANE_ID: "w-stale:old",
    HERDR_WORKSPACE_ID: "w-stale",
  };
  applyHerdrIdentity(env, {
    paneId: "w-live:current",
    workspaceId: "w-live",
  });

  assert.deepEqual(currentAppliedHerdrIdentity(env), {
    paneId: "w-live:current",
    workspaceId: "w-live",
  });
  env.CLAUDE_CODE_SESSION_ID = "a-different-session";
  assert.equal(currentAppliedHerdrIdentity(env), undefined);
  clearAppliedHerdrIdentity(env);
  assert.equal(currentAppliedHerdrIdentity(env), undefined);
});
