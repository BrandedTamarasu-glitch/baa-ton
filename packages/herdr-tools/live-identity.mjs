/**
 * Resolve the identity of a live Claude Code MCP subprocess.
 *
 * Claude's project-scoped MCP configuration freezes the HERDR_* values that
 * were present when the registration was created. CLAUDE_CODE_SESSION_ID is
 * not frozen, however, and may be regenerated for an MCP subprocess when a
 * Claude process restarts. It is therefore only a hint. When available, the
 * live pane process tree is the authoritative correlation; the session id is
 * used as a secondary fallback. Harnesses without that session id
 * intentionally retain the inherited static identity.
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

const LIVE_SESSION_ENV = "BAA_TON_LIVE_IDENTITY_SESSION_ID";
const LIVE_PANE_ENV = "BAA_TON_LIVE_IDENTITY_PANE_ID";
const LIVE_WORKSPACE_ENV = "BAA_TON_LIVE_IDENTITY_WORKSPACE_ID";

/**
 * Publish a live identity for the current MCP request. These private
 * process-local markers let the MCP bridge and the Jiti-loaded extension use
 * the same lookup result without making two independent Herdr calls.
 */
export function applyHerdrIdentity(env, identity) {
  if (identity.paneId !== undefined) env.HERDR_PANE_ID = identity.paneId;
  if (identity.workspaceId !== undefined)
    env.HERDR_WORKSPACE_ID = identity.workspaceId;
  const sessionId = nonEmptyString(env.CLAUDE_CODE_SESSION_ID);
  if (sessionId && identity.paneId && identity.workspaceId) {
    env[LIVE_SESSION_ENV] = sessionId;
    env[LIVE_PANE_ENV] = identity.paneId;
    env[LIVE_WORKSPACE_ENV] = identity.workspaceId;
  } else {
    delete env[LIVE_SESSION_ENV];
    delete env[LIVE_PANE_ENV];
    delete env[LIVE_WORKSPACE_ENV];
  }
}

export function currentAppliedHerdrIdentity(env = process.env) {
  const sessionId = nonEmptyString(env.CLAUDE_CODE_SESSION_ID);
  if (!sessionId || env[LIVE_SESSION_ENV] !== sessionId) return undefined;
  const paneId = nonEmptyString(env[LIVE_PANE_ENV]);
  const workspaceId = nonEmptyString(env[LIVE_WORKSPACE_ENV]);
  return paneId && workspaceId ? { paneId, workspaceId } : undefined;
}

export function clearAppliedHerdrIdentity(env = process.env) {
  delete env[LIVE_SESSION_ENV];
  delete env[LIVE_PANE_ENV];
  delete env[LIVE_WORKSPACE_ENV];
}

function agentListFromPayload(payload) {
  const result = isRecord(payload?.result) ? payload.result : payload;
  return isRecord(result) && Array.isArray(result.agents) ? result.agents : [];
}

function agentKind(agent) {
  return (
    nonEmptyString(agent?.agent) ??
    nonEmptyString(agent?.agent_session?.agent)
  );
}

function agentIdentity(agent) {
  if (!isRecord(agent)) return undefined;
  const paneId = nonEmptyString(agent.pane_id);
  const workspaceId = nonEmptyString(agent.workspace_id);
  if (!paneId || !workspaceId) return undefined;
  return { paneId, workspaceId };
}

function sameWorkingDirectory(agent, currentCwd) {
  if (!currentCwd) return true;
  const values = [agent?.cwd, agent?.foreground_cwd].filter(
    (value) => typeof value === "string" && value,
  );
  if (values.length === 0) return true;
  return values.some((value) => {
    if (value === currentCwd) return true;
    const windowsPath = value.includes("\\") || currentCwd.includes("\\");
    return (
      windowsPath &&
      value.replaceAll("\\", "/").toLowerCase() ===
        currentCwd.replaceAll("\\", "/").toLowerCase()
    );
  });
}

function processIdsFromPayload(payload) {
  const result = isRecord(payload?.result) ? payload.result : payload;
  const info = isRecord(result?.process_info) ? result.process_info : result;
  if (!isRecord(info)) return [];
  const values = [info.shell_pid, info.foreground_process_group_id];
  if (Array.isArray(info.foreground_processes))
    values.push(...info.foreground_processes.map((process) => process?.pid));
  return values
    .map((value) =>
      typeof value === "number" ? value : Number.parseInt(String(value), 10),
    )
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

function liveClaudeAgents(agents) {
  return agents.filter(
    (agent) =>
      isRecord(agent) &&
      agentKind(agent) === "claude" &&
      agentIdentity(agent),
  );
}

async function processMatchedAgents({
  agents,
  listPaneProcesses,
  currentProcessPids,
}) {
  if (typeof listPaneProcesses !== "function" || currentProcessPids.size === 0)
    return [];
  return (
    await Promise.all(
      agents.map(async (agent) => {
        try {
          const processIds = new Set(
            processIdsFromPayload(
              await listPaneProcesses({
                paneId: agent.pane_id,
                workspaceId: agent.workspace_id,
                agent,
              }),
            ),
          );
          return [...currentProcessPids].some((pid) => processIds.has(pid))
            ? agent
            : undefined;
        } catch {
          // Process info is an optional Herdr capability. A transient failure
          // must not discard a valid session-id or static-root fallback.
          return undefined;
        }
      }),
    )
  ).filter(Boolean);
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   listAgents?: () => Promise<unknown>,
 *   listPaneProcesses?: (target: {paneId: string, workspaceId: string, agent: unknown}) => Promise<unknown>,
 *   currentProcessPids?: number[],
 *   currentCwd?: string,
 *   allowStaticFallback?: (target: {fallback: {paneId?: string, workspaceId?: string}, agents: unknown[], sessionId: string}) => boolean | Promise<boolean>,
 * }} options
 * @returns {Promise<{paneId?: string, workspaceId?: string}>}
 */
export async function resolveHerdrIdentity({
  env = process.env,
  listAgents,
  listPaneProcesses,
  currentProcessPids = [process.pid, process.ppid],
  currentCwd,
  allowStaticFallback,
} = {}) {
  const fallback = staticIdentity(env);
  const sessionId = nonEmptyString(env.CLAUDE_CODE_SESSION_ID);
  if (!sessionId) return fallback;
  if (typeof listAgents !== "function")
    throw new Error(
      "A live Herdr agent-list lookup is required when CLAUDE_CODE_SESSION_ID is present.",
    );

  const agents = agentListFromPayload(await listAgents());
  // Do not use cwd as a candidate filter. Claude may launch a project-scoped
  // MCP server from the server package directory instead of the project cwd;
  // the MCP/Claude PID is still an unambiguous pane anchor. Cwd is only a
  // tiebreaker if Herdr reports the same PID in multiple panes.
  const candidates = liveClaudeAgents(agents);
  const processMatches = await processMatchedAgents({
    agents: candidates,
    listPaneProcesses,
    currentProcessPids: new Set(
      currentProcessPids
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  });
  if (processMatches.length === 1) return agentIdentity(processMatches[0]);
  if (processMatches.length > 1) {
    const cwdMatches = currentCwd
      ? processMatches.filter((agent) => sameWorkingDirectory(agent, currentCwd))
      : [];
    if (cwdMatches.length === 1) return agentIdentity(cwdMatches[0]);
    throw new Error(
      `The MCP process matched multiple live Herdr Claude panes by PID.`,
    );
  }

  const sessionMatches = candidates.filter(
    (agent) =>
      isRecord(agent.agent_session) &&
      nonEmptyString(agent.agent_session.value) === sessionId,
  );
  if (sessionMatches.length === 1) return agentIdentity(sessionMatches[0]);
  if (sessionMatches.length > 1)
    throw new Error(
      `Claude session ${sessionId} matched multiple live Herdr agents.`,
    );
  if (
    sessionMatches.length === 0 &&
    typeof allowStaticFallback === "function" &&
    await allowStaticFallback({ fallback, agents, sessionId })
  )
    return fallback;
  if (sessionMatches.length === 0)
    throw new Error(
      `Claude session ${sessionId} is not present in the live Herdr agent list ` +
        `(mcp_pid=${process.pid}, mcp_ppid=${process.ppid}, ` +
        `lookup_pids=${currentProcessPids.join(",") || "<none>"}, ` +
        `cwd=${currentCwd ?? "<unset>"}, ` +
        `claude_candidates=${candidates.length}, ` +
        `pid_matches=${processMatches.length}, ` +
        `session_matches=${sessionMatches.length}).`,
    );
  throw new Error(`Unable to resolve Claude session ${sessionId}.`);
}
