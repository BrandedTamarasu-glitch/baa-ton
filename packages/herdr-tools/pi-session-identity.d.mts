export const PI_ROOT_IDENTITY_CHANNEL: string;
export type PiSessionIdentity = {
  version: number; source: string; paneId: string; workspaceId: string; checkout: string;
  sessionId: string; sessionPath: string; nativeSession: { kind: "path" | "id"; value: string };
};
export function resolvePiSessionIdentity(options: {
  agent: unknown; runtime: { getSessionId(): string; getSessionFile(): string | undefined };
  paneId: string; workspaceId: string; cwd: string; env?: NodeJS.ProcessEnv;
}): Promise<PiSessionIdentity>;
export function registerPiIdentityBridge(
  pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
  inspect: (ctx: import("@earendil-works/pi-coding-agent").ExtensionContext) => Promise<unknown>,
): void;
