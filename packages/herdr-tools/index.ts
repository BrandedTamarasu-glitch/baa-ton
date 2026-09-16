import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { setTimeout as lockRetryDelay } from "node:timers/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { blocksUnmanagedAgentCommand } from "./command-policy.js";
import {
  AUTHORIZATION_CAPABILITIES,
  SUPPORTED_AGENT_KINDS,
  toPersistenceHandle,
  type AgentKind,
  type ApprovalRequest,
  type AuthorizationCapability,
  type AuthorizationDecision,
  type AuthorizationPolicy,
  type AutonomousOperation,
  type ControllerConfig,
  type ControllerLaneMapping,
  type ControllerOrchestrator,
  type ControllerRootMapping,
  type ControllerWorkflowMapping,
  type EventControllerRegistration,
  type ExecResult,
  type GoalOutcome,
  type GoalRecord,
  type GoalStatus,
  type GoalResumeReceipt,
  type Lane,
  type LaneInput,
  type Manifest,
  type NativeSessionRef,
  type ParentGoal,
  type ParentGoalStatus,
  type ParentQuestionRequest,
  type RootTurn,
  type WorktreeBinding,
  type Workflow,
} from "./contract.js";

export type {
  GoalOwnership,
  OperatorClosure,
} from "./contract.js";
import { dispatchTask } from "./dispatch-task.js";
import {
  LAUNCH_PROFILE_SCHEMA_VERSION,
  type LaunchProfile,
  type LaunchProfileVersion,
  validateLaunchProfile,
} from "./launch-profile.js";
import { piLaunchAdapter, verifyActualProfile } from "./pi-launch-adapter.js";
import { claudeLaunchAdapter } from "./claude-launch-adapter.js";
import { codexLaunchAdapter } from "./codex-launch-adapter.js";
import { opencodeLaunchAdapter } from "./opencode-launch-adapter.js";
import {
  HarnessAdapterRegistry,
  STARTUP_PROOF_REQUIRED_OPERATIONS,
} from "./harness-adapter.js";
import { fileURLToPath } from "node:url";
import { acknowledgeActivation } from "./activation-ack.mjs";

const MANIFEST_DIR = ".pi/herdr-orchestrator";
const MANIFEST_NAME = "manifest.json";
const OWNER = "herdr-orchestrator";
const BB029_AUTHORIZATION_SCOPE = "BB-029";
const HERDR_COMMAND_TIMEOUT_MS = 35_000;
const RECENT_AGENT_OUTPUT_LINES = 120;
const GOAL_PAUSE_OUTPUT_LIMIT = 6000;
const HERDR_PANE_ID_ENV = "HERDR_PANE_ID";
const HERDR_PLUGIN_CONFIG_DIR_ENV = "HERDR_PLUGIN_CONFIG_DIR";
const CONTROLLER_PLUGIN_ID = "herdr-orchestrator-controller";
const CONTROLLER_CONFIG_NAME = "config.json";
const SCOPED_GOALS_SCHEMA_VERSION = 1 as const;
const now = () => new Date().toISOString();
const manifestPath = (cwd: string) => join(cwd, MANIFEST_DIR, MANIFEST_NAME);
const jsonText = (value: unknown) => JSON.stringify(value, null, 2);
const clip = (text: string, limit = 6000) =>
  text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;

async function rootBootstrapPrompt(cwd: string): Promise<string> {
  if (!isRootOrchestrator()) return "";
  const manifest = await loadManifest(cwd);
  const goal = manifest.parentGoal;
  const rootGoal = goal
    ? `${goal.status}: ${clip(goal.objective, 4000)} Next: ${clip(goal.nextAction, 1000)}`
    : "No registered parent goal.";
  const active = manifest.workflows
    .filter((workflow) => workflow.status !== "closed")
    .map((workflow) => ({
      id: workflow.id,
      status: workflow.status,
      lanes: workflow.lanes.length,
    }));
  return `\n\nHerdr parent-root bootstrap: you are the sole parent executor. Registered parent goal: ${rootGoal}. Herdr's durable manifest at ${manifestPath(cwd)} is authoritative; current workflows: ${jsonText(active)}. You may use herdr_plan, herdr_dispatch, herdr_observe, herdr_resume, and herdr_close only through their documented parent/root paths. Treat controller-delivered lane lifecycle, parent-question-required, parent-approval-required, and blocker records as durable work signals: read the record and continue through safe local actions under existing authorization. Persist a truthful state when waiting for an external event, blocked, paused, or complete; do not stop merely because one tool or parent action finished. Never ask the user to operate a child pane or Pi goal UI; children persist requests and Herdr wakes you. Do not poll or create detached agents. Do not push, merge, create PRs, deploy, mutate production, or close resources without explicit user approval.`;
}

function pausedGoalIds(output: string): string[] {
  const goalIds = new Set<string>();
  for (const line of clip(output, GOAL_PAUSE_OUTPUT_LIMIT).split(/\r?\n/)) {
    if (!/\bpaus(?:e|ed|ing)\b/i.test(line)) continue;
    for (const match of line.matchAll(/\bpi-goal-[a-z0-9][a-z0-9_-]*\b/gi))
      goalIds.add(match[0].toLowerCase());
  }
  return [...goalIds].sort((left, right) => left.localeCompare(right));
}

function goalStatus(value: unknown, fallback: GoalStatus): GoalStatus {
  return typeof value === "string" &&
    ["planned", "ready", "running", "blocked", "completed", "paused"].includes(
      value,
    )
    ? (value as GoalStatus)
    : fallback;
}

function goalOutcome(value: unknown, fallback: GoalOutcome): GoalOutcome {
  return typeof value === "string" &&
    ["unresolved", "success", "failure", "cancelled"].includes(value)
    ? (value as GoalOutcome)
    : fallback;
}

function normalizeWorkflowGoals(workflow: Workflow): Workflow {
  if (!Array.isArray(workflow.lanes)) return workflow;
  const rootGoalId =
    typeof workflow.rootGoalId === "string" && workflow.rootGoalId
      ? workflow.rootGoalId
      : `goal-${workflow.id}`;
  const existing = Array.isArray(workflow.goals) ? workflow.goals : [];
  const byId = new Map(
    existing
      .filter(
        (goal): goal is GoalRecord =>
          isRecord(goal) && typeof goal.id === "string",
      )
      .map((goal) => [goal.id, goal]),
  );
  const timestamp =
    typeof workflow.updatedAt === "string" && workflow.updatedAt
      ? workflow.updatedAt
      : now();
  const rootExisting = byId.get(rootGoalId);
  const root: GoalRecord = {
    version: 1,
    id: rootGoalId,
    revision:
      typeof rootExisting?.revision === "number" &&
      Number.isSafeInteger(rootExisting.revision) &&
      rootExisting.revision > 0
        ? rootExisting.revision
        : 1,
    dependencies: Array.isArray(rootExisting?.dependencies)
      ? rootExisting.dependencies.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    objective: workflow.objective,
    status: goalStatus(rootExisting?.status, "planned"),
    outcome: goalOutcome(rootExisting?.outcome, "unresolved"),
    ownership: {
      scope: "workflow",
      workflowId: workflow.id,
      authority: "authorized-root",
    },
    updatedAt: rootExisting?.updatedAt ?? timestamp,
  };
  const laneGoals: GoalRecord[] = [];
  for (const lane of workflow.lanes) {
    if (lane.nativeSession && !lane.persistenceHandle) {
      lane.persistenceHandle = toPersistenceHandle(
        lane.nativeSession,
        lane.launchProfile?.provider ??
          workflow.launchProfile?.provider ??
          lane.agentKind ??
          workflow.agentKind ??
          "herdr",
      );
    }
    const goalId =
      typeof lane.goalId === "string" && lane.goalId
        ? lane.goalId
        : `${rootGoalId}/${lane.id}`;
    const existingGoal = byId.get(goalId);
    const explicitSuccess = Boolean(lane.completionReceipt);
    const revision =
      typeof existingGoal?.revision === "number" &&
      Number.isSafeInteger(existingGoal.revision) &&
      existingGoal.revision > 0
        ? existingGoal.revision
        : Number.isSafeInteger(lane.goalRevision) && lane.goalRevision! > 0
          ? lane.goalRevision!
          : 1;
    const dependencies = Array.isArray(lane.dependencies)
      ? lane.dependencies.filter(
          (item): item is string => typeof item === "string",
        )
      : Array.isArray(existingGoal?.dependencies)
        ? existingGoal.dependencies.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
    const goal: GoalRecord = {
      version: 1,
      id: goalId,
      revision,
      parentId: rootGoalId,
      dependencies,
      objective: lane.objective,
      status: explicitSuccess
        ? "completed"
        : goalStatus(existingGoal?.status, "planned"),
      outcome: explicitSuccess
        ? "success"
        : goalOutcome(existingGoal?.outcome, "unresolved"),
      ownership: {
        scope: "lane",
        workflowId: workflow.id,
        laneId: lane.id,
        authority: "lane",
      },
      updatedAt: existingGoal?.updatedAt ?? timestamp,
    };
    lane.goalId = goal.id;
    lane.goalRevision = goal.revision;
    lane.dependencies = goal.dependencies;
    lane.goalOwnership = goal.ownership;
    if (lane.launchProfile && lane.launchProfileVersion === undefined)
      lane.launchProfileVersion = LAUNCH_PROFILE_SCHEMA_VERSION;
    laneGoals.push(goal);
  }
  workflow.goalSchemaVersion = SCOPED_GOALS_SCHEMA_VERSION;
  workflow.rootGoalId = rootGoalId;
  workflow.goals = [root, ...laneGoals];
  if (workflow.launchProfile && workflow.launchProfileVersion === undefined)
    workflow.launchProfileVersion = LAUNCH_PROFILE_SCHEMA_VERSION;
  return workflow;
}

async function loadManifest(cwd: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(cwd), "utf8")) as {
      version?: unknown;
      workflows?: unknown;
      parentGoal?: ParentGoal;
      questionRequests?: ParentQuestionRequest[];
    };
    if (
      (parsed.version === 1 || parsed.version === 2) &&
      Array.isArray(parsed.workflows)
    )
      return {
        version: 2,
        workflows: (parsed.workflows as Workflow[]).map((workflow) =>
          normalizeWorkflowGoals(workflow),
        ),
        parentGoal: parsed.parentGoal,
        questionRequests: parsed.questionRequests,
      };
    return { version: 2, workflows: [] };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 2, workflows: [] };
    throw new Error(`Cannot read Herdr manifest: ${(error as Error).message}`);
  }
}

async function saveManifest(cwd: string, manifest: Manifest): Promise<void> {
  const path = manifestPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${jsonText(manifest)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function acquireManifestLock(
  cwd: string,
  waitMs = 0,
): Promise<() => Promise<void>> {
  const path = manifestPath(cwd);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = join(
    dirname(path),
    `.${MANIFEST_NAME}.herdr-orchestrator.lock`,
  );
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(
        join(lockPath, "owner.json"),
        `${jsonText({ pid: process.pid, createdAt: now() })}\n`,
        { mode: 0o600 },
      );
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (Date.now() < deadline) {
          // Bounded contention on the shared filesystem lock, never agent polling.
          await lockRetryDelay(10);
          continue;
        }
        throw new Error(
          `Herdr manifest is busy: ${path}. Wait for the active controller operation, then retry.`,
        );
      }
      throw error;
    }
  }
}

// The single transactional state owner for the manifest: every writer that
// needs to mutate durable state after any await (a terminal/network call,
// user confirmation, etc.) must reconcile against a freshly reloaded copy
// under this same lock rather than blindly overwriting whatever it read
// before that await. Never hold this across a terminal/network call; gather
// external results first, then pass only the resulting mutation in.
async function withManifestTransaction<T>(
  cwd: string,
  mutate: (manifest: Manifest) => T,
  waitMs = 10_000,
): Promise<T> {
  const release = await acquireManifestLock(cwd, waitMs);
  try {
    const manifest = await loadManifest(cwd);
    const result = mutate(manifest);
    await saveManifest(cwd, manifest);
    return result;
  } finally {
    await release();
  }
}

const PARENT_GOAL_STATUSES = new Set<ParentGoalStatus>([
  "active",
  "waiting-for-event",
  "action-required",
  "review-requested",
  "blocked",
  "completed",
  "paused",
]);
const MIN_PARENT_GOAL_NUDGE_INTERVAL_SECONDS = 5;

// A lane is terminal for operator-closure stamping when its own work is
// reconciled: a receipt, an operator closure, a reported completion, or a
// recorded completion outcome.
const TERMINAL_LANE_STATUSES = new Set([
  "operator-closed",
  "completion-reported",
  "completed",
]);
const MAX_PARENT_GOAL_NUDGE_INTERVAL_SECONDS = 86_400;

function parentGoalNudgeInterval(value: number | undefined): number {
  const interval = value ?? MIN_PARENT_GOAL_NUDGE_INTERVAL_SECONDS;
  if (
    !Number.isSafeInteger(interval) ||
    interval < MIN_PARENT_GOAL_NUDGE_INTERVAL_SECONDS ||
    interval > MAX_PARENT_GOAL_NUDGE_INTERVAL_SECONDS
  )
    throw new Error(
      `nudgeIntervalSeconds must be an integer from ${MIN_PARENT_GOAL_NUDGE_INTERVAL_SECONDS} to ${MAX_PARENT_GOAL_NUDGE_INTERVAL_SECONDS}.`,
    );
  return interval;
}

function requireRootGoalExecutor(): void {
  requireHerdr();
  if (!isRootOrchestrator())
    throw new Error(
      "Only the verified controller-mapped root may create or update the parent goal.",
    );
}

function requireRootOperator(): void {
  requireHerdr();
  if (!isRootOrchestrator())
    throw new Error(
      "Only the verified controller-mapped root may record an operator closure.",
    );
}

async function parentGoal(
  cwd: string,
  action: "initialize" | "set-state" | "status" | "start" | "stop" | "pause",
  objective?: string,
  status?: string,
  nextAction?: string,
  nudgeIntervalSeconds?: number,
  pauseReason?: string,
  rootTurn?: RootTurn,
): Promise<ParentGoal> {
  requireRootGoalExecutor();
  const release = await acquireManifestLock(cwd);
  try {
    const manifest = await loadManifest(cwd);
    if (action === "status") {
      if (!manifest.parentGoal)
        throw new Error("No parent goal is registered.");
      return manifest.parentGoal;
    }
    if (action === "initialize") {
      if (manifest.parentGoal)
        throw new Error("A parent goal is already registered; use set-state.");
      if (!objective?.trim())
        throw new Error("objective is required to initialize a parent goal.");
      const timestamp = now();
      manifest.parentGoal = {
        version: 1,
        id: `parent-goal-${randomUUID().slice(0, 12)}`,
        objective: objective.trim(),
        status: "active",
        nextAction:
          nextAction?.trim() ||
          "Choose one dependency-ready Herdr action or wait for a durable event.",
        signals: [],
        supervisor: {
          version: 1,
          state: "stopped",
          intervalSeconds: parentGoalNudgeInterval(nudgeIntervalSeconds),
          nudgeCount: 0,
          nextNudgeAt: null,
          rootActivity: { status: "unknown", observedAt: timestamp },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    } else {
      const goal = manifest.parentGoal;
      if (!goal)
        throw new Error("No parent goal is registered; initialize one first.");
      const timestamp = now();
      const supervisor = () =>
        (goal.supervisor ??= {
          version: 1,
          state: "stopped",
          intervalSeconds: parentGoalNudgeInterval(undefined),
          nudgeCount: 0,
          nextNudgeAt: null,
          rootActivity: { status: "unknown", observedAt: timestamp },
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      const previousWork = JSON.stringify([
        goal.status,
        goal.objective,
        goal.nextAction,
      ]);
      const previousSupervisorState = goal.supervisor?.state;
      if (action === "set-state") {
        if (!status || !PARENT_GOAL_STATUSES.has(status as ParentGoalStatus))
          throw new Error(
            `status must be one of: ${[...PARENT_GOAL_STATUSES].join(", ")}.`,
          );
        if (status === "paused")
          throw new Error("Use action=pause with a non-empty pauseReason.");
        goal.status = status as ParentGoalStatus;
        if (objective?.trim()) goal.objective = objective.trim();
        if (nextAction?.trim()) goal.nextAction = nextAction.trim();
        if (status === "completed" || status === "blocked") {
          const control = supervisor();
          control.state = "stopped";
          control.nextNudgeAt = null;
          control.updatedAt = timestamp;
        }
      } else if (action === "start") {
        if (goal.status === "completed" || goal.status === "blocked")
          throw new Error(
            "A completed or blocked parent goal cannot be started.",
          );
        const control = supervisor();
        control.state = "running";
        control.intervalSeconds = parentGoalNudgeInterval(
          nudgeIntervalSeconds ?? control.intervalSeconds,
        );
        // Repeating start on a running supervisor is not a new wake authorization.
        if (previousSupervisorState !== "running") {
          control.nextNudgeAt = new Date(
            Date.parse(timestamp) + control.intervalSeconds * 1000,
          ).toISOString();
          delete control.lastDelivery;
        }
        delete control.pauseReason;
        control.updatedAt = timestamp;
        if (goal.status === "paused") goal.status = "active";
        if (nextAction?.trim()) goal.nextAction = nextAction.trim();
      } else if (action === "stop") {
        const control = supervisor();
        control.state = "stopped";
        control.nextNudgeAt = null;
        control.updatedAt = timestamp;
      } else if (action === "pause") {
        if (!pauseReason?.trim())
          throw new Error("pauseReason is required when action=pause.");
        const control = supervisor();
        control.state = "paused";
        control.pauseReason = pauseReason.trim();
        control.nextNudgeAt = null;
        control.updatedAt = timestamp;
        goal.status = "paused";
      }
      const control = goal.supervisor;
      if (
        control &&
        previousWork !==
          JSON.stringify([goal.status, goal.objective, goal.nextAction])
      ) {
        // An explicit material work transition can re-arm a delivered wake, but
        // never silently retry an ambiguous send. Stop/start is the review path.
        if (
          control.lastDelivery?.status !== "sending" &&
          control.lastDelivery?.status !== "uncertain"
        ) {
          delete control.lastDelivery;
          control.nextNudgeAt =
            goal.status === "active" && control.state === "running"
              ? new Date(
                  Date.parse(timestamp) + control.intervalSeconds * 1000,
                ).toISOString()
              : null;
        }
        control.updatedAt = timestamp;
      }
      goal.updatedAt = timestamp;
    }
    if (rootTurn && manifest.parentGoal?.supervisor)
      manifest.parentGoal.supervisor.rootTurn = rootTurn;
    await saveManifest(cwd, manifest);
    return manifest.parentGoal!;
  } finally {
    await release();
  }
}

async function plannedCwd(
  callerCwd: string,
  worktreeCwd?: string,
): Promise<{ cwd: string; worktree: string | null }> {
  if (!worktreeCwd) return { cwd: resolve(callerCwd), worktree: null };
  if (!isAbsolute(worktreeCwd))
    throw new Error("worktreeCwd must be an absolute existing directory.");
  let details: Awaited<ReturnType<typeof stat>>;
  try {
    details = await stat(worktreeCwd);
  } catch {
    throw new Error(`worktreeCwd does not exist: ${worktreeCwd}`);
  }
  if (!details.isDirectory())
    throw new Error(`worktreeCwd is not a directory: ${worktreeCwd}`);
  // Canonicalize only an existing checkout; never create or modify a Git worktree.
  const cwd = await realpath(worktreeCwd);
  return { cwd, worktree: cwd };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function validateAgentKind(value: unknown, label = "agentKind"): AgentKind {
  if (
    typeof value === "string" &&
    SUPPORTED_AGENT_KINDS.includes(value as AgentKind)
  )
    return value as AgentKind;
  throw new Error(
    `${label} must be one of ${SUPPORTED_AGENT_KINDS.join(", ")}.`,
  );
}

function laneAgentKind(workflow: Workflow, lane: Lane): AgentKind {
  // Manifests written before agentKind are Pi workflows by definition.
  return validateAgentKind(lane.agentKind ?? workflow.agentKind ?? "pi");
}

function normalizedLanes(
  objective: string,
  inputs: LaneInput[],
  defaultAgentKind: AgentKind,
  workflowId: string,
  rootGoalId: string,
): Lane[] {
  const values = inputs.length ? inputs : [objective];
  return values.map((input, index) => {
    const laneId = `lane-${index + 1}`;
    const goalId = `${rootGoalId}/${laneId}`;
    if (typeof input === "string")
      return {
        id: laneId,
        objective: input,
        readOnly: false,
        agentKind: defaultAgentKind,
        status: "planned",
        goalId,
        goalRevision: 1,
        dependencies: [],
        goalOwnership: {
          scope: "lane" as const,
          workflowId,
          laneId,
          authority: "lane" as const,
        },
      };
    if (!input || typeof input.objective !== "string" || !input.objective)
      throw new Error("Each lane object needs a non-empty objective.");
    const launchProfile =
      input.launchProfile === undefined
        ? undefined
        : validateLaunchProfile(
            input.launchProfile,
            `Lane ${laneId} launchProfile`,
          );
    return {
      id: laneId,
      objective: input.objective,
      readOnly: input.readOnly === true,
      agentKind: validateAgentKind(input.agentKind ?? defaultAgentKind),
      status: "planned",
      goalId,
      goalRevision: 1,
      dependencies: Array.isArray(input.dependencies ?? input.dependsOn)
        ? [...(input.dependencies ?? input.dependsOn)!]
        : [],
      goalOwnership: {
        scope: "lane" as const,
        workflowId,
        laneId,
        authority: "lane" as const,
      },
      ...(launchProfile
        ? {
            launchProfile,
            launchProfileVersion: LAUNCH_PROFILE_SCHEMA_VERSION,
          }
        : {}),
    };
  });
}

function createWorkflowGoals(
  workflowId: string,
  objective: string,
  lanes: Lane[],
): { rootGoalId: string; goals: GoalRecord[] } {
  const rootGoalId = `goal-${workflowId}`;
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const laneGoalIds = new Map(lanes.map((lane) => [lane.id, lane.goalId!]));
  const root: GoalRecord = {
    version: 1,
    id: rootGoalId,
    revision: 1,
    dependencies: [],
    objective,
    status: "planned",
    outcome: "unresolved",
    ownership: {
      scope: "workflow",
      workflowId,
      authority: "authorized-root",
    },
    updatedAt: now(),
  };
  const laneGoals = lanes.map((lane) => {
    const requested = lane.dependencies ?? [];
    for (const dependency of requested)
      if (!laneIds.has(dependency))
        throw new Error(
          `Lane ${lane.id} dependency must reference another lane ID: ${dependency}.`,
        );
    if (requested.includes(lane.id))
      throw new Error(`Lane ${lane.id} cannot depend on itself.`);
    const dependencies = requested.map(
      (dependency) => laneGoalIds.get(dependency)!,
    );
    lane.dependencies = dependencies;
    const goal: GoalRecord = {
      version: 1,
      id: lane.goalId!,
      revision: 1,
      parentId: rootGoalId,
      dependencies,
      objective: lane.objective,
      status: "planned",
      outcome: "unresolved",
      ownership: lane.goalOwnership!,
      updatedAt: now(),
    };
    return goal;
  });
  return { rootGoalId, goals: [root, ...laneGoals] };
}

function laneGoal(workflow: Workflow, lane: Lane): GoalRecord {
  const goal = workflow.goals.find((item) => item.id === lane.goalId);
  if (
    !goal ||
    goal.ownership.scope !== "lane" ||
    goal.ownership.laneId !== lane.id
  )
    throw new Error(`Lane ${lane.id} has no scoped goal owned by that lane.`);
  return goal;
}

function updateLaneGoal(
  workflow: Workflow,
  lane: Lane,
  status: GoalStatus,
  outcome: GoalOutcome,
): void {
  const goal = laneGoal(workflow, lane);
  if (goal.status === status && goal.outcome === outcome) return;
  goal.revision += 1;
  goal.status = status;
  goal.outcome = outcome;
  goal.updatedAt = now();
  lane.goalRevision = goal.revision;
}

function workflowHasExplicitSuccess(workflow: Workflow): boolean {
  return (
    workflow.lanes.length > 0 &&
    workflow.lanes.every((lane) => {
      const goal = laneGoal(workflow, lane);
      return goal.outcome === "success";
    })
  );
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys.slice().sort()[index])
  );
}

function controllerString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function controllerObject(
  value: unknown,
  label: string,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed.`);
  for (const key of required)
    if (!(key in value)) throw new Error(`${label}.${key} is required.`);
  return value;
}

function validateControllerTarget(
  value: Record<string, unknown>,
  label: string,
  paneId: string,
): Pick<ControllerRootMapping, "target" | "target_kind"> {
  const target = controllerString(value.target, `${label}.target`);
  const targetKind = controllerString(
    value.target_kind,
    `${label}.target_kind`,
  );
  if (targetKind !== "name" && targetKind !== "pane_id")
    throw new Error(`${label}.target_kind must be name or pane_id.`);
  if (targetKind === "pane_id" && target !== paneId)
    throw new Error(`${label}.target must equal ${label}.pane_id.`);
  return { target, target_kind: targetKind };
}

function validateControllerRoot(input: unknown): ControllerRootMapping {
  const value = controllerObject(
    input,
    "controller config.root",
    ["target", "target_kind", "pane_id", "workspace_id"],
    ["agent_kind"],
  );
  const paneId = controllerString(
    value.pane_id,
    "controller config.root.pane_id",
  );
  const root: ControllerRootMapping = {
    ...validateControllerTarget(value, "controller config.root", paneId),
    pane_id: paneId,
    workspace_id: controllerString(
      value.workspace_id,
      "controller config.root.workspace_id",
    ),
  };
  if ("agent_kind" in value)
    root.agent_kind = controllerString(
      value.agent_kind,
      "controller config.root.agent_kind",
    );
  return root;
}

function validateControllerLane(
  input: unknown,
  label: string,
): ControllerLaneMapping {
  const value = controllerObject(
    input,
    label,
    ["lane_id", "target", "target_kind", "pane_id", "workspace_id"],
    ["relationship_id"],
  );
  const paneId = controllerString(value.pane_id, `${label}.pane_id`);
  return {
    lane_id: controllerString(value.lane_id, `${label}.lane_id`),
    ...validateControllerTarget(value, label, paneId),
    pane_id: paneId,
    workspace_id: controllerString(value.workspace_id, `${label}.workspace_id`),
    ...(typeof value.relationship_id === "string"
      ? {
          relationship_id: controllerString(
            value.relationship_id,
            `${label}.relationship_id`,
          ),
        }
      : {}),
  };
}

function validateControllerWorkflow(
  input: unknown,
  label: string,
): ControllerWorkflowMapping {
  const value = controllerObject(
    input,
    label,
    ["workflow_id", "manifest_path", "lanes"],
    ["pi_goal_pause_detection"],
  );
  const manifest = controllerString(
    value.manifest_path,
    `${label}.manifest_path`,
  );
  if (!isAbsolute(manifest))
    throw new Error(`${label}.manifest_path must be absolute.`);
  if (!Array.isArray(value.lanes) || value.lanes.length === 0)
    throw new Error(`${label}.lanes must be a non-empty array.`);
  if (
    "pi_goal_pause_detection" in value &&
    typeof value.pi_goal_pause_detection !== "boolean"
  )
    throw new Error(`${label}.pi_goal_pause_detection must be a boolean.`);
  const lanes = value.lanes.map((lane, index) =>
    validateControllerLane(lane, `${label}.lanes[${index}]`),
  );
  if (new Set(lanes.map((lane) => lane.lane_id)).size !== lanes.length)
    throw new Error(`${label}.lanes cannot repeat lane_id values.`);
  if (new Set(lanes.map((lane) => lane.pane_id)).size !== lanes.length)
    throw new Error(`${label}.lanes cannot repeat pane_id values.`);
  if (
    new Set(lanes.map((lane) => `${lane.target_kind}:${lane.target}`)).size !==
    lanes.length
  )
    throw new Error(`${label}.lanes cannot repeat targets.`);
  return {
    workflow_id: controllerString(value.workflow_id, `${label}.workflow_id`),
    manifest_path: resolve(manifest),
    ...(typeof value.pi_goal_pause_detection === "boolean"
      ? { pi_goal_pause_detection: value.pi_goal_pause_detection }
      : {}),
    lanes,
  };
}

function validateControllerConfig(input: unknown): ControllerConfig {
  if (!isRecord(input) || input.owner !== OWNER)
    throw new Error(`controller config.owner must be ${OWNER}.`);
  // Read v1 as one isolated legacy record. The next registration writes v2.
  if (input.version === 1) {
    const legacy = controllerObject(input, "controller config", [
      "version",
      "owner",
      "root",
      "workflows",
    ]);
    const root = validateControllerRoot(legacy.root);
    if (!Array.isArray(legacy.workflows) || legacy.workflows.length === 0)
      throw new Error("controller config.workflows must be a non-empty array.");
    return {
      version: 2,
      owner: OWNER,
      orchestrators: [
        {
          id: `legacy:${root.workspace_id}:${root.pane_id}`,
          root,
          program: { id: "legacy-global", workspace_id: root.workspace_id },
          workflows: legacy.workflows.map((item, index) =>
            validateControllerWorkflow(
              item,
              `controller config.workflows[${index}]`,
            ),
          ),
        },
      ],
    };
  }
  const value = controllerObject(input, "controller config", [
    "version",
    "owner",
    "orchestrators",
  ]);
  if (value.version !== 2)
    throw new Error("controller config.version must be 1 or 2.");
  if (!Array.isArray(value.orchestrators) || value.orchestrators.length === 0)
    throw new Error(
      "controller config.orchestrators must be a non-empty array.",
    );
  const orchestrators = value.orchestrators.map((item, index) => {
    const record = controllerObject(
      item,
      `controller config.orchestrators[${index}]`,
      ["id", "root", "program", "workflows"],
    );
    const root = validateControllerRoot(record.root);
    const program = controllerObject(
      record.program,
      `controller config.orchestrators[${index}].program`,
      ["id", "workspace_id"],
      ["parent_manifest_path"],
    );
    if (!Array.isArray(record.workflows))
      throw new Error("controller orchestrator.workflows must be an array.");
    const programId = controllerString(program.id, "controller program.id");
    const workspaceId = controllerString(
      program.workspace_id,
      "controller program.workspace_id",
    );
    if (workspaceId !== root.workspace_id)
      throw new Error(
        "controller program workspace must match root workspace.",
      );
    const parentManifestPath =
      "parent_manifest_path" in program
        ? controllerString(
            program.parent_manifest_path,
            "controller program.parent_manifest_path",
          )
        : undefined;
    if (parentManifestPath && !isAbsolute(parentManifestPath))
      throw new Error(
        "controller program.parent_manifest_path must be absolute.",
      );
    return {
      id: controllerString(record.id, "controller orchestrator.id"),
      root,
      program: {
        id: programId,
        workspace_id: workspaceId,
        ...(parentManifestPath
          ? { parent_manifest_path: resolve(parentManifestPath) }
          : {}),
      },
      workflows: record.workflows.map((workflow, workflowIndex) =>
        validateControllerWorkflow(
          workflow,
          `controller config.orchestrators[${index}].workflows[${workflowIndex}]`,
        ),
      ),
    };
  });
  if (
    new Set(orchestrators.map((item) => item.id)).size !== orchestrators.length
  )
    throw new Error("controller config cannot repeat orchestrator IDs.");
  const workflowIds = orchestrators.flatMap((item) =>
    item.workflows.map((workflow) => workflow.workflow_id),
  );
  if (new Set(workflowIds).size !== workflowIds.length)
    throw new Error(
      "controller config cannot repeat workflow IDs across orchestrators.",
    );
  return { version: 2, owner: OWNER, orchestrators };
}

function controllerRecordId(root: ControllerRootMapping, cwd: string): string {
  return `orchestrator:${root.workspace_id}:${root.pane_id}:${resolve(cwd)}`;
}

function findControllerRecord(
  config: ControllerConfig,
  root: ControllerRootMapping,
  cwd: string,
): ControllerOrchestrator | undefined {
  const id = controllerRecordId(root, cwd);
  return config.orchestrators.find((record) => record.id === id);
}

function recordForRegistration(
  config: ControllerConfig,
  registration: EventControllerRegistration,
): ControllerOrchestrator | undefined {
  if (!registration.root || !registration.workflow) return undefined;
  return config.orchestrators.find(
    (record) =>
      sameControllerRoot(record.root, registration.root!) &&
      record.workflows.some((workflow) =>
        sameControllerWorkflow(workflow, registration.workflow!),
      ),
  );
}

function sameControllerRoot(
  left: ControllerRootMapping,
  right: ControllerRootMapping,
): boolean {
  return (
    left.target === right.target &&
    left.target_kind === right.target_kind &&
    left.pane_id === right.pane_id &&
    left.workspace_id === right.workspace_id &&
    left.agent_kind === right.agent_kind
  );
}

function sameControllerWorkflow(
  left: ControllerWorkflowMapping,
  right: ControllerWorkflowMapping,
): boolean {
  return (
    left.workflow_id === right.workflow_id &&
    samePath(left.manifest_path, right.manifest_path) &&
    (left.pi_goal_pause_detection ?? false) ===
      (right.pi_goal_pause_detection ?? false) &&
    left.lanes.length === right.lanes.length &&
    left.lanes.every((lane) => {
      const other = right.lanes.find(
        (candidate) => candidate.lane_id === lane.lane_id,
      );
      return (
        lane.target === other?.target &&
        lane.target_kind === other.target_kind &&
        lane.pane_id === other.pane_id &&
        lane.workspace_id === other.workspace_id
      );
    })
  );
}

async function secureControllerConfigDirectory(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new Error("Herdr controller config directory must be absolute.");
  const directory = resolve(path);
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    details = await lstat(directory);
  }
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error(
      "Herdr controller config directory must be a real directory.",
    );
  const identity = { dev: details.dev, ino: details.ino };
  await chmod(directory, 0o700);
  details = await lstat(directory);
  if (
    !details.isDirectory() ||
    details.isSymbolicLink() ||
    details.dev !== identity.dev ||
    details.ino !== identity.ino ||
    (details.mode & 0o077) !== 0
  )
    throw new Error(
      "Herdr controller config directory could not be securely repaired to private mode (0700).",
    );
  return directory;
}

async function loadControllerConfig(
  path: string,
): Promise<ControllerConfig | undefined> {
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error("Herdr controller config must be a regular file.");
  if ((details.mode & 0o022) !== 0)
    throw new Error(
      "Herdr controller config must not be group- or world-writable.",
    );
  try {
    return validateControllerConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(
      `Herdr controller config is invalid: ${(error as Error).message}`,
    );
  }
}

async function saveControllerConfig(
  configPath: string,
  config: ControllerConfig,
): Promise<void> {
  const temporary = join(
    dirname(configPath),
    `.${CONTROLLER_CONFIG_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${jsonText(config)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, configPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeControllerConfig(configPath: string): Promise<void> {
  const temporary = join(
    dirname(configPath),
    `.${CONTROLLER_CONFIG_NAME}.removed.${process.pid}.${randomUUID()}.tmp`,
  );
  await rename(configPath, temporary);
  await rm(temporary, { force: true });
}

function validateAuthorizationPolicy(input: unknown): AuthorizationPolicy {
  if (
    !isRecord(input) ||
    !exactKeys(input, ["version", "scope", "capabilities"])
  )
    throw new Error(
      "authorizationPolicy must contain only version, scope, and capabilities.",
    );
  if (input.version !== 1)
    throw new Error("authorizationPolicy.version must be 1.");
  if (
    !isRecord(input.scope) ||
    !exactKeys(input.scope, ["workflow", "localOnly"])
  )
    throw new Error(
      "authorizationPolicy.scope must contain only workflow and localOnly.",
    );
  if (
    input.scope.workflow !== BB029_AUTHORIZATION_SCOPE ||
    input.scope.localOnly !== true
  )
    throw new Error(
      `authorizationPolicy is restricted to ${BB029_AUTHORIZATION_SCOPE} local-only work.`,
    );
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0)
    throw new Error(
      "authorizationPolicy.capabilities must be a non-empty array.",
    );
  const capabilities = input.capabilities.map((capability) => {
    if (
      typeof capability !== "string" ||
      !AUTHORIZATION_CAPABILITIES.includes(
        capability as AuthorizationCapability,
      )
    )
      throw new Error(
        `authorizationPolicy cannot authorize ${String(capability)}.`,
      );
    return capability as AuthorizationCapability;
  });
  if (new Set(capabilities).size !== capabilities.length)
    throw new Error(
      "authorizationPolicy.capabilities must not contain duplicates.",
    );
  return {
    version: 1,
    scope: { workflow: BB029_AUTHORIZATION_SCOPE, localOnly: true },
    capabilities,
  };
}

function authorizationDecision(
  workflow: Workflow,
  operation: AutonomousOperation,
): AuthorizationDecision {
  if (!workflow.authorizationPolicy)
    return {
      allowed: false,
      operation,
      reason:
        "no authorizationPolicy is recorded; explicit root approval is required",
    };
  let policy: AuthorizationPolicy;
  try {
    policy = validateAuthorizationPolicy(workflow.authorizationPolicy);
  } catch (error) {
    return {
      allowed: false,
      operation,
      reason: `recorded authorizationPolicy is invalid: ${(error as Error).message}`,
    };
  }
  if (
    !new RegExp(`\\b${BB029_AUTHORIZATION_SCOPE}\\b`, "i").test(
      workflow.objective,
    )
  )
    return {
      allowed: false,
      operation,
      reason: `workflow objective is not bound to ${BB029_AUTHORIZATION_SCOPE}`,
      policy,
    };
  const required: Record<AutonomousOperation, AuthorizationCapability[]> = {
    dispatch: ["local-herdr-topology", "foreground-tests", "durable-ledger"],
    retry: [
      "local-herdr-topology",
      "foreground-tests",
      "observe-retry-review",
      "durable-ledger",
    ],
    resume: ["observe-retry-review", "durable-ledger", "paused-goal-recovery"],
  };
  if (workflow.worktree) required[operation].push("clean-local-worktrees");
  const missing = required[operation].filter(
    (capability) => !policy.capabilities.includes(capability),
  );
  return missing.length === 0
    ? {
        allowed: true,
        operation,
        reason: "preauthorized local operation",
        policy,
      }
    : {
        allowed: false,
        operation,
        reason: `authorizationPolicy lacks ${missing.join(", ")}`,
        policy,
      };
}

function auditAuthorization(
  workflow: Workflow,
  decision: AuthorizationDecision,
): void {
  workflow.evidence.push({
    at: now(),
    kind: decision.allowed
      ? "authorization-policy-granted"
      : "authorization-policy-denied",
    text: `Autonomous ${decision.operation}: ${decision.reason}${
      decision.policy
        ? `; scope=${decision.policy.scope.workflow}; capabilities=${decision.policy.capabilities.join(",")}`
        : ""
    }`,
  });
}

function workflowFor(manifest: Manifest, id: string): Workflow {
  const workflow = manifest.workflows.find((item) => item.id === id);
  if (!workflow) throw new Error(`Unknown Herdr workflow: ${id}`);
  return workflow;
}

function parseJson(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Herdr returned non-JSON output: ${clip(stdout, 1000)}`);
  }
}

function deepString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  for (const key of keys)
    if (typeof object[key] === "string" && object[key])
      return object[key] as string;
  for (const child of Object.values(object)) {
    const found = deepString(child, keys);
    if (found) return found;
  }
  return undefined;
}

function deepState(value: unknown): string | undefined {
  return deepString(value, ["agent_status", "state", "agent_state", "status"]);
}

function nativeSessionFromAgent(value: unknown): NativeSessionRef | undefined {
  if (!isRecord(value) || !isRecord(value.agent_session)) return undefined;
  const session = value.agent_session;
  if (
    (session.kind !== "path" && session.kind !== "id") ||
    typeof session.value !== "string" ||
    !session.value
  )
    return undefined;
  return { kind: session.kind, value: session.value };
}

function contract(workflow: Workflow, lane: Lane): string {
  const agentKind = laneAgentKind(workflow, lane);
  return [
    "You are a delegated coding-agent session managed exclusively by Herdr.",
    `Agent kind: ${agentKind}`,
    `Workflow: ${workflow.id}`,
    `Objective: ${lane.objective}`,
    `Lane: ${lane.id}`,
    `Parent-child relationship: ${lane.relationshipId ?? "pending"}`,
    lane.readOnly
      ? "This lane is declared read-only: do not modify files, Git state, or external systems."
      : "Contract: work only in the assigned cwd; report concise progress, commands, tests, evidence, and blockers.",
    "Do not create subagents, background jobs, detached tasks, or another agent session.",
    "Run tests synchronously in this pane, or ask the caller to create an explicit Herdr test pane.",
    "A recorded local authorization policy applies only to the designated root's dispatch, retry, and Pi paused-goal recovery; it grants this child no approval authority.",
    "Never push, merge, deploy, create a PR, mutate production or external services, or close Herdr resources.",
    `Before ending, you MUST call herdr_complete({ workflowId: "${workflow.id}", summary: "<outcome, evidence, blockers>" }) exactly once after verifying the work. A chat-only outcome is insufficient and does not complete this lane.`,
    "Then state the same outcome/evidence clearly. Generic Herdr done events are fallback-only; the durable herdr_complete receipt is required for normal completion.",
  ].join("\n");
}

function requireHerdr(): void {
  if (process.env.HERDR_ENV !== "1")
    throw new Error(
      "HERDR_ENV=1 is required; dispatch and close are unavailable outside a Herdr pane.",
    );
}

type GitMetadataDirectories = {
  gitDirectory: string;
  commonDirectory: string;
};

/** Resolve the directories Git will mutate for a checkout without invoking a
 * mutating Git command. Linked worktrees keep their administrative metadata
 * outside the checkout, which is the path Codex's workspace-write sandbox can
 * leave unwritable. */
async function gitMetadataDirectories(
  cwd: string,
): Promise<GitMetadataDirectories> {
  const dotGit = join(resolve(cwd), ".git");
  const details = await lstat(dotGit);
  if (details.isSymbolicLink())
    throw new Error(
      ".git is a symbolic link; Git metadata ownership is ambiguous.",
    );
  let gitDirectory: string;
  if (details.isDirectory()) gitDirectory = dotGit;
  else if (details.isFile()) {
    const pointer = (await readFile(dotGit, "utf8")).trim();
    const match = /^gitdir:\s*(.+)$/i.exec(pointer);
    if (!match)
      throw new Error(".git is not a valid Git worktree metadata pointer.");
    gitDirectory = resolve(dirname(dotGit), match[1].trim());
  } else throw new Error(".git is not a regular directory or worktree pointer.");

  let commonDirectory = gitDirectory;
  try {
    const common = (await readFile(join(gitDirectory, "commondir"), "utf8"))
      .trim();
    if (common) commonDirectory = resolve(gitDirectory, common);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { gitDirectory, commonDirectory };
}

async function inspectCodexSandboxGitMetadata(
  cwd: string,
): Promise<{ status: "ok" | "warn" | "fail"; detail: string }> {
  let directories: GitMetadataDirectories;
  try {
    directories = await gitMetadataDirectories(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        status: "warn",
        detail: `No Git metadata found under ${resolve(cwd)}; this check is not applicable to a non-Git checkout.`,
      };
    return {
      status: "fail",
      detail: `Cannot resolve Git metadata for ${resolve(cwd)}: ${(error as Error).message}`,
    };
  }
  const paths = [
    ...new Set([directories.gitDirectory, directories.commonDirectory]),
  ];
  const blocked: string[] = [];
  for (const path of paths) {
    try {
      const details = await lstat(path);
      if (!details.isDirectory() || details.isSymbolicLink())
        blocked.push(`${path} (not a real directory)`);
      else await access(path, fsConstants.W_OK);
    } catch {
      blocked.push(path);
    }
  }
  if (blocked.length)
    return {
      status: "fail",
      detail: `Codex sandbox cannot write Git metadata: ${blocked.join(", ")}. A parent-side commit/reconciliation is required.`,
    };
  return {
    status: "ok",
    detail: `Git metadata directories are writable: ${paths.join(", ")}.`,
  };
}

function rootConfigPath(): string {
  const configuredDirectory = process.env[HERDR_PLUGIN_CONFIG_DIR_ENV];
  if (configuredDirectory && isAbsolute(configuredDirectory))
    return join(resolve(configuredDirectory), CONTROLLER_CONFIG_NAME);
  return join(
    homedir(),
    ".config",
    "herdr",
    "plugins",
    "config",
    CONTROLLER_PLUGIN_ID,
    CONTROLLER_CONFIG_NAME,
  );
}

function readControllerConfigForCurrentPane(): ControllerConfig | undefined {
  try {
    const path = rootConfigPath();
    const details = lstatSync(path);
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      (details.mode & 0o022) !== 0
    )
      return undefined;
    return validateControllerConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function isRootOrchestrator(): boolean {
  const paneId = process.env[HERDR_PANE_ID_ENV];
  if (!paneId) return false;
  return (
    readControllerConfigForCurrentPane()?.orchestrators.some(
      (record) => record.root.pane_id === paneId,
    ) ?? false
  );
}

function isRegisteredChildLane(): boolean {
  const paneId = process.env[HERDR_PANE_ID_ENV];
  if (!paneId) return false;
  return (
    readControllerConfigForCurrentPane()?.orchestrators.some((record) =>
      record.workflows.some((workflow) =>
        workflow.lanes.some((lane) => lane.pane_id === paneId),
      ),
    ) ?? false
  );
}

function requestParentApproval(
  workflow: Workflow,
  action: ApprovalRequest["action"],
): ApprovalRequest {
  workflow.approvalRequests ??= [];
  const existing = workflow.approvalRequests.find(
    (request) =>
      request.action === action &&
      request.status === "parent-approval-required",
  );
  if (existing) return existing;
  const request: ApprovalRequest = {
    id: `approval-${randomUUID().slice(0, 8)}`,
    action,
    status: "parent-approval-required",
    requestedAt: now(),
    request:
      `Parent approval required for ${action} of ${workflow.id}. ` +
      "Observe the requesting child through Herdr, then run from the verified controller-mapped root.",
  };
  workflow.approvalRequests.push(request);
  workflow.evidence.push({
    at: now(),
    kind: "parent-approval-required",
    text: request.request,
  });
  return request;
}

function resolveParentApproval(
  workflow: Workflow,
  action: ApprovalRequest["action"],
  status: "approved" | "cancelled",
): void {
  const request = workflow.approvalRequests
    ?.slice()
    .reverse()
    .find(
      (item) =>
        item.action === action && item.status === "parent-approval-required",
    );
  if (!request) return;
  request.status = status;
  request.resolvedAt = now();
}

function currentChildAssignment() {
  const paneId = process.env.HERDR_PANE_ID;
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const matches =
    readControllerConfigForCurrentPane()?.orchestrators.flatMap((record) =>
      record.workflows.flatMap((workflow) =>
        workflow.lanes
          .filter(
            (lane) =>
              lane.pane_id === paneId && lane.workspace_id === workspaceId,
          )
          .map((lane) => ({ record, workflow, lane })),
      ),
    ) ?? [];
  if (matches.length !== 1)
    throw new Error(
      "Child routing requires exactly one registered pane/workspace assignment; no cwd fallback is allowed.",
    );
  const match = matches[0];
  const cwd = dirname(dirname(dirname(match.workflow.manifest_path)));
  if (resolve(manifestPath(cwd)) !== resolve(match.workflow.manifest_path))
    throw new Error(
      "Registered child manifest path does not use the supported store layout.",
    );
  return { ...match, cwd };
}

async function persistParentQuestion(
  cwd: string,
  input: unknown,
): Promise<{ request: ParentQuestionRequest; created: boolean }> {
  const assignment = currentChildAssignment();
  // cwd is a code location, never routing authority.
  cwd = assignment.cwd;
  const release = await acquireManifestLock(cwd, 10_000);
  try {
    const manifest = await loadManifest(cwd);
    const workflow = workflowFor(manifest, assignment.workflow.workflow_id);
    if (
      !workflow.lanes.some(
        (lane) =>
          lane.id === assignment.lane.lane_id &&
          lane.paneId === assignment.lane.pane_id,
      )
    )
      throw new Error(
        "Child assignment differs from the authoritative manifest.",
      );
    const question = clip(jsonText(input), 6000);
    const paneId = assignment.lane.pane_id;
    const requests = (workflow.questionRequests ??= []);
    const existing = requests.find(
      (request) =>
        request.status === "parent-question-required" &&
        request.question === question &&
        request.paneId === paneId,
    );
    if (existing) return { request: existing, created: false };
    const request: ParentQuestionRequest = {
      id: `question-${randomUUID().slice(0, 8)}`,
      kind: "question",
      status: "parent-question-required",
      requestedAt: now(),
      workflowId: workflow.id,
      paneId,
      question,
      delivery: { status: "pending", updatedAt: now() },
    };
    requests.push(request);
    workflow.evidence.push({
      at: now(),
      kind: "parent-question-required",
      text: `Question ${request.id} is durable in the authoritative parent store.`,
    });
    await saveManifest(cwd, manifest);
    return { request, created: true };
  } finally {
    await release();
  }
}

async function confirmExecution(
  ctx: ExtensionContext,
  label: string,
): Promise<boolean> {
  if (!isRootOrchestrator())
    throw new Error(
      "Only the verified controller-mapped root may request direct approval.",
    );
  if (ctx.mode !== "tui" || !ctx.hasUI)
    throw new Error(
      `${label} requires TUI confirmation from the designated root orchestrator.`,
    );
  return ctx.ui.confirm(
    "Herdr orchestrator",
    `${label}? Only extension-owned resources will be changed.`,
  );
}

export default function herdrOrchestrator(pi: ExtensionAPI) {
  async function runHerdrRaw(
    args: string[],
    signal?: AbortSignal,
    timeoutMs = HERDR_COMMAND_TIMEOUT_MS,
  ): Promise<string> {
    const result = (await pi.exec("herdr", args, {
      signal,
      timeout: timeoutMs,
    })) as ExecResult;
    if (result.code !== 0)
      throw new Error(
        `herdr ${args.join(" ")} failed: ${clip(result.stderr || result.stdout, 2000)}`,
      );
    return result.stdout;
  }

  async function runHerdr(
    args: string[],
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<any> {
    return parseJson(await runHerdrRaw(args, signal, timeoutMs));
  }

  async function assertCleanLocalWorktree(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const root = (await pi.exec(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { signal, timeout: HERDR_COMMAND_TIMEOUT_MS },
    )) as ExecResult;
    if (root.code !== 0 || !root.stdout.trim())
      throw new Error(
        `worktreeCwd must be an existing local Git worktree: ${clip(root.stderr || root.stdout, 1000)}`,
      );
    const checkoutPath = resolve(root.stdout.trim());
    if (!samePath(cwd, checkoutPath))
      throw new Error(
        "worktreeCwd must name the Git worktree root, not a subdirectory.",
      );
    const result = (await pi.exec(
      "git",
      ["-C", checkoutPath, "status", "--porcelain", "--untracked-files=all"],
      { signal, timeout: HERDR_COMMAND_TIMEOUT_MS },
    )) as ExecResult;
    if (result.code !== 0)
      throw new Error(
        `worktreeCwd must be an existing local Git worktree: ${clip(result.stderr || result.stdout, 1000)}`,
      );
    if (result.stdout.trim())
      throw new Error("worktreeCwd must be clean before Herdr dispatch.");
    return checkoutPath;
  }

  function responseRecord(
    value: unknown,
    label: string,
  ): Record<string, unknown> {
    const candidate =
      isRecord(value) && isRecord(value.result) ? value.result : value;
    if (!isRecord(candidate))
      throw new Error(
        `Herdr ${label} response did not contain an object result.`,
      );
    return candidate;
  }

  function requiredString(
    value: Record<string, unknown>,
    key: string,
    label: string,
  ): string {
    if (typeof value[key] !== "string" || !value[key])
      throw new Error(`Herdr ${label} response is missing ${key}.`);
    return value[key] as string;
  }

  function controllerConfigDirectoryFrom(stdout: string): string {
    const text = stdout.trim();
    if (!text)
      throw new Error("Herdr returned an empty controller config directory.");
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "string") return parsed;
      const result = responseRecord(parsed, "plugin config-dir");
      return requiredString(result, "config_dir", "plugin config-dir");
    } catch (error) {
      if (text.startsWith("{") || text.startsWith("[")) throw error;
      return text;
    }
  }

  const GOAL_SIDEBAR_TOKEN_NAMES = [
    "herdr_goal_status",
    "herdr_goal_next_1",
    "herdr_goal_next_2",
    "herdr_goal_next_3",
  ] as const;

  function wrapSidebarText(text: string, width = 20): string[] {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > width && line) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
    return lines;
  }

  function parentGoalSidebarTokens(
    goal: ParentGoal,
  ): Record<string, string | undefined> {
    const status = goal.status.replaceAll("-", " ");
    const next = wrapSidebarText(goal.nextAction).slice(0, 3);
    return {
      herdr_goal_status: `Goal: ${status}`,
      herdr_goal_next_1: next[0] ? `Next: ${next[0]}` : undefined,
      herdr_goal_next_2: next[1],
      herdr_goal_next_3: next[2],
    };
  }

  function parentGoalMobileLabel(goal: ParentGoal): string {
    return `Goal: ${goal.status.replaceAll("-for-event", "").replaceAll("-", " ")}`;
  }

  async function publishParentGoalSidebar(
    goal: ParentGoal,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!isRootOrchestrator()) return;
    const paneId = process.env[HERDR_PANE_ID_ENV];
    if (!paneId) return;
    const args = ["pane", "report-metadata", paneId, "--source", OWNER];
    for (const name of GOAL_SIDEBAR_TOKEN_NAMES) {
      const value = parentGoalSidebarTokens(goal)[name];
      if (value) args.push("--token", `${name}=${value}`);
      else args.push("--clear-token", name);
    }
    const mobileLabel = parentGoalMobileLabel(goal);
    // Herdr's compact/mobile switcher uses only state labels, not sidebar rows.
    // Cover idle-but-unseen panes, which the switcher renders as "done".
    args.push(
      "--state-label",
      `idle=${mobileLabel}`,
      "--state-label",
      `done=${mobileLabel}`,
    );
    args.push("--ttl-ms", "86400000");
    await runHerdrRaw(args, signal);
  }

  async function clearParentGoalSidebar(signal?: AbortSignal): Promise<void> {
    if (!isRootOrchestrator()) return;
    const paneId = process.env[HERDR_PANE_ID_ENV];
    if (!paneId) return;
    const args = ["pane", "report-metadata", paneId, "--source", OWNER];
    for (const name of GOAL_SIDEBAR_TOKEN_NAMES)
      args.push("--clear-token", name);
    args.push("--clear-state-labels");
    await runHerdrRaw(args, signal);
  }

  async function controllerConfigPath(signal?: AbortSignal): Promise<string> {
    const directory = await secureControllerConfigDirectory(
      controllerConfigDirectoryFrom(
        await runHerdrRaw(
          ["plugin", "config-dir", CONTROLLER_PLUGIN_ID],
          signal,
        ),
      ),
    );
    return join(directory, CONTROLLER_CONFIG_NAME);
  }

  async function wakeParentForQuestion(
    cwd: string,
    request: ParentQuestionRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const assignment = currentChildAssignment();
    cwd = assignment.cwd;
    if (
      request.workflowId !== assignment.workflow.workflow_id ||
      request.paneId !== assignment.lane.pane_id
    )
      throw new Error(
        "Question does not belong to the current child assignment.",
      );
    if (request.delivery?.status === "delivered") return;
    if (
      request.delivery?.status === "sending" ||
      request.delivery?.status === "uncertain"
    )
      throw new Error(
        `Question ${request.id} is durable; notification delivery is uncertain. Do not resubmit terminal input.`,
      );
    const root = assignment.record.root;
    const result = await runHerdr(["agent", "get", root.pane_id], signal);
    const live = liveAgentIdentity(result, "question parent get");
    if (
      live.paneId !== root.pane_id ||
      live.workspaceId !== root.workspace_id ||
      (root.agent_kind && live.kind !== root.agent_kind) ||
      (root.target_kind === "name" && live.name !== root.target)
    )
      throw new Error(
        `Question ${request.id} remains pending: parent identity mismatch.`,
      );
    if (!["idle", "done"].includes(deepState(result) ?? "unknown"))
      throw new Error(
        `Question ${request.id} remains pending: parent is not ready.`,
      );
    const updateDelivery = async (
      status: "sending" | "delivered" | "uncertain",
      reason?: string,
    ) => {
      const release = await acquireManifestLock(cwd, 10_000);
      try {
        const manifest = await loadManifest(cwd);
        const stored = workflowFor(
          manifest,
          request.workflowId!,
        ).questionRequests?.find((item) => item.id === request.id);
        if (!stored)
          throw new Error(`Durable question ${request.id} is missing.`);
        if (status === "sending" && stored.delivery?.status !== "pending")
          return false;
        stored.delivery = {
          status,
          updatedAt: now(),
          ...(reason ? { reason } : {}),
        };
        await saveManifest(cwd, manifest);
        return true;
      } finally {
        await release();
      }
    };
    // Claim before terminal I/O. A crash or lost reply cannot authorize retyping.
    if (!(await updateDelivery("sending"))) return;
    try {
      await runHerdr(
        [
          "agent",
          "prompt",
          root.pane_id,
          `A mapped Herdr child needs a parent answer. Ask Zach the durable question in request ${request.id}, then call herdr_question_answer with that request ID and Zach's answer.\n\n${request.question}`,
          "--wait",
        ],
        signal,
      );
    } catch (error) {
      await updateDelivery("uncertain", clip((error as Error).message, 1000));
      throw new Error(
        `Question ${request.id} is durable; notification delivery is uncertain. Do not resubmit terminal input.`,
      );
    }
    await updateDelivery("delivered");
  }

  async function answerChildQuestion(
    cwd: string,
    requestId: string,
    answer: string,
    signal?: AbortSignal,
  ): Promise<ParentQuestionRequest> {
    requireRootGoalExecutor();
    const release = await acquireManifestLock(cwd);
    try {
      const manifest = await loadManifest(cwd);
      const containers = [
        { requests: manifest.questionRequests, workflow: undefined },
        ...manifest.workflows.map((workflow) => ({
          requests: workflow.questionRequests,
          workflow,
        })),
      ];
      const container = containers.find((item) =>
        item.requests?.some((request) => request.id === requestId),
      );
      const request = container?.requests?.find(
        (item) => item.id === requestId,
      );
      if (!request)
        throw new Error(
          `No durable parent question exists with ID ${requestId}.`,
        );
      if (request.status === "answered") return request;
      if (!request.paneId)
        throw new Error(
          `Question ${requestId} has no child pane to receive an answer.`,
        );

      request.answer = answer;
      request.answeredAt = now();
      request.status = "answer-delivery-pending";
      if (container?.workflow) {
        container.workflow.evidence.push({
          at: now(),
          kind: "parent-question-answered",
          text: `Parent answer for ${requestId} is awaiting delivery to ${request.paneId}.`,
        });
      }
      await saveManifest(cwd, manifest);
      try {
        await runHerdr(
          [
            "agent",
            "prompt",
            request.paneId,
            `Herdr parent answer to your question (${requestId}):\n${answer}`,
            "--wait",
          ],
          signal,
        );
      } catch (error) {
        throw new Error(
          `The answer is durable but child delivery is pending: ${(error as Error).message}`,
        );
      }
      request.status = "answered";
      await saveManifest(cwd, manifest);
      return request;
    } finally {
      await release();
    }
  }

  type LiveAgentIdentity = {
    name?: string;
    kind: AgentKind;
    paneId: string;
    workspaceId: string;
  };

  function liveAgentIdentity(value: unknown, label: string): LiveAgentIdentity {
    const result = responseRecord(value, label);
    if (result.type !== "agent_info" || !isRecord(result.agent))
      throw new Error(`Herdr ${label} response is not an agent_info record.`);
    const agent = result.agent;
    const name = agent.name;
    if (
      name !== null &&
      name !== undefined &&
      (typeof name !== "string" || !name)
    )
      throw new Error(`Herdr ${label} response has an invalid agent name.`);
    return {
      ...(typeof name === "string" ? { name } : {}),
      kind: validateAgentKind(agent.agent, `Herdr ${label} agent kind`),
      paneId: requiredString(agent, "pane_id", label),
      workspaceId: requiredString(agent, "workspace_id", label),
    };
  }

  async function currentPaneRoot(
    signal?: AbortSignal,
  ): Promise<ControllerRootMapping> {
    const paneId = process.env[HERDR_PANE_ID_ENV];
    if (!paneId)
      throw new Error(
        `${HERDR_PANE_ID_ENV} is required to discover the current pane identity.`,
      );
    const agent = liveAgentIdentity(
      await runHerdr(["agent", "get", paneId], signal),
      "current pane agent get",
    );
    if (agent.paneId !== paneId)
      throw new Error(
        "Herdr current pane identity does not match the requested pane target.",
      );
    return {
      target: paneId,
      target_kind: "pane_id",
      agent_kind: agent.kind,
      pane_id: agent.paneId,
      workspace_id: agent.workspaceId,
    };
  }

  async function discoverControllerRoot(
    signal?: AbortSignal,
  ): Promise<ControllerRootMapping> {
    if (!isRootOrchestrator())
      throw new Error(
        "Only the verified controller-mapped root may register the event controller.",
      );
    return currentPaneRoot(signal);
  }

  async function bootstrapRoot(
    cwd: string,
    reset: boolean,
    confirm: boolean,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<{
    root: ControllerRootMapping;
    configPath: string;
    reset: boolean;
    manifestReset: boolean;
    alreadyRegistered: boolean;
  }> {
    requireHerdr();
    const root = await currentPaneRoot(signal);
    const configPath = await controllerConfigPath(signal);
    const config = await loadControllerConfig(configPath);
    const existingManifest = await loadManifest(cwd);
    const manifestHasLegacyState =
      existingManifest.workflows.length > 0 ||
      existingManifest.parentGoal !== undefined ||
      (existingManifest.questionRequests?.length ?? 0) > 0;
    if (
      config?.orchestrators.some((record) =>
        record.workflows.some((workflow) =>
          workflow.lanes.some((lane) => lane.pane_id === root.pane_id),
        ),
      )
    )
      throw new Error(
        "The current pane is already a registered child lane and cannot claim root authority.",
      );
    const current = config?.orchestrators.find(
      (record) =>
        sameControllerRoot(record.root, root) &&
        record.program.id === resolve(cwd),
    );
    if (current && !reset)
      return {
        root,
        configPath,
        reset: false,
        manifestReset: false,
        alreadyRegistered: true,
      };
    if ((config && config.orchestrators.length > 0) || manifestHasLegacyState) {
      if (!reset)
        throw new Error(
          "Controller config or parent manifest has existing state. Review it, then call herdr_bootstrap_root with reset=true to retire it before claiming this manually started root.",
        );
    }
    const label = reset
      ? "Reset Baa-ton controller mappings and claim this root"
      : "Claim this manually started Baa-ton root";
    if (
      confirm &&
      !(await ctx.ui.confirm(
        "Herdr orchestrator",
        `${label}? ${reset ? "This retires the existing controller mapping and parent manifest state." : "This records the verified current pane/workspace and a clean parent manifest."} It does not create lanes or enable the controller.`,
      ))
    )
      throw new Error("Root bootstrap was cancelled.");
    const next: ControllerConfig = {
      version: 2,
      owner: OWNER,
      orchestrators: [
        {
          id: controllerRecordId(root, cwd),
          root,
          program: {
            id: resolve(cwd),
            workspace_id: root.workspace_id,
            parent_manifest_path: resolve(manifestPath(cwd)),
          },
          workflows: [],
        },
      ],
    };
    const release = await acquireManifestLock(cwd);
    try {
      if (reset) await saveManifest(cwd, { version: 2, workflows: [] });
      await saveControllerConfig(
        configPath,
        reset || !config
          ? next
          : {
              ...config,
              orchestrators: [...config.orchestrators, ...next.orchestrators],
            },
      );
    } finally {
      await release();
    }
    return {
      root,
      configPath,
      reset,
      manifestReset: reset,
      alreadyRegistered: false,
    };
  }

  async function controllerWorkflowMapping(
    cwd: string,
    workflow: Workflow,
    signal?: AbortSignal,
  ): Promise<ControllerWorkflowMapping> {
    const workspaceId = workflow.ownership.workspaceId;
    if (!workspaceId)
      throw new Error(
        "Workflow has no recorded Herdr workspace for controller registration.",
      );
    const lanes: ControllerLaneMapping[] = [];
    for (const lane of workflow.lanes) {
      if (!lane.agentName || !lane.paneId)
        throw new Error(
          `Lane ${lane.id} has no recorded agent or pane for controller registration.`,
        );
      const agent = liveAgentIdentity(
        await runHerdr(["agent", "get", lane.agentName], signal),
        `lane ${lane.id} agent get`,
      );
      if (
        agent.name !== lane.agentName ||
        agent.kind !== laneAgentKind(workflow, lane) ||
        agent.paneId !== lane.paneId ||
        agent.workspaceId !== workspaceId
      )
        throw new Error(
          `Lane ${lane.id} Herdr identity does not match its recorded agent, kind, pane, and workspace.`,
        );
      lanes.push({
        lane_id: lane.id,
        target: agent.name,
        target_kind: "name",
        pane_id: agent.paneId,
        workspace_id: agent.workspaceId,
        ...(lane.relationshipId
          ? { relationship_id: lane.relationshipId }
          : {}),
      });
    }
    return {
      workflow_id: workflow.id,
      manifest_path: resolve(manifestPath(cwd)),
      // This controller integration is agent-neutral; Pi-only output probing
      // remains opt-in and is never enabled by automatic registration.
      pi_goal_pause_detection: false,
      lanes,
    };
  }

  function recordControllerRegistration(
    workflow: Workflow,
    registration: EventControllerRegistration,
  ): void {
    const previous = workflow.eventControllerRegistration;
    workflow.eventControllerRegistration = registration;
    if (
      previous?.status === registration.status &&
      previous.reason === registration.reason &&
      previous.configPath === registration.configPath
    )
      return;
    workflow.evidence.push({
      at: now(),
      kind:
        registration.status === "registered"
          ? "event-controller-registered"
          : registration.status === "removed"
            ? "event-controller-removed"
            : "event-controller-registration-pending",
      text: registration.reason ?? registration.status,
    });
  }

  async function registerEventController(
    cwd: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<EventControllerRegistration> {
    // Read-only snapshot for external identity checks only; the eventual
    // registration write reconciles against a freshly reloaded manifest so
    // it can never clobber a concurrent mutation made while these
    // network/config calls were in flight.
    const workflow = workflowFor(await loadManifest(cwd), id);
    try {
      const [configPath, root] = await Promise.all([
        controllerConfigPath(signal),
        discoverControllerRoot(signal),
      ]);
      const mapping = await controllerWorkflowMapping(cwd, workflow, signal);
      const config = await loadControllerConfig(configPath);
      // A sole v1-derived record is promoted in place on the first matching
      // registration. This avoids leaving a legacy global record beside its
      // v2 replacement and therefore avoids duplicate wakes.
      const legacy =
        config?.orchestrators.length === 1 &&
        config.orchestrators[0].id.startsWith("legacy:") &&
        sameControllerRoot(config.orchestrators[0].root, root)
          ? config.orchestrators[0]
          : undefined;
      const record = config
        ? (findControllerRecord(config, root, cwd) ?? legacy)
        : undefined;
      if (record) {
        const sameId = record.workflows.filter(
          (candidate) => candidate.workflow_id === mapping.workflow_id,
        );
        if (sameId.length > 0 && !sameControllerWorkflow(sameId[0], mapping))
          throw new Error(
            "Linked controller config has a stale or mismatched workflow mapping; refusing to replace it.",
          );
        const promoted = record.id.startsWith("legacy:")
          ? {
              ...record,
              id: controllerRecordId(root, cwd),
              program: {
                id: resolve(cwd),
                workspace_id: root.workspace_id,
                parent_manifest_path: resolve(manifestPath(cwd)),
              },
            }
          : record;
        if (sameId.length === 0 || promoted !== record)
          await saveControllerConfig(configPath, {
            ...config!,
            orchestrators: config!.orchestrators.map((candidate) =>
              candidate.id === record.id
                ? {
                    ...promoted,
                    workflows:
                      sameId.length === 0
                        ? [...promoted.workflows, mapping]
                        : promoted.workflows,
                  }
                : candidate,
            ),
          });
      } else {
        const next: ControllerOrchestrator = {
          id: controllerRecordId(root, cwd),
          root,
          program: {
            id: resolve(cwd),
            workspace_id: root.workspace_id,
            parent_manifest_path: resolve(manifestPath(cwd)),
          },
          workflows: [mapping],
        };
        await saveControllerConfig(
          configPath,
          config
            ? { ...config, orchestrators: [...config.orchestrators, next] }
            : { version: 2, owner: OWNER, orchestrators: [next] },
        );
      }
      const registration: EventControllerRegistration = {
        version: 1,
        status: "registered",
        updatedAt: now(),
        configPath,
        root,
        workflow: mapping,
      };
      return await withManifestTransaction(cwd, (current) => {
        const stored = workflowFor(current, id);
        recordControllerRegistration(stored, registration);
        stored.updatedAt = now();
        return registration;
      });
    } catch (error) {
      const registration: EventControllerRegistration = {
        version: 1,
        status: "pending",
        updatedAt: now(),
        reason: clip((error as Error).message, 1200),
      };
      return await withManifestTransaction(cwd, (current) => {
        const stored = workflowFor(current, id);
        recordControllerRegistration(stored, registration);
        stored.updatedAt = now();
        return registration;
      });
    }
  }

  function registeredControllerRegistration(
    cwd: string,
    workflow: Workflow,
  ): EventControllerRegistration {
    const registration = workflow.eventControllerRegistration;
    if (
      !registration ||
      registration.version !== 1 ||
      registration.status !== "registered" ||
      !registration.configPath ||
      !registration.root ||
      !registration.workflow
    )
      throw new Error(
        "Workflow has no complete registered controller mapping.",
      );
    const root = validateControllerRoot(registration.root);
    const mapping = validateControllerWorkflow(
      registration.workflow,
      "workflow.eventControllerRegistration.workflow",
    );
    if (
      mapping.workflow_id !== workflow.id ||
      !samePath(mapping.manifest_path, manifestPath(cwd)) ||
      mapping.lanes.length !== workflow.lanes.length ||
      mapping.lanes.some((lane) => {
        const current = workflow.lanes.find((item) => item.id === lane.lane_id);
        return (
          !current ||
          current.agentName !== lane.target ||
          current.relationshipId !== lane.relationship_id ||
          current.paneId !== lane.pane_id ||
          workflow.ownership.workspaceId !== lane.workspace_id
        );
      })
    )
      throw new Error("Controller registration record is stale or mismatched.");
    return {
      ...registration,
      configPath: resolve(registration.configPath),
      root,
      workflow: mapping,
    };
  }

  async function linkedControllerConfig(
    registration: EventControllerRegistration,
    signal?: AbortSignal,
  ): Promise<ControllerConfig> {
    const configPath = await controllerConfigPath(signal);
    if (
      !registration.configPath ||
      !samePath(configPath, registration.configPath)
    )
      throw new Error(
        "Linked controller config directory changed since registration.",
      );
    const config = await loadControllerConfig(configPath);
    if (!config) throw new Error("Linked controller config is missing.");
    const record = recordForRegistration(config, registration);
    if (!record)
      throw new Error(
        "Linked controller config root, program, or workflow mapping is stale or mismatched.",
      );
    return config;
  }

  async function unregisterEventController(
    cwd: string,
    workflow: Workflow,
    signal?: AbortSignal,
  ): Promise<void> {
    const registration = registeredControllerRegistration(cwd, workflow);
    const config = await linkedControllerConfig(registration, signal);
    const record = recordForRegistration(config, registration);
    if (!record)
      throw new Error(
        "Linked controller config no longer contains this workflow mapping.",
      );
    const remaining = record.workflows.filter(
      (candidate) =>
        candidate.workflow_id !== registration.workflow!.workflow_id,
    );
    if (remaining.length === record.workflows.length)
      throw new Error(
        "Linked controller config no longer contains this workflow mapping.",
      );
    const orchestrators =
      remaining.length === 0
        ? config.orchestrators
            .map((candidate) =>
              candidate.id === record.id &&
              candidate.program.parent_manifest_path
                ? { ...candidate, workflows: [] }
                : candidate,
            )
            .filter(
              (candidate) =>
                candidate.id !== record.id ||
                candidate.program.parent_manifest_path,
            )
        : config.orchestrators.map((candidate) =>
            candidate.id === record.id
              ? { ...candidate, workflows: remaining }
              : candidate,
          );
    if (orchestrators.length === 0)
      await removeControllerConfig(registration.configPath!);
    else
      await saveControllerConfig(registration.configPath!, {
        ...config,
        orchestrators,
      });
    recordControllerRegistration(workflow, {
      ...registration,
      status: "removed",
      updatedAt: now(),
      reason: "Removed this workflow mapping after successful Herdr close.",
    });
  }

  async function inspectWorktreeForWorkspace(
    cwd: string,
    expectedWorkspaceId?: string,
    signal?: AbortSignal,
  ): Promise<WorktreeBinding> {
    const checkoutPath = await assertCleanLocalWorktree(cwd, signal);
    const worktreeList = responseRecord(
      await runHerdr(["worktree", "list", "--cwd", checkoutPath], signal),
      "worktree list",
    );
    const source = worktreeList.source;
    const worktrees = worktreeList.worktrees;
    if (!isRecord(source) || !Array.isArray(worktrees))
      throw new Error(
        "Herdr worktree list returned no registered repository source.",
      );
    const sourceWorkspaceId = requiredString(
      source,
      "source_workspace_id",
      "worktree list",
    );
    const parentCheckoutPath = requiredString(
      source,
      "source_checkout_path",
      "worktree list",
    );
    const repoKey = requiredString(source, "repo_key", "worktree list");
    const repoRoot = requiredString(source, "repo_root", "worktree list");
    const targetMatches = worktrees.filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) &&
        typeof item.path === "string" &&
        samePath(item.path, checkoutPath),
    );
    if (targetMatches.length !== 1)
      throw new Error(
        `Herdr must register ${checkoutPath} exactly once as a Git worktree; found ${targetMatches.length}.`,
      );
    const targetWorkspaceId = targetMatches[0].open_workspace_id;
    if (expectedWorkspaceId) {
      if (targetWorkspaceId !== expectedWorkspaceId)
        throw new Error(
          `Git worktree ${checkoutPath} is not open in recorded workspace ${expectedWorkspaceId}.`,
        );
    } else if (typeof targetWorkspaceId === "string" && targetWorkspaceId) {
      throw new Error(
        `Git worktree ${checkoutPath} is already open in workspace ${targetWorkspaceId}; this workflow must not reuse it.`,
      );
    }
    if (samePath(parentCheckoutPath, checkoutPath))
      throw new Error(
        "worktreeCwd resolves to the registered parent checkout and would reuse its workspace.",
      );

    const workspaceList = responseRecord(
      await runHerdr(["workspace", "list"], signal),
      "workspace list",
    );
    if (!Array.isArray(workspaceList.workspaces))
      throw new Error(
        "Herdr workspace list returned no registered parent workspaces.",
      );
    const parentCandidates = workspaceList.workspaces.filter(
      (item): item is Record<string, unknown> => {
        if (!isRecord(item) || item.workspace_id !== sourceWorkspaceId)
          return false;
        // A generic parent has no workspace.worktree metadata. When present,
        // validate it against the worktree-list source rather than requiring it.
        if (!isRecord(item.worktree)) return true;
        const worktree = item.worktree;
        return (
          worktree.repo_key === repoKey &&
          typeof worktree.checkout_path === "string" &&
          samePath(worktree.checkout_path, parentCheckoutPath)
        );
      },
    );
    if (parentCandidates.length === 0)
      throw new Error(
        `Herdr has no registered parent workspace for ${parentCheckoutPath}.`,
      );
    if (parentCandidates.length !== 1)
      throw new Error(
        `Herdr found ${parentCandidates.length} registered parent workspaces for ${parentCheckoutPath}; refusing ambiguous worktree dispatch.`,
      );
    const parent = parentCandidates[0];
    const parentWorkspaceId = requiredString(
      parent,
      "workspace_id",
      "workspace list",
    );
    if (parentWorkspaceId !== sourceWorkspaceId)
      throw new Error(
        `Herdr worktree source ${sourceWorkspaceId} does not match its sole registered parent ${parentWorkspaceId}.`,
      );
    return {
      checkoutPath,
      repoParent: {
        workspaceId: parentWorkspaceId,
        checkoutPath: resolve(parentCheckoutPath),
        repoKey,
        repoRoot: resolve(repoRoot),
      },
    };
  }

  async function plan(
    cwd: string,
    objective: string,
    laneObjectives: LaneInput[],
    worktreeCwd?: string,
    authorizationPolicyInput?: unknown,
    agentKindInput?: unknown,
    launchProfileInput?: unknown,
  ): Promise<Workflow> {
    const agentKind = validateAgentKind(agentKindInput ?? "pi");
    const authorizationPolicy =
      authorizationPolicyInput === undefined
        ? undefined
        : validateAuthorizationPolicy(authorizationPolicyInput);
    if (
      authorizationPolicy &&
      !new RegExp(`\\b${BB029_AUTHORIZATION_SCOPE}\\b`, "i").test(objective)
    )
      throw new Error(
        `authorizationPolicy.scope.workflow requires an objective containing ${BB029_AUTHORIZATION_SCOPE}.`,
      );
    const target = await plannedCwd(cwd, worktreeCwd);
    const id = `herdr-${randomUUID().slice(0, 8)}`;
    const rootGoalId = `goal-${id}`;
    const lanes = normalizedLanes(
      objective,
      laneObjectives,
      agentKind,
      id,
      rootGoalId,
    );
    if (
      target.worktree &&
      lanes.length > 1 &&
      lanes.some((lane) => !lane.readOnly)
    )
      throw new Error(
        "A worktree workflow may use multiple lanes only when every lane declares readOnly: true.",
      );
    const worktreeBinding = target.worktree
      ? await inspectWorktreeForWorkspace(target.worktree)
      : undefined;
    requireRootGoalExecutor();
    const root = await currentPaneRoot();
    const rootAgent = responseRecord(
      await runHerdr(["agent", "get", root.pane_id]),
      "task root",
    ).agent;
    if (
      !isRecord(rootAgent) ||
      !isRecord(rootAgent.agent_session) ||
      rootAgent.agent_session.kind !== "path" ||
      typeof rootAgent.agent_session.value !== "string"
    )
      throw new Error(
        "Task planning requires a verified native root session path.",
      );
    const rootSessionPath = rootAgent.agent_session.value;
    const launchProfile =
      launchProfileInput === undefined
        ? undefined
        : validateLaunchProfile(launchProfileInput);
    const stamp = now();
    const goals = createWorkflowGoals(id, objective, lanes);
    const workflow: Workflow = {
      id,
      objective,
      outcome: "planned",
      status: "planned",
      lanes,
      herdr: {},
      agent: {},
      agentKind,
      cwd: target.cwd,
      worktree: target.worktree,
      worktreeBinding,
      taskBinding: {
        workspaceId: root.workspace_id,
        rootPaneId: root.pane_id,
        rootSessionPath,
      },
      launchProfile,
      ...(launchProfile
        ? { launchProfileVersion: LAUNCH_PROFILE_SCHEMA_VERSION }
        : {}),
      goalSchemaVersion: SCOPED_GOALS_SCHEMA_VERSION,
      rootGoalId: goals.rootGoalId,
      goals: goals.goals,
      evidence: [],
      ownership: { createdBy: OWNER, tabIds: [], paneIds: [] },
      authorizationPolicy,
      approvalRequests: [],
      questionRequests: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    if (authorizationPolicy)
      workflow.evidence.push({
        at: now(),
        kind: "authorization-policy-installed",
        text: `Validated ${authorizationPolicy.scope.workflow} local-only policy: ${authorizationPolicy.capabilities.join(",")}`,
      });
    if (worktreeBinding)
      workflow.evidence.push({
        at: now(),
        kind: "worktree-parent-resolved",
        text: jsonText(worktreeBinding),
      });
    const release = await acquireManifestLock(cwd, 10_000);
    try {
      const manifest = await loadManifest(cwd);
      manifest.workflows.push(workflow);
      await saveManifest(cwd, manifest);
    } finally {
      await release();
    }
    return workflow;
  }

  async function dispatch(
    cwd: string,
    id: string,
    execute: boolean,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    restart = false,
  ): Promise<{
    workflow: Workflow;
    dryRun?: boolean;
    cancelled?: boolean;
    dispatched?: boolean;
    parentApprovalRequired?: boolean;
    approvalRequest?: ApprovalRequest;
    commands?: string[];
  }> {
    const manifest = await loadManifest(cwd);
    const workflow = workflowFor(manifest, id);
    if (execute && !isRootOrchestrator()) {
      const release = await acquireManifestLock(cwd, 10_000);
      try {
        const current = await loadManifest(cwd);
        const stored = workflowFor(current, id);
        const approvalRequest = requestParentApproval(stored, "dispatch");
        await saveManifest(cwd, current);
        return {
          parentApprovalRequired: true,
          approvalRequest,
          workflow: stored,
        };
      } finally {
        await release();
      }
    }
    const adapters = new HarnessAdapterRegistry();
    adapters.register(
      piLaunchAdapter(
        ctx,
        join(homedir(), ".pi/agent/extensions/herdr-agent-state.ts"),
      ),
    );
    adapters.register(
      claudeLaunchAdapter({
        bridge: fileURLToPath(new URL("./mcp-server.mjs", import.meta.url)),
        attestHelper: fileURLToPath(
          new URL("./claude-startup-attest.mjs", import.meta.url),
        ),
        scratchDirectory: dirname(manifestPath(cwd)),
      }),
    );
    adapters.register(
      codexLaunchAdapter({
        bridge: fileURLToPath(new URL("./mcp-server.mjs", import.meta.url)),
        attestHelper: fileURLToPath(
          new URL("./codex-startup-attest.mjs", import.meta.url),
        ),
        sessionRoot: join(homedir(), ".codex", "sessions"),
      }),
    );
    adapters.register(
      opencodeLaunchAdapter({
        scratchDirectory: dirname(manifestPath(cwd)),
      }),
    );
    return dispatchTask(
      workflow,
      execute,
      {
        directory: dirname(manifestPath(cwd)),
        source: fileURLToPath(import.meta.url),
        adapter: (kind) => adapters.resolve(kind),
        run: runHerdr,
        contract,
        async update(workflowId, mutate) {
          const release = await acquireManifestLock(cwd, 10_000);
          try {
            const current = await loadManifest(cwd);
            const stored = workflowFor(current, workflowId);
            mutate(stored);
            stored.updatedAt = now();
            await saveManifest(cwd, current);
            return stored;
          } finally {
            await release();
          }
        },
        async verifyRoot(w) {
          requireRootGoalExecutor();
          const root = await currentPaneRoot(signal);
          if (
            root.pane_id !== w.taskBinding?.rootPaneId ||
            root.workspace_id !== w.taskBinding.workspaceId
          )
            throw new Error(
              "Current root does not match the designated task workspace; no topology fallback allowed.",
            );
          const native = responseRecord(
            await runHerdr(["agent", "get", root.pane_id], signal),
            "task root",
          ).agent;
          if (
            !isRecord(native) ||
            !isRecord(native.agent_session) ||
            native.agent_session.value !== w.taskBinding.rootSessionPath
          )
            throw new Error(
              "Root incarnation changed; authorized task recovery is required before dispatch.",
            );
        },
        async authorize(w) {
          const decision = authorizationDecision(
            w,
            w.retry ? "retry" : "dispatch",
          );
          return (
            decision.allowed ||
            (await confirmExecution(
              ctx,
              `Dispatch ${w.id} in task workspace ${w.taskBinding?.workspaceId}`,
            ))
          );
        },
        async register(w) {
          const configPath = await controllerConfigPath(signal);
          const lockPath = `${configPath}.lock`;
          await mkdir(lockPath, { mode: 0o700 });
          try {
            const config = await loadControllerConfig(configPath);
            const root = await currentPaneRoot(signal);
            const record = config && findControllerRecord(config, root, cwd);
            if (!record)
              throw new Error(
                "Task root routing must be registered before launch.",
              );
            const mapping: ControllerWorkflowMapping = {
              workflow_id: w.id,
              manifest_path: resolve(manifestPath(cwd)),
              pi_goal_pause_detection: false,
              lanes: w.lanes.map((lane) => ({
                lane_id: lane.id,
                target: lane.paneId!,
                target_kind: "pane_id",
                pane_id: lane.paneId!,
                workspace_id: w.taskBinding!.workspaceId,
                relationship_id: lane.relationshipId,
              })),
            };
            const previous = record.workflows.find(
              (item) => item.workflow_id === w.id,
            );
            if (previous && !sameControllerWorkflow(previous, mapping))
              throw new Error(
                "Recorded lane route differs; authorized recovery is required.",
              );
            if (!previous) record.workflows.push(mapping);
            await saveControllerConfig(configPath, config!);
          } finally {
            await rm(lockPath, { recursive: true, force: true });
          }
        },
      },
      signal,
      { restart },
    );
  }

  async function observe(cwd: string, id: string, signal?: AbortSignal) {
    // This snapshot drives which lanes to poll and their native identity; it
    // is never itself written back. Every field this function persists is
    // reconciled against a freshly reloaded manifest in the single
    // transaction below, so a concurrent writer (a pause, a completion
    // receipt, an approval) can never be silently overwritten by observation
    // results gathered while these unlocked terminal/network calls ran.
    const snapshot = workflowFor(await loadManifest(cwd), id);
    if (!snapshot.lanes.some((lane) => lane.agentName))
      throw new Error(`Workflow ${id} has no recorded Herdr agents.`);
    requireHerdr();

    const observations: Array<{
      lane: string;
      state: string;
      agent: unknown;
      output: string;
      pausedGoalIds: string[];
    }> = [];
    const laneUpdates: Array<{
      id: string;
      fields: Partial<Lane>;
      newEvidence?: { at: string; kind: "goal-paused"; text: string };
    }> = [];
    let primaryLaneUpdate:
      | {
          agent: { sessionPath?: string; sessionId?: string };
          pi?: { sessionPath?: string; sessionId?: string };
        }
      | undefined;
    for (const [index, lane] of snapshot.lanes.entries()) {
      if (!lane.agentName) continue;
      const agent = await runHerdr(["agent", "get", lane.agentName], signal);
      const output = clip(
        await runHerdrRaw(
          [
            "agent",
            "read",
            lane.agentName,
            "--source",
            "recent-unwrapped",
            "--lines",
            String(RECENT_AGENT_OUTPUT_LINES),
          ],
          signal,
        ),
        GOAL_PAUSE_OUTPUT_LIMIT,
      );
      const state = deepState(agent) ?? "unknown";
      const agentKind = laneAgentKind(snapshot, lane);
      const agentSessionPath = deepString(agent, [
        "agent_session_path",
        "session_path",
        "value",
      ]);
      const agentSessionId = deepString(agent, [
        "agent_session_id",
        "session_id",
      ]);
      // /goal-resume is a Pi protocol, not a generic agent command.
      const detectedGoalIds = agentKind === "pi" ? pausedGoalIds(output) : [];
      const previousPause = lane.goalPaused;
      const unchangedPause =
        previousPause &&
        JSON.stringify(previousPause.goalIds) ===
          JSON.stringify(detectedGoalIds) &&
        previousPause.output === output;
      const goalPaused = detectedGoalIds.length
        ? unchangedPause
          ? previousPause
          : {
              status: "goal-paused" as const,
              goalIds: detectedGoalIds,
              detectedAt: now(),
              source: "herdr agent read recent-unwrapped" as const,
              output,
            }
        : undefined;
      const fields: Partial<Lane> = {
        agentKind,
        status: goalPaused ? "goal-paused" : state,
        herdrState: state,
        agentSessionPath,
        agentSessionId,
        ...(agentKind === "pi"
          ? { piSessionPath: agentSessionPath, piSessionId: agentSessionId }
          : {}),
        ...(goalPaused ? { goalPaused } : {}),
      };
      laneUpdates.push({
        id: lane.id,
        fields,
        ...(goalPaused && !unchangedPause
          ? {
              newEvidence: {
                at: now(),
                kind: "goal-paused",
                text: `Lane ${lane.id} (${lane.agentName}) paused ${goalPaused.goalIds.join(", ")} from bounded recent agent output:\n${output}`,
              },
            }
          : {}),
      });
      if (index === 0) {
        primaryLaneUpdate = {
          agent: { sessionPath: agentSessionPath, sessionId: agentSessionId },
          ...(agentKind === "pi"
            ? {
                pi: {
                  sessionPath: agentSessionPath,
                  sessionId: agentSessionId,
                },
              }
            : {}),
        };
      }
      observations.push({
        lane: lane.id,
        state,
        agent,
        output,
        pausedGoalIds: detectedGoalIds,
      });
    }

    const states = observations.map((item) => item.state);
    const hasPausedGoal = observations.some(
      (item) => item.pausedGoalIds.length > 0,
    );
    const allNativeAgentsSettled =
      states.length > 0 && states.every((state) => state === "done");
    const observedStatus = hasPausedGoal
      ? "goal-paused"
      : states.includes("blocked")
        ? "blocked"
        : states.includes("working")
          ? "running"
          : allNativeAgentsSettled
            ? "awaiting-explicit-outcome"
            : "unknown";
    const observationEvidenceText = clip(jsonText(observations), 6000);

    const observedWorkflow = await withManifestTransaction(cwd, (current) => {
      const stored = workflowFor(current, id);
      for (const update of laneUpdates) {
        const index = stored.lanes.findIndex((lane) => lane.id === update.id);
        // A lane removed by a concurrent writer has nothing left to update.
        if (index === -1) continue;
        stored.lanes[index] = { ...stored.lanes[index], ...update.fields };
        if (update.newEvidence) stored.evidence.push(update.newEvidence);
      }
      if (primaryLaneUpdate) {
        stored.agent = primaryLaneUpdate.agent;
        if (primaryLaneUpdate.pi) stored.pi = primaryLaneUpdate.pi;
      }
      const explicitlyCompleted = workflowHasExplicitSuccess(stored);
      stored.status = explicitlyCompleted ? "completed" : observedStatus;
      stored.outcome = explicitlyCompleted ? "completed" : "unknown";
      stored.observedAt = now();
      stored.updatedAt = now();
      stored.evidence.push({
        at: now(),
        kind: "agent-observation",
        text: observationEvidenceText,
      });
      return stored;
    });
    // Explicit root observation is the bounded recovery path for a completed
    // dispatch whose controller registration was deferred before the plugin
    // config became available. It never dispatches or enables a plugin.
    if (
      isRootOrchestrator() &&
      observedWorkflow.eventControllerRegistration?.status === "pending"
    )
      await registerEventController(cwd, id, signal);
    const workflow = workflowFor(await loadManifest(cwd), id);
    return { workflow, state: workflow.status, observations };
  }

  async function resume(
    cwd: string,
    id: string,
    execute: boolean,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    const manifest = await loadManifest(cwd);
    const workflow = workflowFor(manifest, id);
    const pausedLanes = workflow.lanes
      .map((lane, index) => ({ lane, index }))
      .filter(
        ({ lane }) =>
          laneAgentKind(workflow, lane) === "pi" &&
          lane.status === "goal-paused" &&
          Boolean(lane.agentName),
      );
    if (!execute)
      return {
        dryRun: true,
        workflow,
        pausedLanes: pausedLanes.map(({ lane }) => ({
          laneId: lane.id,
          agentName: lane.agentName,
          goalIds: lane.goalPaused?.goalIds ?? [],
        })),
        commands: pausedLanes.map(
          ({ lane }) => `herdr agent prompt ${lane.agentName} /goal-resume`,
        ),
      };
    requireHerdr();
    if (!isRootOrchestrator()) {
      const approvalRequest = requestParentApproval(workflow, "resume");
      workflow.updatedAt = now();
      await saveManifest(cwd, manifest);
      return { parentApprovalRequired: true, approvalRequest, workflow };
    }
    if (pausedLanes.length === 0)
      throw new Error(
        `Workflow ${id} has no currently observed paused goals; run herdr_observe before herdr_resume.`,
      );
    const decision = authorizationDecision(workflow, "resume");
    if (decision.allowed) {
      try {
        if (workflow.worktree)
          await assertCleanLocalWorktree(workflow.worktree, signal);
      } catch (error) {
        const denied: AuthorizationDecision = {
          ...decision,
          allowed: false,
          reason: `preauthorization denied: ${(error as Error).message}`,
        };
        auditAuthorization(workflow, denied);
        workflow.updatedAt = now();
        await saveManifest(cwd, manifest);
        throw error;
      }
      auditAuthorization(workflow, decision);
      resolveParentApproval(workflow, "resume", "approved");
      workflow.updatedAt = now();
      await saveManifest(cwd, manifest);
    } else {
      auditAuthorization(workflow, decision);
      workflow.updatedAt = now();
      await saveManifest(cwd, manifest);
      const approved = await confirmExecution(
        ctx,
        `Resume paused Pi goals for ${id}`,
      );
      resolveParentApproval(
        workflow,
        "resume",
        approved ? "approved" : "cancelled",
      );
      workflow.updatedAt = now();
      await saveManifest(cwd, manifest);
      if (!approved) return { cancelled: true, workflow };
    }

    const receipts: Array<{
      laneId: string;
      agentName: string;
      receipt: string;
    }> = [];
    try {
      for (const { lane, index } of pausedLanes) {
        const agentName = lane.agentName;
        if (!agentName) continue;
        const receipt = clip(
          jsonText(
            await runHerdr(
              ["agent", "prompt", agentName, "/goal-resume"],
              signal,
            ),
          ),
          6000,
        );
        const record: GoalResumeReceipt = {
          command: "/goal-resume",
          requestedAt: now(),
          receipt,
        };
        workflow.lanes[index] = {
          ...lane,
          status: "goal-resume-requested",
          goalResumeReceipts: [...(lane.goalResumeReceipts ?? []), record],
        };
        workflow.status = "goal-resume-requested";
        workflow.outcome = "unknown";
        workflow.updatedAt = now();
        workflow.evidence.push({
          at: now(),
          kind: "goal-resume-receipt",
          text: `Lane ${lane.id} (${agentName}) accepted /goal-resume:\n${receipt}`,
        });
        await saveManifest(cwd, manifest);
        receipts.push({ laneId: lane.id, agentName, receipt });
      }
    } catch (error) {
      const message = (error as Error).message;
      workflow.status = "goal-resume-failed";
      workflow.outcome = "unknown";
      workflow.updatedAt = now();
      workflow.evidence.push({
        at: now(),
        kind: "goal-resume-error",
        text: message,
      });
      await saveManifest(cwd, manifest);
      throw error;
    }
    return { resumed: true, receipts, workflow };
  }

  async function complete(
    cwd: string,
    id: string,
    summary: string,
    signal?: AbortSignal,
  ) {
    requireHerdr();
    const assignment = currentChildAssignment();
    if (assignment.workflow.workflow_id !== id)
      throw new Error("Completion is outside this participant's assignment.");
    cwd = assignment.cwd;
    const initial = workflowFor(await loadManifest(cwd), id);
    const lane = initial.lanes.find(
      (item) => item.id === assignment.lane.lane_id,
    )!;
    const raw = await runHerdr(
      ["agent", "get", assignment.lane.pane_id],
      signal,
    );
    const child = liveAgentIdentity(raw, "completion child identity");
    const nativeAgent = responseRecord(raw, "completion child").agent;
    const liveSession = nativeSessionFromAgent(nativeAgent);
    if (
      !lane?.relationshipId ||
      child.paneId !== lane.paneId ||
      child.workspaceId !== assignment.lane.workspace_id ||
      child.kind !== laneAgentKind(initial, lane) ||
      (lane.nativeSession
        ? !liveSession ||
          liveSession.kind !== lane.nativeSession.kind ||
          liveSession.value !== lane.nativeSession.value
        : lane.agentSessionPath
          ? liveSession?.value !== lane.agentSessionPath
          : child.name !== lane.agentName)
    )
      throw new Error(
        "Live child incarnation differs from its recorded completion authority.",
      );
    const transaction = async (
      mutate: (stored: Workflow, current: Lane) => void,
    ) => {
      const release = await acquireManifestLock(cwd, 10_000);
      try {
        const manifest = await loadManifest(cwd);
        const stored = workflowFor(manifest, id);
        const current = stored.lanes.find((item) => item.id === lane.id)!;
        if (
          !current ||
          (lane.nativeSession
            ? !current.nativeSession ||
              current.nativeSession.kind !== lane.nativeSession.kind ||
              current.nativeSession.value !== lane.nativeSession.value
            : current.agentSessionPath !== lane.agentSessionPath) ||
          current.relationshipId !== lane.relationshipId
        )
          throw new Error(
            "Completion writer was fenced by a changed incarnation.",
          );
        mutate(stored, current);
        await saveManifest(cwd, manifest);
        return stored;
      } finally {
        await release();
      }
    };
    let workflow = await transaction((stored, current) => {
      if (current.completionReceipt) {
        if (current.completionReceipt.summary !== summary)
          throw new Error(
            "Completion operation already exists with a different summary.",
          );
        return;
      }
      current.completionReceipt = {
        id: current.incarnationId ?? current.relationshipId!,
        summary,
        delivery: "pending",
      };
      current.status = "completion-reported";
      updateLaneGoal(stored, current, "completed", "success");
      stored.status = workflowHasExplicitSuccess(stored)
        ? "completed"
        : "completion-reported";
      stored.outcome = workflowHasExplicitSuccess(stored)
        ? "completed"
        : "unknown";
      stored.evidence.push({
        at: now(),
        kind: "child-completion-receipt",
        text: `${current.relationshipId}: ${clip(summary, 2000)}`,
      });
    });
    let delivery = workflow.lanes.find((item) => item.id === lane.id)!
      .completionReceipt!.delivery;
    const result = () => ({
      stored: true,
      delivered: delivery === "delivered",
      delivery,
      workflow,
      relationshipId: lane.relationshipId,
      incarnationId: lane.incarnationId,
    });
    if (delivery !== "pending") return result();
    const rootBinding = assignment.record.root;
    let rootRaw;
    try {
      rootRaw = await runHerdr(["agent", "get", rootBinding.pane_id], signal);
    } catch {
      return result();
    }
    const root = liveAgentIdentity(rootRaw, "completion root identity");
    if (
      root.paneId !== rootBinding.pane_id ||
      root.workspaceId !== rootBinding.workspace_id ||
      !["idle", "done"].includes(deepState(rootRaw) ?? "unknown")
    )
      return result();
    let claimed = false;
    workflow = await transaction((_stored, current) => {
      if (current.completionReceipt!.delivery === "pending") {
        current.completionReceipt!.delivery = "sending";
        claimed = true;
      }
    });
    if (!claimed) {
      delivery = workflow.lanes.find((item) => item.id === lane.id)!
        .completionReceipt!.delivery;
      return result();
    }
    try {
      await runHerdr(
        [
          "agent",
          "prompt",
          rootBinding.pane_id,
          `[Herdr completion receipt] ${lane.relationshipId}: ${id}/${lane.id} reports complete. ${clip(summary, 2000)}`,
        ],
        signal,
      );
      delivery = "delivered";
    } catch {
      delivery = "uncertain";
    }
    workflow = await transaction((_stored, current) => {
      current.completionReceipt!.delivery = delivery;
    });
    return result();
  }

  async function operatorClose(
    cwd: string,
    id: string,
    laneId: string,
    who: string,
    why: string,
    evidence: string[],
  ) {
    requireRootOperator();
    const normalizedLaneId = laneId.trim();
    const normalizedWho = who.trim();
    const normalizedWhy = why.trim();
    const normalizedEvidence = evidence
      .map((item) => item.trim())
      .filter(Boolean);
    if (!normalizedLaneId)
      throw new Error("operator closure requires a laneId.");
    if (!normalizedWho)
      throw new Error("operator closure requires who.");
    if (!normalizedWhy)
      throw new Error("operator closure requires why.");
    if (normalizedEvidence.length === 0)
      throw new Error("operator closure requires at least one evidence item.");

    const workflow = await withManifestTransaction(cwd, (manifest) => {
      const stored = workflowFor(manifest, id);
      const requested = {
        laneId: normalizedLaneId,
        who: normalizedWho,
        why: normalizedWhy,
        evidence: normalizedEvidence,
      };
      if (stored.operatorClosure) {
        const existing = stored.operatorClosure;
        const sameLane = existing.laneId === requested.laneId;
        if (
          sameLane &&
          (existing.who !== requested.who ||
            existing.why !== requested.why ||
            JSON.stringify(existing.evidence) !== JSON.stringify(requested.evidence))
        )
          throw new Error(
            "Workflow already has an operator closure with different reconciliation evidence.",
          );
        if (sameLane) return stored;
        // A different lane is reconciled separately: the workflow-level record
        // holds the latest closure and per-lane evidence accumulates below.
      }
      const lane = stored.lanes.find((item) => item.id === normalizedLaneId);
      if (!lane) throw new Error(`Unknown lane in workflow: ${normalizedLaneId}.`);
      if (lane.completionReceipt)
        throw new Error(
          "Operator closure cannot replace or duplicate an existing lane completion receipt.",
        );
      if (stored.outcome === "completed" || stored.outcome === "closed")
        throw new Error(
          "Operator closure cannot reconcile a workflow that already has a normal completion or close state.",
        );
      const timestamp = now();
      stored.operatorClosure = {
        version: 1,
        id: `operator-closure-${randomUUID().slice(0, 12)}`,
        ...requested,
        recordedAt: timestamp,
      };
      // This state is deliberately separate from completionReceipt: it says
      // an authorized operator reconciled the outcome, not that the lane
      // successfully called herdr_complete.
      lane.status = "operator-closed";
      // Stamp the workflow level only when every lane is terminal: the
      // controller treats workflow-wide status/outcome as a post-completion
      // signal, and one lane's reconciliation must never suppress a still-
      // running sibling's completion wake.
      if (
        stored.lanes.every(
          (candidate) =>
            candidate.completionReceipt ||
            TERMINAL_LANE_STATUSES.has(candidate.status),
        )
      ) {
        stored.status = "operator-closed";
        stored.outcome = "operator-closed";
      }
      stored.operatorClosedAt = timestamp;
      stored.evidence.push({
        at: timestamp,
        kind: "operator-closure",
        text: JSON.stringify({
          laneId: normalizedLaneId,
          who: normalizedWho,
          why: normalizedWhy,
          evidence: normalizedEvidence,
          receipt: "not recorded; lane completion receipt was unavailable",
        }),
      });
      stored.updatedAt = timestamp;
      return stored;
    });
    return {
      operatorClosed: true,
      workflow,
      operatorClosure: workflow.operatorClosure,
      laneCompletionReceiptRecorded: false,
    };
  }

  async function reparent(
    cwd: string,
    id: string,
    execute: boolean,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    const manifest = await loadManifest(cwd);
    const workflow = workflowFor(manifest, id);
    const registration = registeredControllerRegistration(cwd, workflow);
    const config = await linkedControllerConfig(registration, signal);
    const record = recordForRegistration(config, registration);
    if (
      !record ||
      record.workflows.length !== 1 ||
      !sameControllerWorkflow(record.workflows[0], registration.workflow!)
    )
      throw new Error(
        "Controller root handoff requires an isolated one-workflow orchestrator record.",
      );
    const nextRoot = await discoverControllerRoot(signal);
    if (!execute)
      return {
        dryRun: true,
        workflow,
        previousRoot: registration.root,
        nextRoot,
      };
    requireHerdr();
    if (!isRootOrchestrator())
      throw new Error(
        "Only the designated root may reparent a controller workflow.",
      );
    if (sameControllerRoot(registration.root!, nextRoot))
      return { reparented: false, unchanged: true, workflow };
    if (!(await confirmExecution(ctx, `Reparent controller root for ${id}`)))
      return { cancelled: true, workflow };
    await saveControllerConfig(registration.configPath!, {
      ...config,
      orchestrators: config.orchestrators.map((candidate) =>
        candidate.id === record.id
          ? {
              ...candidate,
              id: controllerRecordId(nextRoot, workflow.cwd),
              root: nextRoot,
              program: {
                ...candidate.program,
                workspace_id: nextRoot.workspace_id,
              },
            }
          : candidate,
      ),
    });
    recordControllerRegistration(workflow, {
      ...registration,
      status: "registered",
      updatedAt: now(),
      root: nextRoot,
      reason: `Controller root handed off from ${registration.root!.pane_id} to ${nextRoot.pane_id}.`,
    });
    workflow.evidence.push({
      at: now(),
      kind: "controller-root-reparented",
      text: `Verified live root handoff: ${registration.root!.pane_id} -> ${nextRoot.pane_id}.`,
    });
    workflow.updatedAt = now();
    await saveManifest(cwd, manifest);
    return {
      reparented: true,
      workflow,
      previousRoot: registration.root,
      nextRoot,
    };
  }

  async function close(
    cwd: string,
    id: string,
    evidence: string[],
    execute: boolean,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    const manifest = await loadManifest(cwd);
    const workflow = workflowFor(manifest, id);
    const sharedWorkspace = Boolean(
      workflow.ownership.workspaceId &&
        manifest.workflows.some(
          (candidate) =>
            candidate.id !== workflow.id &&
            candidate.ownership.workspaceId ===
              workflow.ownership.workspaceId &&
            candidate.outcome !== "closed",
        ),
    );
    if (evidence.filter(Boolean).length === 0)
      throw new Error("Close requires at least one evidence item.");
    if (workflow.taskBinding)
      throw new Error(
        "Task workspaces are user-owned. Workspace closure is forbidden; per-lane cleanup requires a separately reviewed operation.",
      );
    if (workflow.outcome !== "completed")
      throw new Error(
        "Close requires a completed Herdr observation; blocked, idle, failed, and unknown workflows stay open.",
      );
    if (!execute)
      return {
        dryRun: true,
        workflow,
        commands:
          workflow.ownership.workspaceId && !sharedWorkspace
            ? [`herdr workspace close ${workflow.ownership.workspaceId}`]
            : [],
        workspaceRetained: sharedWorkspace,
      };
    requireHerdr();
    if (!isRootOrchestrator()) {
      const approvalRequest = requestParentApproval(workflow, "close");
      workflow.updatedAt = now();
      await saveManifest(cwd, manifest);
      return { parentApprovalRequired: true, approvalRequest, workflow };
    }
    const approved = await confirmExecution(ctx, `Close ${id}`);
    resolveParentApproval(
      workflow,
      "close",
      approved ? "approved" : "cancelled",
    );
    workflow.updatedAt = now();
    await saveManifest(cwd, manifest);
    if (!approved) return { cancelled: true, workflow };
    if (
      workflow.ownership.createdBy !== OWNER ||
      !workflow.ownership.workspaceId
    )
      throw new Error(
        "Refusing to close: no extension-owned workspace is recorded.",
      );

    // Validate the recorded controller link before closing a workspace. A
    // stale record cannot redirect cleanup to another workflow or root.
    let registration: EventControllerRegistration | undefined;
    if (workflow.eventControllerRegistration?.status === "registered") {
      try {
        registration = registeredControllerRegistration(cwd, workflow);
        const root = await discoverControllerRoot(signal);
        if (!registration.root || !sameControllerRoot(registration.root, root))
          throw new Error(
            "Current root identity differs from the registered controller root.",
          );
        await linkedControllerConfig(registration, signal);
      } catch (error) {
        workflow.evidence.push({
          at: now(),
          kind: "event-controller-registration-pending",
          text: `Close refused before workspace mutation: ${clip((error as Error).message, 1200)}`,
        });
        workflow.updatedAt = now();
        await saveManifest(cwd, manifest);
        throw error;
      }
    }

    workflow.closeRequestedAt = now();
    workflow.evidence.push(
      ...evidence
        .filter(Boolean)
        .map((text) => ({ at: now(), kind: "closeout", text })),
    );
    // A durable workspace can carry multiple goal/lane tabs. Never close it
    // while another non-closed workflow still references it; this workflow
    // only owns its tabs/panes and close has no tab/pane mutation path.
    if (sharedWorkspace) {
      workflow.evidence.push({
        at: now(),
        kind: "workspace-retained-for-other-workflows",
        text: `Retained durable workspace ${workflow.ownership.workspaceId}; another open workflow still references it.`,
      });
    } else {
      await runHerdr(
        ["workspace", "close", workflow.ownership.workspaceId],
        signal,
      );
    }
    if (registration) {
      try {
        await unregisterEventController(cwd, workflow, signal);
      } catch (error) {
        recordControllerRegistration(workflow, {
          ...registration,
          status: "cleanup-pending",
          updatedAt: now(),
          reason: `Controller cleanup awaits recovery after workflow close: ${clip((error as Error).message, 1000)}`,
        });
        workflow.status = "close-cleanup-pending";
        workflow.outcome = "unknown";
        workflow.updatedAt = now();
        await saveManifest(cwd, manifest);
        throw new Error(
          `Workspace closed but controller cleanup is pending: ${(error as Error).message}`,
        );
      }
    }
    workflow.status = "closed";
    workflow.outcome = "closed";
    workflow.closedAt = now();
    workflow.updatedAt = now();
    await saveManifest(cwd, manifest);
    return { closed: true, workflow };
  }

  type DoctorCheck = {
    id: string;
    status: "ok" | "warn" | "fail";
    detail: string;
  };

  /** Idempotent, read-only preflight. Never mutates the manifest, controller
   * config, or any live Herdr/plugin state; every check below is a read. */
  async function doctor(
    cwd: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
    const checks: DoctorCheck[] = [];
    const check = (id: string, run: () => Promise<Omit<DoctorCheck, "id">>) =>
      run().then(
        (partial) => checks.push({ id, ...partial }),
        (error: unknown) =>
          checks.push({
            id,
            status: "fail",
            detail: error instanceof Error ? error.message : String(error),
          }),
      );

    await check("extension-source", async () => ({
      status: "ok",
      detail: `Loaded from ${await realpath(fileURLToPath(import.meta.url))}.`,
    }));

    let configPath: string | undefined;
    await check("native-herdr-connectivity", async () => {
      configPath = await controllerConfigPath(signal);
      return {
        status: "ok",
        detail: `herdr plugin config-dir resolved: ${dirname(configPath)}.`,
      };
    });

    let controllerConfig: ControllerConfig | undefined;
    await check("plugin-enablement-and-routing", async () => {
      if (!configPath)
        return {
          status: "fail",
          detail: "Cannot check without native Herdr connectivity.",
        };
      controllerConfig = await loadControllerConfig(configPath);
      if (!controllerConfig)
        return {
          status: "warn",
          detail:
            "No controller config registered yet; nothing has been dispatched through this controller.",
        };
      const workflowCount = controllerConfig.orchestrators.reduce(
        (sum, orchestrator) => sum + orchestrator.workflows.length,
        0,
      );
      return {
        status: "ok",
        detail: `${controllerConfig.orchestrators.length} registered orchestrator(s), ${workflowCount} routed workflow(s). This pane is${isRootOrchestrator() ? "" : " not"} a registered root.`,
      };
    });

    await check("manifest-store", async () => {
      const manifest = await loadManifest(cwd);
      if (manifest.version !== 2)
        return {
          status: "warn",
          detail: `Unrecognized manifest version ${manifest.version} at ${manifestPath(cwd)}; expected 2.`,
        };
      return {
        status: "ok",
        detail: `Version 2 manifest at ${manifestPath(cwd)}: ${manifest.workflows.length} workflow(s), parent goal ${manifest.parentGoal ? "present" : "absent"}.`,
      };
    });

    await check(
      "codex-sandbox-git-metadata-writability",
      () => inspectCodexSandboxGitMetadata(cwd),
    );

    await check("lane-bridge-liveness", async () => {
      if (!controllerConfig)
        return {
          status: "warn",
          detail:
            "No controller config is available; no mapped lane bridge can be checked.",
        };
      const lanes = controllerConfig.orchestrators.flatMap((orchestrator) =>
        orchestrator.workflows.flatMap((workflow) =>
          workflow.lanes.map((lane) => ({
            orchestrator,
            workflow,
            lane,
          })),
        ),
      );
      if (lanes.length === 0)
        return {
          status: "ok",
          detail: "No mapped lane bridges are currently registered.",
        };
      const results: string[] = [];
      const warnings: string[] = [];
      for (const { workflow, lane } of lanes) {
        const response = responseRecord(
          await runHerdr(["agent", "get", lane.pane_id], signal),
          `lane bridge ${lane.lane_id}`,
        );
        const agent = response.agent;
        if (!isRecord(agent))
          throw new Error(
            `Lane ${lane.lane_id} agent response did not contain native identity.`,
          );
        if (
          agent.pane_id !== lane.pane_id ||
          agent.workspace_id !== lane.workspace_id
        )
          throw new Error(
            `Lane ${lane.lane_id} native identity does not match its registered route.`,
          );
        if (agent.launch_pending || agent.interactive_ready === false) {
          warnings.push(
            `${lane.lane_id} (${lane.pane_id}) is not interactive-ready`,
          );
          continue;
        }
        // A startup attestation containing all protocol operations is the
        // strongest read-only evidence available for a stdio bridge: the
        // bridge has no independently addressable socket to ping. Missing or
        // incomplete evidence is surfaced as a warning rather than guessed
        // healthy from a pane status alone.
        let attestation: any = null;
        try {
          const manifest = await loadManifest(workflow.manifest_path);
          const stored = manifest.workflows.find(
            (candidate) => candidate.id === workflow.workflow_id,
          );
          const storedLane = stored?.lanes.find(
            (candidate) => candidate.id === lane.lane_id,
          );
          if (storedLane?.startupIntentPath)
            attestation = JSON.parse(
              await readFile(`${storedLane.startupIntentPath}.ready`, "utf8"),
            );
        } catch {
          attestation = null;
        }
        const operations = isRecord(attestation)
          ? attestation.operations
          : undefined;
        if (
          !Array.isArray(operations) ||
          !STARTUP_PROOF_REQUIRED_OPERATIONS.every((operation) =>
            operations.includes(operation),
          )
        ) {
          warnings.push(
            `${lane.lane_id} (${lane.pane_id}) has no complete startup bridge attestation`,
          );
          continue;
        }
        results.push(`${lane.lane_id} (${lane.pane_id}) native/bridge evidence present`);
      }
      return {
        status: warnings.length ? "warn" : "ok",
        detail: [
          results.length
            ? `Checked ${results.length}/${lanes.length} mapped lane bridge(s): ${results.join("; ")}.`
            : `Checked ${lanes.length} mapped lane bridge(s).`,
          ...(warnings.length ? [`Warnings: ${warnings.join("; ")}.`] : []),
        ].join(" "),
      };
    });

    await check("adapter-registry-capability-matrix", async () => {
      const adapters = new HarnessAdapterRegistry();
      adapters.register(
        piLaunchAdapter(
          ctx,
          join(homedir(), ".pi/agent/extensions/herdr-agent-state.ts"),
        ),
      );
      adapters.register(
        claudeLaunchAdapter({
          bridge: fileURLToPath(new URL("./mcp-server.mjs", import.meta.url)),
          attestHelper: fileURLToPath(
            new URL("./claude-startup-attest.mjs", import.meta.url),
          ),
          scratchDirectory: dirname(manifestPath(cwd)),
        }),
      );
      const matrix = adapters.capabilities();
      const unqualified = matrix.filter(
        (entry) =>
          !entry.startupAttestation || !entry.supportsSessionPersistence,
      );
      return {
        status: unqualified.length > 0 ? "warn" : "ok",
        detail: jsonText(matrix),
      };
    });

    return { ok: checks.every((entry) => entry.status !== "fail"), checks };
  }

  // A run spans every tool/LLM turn, retries, compaction and queued follow-ups.
  // No timer, tool completion, agent_end, or Herdr idle snapshot releases it.
  let rootRunId = randomUUID();
  function currentRootTurn(state: RootTurn["state"]): RootTurn {
    return {
      state,
      runId: rootRunId,
      paneId: process.env.HERDR_PANE_ID ?? "",
      workspaceId: process.env.HERDR_WORKSPACE_ID ?? "",
      updatedAt: now(),
    };
  }
  async function persistRootTurn(
    ctx: ExtensionContext,
    state: RootTurn["state"],
  ): Promise<void> {
    if (process.env.HERDR_ENV !== "1" || !isRootOrchestrator()) return;
    const turn = currentRootTurn(state);
    const config = readControllerConfigForCurrentPane();
    if (
      !config?.orchestrators.some(
        (record) =>
          record.root.pane_id === turn.paneId &&
          record.root.workspace_id === turn.workspaceId &&
          record.root.agent_kind === "pi" &&
          (record.program?.parent_manifest_path === manifestPath(ctx.cwd) ||
            record.workflows.some(
              (workflow) => workflow.manifest_path === manifestPath(ctx.cwd),
            )),
      )
    )
      return;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireManifestLock(ctx.cwd, 10_000);
      // A queued settled handler must not release a newer run.
      if (turn.runId !== rootRunId || (state === "idle" && !ctx.isIdle()))
        return;
      const manifest = await loadManifest(ctx.cwd);
      const control = manifest.parentGoal?.supervisor;
      if (!control) return;
      if (
        state === "idle" &&
        (control.rootTurn?.runId !== turn.runId ||
          control.rootTurn.state !== "active")
      )
        return;
      control.rootTurn = turn;
      if (state === "active" && control.lastDelivery?.status === "delivered")
        control.lastDelivery.acknowledgedAt ??= turn.updatedAt;
      // Settling never clears the wake latch. Only a material goal transition does.
      control.updatedAt = turn.updatedAt;
      await saveManifest(ctx.cwd, manifest);
    } catch (error) {
      // Pi logs lifecycle errors and otherwise continues. Do not execute a run
      // with stale idle authority if its active write could not be persisted.
      if (state === "active") ctx.abort();
      throw error;
    } finally {
      await release?.();
    }
  }
  // acknowledgeActivation() is idempotent and cheap when nothing is pending
  // (a local file read that returns undefined), so it is safe to attempt on
  // every agent_start. session_start does not fire on /reload, so it alone
  // can never observe the reload it is meant to acknowledge; agent_start
  // fires on every subsequent turn, including the one that follows a
  // reload, and is the hook that actually closes this loop.
  async function attemptActivationAck(ctx: {
    sessionManager: { getSessionFile(): string | undefined };
    signal?: AbortSignal;
  }): Promise<void> {
    if (!isRootOrchestrator()) return;
    const activation = await acknowledgeActivation(
      dirname(rootConfigPath()),
      {
        paneId: process.env.HERDR_PANE_ID,
        workspaceId: process.env.HERDR_WORKSPACE_ID,
        sessionPath: ctx.sessionManager.getSessionFile(),
        source: await realpath(fileURLToPath(import.meta.url)),
      },
      async (paneId: string) =>
        responseRecord(
          await runHerdr(["agent", "get", paneId], ctx.signal),
          "activation root",
        ).agent,
    );
    if (activation)
      pi.sendMessage(
        {
          customType: "herdr-runtime-activated",
          display: true,
          content: `Authorized runtime activation ${activation.id} verified in ${activation.workspaceId}. Continue the existing task: verify the live subscription/profile, then plan and dispatch bounded Luna work in this workspace only. Do not ask for activation approval again.`,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
  }
  pi.on("agent_start", async (_event, ctx) => {
    rootRunId = randomUUID();
    await persistRootTurn(ctx, "active");
    await attemptActivationAck(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await persistRootTurn(ctx, "idle");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    rootRunId = randomUUID();
    await persistRootTurn(ctx, "unknown");
  });
  pi.on("session_start", async (_event, ctx) => {
    rootRunId = randomUUID();
    await persistRootTurn(ctx, "unknown");
    const startupPath = process.env.BAA_STARTUP_INTENT;
    if (startupPath) {
      const intent = parseJson(await readFile(startupPath, "utf8"));
      const profile = validateLaunchProfile(intent.profile);
      await verifyActualProfile(profile, ctx);
      if (
        intent.workspaceId !== process.env.HERDR_WORKSPACE_ID ||
        intent.paneId !== process.env.HERDR_PANE_ID ||
        intent.source !== fileURLToPath(import.meta.url)
      )
        throw new Error(
          "Startup binding differs from the native task workspace or adapter source.",
        );
      const sessionPath = ctx.sessionManager.getSessionFile();
      if (!sessionPath)
        throw new Error(
          "A durable native session is required for startup proof.",
        );
      const ready = {
        version: 1,
        nonce: intent.nonce,
        paneId: process.env.HERDR_PANE_ID,
        workspaceId: process.env.HERDR_WORKSPACE_ID,
        sessionPath,
        profile,
        source: fileURLToPath(import.meta.url),
        tools: pi.getActiveTools(),
      };
      const temporary = `${startupPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, jsonText(ready), { mode: 0o600 });
      await rename(temporary, `${startupPath}.ready`);
    }
    await attemptActivationAck(ctx);
    if (!ctx.hasUI) return;
    const manifest = await loadManifest(ctx.cwd);
    if (manifest.parentGoal)
      await publishParentGoalSidebar(manifest.parentGoal, ctx.signal);
    else await clearParentGoalSidebar(ctx.signal);
  });

  pi.on("tool_call", async (event, ctx) => {
    // SAFETY: Pi's event union requires a runtime tool-name guard before bash input is available.
    const call = event as unknown as {
      toolName?: string;
      input?: { command?: unknown };
    };
    if (
      call.toolName === "ask_user_question" &&
      process.env.HERDR_ENV === "1" &&
      isRegisteredChildLane()
    ) {
      try {
        const persisted = await persistParentQuestion(
          ctx.cwd,
          call.input ?? {},
        );
        await wakeParentForQuestion(ctx.cwd, persisted.request, ctx.signal);
        return {
          block: true,
          terminate: true,
          reason: `Question ${persisted.request.id} is stored for the registered parent. Direct child UI remains disabled.`,
        };
      } catch (error) {
        // Routing/persistence failure is not successful delegation. Keep it visible.
        return {
          block: true,
          reason: `Parent question routing failed: ${(error as Error).message}. No user answer was recorded; do not treat this as approval.`,
        };
      }
    }
    const command = call.input?.command;
    if (call.toolName !== "bash" || typeof command !== "string") return;
    const gitPush = /(?:^|[;&|]\s*)git(?:\s+\S+)*\s+push\b/im;
    const nonAutonomousMutation =
      /(?:^|[;&|]\s*)(?:git(?:\s+\S+)*\s+(?:push|merge)\b|gh\s+pr\s+create\b|glab\s+mr\s+create\b|hub\s+pull-request\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:deploy|publish|release)\b|(?:wrangler|vercel|netlify|flyctl|kubectl)\s+(?:deploy|publish|apply)\b|herdr\s+(?:workspace|tab|pane)\s+close\b)/im;
    // 2026-09-16 ruling: the verified controller-mapped root is the parent
    // executor acting with the user present, so a plain `git push` is allowed
    // there, and it may retire its own lane tabs/panes (children remain
    // reachable through durable manifests). Every other mutation stays
    // blocked for every caller, workspace closure is never allowed from an
    // agent shell (it would close the root's own session), and a compound
    // command that also carries a non-push mutation keeps the block.
    const nonPushMutation =
      /(?:^|[;&|]\s*)(?:git(?:\s+\S+)*\s+merge\b|gh\s+pr\s+create\b|glab\s+mr\s+create\b|hub\s+pull-request\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:deploy|publish|release)\b|(?:wrangler|vercel|netlify|flyctl|kubectl)\s+(?:deploy|publish|apply)\b)/im;
    const herdrWorkspaceClose =
      /(?:^|[;&|]\s*)herdr\s+workspace\s+close\b/im;
    const herdrPaneClose =
      /(?:^|[;&|]\s*)herdr\s+(?:tab|pane)\s+close\b/im;
    if (
      process.env.HERDR_ENV === "1" &&
      (nonPushMutation.test(command) ||
        herdrWorkspaceClose.test(command) ||
        (gitPush.test(command) && !isRootOrchestrator()) ||
        (herdrPaneClose.test(command) && !isRootOrchestrator()))
    ) {
      return {
        block: true,
        reason:
          "Push, merge, PR creation, deploy/external mutation, and Herdr resource closure require explicit parent approval and are never authorized by the local policy.",
      };
    }
    if (blocksUnmanagedAgentCommand(command)) {
      return {
        block: true,
        reason:
          "Delegated Pi sessions and detached child jobs must be created only through Herdr dispatch.",
      };
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (process.env.HERDR_ENV !== "1") return {};
    await persistRootTurn(ctx, "active");
    return {
      systemPrompt: `${event.systemPrompt}\n\nHerdr controller active. Use available Herdr tools only as permitted by role; do not poll. Continue authorized safe local work until waiting, blocked, paused, or complete. Herdr delegation policy: delegate only via herdr_plan then herdr_dispatch. Every child must be a new Herdr-created session using its declared agentKind from the installed Herdr compatibility set. Never use Pi subagents, Pi background tasks, detached/background child jobs, or direct Pi child-session launches. Use herdr_observe for completion and herdr_close with evidence for extension-owned resources only.${await rootBootstrapPrompt(ctx.cwd)}`,
    };
  });

  pi.registerTool({
    name: "herdr_bootstrap_root",
    label: "Bootstrap Herdr Root",
    description:
      "Explicitly claim the verified current pane as the Baa-ton root before creating a parent goal.",
    promptSnippet:
      "Bootstrap the manually started Baa-ton root; confirmation is opt-in.",
    promptGuidelines: [
      "Use herdr_bootstrap_root only when Zach explicitly asks to initialize a manually started Baa-ton parent. It never creates lanes or enables the controller; pass confirm=true only when Zach asks for a confirmation gate.",
    ],
    parameters: Type.Object(
      {
        reset: Type.Optional(Type.Boolean()),
        confirm: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const result = await bootstrapRoot(
        ctx.cwd,
        params.reset ?? false,
        params.confirm ?? false,
        ctx,
        signal,
      );
      if (!result.alreadyRegistered && ctx.hasUI)
        await clearParentGoalSidebar(signal);
      return {
        content: [
          {
            type: "text",
            text: result.alreadyRegistered
              ? `Verified Baa-ton root ${result.root.pane_id} is already registered.`
              : `Registered Baa-ton root ${result.root.pane_id}${result.reset ? " after retiring prior mappings" : ""}.`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_goal",
    label: "Herdr Goal",
    description:
      "Create or update the controller-owned thin parent goal record; it never polls or resumes Pi goals.",
    promptSnippet:
      "Manage the durable Herdr parent goal from the designated root.",
    promptGuidelines: [
      "Use herdr_goal only from the verified controller-mapped root. Initialize only for an explicit user objective. A durable controller signal changes the goal to action-required; continue authorized safe local work and set waiting-for-event or another truthful state only at a real wait, blocker, pause, or completion boundary.",
    ],
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("initialize"),
          Type.Literal("set-state"),
          Type.Literal("status"),
          Type.Literal("start"),
          Type.Literal("stop"),
          Type.Literal("pause"),
        ]),
        objective: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        nextAction: Type.Optional(Type.String()),
        nudgeIntervalSeconds: Type.Optional(
          Type.Integer({
            minimum: MIN_PARENT_GOAL_NUDGE_INTERVAL_SECONDS,
            maximum: MAX_PARENT_GOAL_NUDGE_INTERVAL_SECONDS,
          }),
        ),
        pauseReason: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const goal = await parentGoal(
        ctx.cwd,
        params.action,
        params.objective,
        params.status,
        params.nextAction,
        params.nudgeIntervalSeconds,
        params.pauseReason,
        currentRootTurn("active"),
      );
      if (ctx.hasUI) await publishParentGoalSidebar(goal, signal);

      return {
        content: [
          { type: "text", text: `Parent goal ${goal.id}: ${goal.status}` },
        ],
        details: { goal },
      };
    },
  });
  pi.registerTool({
    name: "herdr_question_answer",
    label: "Herdr Question Answer",
    description:
      "Record a user-approved parent answer and deliver it to one mapped child lane.",
    promptSnippet:
      "Answer a durable mapped-child question from the verified controller root.",
    promptGuidelines: [
      "Use only after Zach has answered the exact durable child question. This records and delivers the answer; it never resumes a paused Pi goal.",
    ],
    parameters: Type.Object(
      {
        requestId: Type.String({ minLength: 1 }),
        answer: Type.String({ minLength: 1, maxLength: 6000 }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const question = await answerChildQuestion(
        ctx.cwd,
        params.requestId,
        params.answer,
        signal,
      );
      return {
        content: [
          { type: "text", text: `Delivered parent answer for ${question.id}.` },
        ],
        details: { question },
      };
    },
  });
  pi.registerTool({
    name: "herdr_complete",
    label: "Herdr Complete",
    description:
      "Deliver one verified child completion receipt to the registered controller root.",
    promptSnippet: "Report a completed mapped child lane to its Herdr parent.",
    parameters: Type.Object({
      workflowId: Type.String(),
      summary: Type.String(),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await complete(
        ctx.cwd,
        params.workflowId,
        params.summary,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: `Stored completion receipt ${result.relationshipId}; parent notification: ${result.delivery}.`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_operator_close",
    label: "Herdr Operator Close",
    description:
      "Record a root-authorized operator reconciliation for a lane that could not store its own completion receipt; this never creates or impersonates herdr_complete.",
    promptSnippet:
      "Reconcile a verified receipt-blocked lane with explicit operator, reason, and evidence.",
    promptGuidelines: [
      "Use only from the verified controller-mapped root after independently verifying the lane's work and recording who, why, and concrete evidence.",
      "This operation sets an explicit operator-closed state and never writes a lane completionReceipt.",
    ],
    parameters: Type.Object({
      workflowId: Type.String({ minLength: 1 }),
      laneId: Type.String({ minLength: 1 }),
      who: Type.String({ minLength: 1 }),
      why: Type.String({ minLength: 1 }),
      evidence: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await operatorClose(
        ctx.cwd,
        params.workflowId,
        params.laneId,
        params.who,
        params.why,
        params.evidence,
      );
      return {
        content: [
          {
            type: "text",
            text: `Operator-closed ${params.workflowId}/${params.laneId}; lane completion receipt was not recorded.`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_reparent",
    label: "Herdr Reparent",
    description:
      "Preview or root-confirm a controller-root handoff for one isolated registered workflow.",
    promptSnippet:
      "Reparent an isolated Herdr controller workflow to the verified current root.",
    parameters: Type.Object({
      workflowId: Type.String(),
      execute: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await reparent(
        ctx.cwd,
        params.workflowId,
        params.execute ?? false,
        ctx,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: result.dryRun
              ? `Dry-run reparent for ${params.workflowId}`
              : result.cancelled
                ? "Reparent cancelled"
                : result.unchanged
                  ? "Controller root is already current"
                  : `Reparented ${params.workflowId}`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_plan",
    label: "Herdr Plan",
    description:
      "Create a durable local plan manifest for Herdr-managed agent lanes.",
    promptSnippet: "Plan a Herdr-only delegated agent workflow.",
    promptGuidelines: [
      "Use herdr_plan before herdr_dispatch; select any documented Herdr agentKind when needed. Supply authorizationPolicy only for the narrowly validated BB-029 local-only scope.",
    ],
    parameters: Type.Object(
      {
        objective: Type.String(),
        lanes: Type.Optional(
          Type.Array(
            Type.Union([
              Type.String(),
              Type.Object(
                {
                  objective: Type.String(),
                  readOnly: Type.Optional(Type.Boolean()),
                  agentKind: Type.Optional(Type.String()),
                  dependencies: Type.Optional(Type.Array(Type.String())),
                  dependsOn: Type.Optional(Type.Array(Type.String())),
                  launchProfile: Type.Optional(
                    Type.Object(
                      {
                        provider: Type.String(),
                        model: Type.String(),
                        thinking: Type.String(),
                        auth: Type.Literal("subscription"),
                      },
                      { additionalProperties: false },
                    ),
                  ),
                },
                { additionalProperties: false },
              ),
            ]),
          ),
        ),
        worktreeCwd: Type.Optional(Type.String()),
        agentKind: Type.Optional(Type.String()),
        launchProfile: Type.Optional(
          Type.Object(
            {
              provider: Type.String(),
              model: Type.String(),
              thinking: Type.String(),
              auth: Type.Literal("subscription"),
            },
            { additionalProperties: false },
          ),
        ),
        authorizationPolicy: Type.Optional(
          Type.Object(
            {
              version: Type.Integer({ minimum: 1, maximum: 1 }),
              scope: Type.Object({
                workflow: Type.String(),
                localOnly: Type.Boolean(),
              }),
              capabilities: Type.Array(Type.String(), {
                minItems: 1,
                maxItems: AUTHORIZATION_CAPABILITIES.length,
              }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, _signal, _update, ctx) {
      const workflow = await plan(
        ctx.cwd,
        params.objective,
        (params.lanes ?? []).map((lane) =>
          typeof lane === "string"
            ? lane
            : {
                ...lane,
                agentKind:
                  lane.agentKind === undefined
                    ? undefined
                    : validateAgentKind(lane.agentKind),
              },
        ),
        params.worktreeCwd,
        params.authorizationPolicy,
        params.agentKind,
        params.launchProfile,
      );
      return {
        content: [
          {
            type: "text",
            text: `Planned ${workflow.id} in ${manifestPath(ctx.cwd)}`,
          },
        ],
        details: { workflow },
      };
    },
  });
  pi.registerTool({
    name: "herdr_dispatch",
    label: "Herdr Dispatch",
    description:
      "Dispatch verified lanes into the root-bound task workspace only. Explicit per-lane or workflow-fallback launch profiles and startup proof are mandatory; no workspace creation or model fallback.",
    promptSnippet:
      "Dispatch only a planned Herdr workflow; dry-run by default.",
    promptGuidelines: [
      "Use herdr_dispatch with execute=true only after explicit user intent. A root bypasses UI only when the workflow's validated local authorizationPolicy grants dispatch or retry; children remain UI-free and return parentApprovalRequired.",
    ],
    parameters: Type.Object({
      workflowId: Type.String(),
      execute: Type.Optional(Type.Boolean()),
      restart: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await dispatch(
        ctx.cwd,
        params.workflowId,
        params.execute ?? false,
        ctx,
        signal,
        params.restart ?? false,
      );
      return {
        content: [
          {
            type: "text",
            text: result.dryRun
              ? `Dry-run dispatch for ${params.workflowId}`
              : result.parentApprovalRequired
                ? `Parent approval required for ${params.workflowId}; observe the child through Herdr and approve from the designated root.`
                : result.cancelled
                  ? "Dispatch cancelled"
                  : `Dispatched ${params.workflowId}`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_observe",
    label: "Herdr Observe",
    description:
      "Read a Herdr lane agent's live state and recent output, then update its manifest.",
    promptSnippet: "Observe a dispatched Herdr workflow.",
    parameters: Type.Object({ workflowId: Type.String() }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await observe(ctx.cwd, params.workflowId, signal);
      return {
        content: [
          { type: "text", text: `${params.workflowId}: ${result.state}` },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_resume",
    label: "Herdr Resume",
    description:
      "Preview or explicitly send /goal-resume through Herdr to lanes with a recorded paused Pi goal.",
    promptSnippet:
      "Resume observed paused Pi goals through their recorded Herdr lane agents; dry-run by default.",
    promptGuidelines: [
      "Use herdr_resume only after herdr_observe records a goal-paused workflow. A root bypasses UI only when the workflow's validated local authorizationPolicy grants paused-goal recovery; children remain UI-free and return parentApprovalRequired.",
    ],
    parameters: Type.Object({
      workflowId: Type.String(),
      execute: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await resume(
        ctx.cwd,
        params.workflowId,
        params.execute ?? false,
        ctx,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: result.dryRun
              ? `Dry-run resume for ${params.workflowId}`
              : result.parentApprovalRequired
                ? `Parent approval required for ${params.workflowId}; the designated root must resume the observed goal through Herdr.`
                : result.cancelled
                  ? "Goal resume cancelled"
                  : `Sent /goal-resume to ${result.receipts?.length ?? 0} lane agent(s) for ${params.workflowId}`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_close",
    label: "Herdr Close",
    description:
      "Preview or explicitly close only a recorded extension-owned Herdr workspace; evidence is mandatory.",
    promptSnippet:
      "Close a Herdr workflow only with evidence; dry-run by default.",
    promptGuidelines: [
      "Use herdr_close only after recording concrete evidence and explicit user intent. Child sessions receive a parent-approval-required result; only the verified controller-mapped root may show the confirmation.",
    ],
    parameters: Type.Object({
      workflowId: Type.String(),
      evidence: Type.Array(Type.String(), { minItems: 1 }),
      execute: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await close(
        ctx.cwd,
        params.workflowId,
        params.evidence,
        params.execute ?? false,
        ctx,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: result.dryRun
              ? `Dry-run close for ${params.workflowId}`
              : result.parentApprovalRequired
                ? `Parent approval required for ${params.workflowId}; observe the child through Herdr and approve from the designated root.`
                : result.cancelled
                  ? "Close cancelled"
                  : `Closed ${params.workflowId}`,
          },
        ],
        details: result,
      };
    },
  });
  pi.registerTool({
    name: "herdr_doctor",
    label: "Herdr Doctor",
    description:
      "Idempotent, read-only preflight: extension source, native Herdr connectivity, plugin/routing registration, manifest store version, and the adapter capability matrix. Never mutates anything.",
    promptSnippet:
      "Run a read-only Herdr installation/health preflight before relying on dispatch, goals, or messaging.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const report = await doctor(ctx.cwd, ctx, signal);
      return {
        content: [
          {
            type: "text",
            text: `${report.ok ? "healthy" : "attention required"}: ${report.checks
              .map((entry) => `${entry.id}=${entry.status}`)
              .join(", ")}`,
          },
        ],
        details: report,
      };
    },
  });

  pi.registerCommand("herdr-plan", {
    description: "Create a Herdr workflow plan: /herdr-plan <objective>",
    handler: async (args, ctx) => {
      if (!args.trim()) throw new Error("Usage: /herdr-plan <objective>");
      const workflow = await plan(ctx.cwd, args.trim(), []);
      ctx.ui.notify(`Planned ${workflow.id}`, "info");
    },
  });
  pi.registerCommand("herdr-dispatch", {
    description:
      "Preview or dispatch: /herdr-dispatch <id> [--execute] [--restart]",
    handler: async (args, ctx) => {
      const [id, ...flags] = args.trim().split(/\s+/);
      if (!id) throw new Error("Usage: /herdr-dispatch <id> [--execute]");
      const result = await dispatch(
        ctx.cwd,
        id,
        flags.includes("--execute"),
        ctx,
        undefined,
        flags.includes("--restart"),
      );
      let message = `Dispatched ${id}`;
      if (result.dryRun) message = `Dry-run: ${id}`;
      else if (result.parentApprovalRequired)
        message = `Parent approval required for ${id}; observe the child through Herdr and approve from the designated root.`;
      else if (result.cancelled) message = "Dispatch cancelled";
      ctx.ui.notify(message, "info");
    },
  });
  pi.registerCommand("herdr-observe", {
    description: "Observe a workflow: /herdr-observe <id>",
    handler: async (args, ctx) => {
      if (!args.trim()) throw new Error("Usage: /herdr-observe <id>");
      const result = await observe(ctx.cwd, args.trim());
      ctx.ui.notify(`${args.trim()}: ${result.state}`, "info");
    },
  });
  pi.registerCommand("herdr-resume", {
    description:
      "Preview or resume paused goals: /herdr-resume <id> [--execute]",
    handler: async (args, ctx) => {
      const [id, flag] = args.trim().split(/\s+/);
      if (!id) throw new Error("Usage: /herdr-resume <id> [--execute]");
      const result = await resume(ctx.cwd, id, flag === "--execute", ctx);
      let message = `Sent /goal-resume for ${id}`;
      if (result.dryRun) message = `Dry-run: ${id}`;
      if (result.parentApprovalRequired) return;
      if (result.cancelled) message = "Goal resume cancelled";
      ctx.ui.notify(message, "info");
    },
  });
  pi.registerCommand("herdr-close", {
    description: "Preview or close: /herdr-close <id> <evidence> [--execute]",
    handler: async (args, ctx) => {
      const execute = args.includes("--execute");
      const [id, ...rest] = args.replace("--execute", "").trim().split(/\s+/);
      const evidence = rest.join(" ");
      if (!id || !evidence)
        throw new Error("Usage: /herdr-close <id> <evidence> [--execute]");
      const result = await close(ctx.cwd, id, [evidence], execute, ctx);
      let message = `Closed ${id}`;
      if (result.dryRun) message = `Dry-run: ${id}`;
      else if (result.parentApprovalRequired)
        message = `Parent approval required for ${id}; observe the child through Herdr and approve from the designated root.`;
      else if (result.cancelled) message = "Close cancelled";
      ctx.ui.notify(message, "info");
    },
  });
}
