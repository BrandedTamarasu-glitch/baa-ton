import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Workflow, Lane } from "./index.js";
import { validateLaunchProfile } from "./launch-profile.js";
import type { HarnessLaunchAdapter } from "./harness-adapter.js";

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
};

/** The only dispatch implementation. Never creates, moves, replaces or closes a workspace. */
export async function dispatchTask(
  workflow: Workflow,
  execute: boolean,
  port: DispatchPorts,
  signal?: AbortSignal,
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
  const profile = validateLaunchProfile(workflow.launchProfile);
  const adapters = workflow.lanes.map((lane) => port.adapter(lane.agentKind));
  for (const adapter of adapters) {
    if (adapter.version !== 1 || !adapter.capabilities.startupAttestation)
      throw new Error(
        "Harness lacks the required versioned startup capability.",
      );
    await adapter.preflight(profile);
  }
  const workspaceId = workflow.taskBinding?.workspaceId;
  if (
    !workspaceId ||
    (workflow.ownership.workspaceId &&
      workflow.ownership.workspaceId !== workspaceId)
  )
    throw new Error(
      "Missing or mismatched task workspace binding; no replacement workspace will be created.",
    );
  if (!["planned", "dispatch-failed", "starting"].includes(workflow.status))
    throw new Error(`Workflow cannot be dispatched from ${workflow.status}.`);
  if (!(await port.authorize(workflow))) return { cancelled: true, workflow };
  // Per-workflow effect serialization, not a global manifest transaction. A crash
  // retains this lock for diagnosed recovery rather than spawning a duplicate.
  await mkdir(port.directory, { recursive: true, mode: 0o700 });
  const lock = join(port.directory, `${workflow.id}.dispatch-lock`);
  await mkdir(lock, { mode: 0o700 }).catch((error) => {
    if (error.code === "EEXIST")
      throw new Error(
        "Dispatch is already active or requires crash reconciliation; no duplicate start allowed.",
      );
    throw error;
  });
  const update = async (edit: (workflow: Workflow) => void) => {
    workflow = await port.update(workflow.id, edit);
    return workflow;
  };
  let stage = "workspace-verify";
  try {
    await port.run(["workspace", "get", workspaceId], signal);
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
      if (!lane.startupIntentPath) {
        const intentPath = join(
          port.directory,
          `${workflow.id}-${lane.id}-startup.json`,
        );
        const nonce = randomUUID();
        await writeFile(
          intentPath,
          JSON.stringify({
            version: 1,
            workflowId: workflow.id,
            laneId: lane.id,
            manifestDirectory: port.directory,
            workspaceId,
            profile,
            nonce,
            source: port.source,
          }),
          { mode: 0o600 },
        );
        await update((w) => {
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
      const intent = JSON.parse(
        await readFile(lane.startupIntentPath!, "utf8"),
      );
      await writeFile(
        lane.startupIntentPath!,
        JSON.stringify({ ...intent, paneId: lane.paneId }),
        { mode: 0o600 },
      );
      stage = "agent-start";
      if (!lane.agentStartedAt) {
        if (lane.agentStartAttemptedAt)
          throw new Error(
            "Agent start response was lost; verify its incarnation through recovery before retrying.",
          );
        await update((w) => {
          w.lanes[i].agentStartAttemptedAt = new Date().toISOString();
        });
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
              ...adapters[i].launchArguments(profile, port.source),
            ],
            signal,
            65_000,
          );
        } catch (error) {
          // Native busy rejection is before launch, unlike timeout after submission.
          if (/agent_pane_busy/.test(String(error)))
            await update((w) => {
              delete w.lanes[i].agentStartAttemptedAt;
            });
          throw error;
        }
        await update((w) => {
          w.lanes[i].agentStartedAt = new Date().toISOString();
        });
      }
      stage = "startup-proof";
      lane = workflow.lanes[i];
      const raw = await port.run(["agent", "get", lane.paneId!], signal);
      const agent = (raw.result ?? raw).agent;
      const hello = JSON.parse(
        await readFile(`${lane.startupIntentPath}.ready`, "utf8").catch(() => {
          throw new Error(
            "Startup handshake not available; no work assigned. Observe before retrying dispatch.",
          );
        }),
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
        !["herdr_complete", "herdr_plan", "herdr_dispatch"].every((name) =>
          proof.tools?.includes(name),
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
        w.lanes[i].nativeSession = proof.session;
        if (proof.session.kind === "path")
          w.lanes[i].agentSessionPath = proof.session.value;
        else w.lanes[i].agentSessionId = proof.session.value;
        if (!w.lanes[i].completionReceipt) w.lanes[i].status = "agent-ready";
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
        w.lanes[i].promptedAt = new Date().toISOString();
        if (!w.lanes[i].completionReceipt) w.lanes[i].status = "running";
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
