export type HerdrIdentity = {
  paneId?: string;
  workspaceId?: string;
};

export function resolveHerdrIdentity(options?: {
  env?: Record<string, string | undefined>;
  listAgents?: () => Promise<unknown>;
}): Promise<HerdrIdentity>;

export function applyHerdrIdentity(
  env: Record<string, string | undefined>,
  identity: HerdrIdentity,
): void;

export function currentAppliedHerdrIdentity(
  env?: Record<string, string | undefined>,
): HerdrIdentity | undefined;

export function clearAppliedHerdrIdentity(
  env?: Record<string, string | undefined>,
): void;
