export function handleActivation(
  configDir: string,
  event: {
    data?: {
      pane_id?: string;
      workspace_id?: string;
      agent?: string;
      agent_status?: string;
    };
  },
  api: {
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  },
): Promise<{ accepted: boolean; activation: string; id?: string } | undefined>;
