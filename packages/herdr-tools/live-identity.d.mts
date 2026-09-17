export type HerdrIdentity = {
  paneId?: string;
  workspaceId?: string;
};

export function resolveHerdrIdentity(options?: {
  env?: Record<string, string | undefined>;
  listAgents?: () => Promise<unknown>;
}): Promise<HerdrIdentity>;
