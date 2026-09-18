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

function normalizeProcessId(value) {
  const numeric =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function processIdsFromPayload(payload) {
  const result = isRecord(payload?.result) ? payload.result : payload;
  const info = isRecord(result?.process_info) ? result.process_info : result;
  if (!isRecord(info)) return [];
  const values = [info.shell_pid, info.foreground_process_group_id];
  if (Array.isArray(info.foreground_processes))
    values.push(...info.foreground_processes.map((process) => process?.pid));
  return values.map(normalizeProcessId).filter(Boolean);
}

function liveClaudeAgents(agents) {
  return agents.filter(
    (agent) =>
      isRecord(agent) &&
      agentKind(agent) === "claude" &&
      agentIdentity(agent),
  );
}

async function paneProcessEntries({ agents, listPaneProcesses }) {
  if (typeof listPaneProcesses !== "function") return [];
  return (
    await Promise.all(
      agents.map(async (agent) => {
        try {
          return {
            agent,
            processIds: new Set(
              processIdsFromPayload(
                await listPaneProcesses({
                  paneId: agent.pane_id,
                  workspaceId: agent.workspace_id,
                  agent,
                }),
              ),
            ),
          };
        } catch {
          // Process info is an optional Herdr capability. A transient failure
          // must not discard a valid session-id or static-root fallback.
          return undefined;
        }
      }),
    )
  ).filter(Boolean);
}

function processMatchedAgents(entries, currentProcessPids) {
  if (currentProcessPids.size === 0) return [];
  return entries
    .filter((entry) =>
      [...currentProcessPids].some((pid) => entry.processIds.has(pid)),
    )
    .map((entry) => entry.agent);
}

async function resolveProcessMatches({
  agents,
  listPaneProcesses,
  currentProcessPids,
  currentProcessPid,
  getParentPid,
  maxProcessAncestorDepth,
}) {
  const entries = await paneProcessEntries({ agents, listPaneProcesses });
  const lookupPids = new Set(
    [...currentProcessPids].map(normalizeProcessId).filter(Boolean),
  );
  const processPid = normalizeProcessId(currentProcessPid);
  if (processPid) lookupPids.add(processPid);
  let matches = processMatchedAgents(entries, lookupPids);
  if (
    matches.length > 0 ||
    entries.length === 0 ||
    typeof getParentPid !== "function" ||
    !processPid
  )
    return { matches, lookupPids };

  let cursor = processPid;
  const maxDepth = Number.isSafeInteger(maxProcessAncestorDepth)
    ? Math.max(0, maxProcessAncestorDepth)
    : 8;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    let parentPid;
    try {
      parentPid = normalizeProcessId(await getParentPid(cursor));
    } catch {
      break;
    }
    if (!parentPid || parentPid === cursor) break;
    cursor = parentPid;
    lookupPids.add(parentPid);
    matches = processMatchedAgents(entries, lookupPids);
    if (matches.length > 0) break;
  }
  return { matches, lookupPids };
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   listAgents?: () => Promise<unknown>,
 *   listPaneProcesses?: (target: {paneId: string, workspaceId: string, agent: unknown}) => Promise<unknown>,
 *   currentProcessPids?: number[],
 *   currentProcessPid?: number,
 *   getParentPid?: (pid: number) => Promise<number | undefined>,
 *   maxProcessAncestorDepth?: number,
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
  currentProcessPid = process.pid,
  getParentPid,
  maxProcessAncestorDepth = 8,
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
  const sessionMatches = candidates.filter(
    (agent) =>
      isRecord(agent.agent_session) &&
      nonEmptyString(agent.agent_session.value) === sessionId,
  );
  const processLookup = await resolveProcessMatches({
    agents: candidates,
    listPaneProcesses,
    currentProcessPids: new Set(
      currentProcessPids
        .map(normalizeProcessId)
        .filter(Boolean),
    ),
    currentProcessPid,
    getParentPid,
    // A unique live session match is already sufficient after direct process
    // evidence. Avoid an expensive Windows ancestor walk in the common case;
    // reserve wrapper traversal for regenerated/missing session ids.
    maxProcessAncestorDepth: sessionMatches.length === 1 ? 0 : maxProcessAncestorDepth,
  });
  const processMatches = processLookup.matches;
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
        `lookup_pids=${[...processLookup.lookupPids].join(",") || "<none>"}, ` +
        `cwd=${currentCwd ?? "<unset>"}, ` +
        `claude_candidates=${candidates.length}, ` +
        `pid_matches=${processMatches.length}, ` +
        `session_matches=${sessionMatches.length}).`,
    );
  throw new Error(`Unable to resolve Claude session ${sessionId}.`);
}
