import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const PI_ROOT_IDENTITY_CHANNEL = "baa-ton:pi-root-identity:v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (value) => typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);

async function canonical(value) {
  if (!clean(value) || !isAbsolute(value)) throw new Error("Pi identity requires an absolute, control-character-free path.");
  return realpath(value);
}

// Only the native extension supplies runtime: never accept a session id/path
// from a tool argument, environment fallback, transcript filename or caller RPC.
export async function resolvePiSessionIdentity({ agent, runtime, paneId, workspaceId, cwd, env = process.env }) {
  if (!clean(paneId) || !clean(workspaceId) || agent?.agent !== "pi" ||
      agent.pane_id !== paneId || agent.workspace_id !== workspaceId)
    throw new Error("Native Pi agent does not match the current pane/workspace.");
  const sessionId = runtime?.getSessionId?.();
  const sessionFile = runtime?.getSessionFile?.();
  if (!clean(sessionId) || !uuid.test(sessionId)) throw new Error("Native Pi runtime session UUID is unavailable.");
  const sessionPath = await canonical(sessionFile);
  const checkout = await canonical(cwd);
  const file = await open(sessionPath, "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error("Native Pi session is not a regular file.");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(10);
    if (newline < 0) throw new Error("Native Pi session header is missing or too large.");
    const header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    if (header.type !== "session" || header.id !== sessionId || await canonical(header.cwd) !== checkout)
      throw new Error("Native Pi session header differs from the live runtime or checkout.");
  } finally { await file.close(); }
  const native = agent.agent_session;
  if (native?.kind === "id") {
    if (native.value !== sessionId) throw new Error("Native Herdr Pi UUID differs from the live runtime.");
  } else if (native?.kind === "path") {
    if (await canonical(native.value) !== sessionPath) throw new Error("Native Herdr Pi path differs from the live runtime.");
  } else throw new Error("Native Herdr Pi session must explicitly identify a path or UUID.");
  if (env.PI_SESSION_FILE !== undefined && await canonical(env.PI_SESSION_FILE) !== sessionPath)
    throw new Error("PI_SESSION_FILE conflicts with the live Pi session.");
  // Session changes during IO must not produce proof for the previous incarnation.
  if (runtime.getSessionId() !== sessionId || runtime.getSessionFile() !== sessionFile ||
      await canonical(sessionFile) !== sessionPath || !(await stat(sessionPath)).isFile())
    throw new Error("Native Pi session changed during identity inspection.");
  return { version: 1, source: "baa-ton-native-pi", paneId, workspaceId, checkout,
    sessionId, sessionPath, nativeSession: { kind: native.kind, value: native.value } };
}

// This is an in-process trusted-extension protocol, not a signed portable
// credential. Capture context only from Pi lifecycle callbacks, not the request.
export function registerPiIdentityBridge(pi, inspect) {
  let context;
  for (const event of ["session_start", "session_switch", "session_fork", "agent_start", "tool_call"])
    pi.on(event, (_event, ctx) => { context = ctx; });
  pi.on("session_shutdown", () => { context = undefined; });
  pi.events?.on(PI_ROOT_IDENTITY_CHANNEL, (request) => {
    if (!request || typeof request.respond !== "function") return;
    // Claim synchronously, so a missing/duplicate provider fails immediately.
    request.respond(context ? inspect(context) : Promise.reject(new Error("Native Pi context unavailable; no identity proof issued.")));
  });
}
