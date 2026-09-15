export function acknowledgeActivation(
  configDir: string,
  identity: { paneId?: string; workspaceId?: string; sessionPath?: string; source: string },
  readNative: (paneId: string) => Promise<unknown>,
): Promise<{ id: string; workspaceId: string } | undefined>;
