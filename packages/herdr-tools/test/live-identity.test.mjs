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
    currentCwd: "C:\\repo",
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
      listAgents: async () => ({ result: { agents: [] } }),
    }),
    /not present in the live Herdr agent list/,
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
