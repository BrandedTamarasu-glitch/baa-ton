#!/usr/bin/env node
/**
 * Herdr Orchestrator durable event controller.
 *
 * This module intentionally uses only Node built-ins. Event hooks call `hook`
 * with HERDR_PLUGIN_EVENT and HERDR_PLUGIN_EVENT_JSON; the state directory is
 * supplied exclusively by Herdr through HERDR_PLUGIN_STATE_DIR.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { handleActivation } from "./activation.mjs";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const OWNER = "herdr-orchestrator";
const CONFIG_NAME = "config.json";
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 10;
const SOCKET_TIMEOUT_MS = 2_500;
const MIN_NUDGE_INTERVAL_SECONDS = 5;
const MAX_NUDGE_INTERVAL_SECONDS = 86_400;
const ACTIONABLE_CLASSIFICATIONS = new Set(["done", "blocked", "goal-paused"]);
const SUPERVISOR_STATES = new Set(["running", "stopped", "paused"]);
const AGENT_STATUSES = new Set([
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
]);
const EVENT_NAMES = new Map([
  ["pane.agent_status_changed", "pane_agent_status_changed"],
]);
// Work/ready transitions carry fresh terminal output without making ordinary
// done/blocked wakes depend on Pi-specific reads.
const PI_PAUSE_PROBE_STATUSES = new Set(["idle", "working"]);
const WINDOWS_NAMED_PIPE_PREFIX = "\\\\.\\pipe\\";

export class ControllerError extends Error {
  constructor(message, code = "controller_error") {
    super(message);
    this.name = "ControllerError";
    this.code = code;
  }
}

class HerdrApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HerdrApiError";
    this.code = code;
  }
}

const now = () => new Date().toISOString();
const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function assert(condition, message, code = "invalid") {
  if (!condition) throw new ControllerError(message, code);
}

function assertString(value, label) {
  assert(
    typeof value === "string" && value.length > 0,
    `${label} must be a non-empty string.`,
  );
  return value;
}

function assertNullableString(value, label) {
  assert(
    value === null || typeof value === "string",
    `${label} must be a string or null.`,
  );
  return value;
}

function assertSafeUInt(value, label) {
  assert(
    Number.isSafeInteger(value) && value >= 0,
    `${label} must be a non-negative safe integer.`,
  );
  return value;
}

function assertObjectShape(value, label, required, optional = []) {
  assert(isRecord(value), `${label} must be an object.`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value))
    assert(allowed.has(key), `${label}.${key} is not allowed.`);
  for (const key of required)
    assert(key in value, `${label}.${key} is required.`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireStateDir(stateDir = process.env.HERDR_PLUGIN_STATE_DIR) {
  assertString(stateDir, "HERDR_PLUGIN_STATE_DIR");
  assert(isAbsolute(stateDir), "HERDR_PLUGIN_STATE_DIR must be absolute.");
  return resolve(stateDir);
}

function isHerdrSocketPath(path) {
  return (
    isAbsolute(path) ||
    (path.toLowerCase().startsWith(WINDOWS_NAMED_PIPE_PREFIX) &&
      path.length > WINDOWS_NAMED_PIPE_PREFIX.length)
  );
}

async function readRegularFile(path, label) {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new ControllerError(`${label} is missing: ${path}`, "missing");
    throw error;
  }
  assert(details.isFile(), `${label} must be a regular file: ${path}`);
  return readFile(path, "utf8");
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ControllerError(
      `${label} is not valid JSON: ${error.message}`,
      "invalid_json",
    );
  }
}

const TARGET_KINDS = new Set(["name", "pane_id"]);

function validateTarget(value, label, paneId) {
  const target = assertString(value.target, `${label}.target`);
  const targetKind = assertString(value.target_kind, `${label}.target_kind`);
  assert(
    TARGET_KINDS.has(targetKind),
    `${label}.target_kind must be name or pane_id.`,
  );
  if (targetKind === "pane_id") {
    assert(
      target === paneId,
      `${label}.target must equal ${label}.pane_id when target_kind is pane_id.`,
    );
  }
  return { target, target_kind: targetKind };
}

function validateRoot(root) {
  const value = assertObjectShape(
    root,
    "config.root",
    ["target", "target_kind", "pane_id", "workspace_id"],
    ["agent_kind"],
  );
  const paneId = assertString(value.pane_id, "config.root.pane_id");
  const target = validateTarget(value, "config.root", paneId);
  const agentKind =
    "agent_kind" in value
      ? assertString(value.agent_kind, "config.root.agent_kind")
      : undefined;
  const normalized = {
    ...target,
    pane_id: paneId,
    workspace_id: assertString(value.workspace_id, "config.root.workspace_id"),
  };
  return agentKind === undefined
    ? normalized
    : { ...normalized, agent_kind: agentKind };
}

function validateLane(lane, index) {
  const label = `config.workflows[].lanes[${index}]`;
  const value = assertObjectShape(
    lane,
    label,
    ["lane_id", "target", "target_kind", "pane_id", "workspace_id"],
    ["relationship_id"],
  );
  const paneId = assertString(value.pane_id, `${label}.pane_id`);
  return {
    lane_id: assertString(value.lane_id, `${label}.lane_id`),
    ...validateTarget(value, label, paneId),
    pane_id: paneId,
    workspace_id: assertString(value.workspace_id, `${label}.workspace_id`),
    ...(typeof value.relationship_id === "string"
      ? {
          relationship_id: assertString(
            value.relationship_id,
            `${label}.relationship_id`,
          ),
        }
      : {}),
  };
}

function validateWorkflowMapping(workflow, index) {
  const value = assertObjectShape(
    workflow,
    `config.workflows[${index}]`,
    ["workflow_id", "manifest_path", "lanes"],
    ["pi_goal_pause_detection"],
  );
  const manifestPath = assertString(
    value.manifest_path,
    `config.workflows[${index}].manifest_path`,
  );
  assert(
    isAbsolute(manifestPath),
    `config.workflows[${index}].manifest_path must be absolute.`,
  );
  assert(
    Array.isArray(value.lanes) && value.lanes.length > 0,
    `config.workflows[${index}].lanes must be a non-empty array.`,
  );
  const piGoalPauseDetection = value.pi_goal_pause_detection ?? false;
  assert(
    typeof piGoalPauseDetection === "boolean",
    `config.workflows[${index}].pi_goal_pause_detection must be a boolean when present.`,
  );
  const lanes = value.lanes.map(validateLane);
  assert(
    new Set(lanes.map((lane) => lane.lane_id)).size === lanes.length,
    "A workflow mapping cannot repeat lane_id values.",
  );
  assert(
    new Set(lanes.map((lane) => lane.pane_id)).size === lanes.length,
    "A workflow mapping cannot repeat pane_id values.",
  );
  assert(
    new Set(lanes.map((lane) => `${lane.target_kind}:${lane.target}`)).size ===
      lanes.length,
    "A workflow mapping cannot repeat target values.",
  );
  return {
    workflow_id: assertString(
      value.workflow_id,
      `config.workflows[${index}].workflow_id`,
    ),
    manifest_path: resolve(manifestPath),
    pi_goal_pause_detection: piGoalPauseDetection,
    lanes,
  };
}

export function validateOrchestrator(input, index) {
  const label = `config.orchestrators[${index}]`;
  const value = assertObjectShape(input, label, [
    "id",
    "root",
    "program",
    "workflows",
  ]);
  const root = validateRoot(value.root);
  const program = assertObjectShape(
    value.program,
    `${label}.program`,
    ["id", "workspace_id"],
    ["parent_manifest_path"],
  );
  assert(
    Array.isArray(value.workflows),
    `${label}.workflows must be an array.`,
  );
  const workflows = value.workflows.map(validateWorkflowMapping);
  assertString(value.id, `${label}.id`);
  assertString(program.id, `${label}.program.id`);
  assertString(program.workspace_id, `${label}.program.workspace_id`);
  const parentManifestPath =
    "parent_manifest_path" in program
      ? assertString(
          program.parent_manifest_path,
          `${label}.program.parent_manifest_path`,
        )
      : undefined;
  if (parentManifestPath)
    assert(
      isAbsolute(parentManifestPath),
      `${label}.program.parent_manifest_path must be absolute.`,
    );
  assert(
    program.workspace_id === root.workspace_id,
    `${label}.program.workspace_id must equal its root workspace_id.`,
  );
  for (const workflow of workflows)
    for (const lane of workflow.lanes) {
      assert(
        lane.pane_id !== root.pane_id,
        `${label}.root.pane_id must differ from every child lane pane_id.`,
      );
      assert(
        lane.target_kind !== root.target_kind || lane.target !== root.target,
        `${label}.root target must differ from every child lane target.`,
      );
    }
  return {
    id: value.id,
    root,
    program: {
      id: program.id,
      workspace_id: program.workspace_id,
      ...(parentManifestPath
        ? { parent_manifest_path: resolve(parentManifestPath) }
        : {}),
    },
    workflows,
  };
}

// v1 had one global root.  It is accepted only as an in-memory migration so a
// subsequent extension registration can atomically persist v2 without a
// service interruption.
export function validateConfig(input) {
  assert(isRecord(input), "config must be an object.");
  assert(input.owner === OWNER, `config.owner must be ${OWNER}.`);
  if (input.version === 1) {
    const legacy = assertObjectShape(input, "config", [
      "version",
      "owner",
      "root",
      "workflows",
    ]);
    const root = validateRoot(legacy.root);
    const workflows = legacy.workflows.map(validateWorkflowMapping);
    assert(
      Array.isArray(legacy.workflows) && workflows.length > 0,
      "config.workflows must be a non-empty array.",
    );
    return {
      version: 2,
      owner: OWNER,
      migratedFrom: 1,
      orchestrators: [
        {
          id: `legacy:${root.workspace_id}:${root.pane_id}`,
          root,
          program: { id: "legacy-global", workspace_id: root.workspace_id },
          workflows,
        },
      ],
    };
  }
  const value = assertObjectShape(input, "config", [
    "version",
    "owner",
    "orchestrators",
  ]);
  assert(value.version === 2, "config.version must be 1 or 2.");
  assert(
    Array.isArray(value.orchestrators) && value.orchestrators.length > 0,
    "config.orchestrators must be a non-empty array.",
  );
  const orchestrators = value.orchestrators.map(validateOrchestrator);
  assert(
    new Set(orchestrators.map((item) => item.id)).size === orchestrators.length,
    "config cannot repeat orchestrator IDs.",
  );
  const workflowIds = orchestrators.flatMap((item) =>
    item.workflows.map((workflow) => workflow.workflow_id),
  );
  assert(
    new Set(workflowIds).size === workflowIds.length,
    "config cannot repeat workflow_id values across orchestrators.",
  );
  return { version: 2, owner: OWNER, orchestrators };
}

export async function loadConfig(configDir) {
  assertString(configDir, "HERDR_PLUGIN_CONFIG_DIR");
  assert(isAbsolute(configDir), "HERDR_PLUGIN_CONFIG_DIR must be absolute.");
  const directory = resolve(configDir);
  const directoryDetails = await lstat(directory).catch((error) => {
    if (error.code === "ENOENT")
      throw new ControllerError(
        `Controller config directory is missing: ${directory}`,
        "missing_config_directory",
      );
    throw error;
  });
  assert(
    directoryDetails.isDirectory() && !directoryDetails.isSymbolicLink(),
    `Controller config directory must be a real directory: ${directory}`,
  );
  const path = join(directory, CONFIG_NAME);
  const details = await lstat(path).catch((error) => {
    if (error.code === "ENOENT")
      throw new ControllerError(
        `Controller config is missing: ${path}`,
        "missing_config",
      );
    throw error;
  });
  assert(details.isFile(), `Controller config must be a regular file: ${path}`);
  assert(
    (details.mode & 0o022) === 0,
    `Controller config must not be group- or world-writable: ${path}`,
  );
  return validateConfig(
    parseJson(
      await readRegularFile(path, "Controller config"),
      "Controller config",
    ),
  );
}

export function validateHookEnvelope(eventName, envelope) {
  const wireEvent = EVENT_NAMES.get(eventName);
  assert(
    wireEvent,
    `Unsupported plugin event hook: ${eventName}.`,
    "unsupported_event",
  );
  const outer = assertObjectShape(envelope, "event", ["event", "data"]);
  assert(outer.event === wireEvent, `event.event must be ${wireEvent}.`);
  const data = isRecord(outer.data)
    ? outer.data
    : (() => {
        throw new ControllerError("event.data must be an object.");
      })();
  if (eventName === "pane.agent_status_changed") {
    const value = assertObjectShape(
      data,
      "event.data",
      ["type", "pane_id", "workspace_id", "agent_status"],
      ["agent", "display_agent", "state_labels", "title"],
    );
    assert(value.type === wireEvent, `event.data.type must be ${wireEvent}.`);
    assert(
      AGENT_STATUSES.has(value.agent_status),
      "event.data.agent_status is not a supported agent status.",
    );
    if ("agent" in value) assertNullableString(value.agent, "event.data.agent");
    if ("display_agent" in value)
      assertNullableString(value.display_agent, "event.data.display_agent");
    if ("title" in value) assertNullableString(value.title, "event.data.title");
    if ("state_labels" in value) {
      assert(
        isRecord(value.state_labels),
        "event.data.state_labels must be an object.",
      );
      for (const [key, label] of Object.entries(value.state_labels)) {
        assertString(key, "event.data.state_labels key");
        assertString(label, `event.data.state_labels.${key}`);
      }
    }
    const normalized = {
      type: wireEvent,
      pane_id: assertString(value.pane_id, "event.data.pane_id"),
      workspace_id: assertString(value.workspace_id, "event.data.workspace_id"),
      agent_status: value.agent_status,
    };
    if ("agent" in value) normalized.agent = value.agent;
    return { event: eventName, data: normalized };
  }
  const value = assertObjectShape(data, "event.data", [
    "type",
    "pane_id",
    "workspace_id",
    "revision",
  ]);
  assert(value.type === wireEvent, `event.data.type must be ${wireEvent}.`);
  return {
    event: eventName,
    data: {
      type: wireEvent,
      pane_id: assertString(value.pane_id, "event.data.pane_id"),
      workspace_id: assertString(value.workspace_id, "event.data.workspace_id"),
      revision: assertSafeUInt(value.revision, "event.data.revision"),
    },
  };
}

function configuredMappings(config) {
  return config.orchestrators.flatMap((orchestrator) =>
    orchestrator.workflows.map((workflow) => ({ orchestrator, workflow })),
  );
}

function configuredParentManifests(config) {
  return config.orchestrators.flatMap((orchestrator) => {
    const paths = new Set(
      orchestrator.workflows.map((workflow) => workflow.manifest_path),
    );
    if (orchestrator.program.parent_manifest_path)
      paths.add(orchestrator.program.parent_manifest_path);
    return [...paths].map((manifestPath) => ({
      orchestrator,
      manifestPath,
      workflows: orchestrator.workflows.filter(
        (workflow) => workflow.manifest_path === manifestPath,
      ),
    }));
  });
}

function locateMapping(config, event) {
  const matches = [];
  for (const orchestrator of config.orchestrators) {
    for (const workflow of orchestrator.workflows) {
      for (const lane of workflow.lanes) {
        if (
          lane.pane_id === event.data.pane_id &&
          lane.workspace_id === event.data.workspace_id
        ) {
          // Protocol 22 event.data.agent is an agent *kind* (for example pi),
          // never the configured Herdr agent name/prompt target.
          matches.push({ orchestrator, workflow, lane });
        }
      }
    }
  }
  if (matches.length === 0) return undefined;
  assert(
    matches.length === 1,
    "Event matches multiple explicit owner/workflow/child-lane mappings.",
    "ambiguous_mapping",
  );
  return matches[0];
}

function validateMappedWorkflow(manifest, mapping, owner) {
  assert(isRecord(manifest), "Workflow manifest must be an object.");
  assert(
    Array.isArray(manifest.workflows),
    "Workflow manifest must contain workflows.",
  );
  const workflows = manifest.workflows.filter(
    (workflow) =>
      isRecord(workflow) && workflow.id === mapping.workflow.workflow_id,
  );
  assert(
    workflows.length === 1,
    "Manifest does not contain exactly one mapped workflow.",
    "invalid_mapping",
  );
  const workflow = workflows[0];
  assert(
    isRecord(workflow.ownership) && workflow.ownership.createdBy === owner,
    "Manifest workflow is not owned by the configured orchestrator.",
    "invalid_mapping",
  );
  assert(
    Array.isArray(workflow.lanes),
    "Mapped workflow has no lanes.",
    "invalid_mapping",
  );
  const lanes = workflow.lanes.filter(
    (lane) => isRecord(lane) && lane.id === mapping.lane.lane_id,
  );
  assert(
    lanes.length === 1,
    "Manifest does not contain exactly one configured child lane.",
    "invalid_mapping",
  );
  const lane = lanes[0];
  assert(
    lane.paneId === mapping.lane.pane_id,
    "Manifest lane pane ID differs from the explicit mapping.",
    "invalid_mapping",
  );
  // Manifest ownership and pane identity are authoritative. Agent names/kinds
  // are live Herdr metadata, not event-mapping identity.
  return workflow;
}

function validateParentGoal(goal) {
  const value = assertObjectShape(
    goal,
    "manifest.parentGoal",
    [
      "version",
      "id",
      "objective",
      "status",
      "nextAction",
      "signals",
      "createdAt",
      "updatedAt",
    ],
    ["supervisor"],
  );
  assert(value.version === 1, "manifest.parentGoal.version must be 1.");
  for (const key of [
    "id",
    "objective",
    "status",
    "nextAction",
    "createdAt",
    "updatedAt",
  ])
    assertString(value[key], `manifest.parentGoal.${key}`);
  assert(
    Array.isArray(value.signals),
    "manifest.parentGoal.signals must be an array.",
  );
  for (const signal of value.signals) {
    assert(isRecord(signal), "manifest.parentGoal contains an invalid signal.");
    for (const key of [
      "identity",
      "workflowId",
      "laneId",
      "classification",
      "receivedAt",
    ])
      assertString(signal[key], `manifest.parentGoal.signals[].${key}`);
    assert(
      ACTIONABLE_CLASSIFICATIONS.has(signal.classification),
      "manifest.parentGoal signal classification is invalid.",
    );
  }
  if ("supervisor" in value) validateSupervisor(value.supervisor);
  return value;
}

function validateSupervisor(supervisor) {
  const value = assertObjectShape(
    supervisor,
    "manifest.parentGoal.supervisor",
    [
      "version",
      "state",
      "intervalSeconds",
      "nudgeCount",
      "nextNudgeAt",
      "createdAt",
      "updatedAt",
    ],
    [
      "pauseReason",
      "lastNudgeAt",
      "lastAttemptAt",
      "lastDelivery",
      "rootActivity",
      "rootTurn",
    ],
  );
  assert(
    value.version === 1,
    "manifest.parentGoal.supervisor.version must be 1.",
  );
  assert(
    SUPERVISOR_STATES.has(value.state),
    "manifest.parentGoal.supervisor.state is invalid.",
  );
  assert(
    Number.isSafeInteger(value.intervalSeconds) &&
      value.intervalSeconds >= MIN_NUDGE_INTERVAL_SECONDS &&
      value.intervalSeconds <= MAX_NUDGE_INTERVAL_SECONDS,
    `manifest.parentGoal.supervisor.intervalSeconds must be an integer from ${MIN_NUDGE_INTERVAL_SECONDS} to ${MAX_NUDGE_INTERVAL_SECONDS}.`,
  );
  assertSafeUInt(value.nudgeCount, "manifest.parentGoal.supervisor.nudgeCount");
  assert(
    value.nextNudgeAt === null || typeof value.nextNudgeAt === "string",
    "manifest.parentGoal.supervisor.nextNudgeAt must be a string or null.",
  );
  for (const key of ["createdAt", "updatedAt"])
    assertString(value[key], `manifest.parentGoal.supervisor.${key}`);
  for (const key of ["pauseReason", "lastNudgeAt", "lastAttemptAt"])
    if (key in value)
      assertString(value[key], `manifest.parentGoal.supervisor.${key}`);
  if (value.state === "paused")
    assertString(
      value.pauseReason,
      "manifest.parentGoal.supervisor.pauseReason",
    );
  if ("rootActivity" in value) {
    const activity = assertObjectShape(
      value.rootActivity,
      "manifest.parentGoal.supervisor.rootActivity",
      ["status", "observedAt"],
    );
    assert(
      AGENT_STATUSES.has(activity.status),
      "manifest.parentGoal.supervisor.rootActivity.status is invalid.",
    );
    assertString(
      activity.observedAt,
      "manifest.parentGoal.supervisor.rootActivity.observedAt",
    );
  }
  if ("rootTurn" in value) {
    const turn = assertObjectShape(
      value.rootTurn,
      "manifest.parentGoal.supervisor.rootTurn",
      ["state", "runId", "paneId", "workspaceId", "updatedAt"],
    );
    assert(
      new Set(["active", "idle", "unknown"]).has(turn.state),
      "manifest.parentGoal.supervisor.rootTurn.state is invalid.",
    );
    for (const key of ["runId", "paneId", "workspaceId", "updatedAt"])
      assertString(turn[key], `manifest.parentGoal.supervisor.rootTurn.${key}`);
    assert(
      Number.isFinite(Date.parse(turn.updatedAt)),
      "manifest.parentGoal.supervisor.rootTurn.updatedAt is invalid.",
    );
  }
  if ("lastDelivery" in value) {
    const delivery = assertObjectShape(
      value.lastDelivery,
      "manifest.parentGoal.supervisor.lastDelivery",
      ["status", "attemptedAt"],
      ["deliveredAt", "acknowledgedAt", "reason"],
    );
    assert(
      new Set(["sending", "delivered", "pending", "uncertain"]).has(
        delivery.status,
      ),
      "manifest.parentGoal.supervisor.lastDelivery.status is invalid.",
    );
    assertString(
      delivery.attemptedAt,
      "manifest.parentGoal.supervisor.lastDelivery.attemptedAt",
    );
    if ("deliveredAt" in delivery)
      assertString(
        delivery.deliveredAt,
        "manifest.parentGoal.supervisor.lastDelivery.deliveredAt",
      );
    if ("acknowledgedAt" in delivery)
      assertString(
        delivery.acknowledgedAt,
        "manifest.parentGoal.supervisor.lastDelivery.acknowledgedAt",
      );
    if ("reason" in delivery)
      assertString(
        delivery.reason,
        "manifest.parentGoal.supervisor.lastDelivery.reason",
      );
  }
  return value;
}

function signalParentGoal(manifest, record) {
  if (!("parentGoal" in manifest)) return;
  const goal = validateParentGoal(manifest.parentGoal);
  if (!ACTIONABLE_CLASSIFICATIONS.has(record.classification)) return;
  if (
    !goal.signals.some(
      (signal) => isRecord(signal) && signal.identity === record.identity,
    )
  ) {
    goal.signals.push({
      identity: record.identity,
      workflowId: record.workflow_id,
      laneId: record.lane_id,
      classification: record.classification,
      receivedAt: record.received_at,
    });
  }
  // A completed or explicitly blocked parent goal must never be revived by a
  // late lane hook; the durable signal remains available for manual review.
  if (
    goal.status !== "completed" &&
    goal.status !== "blocked" &&
    goal.status !== "paused"
  )
    goal.status = "action-required";
  goal.nextAction = `Review durable ${record.classification} event ${record.identity} for ${record.workflow_id}/${record.lane_id}; continue authorized safe local work or persist a truthful waiting/blocked state.`;
  goal.updatedAt = now();
}

function ensureLedger(workflow) {
  if (!("eventController" in workflow)) {
    workflow.eventController = { version: 1, events: [] };
  }
  const ledger = workflow.eventController;
  assertObjectShape(ledger, "workflow.eventController", ["version", "events"]);
  assert(ledger.version === 1, "workflow.eventController.version must be 1.");
  assert(
    Array.isArray(ledger.events),
    "workflow.eventController.events must be an array.",
  );
  for (const event of ledger.events) {
    assert(
      isRecord(event) &&
        typeof event.identity === "string" &&
        typeof event.classification === "string" &&
        isRecord(event.wake) &&
        typeof event.wake.status === "string" &&
        Number.isSafeInteger(event.wake.attempts) &&
        event.wake.attempts >= 0,
      "workflow.eventController contains an invalid event record.",
    );
  }
  return ledger;
}

async function atomicWriteJson(path, value) {
  const original = await lstat(path);
  assert(original.isFile(), `Manifest must be a regular file: ${path}`);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.event-controller-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: original.mode & 0o777,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function acquireManifestLock(manifestPath) {
  // This sibling lock is shared with the global Pi extension's herdr_goal
  // writer. Controller state-dir locks cannot protect that separate process.
  const lockPath = join(
    dirname(manifestPath),
    `.${basename(manifestPath)}.herdr-orchestrator.lock`,
  );
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, created_at: now() })}\n`,
        { mode: 0o600 },
      );
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new ControllerError(
          `Timed out acquiring controller lock for ${manifestPath}.`,
          "lock_timeout",
        );
      await sleep(LOCK_RETRY_MS);
    }
  }
}

export class JsonLineHerdrClient {
  constructor(
    socketPath = process.env.HERDR_SOCKET_PATH,
    timeoutMs = SOCKET_TIMEOUT_MS,
  ) {
    assertString(socketPath, "HERDR_SOCKET_PATH");
    assert(
      isHerdrSocketPath(socketPath),
      "HERDR_SOCKET_PATH must be an absolute POSIX socket path or Windows named pipe.",
    );
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  request(method, params) {
    const id = randomUUID();
    return new Promise((resolveRequest, rejectRequest) => {
      const socket = net.createConnection({ path: this.socketPath });
      let settled = false;
      let sent = false;
      let buffer = "";
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        callback(value);
      };
      // A failure raised once the request bytes were already written cannot
      // prove Herdr never received or acted on it: mark it ambiguous so a
      // caller never treats it as safe-to-retry proof of nondelivery.
      const fail = (code, message) => {
        const error = new HerdrApiError(code, message);
        error.sent = sent;
        settle(rejectRequest, error);
      };
      socket.setEncoding("utf8");
      socket.setTimeout(this.timeoutMs);
      socket.once("timeout", () =>
        fail("socket_timeout", `Timed out calling Herdr ${method}.`),
      );
      socket.once("error", (error) =>
        fail(
          error.code ?? "socket_error",
          `Herdr socket ${method} failed: ${error.message}`,
        ),
      );
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        let response;
        try {
          response = JSON.parse(buffer.slice(0, newline));
        } catch (error) {
          settle(
            rejectRequest,
            new HerdrApiError(
              "invalid_response",
              `Herdr returned invalid JSON: ${error.message}`,
            ),
          );
          return;
        }
        if (!isRecord(response) || response.id !== id) {
          settle(
            rejectRequest,
            new HerdrApiError(
              "invalid_response",
              "Herdr returned an unexpected response ID.",
            ),
          );
          return;
        }
        if (
          isRecord(response.error) &&
          typeof response.error.code === "string" &&
          typeof response.error.message === "string"
        ) {
          settle(
            rejectRequest,
            new HerdrApiError(response.error.code, response.error.message),
          );
          return;
        }
        if (!("result" in response)) {
          settle(
            rejectRequest,
            new HerdrApiError(
              "invalid_response",
              "Herdr response has neither result nor error.",
            ),
          );
          return;
        }
        settle(resolveRequest, response.result);
      });
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
        sent = true;
      });
    });
  }
}

function extractAgentRead(result, expectedPaneId) {
  assert(
    isRecord(result) && result.type === "pane_read" && isRecord(result.read),
    "Herdr agent.read returned an invalid response.",
    "invalid_response",
  );
  const read = result.read;
  assert(
    read.pane_id === expectedPaneId,
    "Herdr agent.read response belongs to an unmapped pane.",
    "invalid_response",
  );
  return assertString(read.text, "Herdr agent.read response text");
}

function pausedGoalIds(output) {
  const ids = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (!/\bpaus(?:e|ed|ing)\b/i.test(line)) continue;
    for (const match of line.matchAll(/\bpi-goal-[a-z0-9][a-z0-9_-]*\b/gi))
      ids.add(match[0].toLowerCase());
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

async function classifyEvent(event, mapping, herdr) {
  const fallback = {
    classification:
      event.data.agent_status === "done" ||
      event.data.agent_status === "blocked"
        ? event.data.agent_status
        : "unclassified",
    source: { agent_status: event.data.agent_status },
  };
  if (
    !mapping.workflow.pi_goal_pause_detection ||
    !PI_PAUSE_PROBE_STATUSES.has(event.data.agent_status)
  )
    return fallback;
  try {
    // This one bounded read is triggered by a supported state-change hook; it
    // does not poll and runs only for an explicitly Pi-enabled workflow.
    const result = await herdr.request("agent.read", {
      target: mapping.lane.target,
      source: "recent_unwrapped",
      lines: 120,
      strip_ansi: true,
    });
    const output = extractAgentRead(result, mapping.lane.pane_id);
    const goalIds = pausedGoalIds(output);
    const source = {
      agent_status: event.data.agent_status,
      output_sha256: sha256(output),
    };
    if (goalIds.length > 0) source.goal_ids = goalIds;
    return {
      classification:
        goalIds.length > 0 ? "goal-paused" : fallback.classification,
      source,
    };
  } catch (error) {
    return {
      ...fallback,
      source: {
        agent_status: event.data.agent_status,
        read_error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function rootAgent(result, root) {
  if (
    !isRecord(result) ||
    result.type !== "agent_info" ||
    !isRecord(result.agent)
  )
    return undefined;
  const agent = result.agent;
  if (
    agent.pane_id !== root.pane_id ||
    agent.workspace_id !== root.workspace_id
  )
    return undefined;
  if (root.target_kind === "name" && agent.name !== root.target)
    return undefined;
  if (root.target_kind === "pane_id" && root.target !== root.pane_id)
    return undefined;
  if (root.agent_kind !== undefined && agent.agent !== root.agent_kind)
    return undefined;
  return agent;
}

function rootMatches(result, root) {
  return rootAgent(result, root) !== undefined;
}

function rootEventMatches(event, root) {
  return (
    event.data.pane_id === root.pane_id &&
    event.data.workspace_id === root.workspace_id
  );
}

function unavailable(error) {
  return (
    error instanceof HerdrApiError &&
    new Set([
      "agent_not_found",
      "agent_not_running",
      "agent_blocked",
      "agent_pane_not_found",
      "agent_pane_unavailable",
      "server_unavailable",
      "socket_timeout",
      "socket_error",
      "ECONNREFUSED",
      "ENOENT",
    ]).has(error.code)
  );
}

const GOAL_SIDEBAR_TOKEN_NAMES = [
  "herdr_goal_status",
  "herdr_goal_next_1",
  "herdr_goal_next_2",
  "herdr_goal_next_3",
];

function wrapSidebarText(text, width = 20) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines = [];
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

function parentGoalSidebarTokens(goal) {
  const next = wrapSidebarText(goal.nextAction).slice(0, 3);
  return {
    herdr_goal_status: `Goal: ${goal.status.replaceAll("-", " ")}`,
    herdr_goal_next_1: next[0] ? `Next: ${next[0]}` : null,
    herdr_goal_next_2: next[1] ?? null,
    herdr_goal_next_3: next[2] ?? null,
  };
}

function parentGoalMobileLabel(goal) {
  return `Goal: ${goal.status.replaceAll("-for-event", "").replaceAll("-", " ")}`;
}

async function publishParentGoalSidebar(goal, root, herdr) {
  // Display-only metadata is best effort: delivery or terminal failures must
  // never change the durable controller outcome.
  try {
    await herdr.request("pane.report_metadata", {
      pane_id: root.pane_id,
      source: OWNER,
      tokens: parentGoalSidebarTokens(goal),
      // The compact/mobile switcher ignores sidebar rows but shows state labels.
      state_labels: {
        idle: parentGoalMobileLabel(goal),
        done: parentGoalMobileLabel(goal),
      },
      ttl_ms: 86_400_000,
    });
  } catch {
    // The root extension republishes on session start and direct goal changes.
  }
}

function wakeText(record) {
  return [
    `[Herdr Orchestrator event] ${record.classification}: workflow ${record.workflow_id}, lane ${record.lane_id}.`,
    `Durable event identity: ${record.identity}. Review the workflow manifest eventController ledger.`,
    "This notification is observational only: do not dispatch, resume, close, push, merge, create a PR, deploy, or mutate production from it.",
  ].join(" ");
}

async function deliverWake(record, root, herdr) {
  try {
    const rootInfo = await herdr.request("agent.get", { target: root.target });
    if (!rootMatches(rootInfo, root)) {
      return {
        status: "pending",
        reason: "recorded_root_unavailable_or_mismatched",
      };
    }
  } catch (error) {
    if (unavailable(error))
      return { status: "pending", reason: `root_unavailable:${error.code}` };
    return {
      status: "uncertain",
      reason: `root_check_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    // Deliberately omit `wait`: this is a wake notification, never a foreground wait.
    await herdr.request("agent.prompt", {
      target: root.target,
      text: wakeText(record),
    });
    return { status: "delivered", reason: "agent_prompt_accepted" };
  } catch (error) {
    // A failure raised after the prompt bytes were already written (timeout
    // or transport error awaiting the reply) is not proof of nondelivery and
    // must never be replayed automatically, regardless of its error code.
    if (error?.sent)
      return {
        status: "uncertain",
        reason: `root_prompt_ambiguous:${error instanceof Error ? error.message : String(error)}`,
      };
    if (unavailable(error))
      return { status: "pending", reason: `root_unavailable:${error.code}` };
    return {
      status: "uncertain",
      reason: `root_prompt_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function supervisorWakeText(goal) {
  return [
    `[Herdr Orchestrator supervisor] Parent goal ${goal.id} remains active.`,
    `Objective: ${goal.objective}`,
    `Next action: ${goal.nextAction}`,
    "Continue the active goal autonomously through as many safe local actions as needed; update or pause it only when waiting for an external event, blocked, paused, or complete. Do not dispatch, resume, close, push, merge, create a PR, deploy, or mutate production without explicit user approval.",
  ].join(" ");
}

async function deliverSupervisorNudge(goal, root, herdr) {
  try {
    const rootInfo = await herdr.request("agent.get", { target: root.target });
    const agent = rootAgent(rootInfo, root);
    if (!agent)
      return {
        status: "pending",
        reason: "recorded_root_unavailable_or_mismatched",
      };
    if (agent.agent_status !== "idle" && agent.agent_status !== "done")
      return {
        status: "pending",
        reason: `root_not_idle:${String(agent.agent_status)}`,
      };
  } catch (error) {
    if (unavailable(error))
      return { status: "pending", reason: `root_unavailable:${error.code}` };
    return {
      status: "uncertain",
      reason: `root_check_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    await herdr.request("agent.prompt", {
      target: root.target,
      text: supervisorWakeText(goal),
    });
    return { status: "delivered", reason: "agent_prompt_accepted" };
  } catch (error) {
    // Same ambiguous-send rule as deliverWake: a post-write failure can never
    // be treated as a definite non-delivery safe to retry.
    if (error?.sent)
      return {
        status: "uncertain",
        reason: `root_prompt_ambiguous:${error instanceof Error ? error.message : String(error)}`,
      };
    if (unavailable(error))
      return { status: "pending", reason: `root_unavailable:${error.code}` };
    return {
      status: "uncertain",
      reason: `root_prompt_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function nudgeDue(supervisor, timestamp) {
  if (supervisor.state !== "running" || supervisor.nextNudgeAt === null)
    return false;
  const dueAt = Date.parse(supervisor.nextNudgeAt);
  return Number.isFinite(dueAt) && dueAt <= Date.parse(timestamp);
}

function nextNudgeAt(timestamp, intervalSeconds) {
  return new Date(Date.parse(timestamp) + intervalSeconds * 1000).toISOString();
}

async function observeRootActivity(root, herdr, timestamp) {
  try {
    const result = await herdr.request("agent.get", { target: root.target });
    const agent = rootAgent(result, root);
    if (!agent)
      return {
        available: false,
        reason: "recorded_root_unavailable_or_mismatched",
      };
    if (!AGENT_STATUSES.has(agent.agent_status))
      return { available: false, reason: "root_status_invalid" };
    return {
      available: true,
      status: agent.agent_status,
      observedAt: timestamp,
    };
  } catch (error) {
    if (unavailable(error))
      return { available: false, reason: `root_unavailable:${error.code}` };
    return {
      available: false,
      reason: `root_check_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function runSupervisorTick({
  stateDir = process.env.HERDR_PLUGIN_STATE_DIR,
  configDir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? stateDir,
  herdr,
  timestamp = now(),
} = {}) {
  requireStateDir(stateDir);
  const config = await loadConfig(configDir);
  const api = herdr ?? new JsonLineHerdrClient();
  const results = [];
  const seenManifests = new Set();
  for (const entry of configuredParentManifests(config)) {
    const { orchestrator, manifestPath, workflows } = entry;
    const manifestKey = `${orchestrator.id}:${manifestPath}`;
    if (seenManifests.has(manifestKey)) continue;
    seenManifests.add(manifestKey);
    const release = await acquireManifestLock(manifestPath);
    try {
      const manifest = parseJson(
        await readRegularFile(manifestPath, "Parent manifest"),
        "Parent manifest",
      );
      // Do not schedule against an unowned or stale registration merely because
      // it shares a manifest with a valid workflow in this orchestrator.
      for (const candidate of workflows)
        validateMappedWorkflow(
          manifest,
          { workflow: candidate, lane: candidate.lanes[0] },
          config.owner,
        );
      if (!("parentGoal" in manifest)) {
        results.push({ manifestPath, status: "no-parent-goal" });
        continue;
      }
      const goal = validateParentGoal(manifest.parentGoal);
      if (!("supervisor" in goal)) {
        results.push({ manifestPath, status: "supervisor-stopped" });
        continue;
      }
      const supervisor = goal.supervisor;
      // A supervisor is a nudge for an actively-owned next action only. It
      // must never revive waiting, paused, blocked, or completed parent goals.
      if (goal.status !== "active" || supervisor.state !== "running") {
        results.push({ manifestPath, status: "not-active" });
        continue;
      }
      if (supervisor.lastDelivery?.status === "sending") {
        supervisor.lastDelivery = {
          status: "uncertain",
          attemptedAt: supervisor.lastDelivery.attemptedAt,
          reason: "interrupted_root_delivery_requires_parent_review",
        };
        supervisor.nextNudgeAt = null;
        supervisor.updatedAt = timestamp;
        goal.updatedAt = timestamp;
        await atomicWriteJson(manifestPath, manifest);
        results.push({ manifestPath, status: "uncertain" });
        continue;
      }
      // A successful or ambiguous send consumes this wake authorization forever,
      // including old manifests that still contain a periodic nextNudgeAt.
      if (
        ["delivered", "uncertain"].includes(supervisor.lastDelivery?.status)
      ) {
        results.push({ manifestPath, status: "wake-suppressed" });
        continue;
      }
      if (!nudgeDue(supervisor, timestamp)) {
        results.push({ manifestPath, status: "not-due" });
        continue;
      }
      const turn = supervisor.rootTurn;
      if (
        !turn ||
        turn.state !== "idle" ||
        turn.paneId !== orchestrator.root.pane_id ||
        turn.workspaceId !== orchestrator.root.workspace_id ||
        orchestrator.root.agent_kind !== "pi"
      ) {
        results.push({ manifestPath, status: "root-turn-not-idle" });
        continue;
      }
      // Live Herdr status can veto delivery, but can never create idle authority.
      const activity = await observeRootActivity(
        orchestrator.root,
        api,
        timestamp,
      );
      if (!activity.available) {
        supervisor.lastAttemptAt = timestamp;
        supervisor.lastDelivery = {
          status: "pending",
          attemptedAt: timestamp,
          reason: activity.reason,
        };
        supervisor.nextNudgeAt = nextNudgeAt(
          timestamp,
          supervisor.intervalSeconds,
        );
        supervisor.updatedAt = timestamp;
        goal.updatedAt = timestamp;
        await atomicWriteJson(manifestPath, manifest);
        results.push({ manifestPath, status: "pending" });
        continue;
      }
      supervisor.rootActivity = {
        status: activity.status,
        observedAt: activity.observedAt,
      };
      // Herdr's done is an unseen completion, also ready for input. The Pi
      // settled proof above is still mandatory for either ready state.
      if (activity.status !== "idle" && activity.status !== "done") {
        supervisor.nextNudgeAt = nextNudgeAt(
          timestamp,
          supervisor.intervalSeconds,
        );
        supervisor.updatedAt = timestamp;
        goal.updatedAt = timestamp;
        await atomicWriteJson(manifestPath, manifest);
        results.push({ manifestPath, status: "root-not-idle" });
        continue;
      }
      const attemptedAt = timestamp;
      supervisor.lastAttemptAt = attemptedAt;
      supervisor.lastDelivery = { status: "sending", attemptedAt };
      supervisor.nextNudgeAt = null;
      supervisor.updatedAt = timestamp;
      goal.updatedAt = timestamp;
      await atomicWriteJson(manifestPath, manifest);
      const outcome = await deliverSupervisorNudge(
        goal,
        orchestrator.root,
        api,
      );
      supervisor.lastDelivery = {
        status: outcome.status,
        attemptedAt,
        ...(outcome.status === "delivered" ? { deliveredAt: timestamp } : {}),
        reason: outcome.reason,
      };
      if (outcome.status === "delivered") {
        supervisor.nudgeCount += 1;
        supervisor.lastNudgeAt = supervisor.lastDelivery.deliveredAt;
      } else if (outcome.status === "pending") {
        // Only a definite pre-delivery failure is retryable.
        supervisor.nextNudgeAt = nextNudgeAt(
          timestamp,
          supervisor.intervalSeconds,
        );
      }
      supervisor.updatedAt = timestamp;
      goal.updatedAt = supervisor.updatedAt;
      await atomicWriteJson(manifestPath, manifest);
      results.push({ manifestPath, status: outcome.status });
    } finally {
      await release();
    }
  }
  return { accepted: true, results };
}

function newRecord(event, mapping, classification) {
  const identity = sha256(
    canonicalJson({ event: event.event, data: event.data }),
  );
  return {
    identity,
    received_at: now(),
    event: event.event,
    workflow_id: mapping.workflow.workflow_id,
    lane_id: mapping.lane.lane_id,
    pane_id: mapping.lane.pane_id,
    workspace_id: mapping.lane.workspace_id,
    agent_target: mapping.lane.target,
    ...(mapping.lane.relationship_id
      ? { relationship_id: mapping.lane.relationship_id }
      : {}),
    classification: classification.classification,
    source: classification.source,
    wake: {
      status: ACTIONABLE_CLASSIFICATIONS.has(classification.classification)
        ? "pending"
        : "not-required",
      attempts: 0,
      updated_at: now(),
    },
  };
}

async function updateWake(manifestPath, manifest, record, patch) {
  record.wake = { ...record.wake, ...patch, updated_at: now() };
  await atomicWriteJson(manifestPath, manifest);
}

async function recordRootActivity(config, event) {
  const timestamp = now();
  const results = [];
  const seenManifests = new Set();
  for (const entry of configuredParentManifests(config)) {
    const { orchestrator, manifestPath, workflows } = entry;
    // A root status is scoped to its own record; no cross-root activity writes.
    if (!rootEventMatches(event, orchestrator.root)) continue;
    const manifestKey = `${orchestrator.id}:${manifestPath}`;
    if (seenManifests.has(manifestKey)) continue;
    seenManifests.add(manifestKey);
    const release = await acquireManifestLock(manifestPath);
    try {
      const manifest = parseJson(
        await readRegularFile(manifestPath, "Parent manifest"),
        "Parent manifest",
      );
      for (const candidate of workflows)
        validateMappedWorkflow(
          manifest,
          { workflow: candidate, lane: candidate.lanes[0] },
          config.owner,
        );
      if (
        !("parentGoal" in manifest) ||
        !("supervisor" in manifest.parentGoal)
      ) {
        results.push({ manifestPath, status: "no-supervisor" });
        continue;
      }
      const goal = validateParentGoal(manifest.parentGoal);
      // Detection hooks are telemetry, not Pi run boundaries. In particular an
      // idle/done event between tool calls must not release rootTurn or a wake.
      goal.supervisor.rootActivity = {
        status: event.data.agent_status,
        observedAt: timestamp,
      };
      goal.supervisor.updatedAt = timestamp;
      goal.updatedAt = timestamp;
      await atomicWriteJson(manifestPath, manifest);
      results.push({ manifestPath, status: "recorded" });
    } finally {
      await release();
    }
  }
  return { accepted: true, rootActivity: results };
}

/**
 * Handles exactly one hook. It is exported for foreground tests; normal plugin
 * execution calls it with the Herdr-provided environment variables.
 */
export async function handleHook({
  eventName = process.env.HERDR_PLUGIN_EVENT,
  eventJson = process.env.HERDR_PLUGIN_EVENT_JSON,
  stateDir = process.env.HERDR_PLUGIN_STATE_DIR,
  configDir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? stateDir,
  herdr,
} = {}) {
  assertString(eventName, "HERDR_PLUGIN_EVENT");
  const rawEnvelope =
    typeof eventJson === "string"
      ? parseJson(eventJson, "HERDR_PLUGIN_EVENT_JSON")
      : eventJson;
  const event = validateHookEnvelope(eventName, rawEnvelope);
  requireStateDir(stateDir);
  let config;
  try {
    config = await loadConfig(configDir);
  } catch (error) {
    // An enabled controller may receive ordinary pane events before the root
    // has dispatched its first workflow and atomically installed config.json.
    // Only that exact absent-file case is inert; malformed or unsafe existing
    // config remains a visible, fail-closed hook error.
    if (error instanceof ControllerError && error.code === "missing_config")
      return { accepted: true, ignored: true, reason: "missing_config" };
    throw error;
  }
  const mapping = locateMapping(config, event);
  // A linked plugin sees every pane status transition. Root transitions are
  // durable activity evidence for idle-only nudging; other panes are inert.
  if (!mapping) {
    if (
      config.orchestrators.some((orchestrator) =>
        rootEventMatches(event, orchestrator.root),
      )
    ) {
      const activation = await handleActivation(
        configDir,
        event,
        herdr ?? new JsonLineHerdrClient(),
      );
      if (activation) return activation;
      return recordRootActivity(config, event);
    }
    return { accepted: true, ignored: true, reason: "unmapped_event" };
  }
  const api = herdr ?? new JsonLineHerdrClient();
  const release = await acquireManifestLock(mapping.workflow.manifest_path);
  try {
    const manifest = parseJson(
      await readRegularFile(
        mapping.workflow.manifest_path,
        "Workflow manifest",
      ),
      "Workflow manifest",
    );
    const workflow = validateMappedWorkflow(manifest, mapping, config.owner);
    const ledger = ensureLedger(workflow);
    const identity = sha256(
      canonicalJson({ event: event.event, data: event.data }),
    );
    let record = ledger.events.find((entry) => entry.identity === identity);
    const created = !record;
    if (!record) {
      const classification = await classifyEvent(event, mapping, api);
      record = newRecord(event, mapping, classification);
      ledger.events.push(record);
      signalParentGoal(manifest, record);
      await atomicWriteJson(mapping.workflow.manifest_path, manifest);
      if ("parentGoal" in manifest)
        await publishParentGoalSidebar(
          validateParentGoal(manifest.parentGoal),
          mapping.orchestrator.root,
          api,
        );
    }
    if (!ACTIONABLE_CLASSIFICATIONS.has(record.classification)) {
      return { accepted: true, deduplicated: !created, record };
    }
    if (
      record.wake.status === "delivered" ||
      record.wake.status === "uncertain"
    ) {
      return { accepted: true, deduplicated: true, record };
    }
    if (record.wake.status === "sending") {
      await updateWake(mapping.workflow.manifest_path, manifest, record, {
        status: "uncertain",
        reason: "interrupted_root_delivery_requires_parent_review",
      });
      return { accepted: true, deduplicated: true, record };
    }
    await updateWake(mapping.workflow.manifest_path, manifest, record, {
      status: "sending",
      attempts: Number.isSafeInteger(record.wake.attempts)
        ? record.wake.attempts + 1
        : 1,
      reason: "root_delivery_started",
    });
    const outcome = await deliverWake(record, mapping.orchestrator.root, api);
    await updateWake(mapping.workflow.manifest_path, manifest, record, outcome);
    return { accepted: true, deduplicated: !created, record };
  } finally {
    await release();
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user; any other
    // failure (notably ESRCH) means a stale lease may be reclaimed.
    return error.code === "EPERM";
  }
}

async function supervisorLeaseDirectory(configDir) {
  assertString(configDir, "HERDR_PLUGIN_CONFIG_DIR");
  assert(isAbsolute(configDir), "HERDR_PLUGIN_CONFIG_DIR must be absolute.");
  const directory = resolve(configDir);
  const details = await lstat(directory).catch((error) => {
    if (error.code === "ENOENT")
      throw new ControllerError(
        `Controller config directory is missing: ${directory}`,
        "missing_config_directory",
      );
    throw error;
  });
  assert(
    details.isDirectory() &&
      !details.isSymbolicLink() &&
      (details.mode & 0o022) === 0,
    `Controller config directory must be a private real directory: ${directory}`,
  );
  return directory;
}

async function acquireSupervisorLease(leaseDirectory) {
  // Herdr may create a fresh state directory for each startup invocation.
  // The plugin config directory is stable per linked plugin, so the singleton
  // lease must live there rather than in an invocation-local state directory.
  const leasePath = join(leaseDirectory, "supervisor.lock");
  while (true) {
    try {
      await mkdir(leasePath, { mode: 0o700 });
      await writeFile(
        join(leasePath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, created_at: now() })}\n`,
        { mode: 0o600 },
      );
      return async () => rm(leasePath, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(
          await readRegularFile(
            join(leasePath, "owner.json"),
            "Supervisor lease",
          ),
        );
        if (
          Number.isSafeInteger(owner.pid) &&
          owner.pid > 0 &&
          !processIsAlive(owner.pid)
        ) {
          await rm(leasePath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // An incomplete or unreadable lease could belong to a process that is
        // still starting. Keep it rather than risking a duplicate supervisor.
      }
      return undefined;
    }
  }
}

export async function runSupervisorLoop({
  intervalMs = 5_000,
  stateDir = process.env.HERDR_PLUGIN_STATE_DIR,
  configDir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? stateDir,
  herdr,
} = {}) {
  assert(
    Number.isSafeInteger(intervalMs) && intervalMs >= 5_000,
    "Supervisor scheduler interval must be at least 5000ms.",
  );
  const resolvedStateDir = requireStateDir(stateDir);
  const resolvedConfigDir = await supervisorLeaseDirectory(configDir);
  const releaseLease = await acquireSupervisorLease(resolvedConfigDir);
  if (!releaseLease)
    return {
      started: false,
      reason: "supervisor_already_running",
      stop: async () => {},
    };
  let stopping = false;
  let ticking = false;
  let timer;
  let inFlightTick;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    // Keep the lease until a tick that already owns the manifest lock has
    // settled. A restart must see this process as the supervisor rather than
    // overlap a late socket delivery with a new scheduler.
    await inFlightTick;
    await releaseLease();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  const tick = () => {
    if (stopping || ticking) return Promise.resolve();
    ticking = true;
    const current = (async () => {
      try {
        await runSupervisorTick({
          stateDir: resolvedStateDir,
          configDir: resolvedConfigDir,
          herdr,
        });
      } catch (error) {
        process.stderr.write(
          `herdr-orchestrator-controller supervisor: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } finally {
        ticking = false;
      }
    })();
    inFlightTick = current;
    return current.finally(() => {
      if (inFlightTick === current) inFlightTick = undefined;
    });
  };
  // Herdr restarts restore panes and agents asynchronously. Do not make an
  // immediate startup nudge race that restoration; the first normal interval
  // is the server-settle window, then later ticks retain the same cadence.
  timer = setInterval(() => void tick(), intervalMs);
  return { started: true, stop };
}

export function hookResponse(result) {
  if (result.ignored)
    return { accepted: true, ignored: true, reason: result.reason };
  // Root activity hooks intentionally persist supervisor state without adding
  // a lane-event ledger record, so they have no record.identity or wake.
  if (result.rootActivity)
    return { accepted: true, rootActivity: result.rootActivity };
  return {
    accepted: result.accepted,
    deduplicated: result.deduplicated,
    identity: result.record.identity,
    wake: result.record.wake.status,
  };
}

async function main() {
  const command = process.argv[2];
  if (command === "hook") {
    const result = await handleHook();
    process.stdout.write(`${JSON.stringify(hookResponse(result))}\n`);
    return;
  }
  if (command === "supervisor-once") {
    process.stdout.write(`${JSON.stringify(await runSupervisorTick())}\n`);
    return;
  }
  if (command === "supervisor") {
    await runSupervisorLoop();
    return;
  }
  throw new ControllerError(
    "Usage: node controller.mjs <hook|supervisor-once|supervisor>.",
    "usage",
  );
}

let launchedDirectly = false;
try {
  launchedDirectly =
    Boolean(process.argv[1]) &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url);
} catch {
  launchedDirectly = false;
}
if (launchedDirectly) {
  main().catch((error) => {
    process.stderr.write(
      `herdr-orchestrator-controller: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
