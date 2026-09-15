import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Workflow, Lane } from "./index.js";
import {
  LAUNCH_PROFILE_SCHEMA_VERSION,
  validateLaunchProfile,
} from "./launch-profile.js";
import {
  STARTUP_PROOF_REQUIRED_OPERATIONS,
  missingRequiredAdapterCapabilities,
  type HarnessLaunchAdapter,
} from "./harness-adapter.js";

export type DispatchPorts = {
  directory: string;
  source: string;
  adapter(kind: string): HarnessLaunchAdapter;
  run(args: string[], signal?: AbortSignal, timeout?: number): Promise<any>;
  update(id: string, edit: (workflow: Workflow) => void): Promise<Workflow>;
  verifyRoot(workflow: Workflow): Promise<void>;
  authorize(workflow: Workflow): Promise<boolean>;
  register(workflow: Workflow): Promise<void>;
  contract(workflow: Workflow, lane: Lane): string;
  busyRetryDelayMs?: number;
};

export type DispatchOptions = {
  /** Rebind each lane to a new, orchestrator-authorized incarnation. */
  restart?: boolean;
};

function nativeAgent(raw: any): any {
  return (raw?.result ?? raw)?.agent;
}

function nativeSession(
  agent: any,
): { kind: "path" | "id"; value: string } | undefined {
  const session = agent?.agent_session;
  if (session?.kind === "path" || session?.kind === "id") {
    return typeof session.value === "string" && session.value
      ? { kind: session.kind, value: session.value }
      : undefined;
  }
  return undefined;
}

function sameSession(
  left: { kind: "path" | "id"; value: string } | undefined,
  right: { kind: "path" | "id"; value: string } | undefined,
): boolean {
  return Boolean(
    left && right && left.kind === right.kind && left.value === right.value,
  );
}

/** Herdr has no native wait-for-shell command. `pane process-info` is the
 * native readiness signal: a pane is startable when its interactive shell is
 * the only foreground process (shell_pid set and matching). Gating on it
 * removes the tab-create/agent-start race without prompt-string matching. */
async function waitForShellReady(
  port: DispatchPorts,
  paneId: string,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const raw = await port.run(
      ["pane", "process-info", "--pane", paneId],
      signal,
    );
    const info = (raw.result ?? raw).process_info;
    if (
      info?.shell_pid &&
      Array.isArray(info.foreground_processes) &&
      info.foreground_processes.length === 1 &&
      info.foreground_processes[0]?.pid === info.shell_pid
    )
      return;
    await delay(300, { signal });
  }
  throw new Error(
    `Pane ${paneId} shell did not become ready for agent start; inspect it before retrying.`,
  );
}

/** The only dispatch implementation. Never creates, moves, replaces or closes a workspace. */
export async function dispatchTask(
  workflow: Workflow,
  execute: boolean,
  port: DispatchPorts,
  signal?: AbortSignal,
  options: DispatchOptions = {},
) {
  if (!execute)
    return {
      dryRun: true,
      workflow,
      commands: [
        `Create lane tabs only in task workspace ${workflow.taskBinding?.workspaceId ?? "UNBOUND (dispatch refused)"}.`,
        "Verify exact profile, register routes, start and verify native incarnation/tools before assignment.",
      ],
    };
  await port.verifyRoot(workflow);
  const workflowProfile =
    workflow.launchProfile === undefined
      ? undefined
      : validateLaunchProfile(workflow.launchProfile, "workflow launchProfile");
  if (
    workflow.launchProfile !== undefined &&
    workflow.launchProfileVersion !== undefined &&
    workflow.launchProfileVersion !== LAUNCH_PROFILE_SCHEMA_VERSION
  )
    throw new Error("Unsupported workflow launchProfile schema version.");
  const profiles = workflow.lanes.map((lane) => {
    if (
      lane.launchProfile !== undefined &&
      lane.launchProfileVersion !== undefined &&
      lane.launchProfileVersion !== LAUNCH_PROFILE_SCHEMA_VERSION
    )
      throw new Error(
        `Unsupported launchProfile schema version for lane ${lane.id}.`,
      );
    return validateLaunchProfile(
      lane.launchProfile ?? workflowProfile,
      `Lane ${lane.id} launchProfile`,
    );
  });
  const adapters = workflow.lanes.map((lane) => port.adapter(lane.agentKind));
  for (const [index, adapter] of adapters.entries()) {
    const missing = missingRequiredAdapterCapabilities(adapter);
    if (adapter.version !== 1 || missing.length > 0)
      throw new Error(
        `Harness lacks the required versioned capabilities${
          missing.length ? `: ${missing.join(", ")}` : ""
        }.`,
      );
    await adapter.preflight(profiles[index]);
  }
  const restart = options.restart === true;
  const workspaceId = workflow.taskBinding?.workspaceId;
  if (
    !workspaceId ||
    (workflow.ownership.workspaceId &&
      workflow.ownership.workspaceId !== workspaceId)
  )
    throw new Error(
      "Missing or mismatched task workspace binding; no replacement workspace will be created.",
    );
  if (
    ![
      "planned",
      "dispatch-failed",
      "starting",
      ...(restart ? ["running"] : []),
    ].includes(workflow.status)
  )
    throw new Error(`Workflow cannot be dispatched from ${workflow.status}.`);
  if (!(await port.authorize(workflow))) return { cancelled: true, workflow };
  // Per-workflow effect serialization, not a global manifest transaction. The
  // lock records its owning pid: a killed dispatch leaves it behind, and a
  // later dispatch may reclaim it only when the recorded owner is verifiably
  // dead — a live or unverifiable owner still fails closed.
  await mkdir(port.directory, { recursive: true, mode: 0o700 });
  const lock = join(port.directory, `${workflow.id}.dispatch-lock`);
  const ownerPath = join(lock, "owner.json");
  const acquire = async (): Promise<void> => {
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: number } | null = null;
      try {
        owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
          pid?: number;
        };
      } catch {
        owner = null;
      }
      if (typeof owner?.pid !== "number")
        throw new Error(
          "Dispatch lock exists without a verifiable owner (possibly a live mid-acquire race or a pre-owner lock); inspect it before retrying dispatch.",
        );
      let alive = false;
      try {
        process.kill(owner.pid, 0);
        alive = true;
      } catch (signalError) {
        alive = (signalError as NodeJS.ErrnoException).code === "EPERM";
      }
      if (alive)
        throw new Error(
          "Dispatch is already active; no duplicate start allowed.",
        );
      await rm(lock, { recursive: true, force: true });
      return acquire();
    }
    await writeFile(
      ownerPath,
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      { mode: 0o600 },
    );
  };
  await acquire();
  const update = async (edit: (workflow: Workflow) => void) => {
    workflow = await port.update(workflow.id, edit);
    return workflow;
  };
  let stage = "workspace-verify";
  try {
    await port.run(["workspace", "get", workspaceId], signal);
    if (restart) {
      for (let i = 0; i < workflow.lanes.length; i++) {
        let lane = workflow.lanes[i];
        if (
          lane.restart?.status === "requested" ||
          lane.restart?.status === "starting"
        )
          continue;
        if (!lane.paneId || !lane.nativeSession)
          throw new Error(
            `Lane ${lane.id} cannot be restarted without a recorded native incarnation.`,
          );
        let raw;
        try {
          raw = await port.run(["agent", "get", lane.paneId], signal);
        } catch (error) {
          if (!/agent_not_found/.test(String(error))) throw error;
        }
        if (raw) {
          const agent = nativeAgent(raw);
          const liveSession = nativeSession(agent);
          if (
            !agent ||
            agent.pane_id !== lane.paneId ||
            agent.workspace_id !== workspaceId ||
            agent.agent !== lane.agentKind ||
            !sameSession(liveSession, lane.nativeSession)
          )
            throw new Error(
              `Lane ${lane.id} has an unrelated or mismatched occupant; authorized rebind is refused.`,
            );
        }
        const incarnationId = `incarnation-${randomUUID().slice(0, 12)}`;
        const previousIncarnationId = lane.incarnationId;
        await update((w) => {
          const current = w.lanes[i];
          current.restart = {
            version: 1,
            status: "requested",
            requestedAt: new Date().toISOString(),
            ...(previousIncarnationId ? { previousIncarnationId } : {}),
            incarnationId,
          };
          current.incarnationId = incarnationId;
          current.incarnationRevision = (current.incarnationRevision ?? 0) + 1;
          delete current.incarnationStartedAt;
          delete current.agentStartedAt;
          delete current.agentStartAttemptedAt;
          delete current.startupIntentPath;
          delete current.startupNonce;
          delete current.promptAttemptedAt;
          delete current.promptedAt;
          delete current.nativeSession;
          delete current.agentSessionPath;
          delete current.agentSessionId;
          delete current.piSessionPath;
          delete current.piSessionId;
          delete current.completionReceipt;
          current.status = "planned";
          const goal = w.goals?.find((item) => item.id === current.goalId);
          if (goal) {
            goal.revision += 1;
            goal.status = "planned";
            goal.outcome = "unresolved";
            goal.updatedAt = new Date().toISOString();
            current.goalRevision = goal.revision;
          }
        });
        lane = workflow.lanes[i];
        if (raw)
          await port.run(
            ["agent", "send-keys", lane.paneId!, "ctrl+c"],
            signal,
          );
        await update((w) => {
          const current = w.lanes[i];
          if (current.restart?.incarnationId === incarnationId)
            current.restart.status = "starting";
        });
        workflow = await port.update(workflow.id, (w) => {
          w.status = "starting";
        });
      }
    }
    await update((w) => {
      w.status = "starting";
      w.ownership.workspaceId = workspaceId;
      w.retry = {
        state: "dispatching",
        attempt: (w.retry?.attempt ?? 0) + 1,
        retryCommand: `herdr_dispatch ${w.id} execute=true`,
      };
    });
    // Establish all routing before any assignment. Cwd only selects code location.
    for (let i = 0; i < workflow.lanes.length; i++) {
      let lane = workflow.lanes[i];
      const profile = profiles[i];
      if (!lane.startupIntentPath) {
        const intentPath = join(
          port.directory,
          `${workflow.id}-${lane.id}-startup.json`,
        );
        const nonce = randomUUID();
        const incarnationId =
          lane.incarnationId ?? `incarnation-${randomUUID().slice(0, 12)}`;
        await writeFile(
          intentPath,
          JSON.stringify({
            version: 1,
            workflowId: workflow.id,
            laneId: lane.id,
            manifestDirectory: port.directory,
            workspaceId,
            profile,
            profileVersion: LAUNCH_PROFILE_SCHEMA_VERSION,
            incarnationId,
            nonce,
            source: port.source,
          }),
          { mode: 0o600 },
        );
        await update((w) => {
          const current = w.lanes[i];
          current.incarnationId = incarnationId;
          current.incarnationRevision = current.incarnationRevision ?? 1;
          w.lanes[i].startupIntentPath = intentPath;
          w.lanes[i].startupNonce = nonce;
        });
        lane = workflow.lanes[i];
      }
      if (!lane.paneId) {
        stage = "tab-create";
        if (lane.tabCreateAttemptedAt)
          throw new Error(
            "Tab creation response was lost; reconcile the recorded intent before retrying.",
          );
        await update((w) => {
          w.lanes[i].tabCreateAttemptedAt = new Date().toISOString();
        });
        const created = await port.run(
          [
            "tab",
            "create",
            "--workspace",
            workspaceId,
            "--cwd",
            workflow.cwd,
            "--label",
            `${workflow.id}-${lane.id}`,
            "--env",
            `BAA_STARTUP_INTENT=${lane.startupIntentPath}`,
            "--no-focus",
          ],
          signal,
        );
        const result = created.result ?? created;
        const tab = result.tab,
          pane = result.root_pane;
        if (
          !tab?.tab_id ||
          !pane?.pane_id ||
          (tab.workspace_id && tab.workspace_id !== workspaceId) ||
          (pane.workspace_id && pane.workspace_id !== workspaceId)
        )
          throw new Error(
            "Native tab response lacks a matching task workspace/pane binding.",
          );
        // Verify opaque native IDs, never derive membership from their spelling.
        const live = await port.run(["pane", "get", pane.pane_id], signal);
        const info = (live.result ?? live).pane;
        if (
          info?.workspace_id !== workspaceId ||
          info?.tab_id !== tab.tab_id ||
          info?.pane_id !== pane.pane_id
        )
          throw new Error(
            "Created lane is outside its designated task workspace.",
          );
        await update((w) => {
          const l = w.lanes[i];
          l.paneId = pane.pane_id;
          l.tabId = tab.tab_id;
          l.agentName = `lane_${w.id.replaceAll("-", "")}_${i + 1}`;
          l.relationshipId = `herdr-rel-${randomUUID()}`;
          w.ownership.tabIds ??= [];
          w.ownership.tabIds.push(tab.tab_id);
          w.ownership.paneIds.push(pane.pane_id);
        });
      }
    }
    stage = "routing";
    await port.register(workflow);
    for (let i = 0; i < workflow.lanes.length; i++) {
      let lane = workflow.lanes[i];
      const profile = profiles[i];
      const intent = JSON.parse(
        await readFile(lane.startupIntentPath!, "utf8"),
      );
      const intentProfile = validateLaunchProfile(
        intent.profile,
        `Lane ${lane.id} startup intent profile`,
      );
      if (JSON.stringify(intentProfile) !== JSON.stringify(profile))
        throw new Error(
          `Lane ${lane.id} startup intent profile differs from its current launchProfile.`,
        );
      if (intent.incarnationId !== lane.incarnationId)
        throw new Error(
          `Lane ${lane.id} startup intent is not bound to its recorded incarnation.`,
        );
      await writeFile(
        lane.startupIntentPath!,
        JSON.stringify({ ...intent, paneId: lane.paneId }),
        { mode: 0o600 },
      );
      stage = "agent-start";
      if (lane.agentStartedAt) {
        // A recorded start whose pane no longer holds any agent (crash after
        // detection) may be restarted once per dispatch attempt. An attested
        // agent that vanished, or any occupied pane, fails closed instead.
        let present = true;
        try {
          await port.run(["agent", "get", lane.paneId!], signal);
        } catch (error) {
          present = !/agent_not_found/.test(String(error));
        }
        if (!present) {
          const prior = await readFile(
            `${lane.startupIntentPath}.ready`,
            "utf8",
          )
            .then((text) => JSON.parse(text))
            .catch(() => null);
          if (prior && prior.nonce === lane.startupNonce)
            throw new Error(
              "Lane attested but its agent vanished; inspect the pane before retrying dispatch.",
            );
          await update((w) => {
            delete w.lanes[i].agentStartedAt;
            delete w.lanes[i].agentStartAttemptedAt;
          });
          lane = workflow.lanes[i];
        }
      }
      if (!lane.agentStartedAt) {
        if (lane.agentStartAttemptedAt) {
          // A previous start was rejected mid-startup, crashed, or lost its
          // response. Adopt it only when the attestation now exists and matches
          // the lane's intent nonce. Without an attestation, a pane holding no
          // live agent may be started fresh (the launch never took); an
          // occupied pane is genuinely uncertain and needs operator review.
          const recovered = await readFile(
            `${lane.startupIntentPath}.ready`,
            "utf8",
          )
            .then((text) => JSON.parse(text))
            .catch(() => null);
          if (recovered && recovered.nonce === lane.startupNonce) {
            await update((w) => {
              w.lanes[i].agentStartedAt = new Date().toISOString();
            });
          } else {
            let paneAgent: unknown = null;
            try {
              const live = await port.run(
                ["agent", "get", lane.paneId!],
                signal,
              );
              paneAgent = (live.result ?? live).agent ?? null;
            } catch {
              paneAgent = null;
            }
            if (paneAgent)
              throw new Error(
                "Agent start outcome is uncertain and the pane is occupied; inspect it and reconcile before retrying dispatch.",
              );
            await update((w) => {
              delete w.lanes[i].agentStartAttemptedAt;
            });
          }
          lane = workflow.lanes[i];
        }
        if (!lane.agentStartedAt && !lane.agentStartAttemptedAt) {
          await update((w) => {
            w.lanes[i].agentStartAttemptedAt = new Date().toISOString();
          });
          await waitForShellReady(port, lane.paneId!, signal);
          for (let attempt = 0; ; attempt++) {
            try {
              await port.run(
                [
                  "agent",
                  "start",
                  lane.agentName!,
                  "--kind",
                  lane.agentKind,
                  "--pane",
                  lane.paneId!,
                  "--timeout",
                  "60000",
                  "--",
                  ...adapters[i].launchArguments(profile, port.source, {
                    startupIntentPath: lane.startupIntentPath!,
                  }),
                ],
                signal,
                65_000,
              );
              break;
            } catch (error) {
              // Native busy rejection is before launch, unlike timeout after submission.
              if (attempt < 2 && /agent_pane_busy/.test(String(error))) {
                await delay(port.busyRetryDelayMs ?? 1_500, { signal });
                continue;
              }
              if (/agent_pane_busy/.test(String(error)))
                await update((w) => {
                  delete w.lanes[i].agentStartAttemptedAt;
                });
              throw error;
            }
          }
          await update((w) => {
            w.lanes[i].agentStartedAt = new Date().toISOString();
          });
        }
      }
      stage = "startup-proof";
      lane = workflow.lanes[i];
      const raw = await port.run(["agent", "get", lane.paneId!], signal);
      const agent = (raw.result ?? raw).agent;
      // Some harnesses attest asynchronously (e.g. a handshake turn completing,
      // or an MCP server merging operations — codex may spawn it lazily). Wait
      // for a COMPLETE attestation: identity fields plus merged operations.
      // Bounded readiness gate, never an unbounded loop, never an early break
      // on a partial attestation.
      let hello: any = null;
      const attestationDeadline = Date.now() + 90_000;
      const complete = (value: unknown) =>
        adapters[i].attestationComplete?.(value) ?? true;
      while (Date.now() < attestationDeadline) {
        hello = await readFile(`${lane.startupIntentPath}.ready`, "utf8")
          .then((text) => JSON.parse(text))
          .catch(() => null);
        if (hello && complete(hello)) break;
        await delay(500, { signal });
      }
      if (!hello || !complete(hello))
        throw new Error(
          "Startup attestation incomplete or unavailable; no work assigned. Verify the harness handshake and MCP bridge serve the protocol tools.",
        );
      const proof = adapters[i].verifyStartup(agent, hello);
      if (
        agent?.pane_id !== lane.paneId ||
        agent?.workspace_id !== workspaceId ||
        agent?.agent !== lane.agentKind ||
        proof.paneId !== lane.paneId ||
        proof.workspaceId !== workspaceId ||
        proof.nonce !== lane.startupNonce ||
        proof.source !== port.source ||
        JSON.stringify(proof.profile) !== JSON.stringify(profile) ||
        !STARTUP_PROOF_REQUIRED_OPERATIONS.every((operation) =>
          proof.operations?.includes(operation),
        )
      )
        throw new Error(
          "Startup workspace/native-session/profile/tools mismatch; no work assigned.",
        );
      if (
        lane.nativeSession &&
        (lane.nativeSession.kind !== proof.session.kind ||
          lane.nativeSession.value !== proof.session.value)
      )
        throw new Error(
          "Unrelated replacement cannot inherit this lane; authorized incarnation recovery is required.",
        );
      await update((w) => {
        const current = w.lanes[i];
        current.nativeSession = proof.session;
        current.incarnationStartedAt = new Date().toISOString();
        if (proof.session.kind === "path")
          current.agentSessionPath = proof.session.value;
        else current.agentSessionId = proof.session.value;
        if (current.restart) current.restart.status = "bound";
        if (!current.completionReceipt) current.status = "agent-ready";
      });
    }
    // No lane receives work until every lane is verified. Routing already exists.
    for (let i = 0; i < workflow.lanes.length; i++) {
      const lane = workflow.lanes[i];
      if (lane.promptedAt) continue;
      if (lane.promptAttemptedAt)
        throw new Error(
          "Assignment submission is uncertain; do not repeat terminal input.",
        );
      stage = "assignment";
      await port.verifyRoot(workflow);
      await update((w) => {
        w.lanes[i].promptAttemptedAt = new Date().toISOString();
      });
      await port.run(
        ["agent", "prompt", lane.paneId!, port.contract(workflow, lane)],
        signal,
      );
      await update((w) => {
        const current = w.lanes[i];
        current.promptedAt = new Date().toISOString();
        if (!current.completionReceipt) current.status = "running";
        const goal = w.goals?.find((item) => item.id === current.goalId);
        if (goal && goal.outcome === "unresolved") {
          goal.revision += 1;
          goal.status = "running";
          goal.updatedAt = new Date().toISOString();
          current.goalRevision = goal.revision;
        }
      });
    }
    await update((w) => {
      w.status = "running";
      w.outcome = "running";
      w.retry = undefined;
      w.dispatchedAt = new Date().toISOString();
    });
    return { dispatched: true, workflow };
  } catch (error) {
    await update((w) => {
      w.status = "dispatch-failed";
      w.outcome = "unknown";
      w.retry = {
        state: "retryable",
        attempt: w.retry?.attempt ?? 1,
        retryCommand: `herdr_dispatch ${w.id} execute=true`,
        failedStage: stage,
        error: String(error),
      };
      w.evidence.push({
        at: new Date().toISOString(),
        kind: "dispatch-error",
        text: `${stage}: ${error}`,
      });
    });
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
