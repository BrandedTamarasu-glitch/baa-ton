import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHerdrIdentity } from "../live-identity.mjs";

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
