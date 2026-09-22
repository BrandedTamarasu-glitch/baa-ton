export type HerdrIdentity = {
  paneId?: string;
  workspaceId?: string;
};

export function resolveHerdrIdentity(options?: {
  env?: Record<string, string | undefined>;
  listAgents?: () => Promise<unknown>;
  listPaneProcesses?: (target: {
    paneId: string;
    workspaceId: string;
    agent: unknown;
  }) => Promise<unknown>;
  currentProcessPids?: number[];
  currentProcessPid?: number;
  getParentPid?: (pid: number) => Promise<number | undefined>;
  maxProcessAncestorDepth?: number;
  currentCwd?: string;
  allowStaticFallback?: (target: {
    fallback: HerdrIdentity;
    agents: unknown[];
    sessionId: string;
  }) => boolean | Promise<boolean>;
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
