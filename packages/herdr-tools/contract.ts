/**
 * Harness-neutral orchestration contract.
 *
 * Keep this module independent from Pi, Herdr, and every other harness. The
 * extension entrypoint and launch adapters may depend on these shapes, but
 * the contract must never depend on an entrypoint or harness SDK.
 */

export const SUPPORTED_AGENT_KINDS = [
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "omp",
  "mastracode",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "qwen",
  "maki",
  "muse",
] as const;
export type AgentKind = (typeof SUPPORTED_AGENT_KINDS)[number];

export const AUTHORIZATION_CAPABILITIES = [
  "local-herdr-topology",
  "clean-local-worktrees",
  "foreground-tests",
  "observe-retry-review",
  "durable-ledger",
  "paused-goal-recovery",
] as const;
export type AuthorizationCapability =
  (typeof AUTHORIZATION_CAPABILITIES)[number];
export type AutonomousOperation = "dispatch" | "retry" | "resume";

export type LaunchProfile = {
  provider: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  auth: "subscription";
};
export type LaunchProfileVersion = 1;

export type AuthorizationPolicy = {
  version: 1;
  scope: { workflow: string; localOnly: true };
  capabilities: AuthorizationCapability[];
};
export type AuthorizationDecision = {
  allowed: boolean;
  operation: AutonomousOperation;
  reason: string;
  policy?: AuthorizationPolicy;
};

export type ReadinessCheck = {
  source: "herdr agent start --timeout";
  checkedAt: string;
  initialShellForeground: boolean;
  agentStartTimeoutMs: number;
};
export type RetryState = {
  state: "dispatching" | "retryable";
  attempt: number;
  retryCommand: string;
  resumedAt?: string;
  failedAt?: string;
  failedLaneId?: string;
  failedStage?: string;
  error?: string;
};

export type ApprovalRequest = {
  id: string;
  action: "dispatch" | "close" | "resume";
  status: "parent-approval-required" | "approved" | "cancelled";
  requestedAt: string;
  resolvedAt?: string;
  request: string;
};
export type ApprovalRecord = ApprovalRequest;

export type ParentQuestionRequest = {
  id: string;
  kind: "question";
  status: "parent-question-required" | "answered" | "answer-delivery-pending";
  requestedAt: string;
  workflowId?: string;
  paneId?: string;
  question: string;
  answer?: string;
  answeredAt?: string;
  delivery?: {
    status: "pending" | "sending" | "delivered" | "uncertain";
    updatedAt: string;
    reason?: string;
  };
};
export type QuestionRecord = ParentQuestionRequest;

export type GoalPauseRecord = {
  status: "goal-paused";
  goalIds: string[];
  detectedAt: string;
  source: "herdr agent read recent-unwrapped";
  output: string;
};
export type GoalResumeReceipt = {
  command: "/goal-resume";
  requestedAt: string;
  receipt: string;
};

export type ControllerTargetKind = "name" | "pane_id";
export type ControllerRootMapping = {
  target: string;
  target_kind: ControllerTargetKind;
  pane_id: string;
  workspace_id: string;
  agent_kind?: string;
};
export type ControllerLaneMapping = {
  lane_id: string;
  target: string;
  target_kind: ControllerTargetKind;
  pane_id: string;
  workspace_id: string;
  relationship_id?: string;
};
export type ControllerWorkflowMapping = {
  workflow_id: string;
  manifest_path: string;
  pi_goal_pause_detection?: boolean;
  lanes: ControllerLaneMapping[];
};
export type ControllerOrchestrator = {
  id: string;
  root: ControllerRootMapping;
  program: {
    id: string;
    workspace_id: string;
    parent_manifest_path?: string;
  };
  workflows: ControllerWorkflowMapping[];
};
export type ControllerConfig = {
  version: 2;
  owner: "herdr-orchestrator";
  orchestrators: ControllerOrchestrator[];
};
export type EventControllerRegistration = {
  version: 1;
  status: "pending" | "registered" | "cleanup-pending" | "removed";
  updatedAt: string;
  reason?: string;
  configPath?: string;
  root?: ControllerRootMapping;
  workflow?: ControllerWorkflowMapping;
};

/** The generalized provider/session identity used for durable persistence. */
export type PersistenceHandle = {
  provider: string;
  sessionId: string;
  /** Harness-native identity, when the provider exposes one. */
  nativeHandle?: unknown;
  /** Provider-specific durable facts that are safe to retain. */
  metadata?: Record<string, unknown>;
};

/**
 * Compatibility view of the original Herdr native session identity. Existing
 * manifests use this shape; new records may additionally carry a
 * PersistenceHandle without invalidating the old view.
 */
export type NativeSessionRef = { kind: "path" | "id"; value: string };
export type SessionHandle = NativeSessionRef | PersistenceHandle;

export function toPersistenceHandle(
  session: SessionHandle,
  provider = "herdr",
): PersistenceHandle {
  if ("provider" in session && "sessionId" in session)
    return { ...session };
  return {
    provider,
    sessionId: session.value,
    nativeHandle: { ...session },
  };
}

export function nativeSessionFromPersistenceHandle(
  session: SessionHandle | undefined,
): NativeSessionRef | undefined {
  if (!session) return undefined;
  if ("kind" in session && "value" in session)
    return { kind: session.kind, value: session.value };
  const native = session.nativeHandle;
  if (
    native &&
    typeof native === "object" &&
    (native as { kind?: unknown }).kind !== undefined &&
    (native as { value?: unknown }).value !== undefined
  ) {
    const kind = (native as { kind?: unknown }).kind;
    const value = (native as { value?: unknown }).value;
    if (
      (kind === "path" || kind === "id") &&
      typeof value === "string" &&
      value
    )
      return { kind, value };
  }
  return undefined;
}

export type WorktreeBinding = {
  checkoutPath: string;
  repoParent: {
    workspaceId: string;
    checkoutPath: string;
    repoKey: string;
    repoRoot: string;
  };
  workspaceId?: string;
  openResult?: unknown;
};
export type LaneInput =
  | string
  | {
      objective: string;
      readOnly?: boolean;
      agentKind?: AgentKind;
      launchProfile?: unknown;
      dependencies?: string[];
      dependsOn?: string[];
    };

export type GoalStatus =
  | "planned"
  | "ready"
  | "running"
  | "blocked"
  | "completed"
  | "paused";
export type GoalOutcome = "unresolved" | "success" | "failure" | "cancelled";
export type GoalOwnership = {
  scope: "workflow" | "lane";
  workflowId: string;
  laneId?: string;
  authority: "authorized-root" | "lane";
};
export type GoalRecord = {
  version: 1;
  id: string;
  revision: number;
  parentId?: string;
  dependencies: string[];
  objective: string;
  status: GoalStatus;
  outcome: GoalOutcome;
  ownership: GoalOwnership;
  updatedAt: string;
};
export type OperatorClosure = {
  version: 1;
  id: string;
  laneId: string;
  who: string;
  why: string;
  evidence: string[];
  recordedAt: string;
};

export type Lane = {
  goalId?: string;
  goalRevision?: number;
  dependencies?: string[];
  goalOwnership?: GoalOwnership;
  launchProfile?: LaunchProfile;
  launchProfileVersion?: LaunchProfileVersion;
  incarnationId?: string;
  incarnationRevision?: number;
  incarnationStartedAt?: string;
  restart?: {
    version: 1;
    status: "requested" | "starting" | "bound";
    requestedAt: string;
    previousIncarnationId?: string;
    incarnationId: string;
  };
  /** Legacy compatibility view retained for manifests written before v1. */
  nativeSession?: NativeSessionRef;
  /** Generalized provider/session persistence identity. */
  persistenceHandle?: PersistenceHandle;
  completionReceipt?: {
    id: string;
    summary: string;
    delivery: "pending" | "sending" | "delivered" | "uncertain";
  };
  startupIntentPath?: string;
  startupNonce?: string;
  tabCreateAttemptedAt?: string;
  agentStartAttemptedAt?: string;
  id: string;
  objective: string;
  readOnly: boolean;
  agentKind: AgentKind;
  status: string;
  agentName?: string;
  relationshipId?: string;
  tabId?: string;
  paneId?: string;
  resourceCreatedAt?: string;
  tabRenamedAt?: string;
  readiness?: ReadinessCheck;
  agentStartedAt?: string;
  startupHandshakeAttemptedAt?: string;
  startupHandshakeSentAt?: string;
  promptAttemptedAt?: string;
  promptedAt?: string;
  agentSessionPath?: string;
  agentSessionId?: string;
  // Retained for Pi manifests written before agentKind.
  piSessionPath?: string;
  piSessionId?: string;
  herdrState?: string;
  goalPaused?: GoalPauseRecord;
  goalResumeReceipts?: GoalResumeReceipt[];
};

export type LedgerEventRecord = {
  at: string;
  kind: string;
  text: string;
};
export type ParentGoalStatus =
  | "active"
  | "waiting-for-event"
  | "action-required"
  | "blocked"
  | "completed"
  | "paused";
export type ParentGoalSignal = {
  identity: string;
  workflowId: string;
  laneId: string;
  classification: "done" | "blocked" | "goal-paused";
  receivedAt: string;
};
export type ParentGoalSupervisorState = "running" | "stopped" | "paused";
export type RootTurn = {
  state: "active" | "idle" | "unknown";
  runId: string;
  paneId: string;
  workspaceId: string;
  updatedAt: string;
};
export type ParentGoalSupervisor = {
  version: 1;
  state: ParentGoalSupervisorState;
  intervalSeconds: number;
  nudgeCount: number;
  nextNudgeAt: string | null;
  createdAt: string;
  updatedAt: string;
  pauseReason?: string;
  lastNudgeAt?: string;
  lastAttemptAt?: string;
  lastDelivery?: {
    status: "sending" | "delivered" | "pending" | "uncertain";
    attemptedAt: string;
    deliveredAt?: string;
    acknowledgedAt?: string;
    reason?: string;
  };
  // Only the root Pi lifecycle writer may authorize idle; Herdr snapshots are telemetry.
  rootTurn?: RootTurn;
  rootActivity?: {
    status: "idle" | "working" | "blocked" | "done" | "unknown";
    observedAt: string;
  };
};
export type ParentGoal = {
  version: 1;
  id: string;
  objective: string;
  status: ParentGoalStatus;
  nextAction: string;
  signals: ParentGoalSignal[];
  supervisor?: ParentGoalSupervisor;
  createdAt: string;
  updatedAt: string;
};
export type ParentGoalRecord = ParentGoal;

export type Workflow = {
  taskBinding?: {
    workspaceId: string;
    rootPaneId: string;
    rootSessionPath: string;
  };
  launchProfile?: LaunchProfile;
  launchProfileVersion?: LaunchProfileVersion;
  goalSchemaVersion: 1;
  rootGoalId: string;
  goals: GoalRecord[];
  id: string;
  objective: string;
  outcome:
    | "planned"
    | "running"
    | "completed"
    | "closed"
    | "operator-closed"
    | "unknown";
  status: string;
  lanes: Lane[];
  herdr: {
    workspaceId?: string;
    tabId?: string;
    paneId?: string;
    testPaneId?: string;
    agentName?: string;
  };
  agent: { sessionPath?: string; sessionId?: string };
  // Retained only for compatibility with manifests written before agentKind.
  pi?: { sessionPath?: string; sessionId?: string };
  agentKind: AgentKind;
  cwd: string;
  worktree: string | null;
  worktreeBinding?: WorktreeBinding;
  evidence: LedgerEventRecord[];
  ownership: {
    createdBy: "herdr-orchestrator";
    workspaceId?: string;
    // The workflow that originally created this durable workspace. Later
    // same-cwd workflows use new tabs/panes in it rather than creating a
    // workspace per trivial lane.
    workspaceOwnerWorkflowId?: string;
    tabIds?: string[];
    paneIds: string[];
  };
  retry?: RetryState;
  authorizationPolicy?: AuthorizationPolicy;
  approvalRequests?: ApprovalRequest[];
  questionRequests?: ParentQuestionRequest[];
  eventControllerRegistration?: EventControllerRegistration;
  createdAt: string;
  updatedAt: string;
  dispatchedAt?: string;
  observedAt?: string;
  closeRequestedAt?: string;
  closedAt?: string;
  operatorClosedAt?: string;
  /** Explicit reconciliation when a lane could not persist its own receipt. */
  operatorClosure?: OperatorClosure;
};

export type Manifest = {
  version: 2;
  workflows: Workflow[];
  parentGoal?: ParentGoal;
  questionRequests?: ParentQuestionRequest[];
};
export type ExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  killed?: boolean;
};
