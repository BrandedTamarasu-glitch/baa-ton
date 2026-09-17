/**
 * Resolve the identity of a live Claude Code MCP subprocess.
 *
 * Claude's project-scoped MCP configuration freezes the HERDR_* values that
 * were present when the registration was created. CLAUDE_CODE_SESSION_ID is
 * not frozen, however, and Herdr exposes that same session id on its live
 * agent records. Harnesses without that session id intentionally retain the
 * inherited static identity.
 */

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function staticString(value) {
  return typeof value === "string" && value ? value : undefined;
}

function staticIdentity(env) {
  return {
    paneId: staticString(env.HERDR_PANE_ID),
    workspaceId: staticString(env.HERDR_WORKSPACE_ID),
  };
}

function agentListFromPayload(payload) {
  const result = isRecord(payload?.result) ? payload.result : payload;
  return isRecord(result) && Array.isArray(result.agents) ? result.agents : [];
}

/**
 * @param {{env?: Record<string, string | undefined>, listAgents?: () => Promise<unknown>}} options
 * @returns {Promise<{paneId?: string, workspaceId?: string}>}
 */
export async function resolveHerdrIdentity({ env = process.env, listAgents } = {}) {
  const fallback = staticIdentity(env);
  const sessionId = nonEmptyString(env.CLAUDE_CODE_SESSION_ID);
  if (!sessionId) return fallback;
  if (typeof listAgents !== "function")
    throw new Error(
      "A live Herdr agent-list lookup is required when CLAUDE_CODE_SESSION_ID is present.",
    );

  const matches = agentListFromPayload(await listAgents()).filter((agent) => {
    if (!isRecord(agent) || !isRecord(agent.agent_session)) return false;
    const kind = nonEmptyString(agent.agent) ?? nonEmptyString(agent.agent_session.agent);
    return (
      kind === "claude" &&
      nonEmptyString(agent.agent_session.value) === sessionId &&
      nonEmptyString(agent.pane_id) !== undefined &&
      nonEmptyString(agent.workspace_id) !== undefined
    );
  });
  if (matches.length === 0)
    throw new Error(
      `Claude session ${sessionId} is not present in the live Herdr agent list.`,
    );
  if (matches.length > 1)
    throw new Error(
      `Claude session ${sessionId} matched multiple live Herdr agents.`,
    );
  return {
    paneId: nonEmptyString(matches[0].pane_id),
    workspaceId: nonEmptyString(matches[0].workspace_id),
  };
}
