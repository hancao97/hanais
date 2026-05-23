/// <reference types="vite/client" />

interface HanaisApi {
  metadata: () => Promise<{
    team: unknown;
    roles: Array<{ id: string; identity: { title: string; summary: string } }>;
    skills: Array<{ id: string; name: string; description: string }>;
    cwd: string;
    kimiConfigured: boolean;
  }>;
  selectWorkspace: () => Promise<string | undefined>;
  runTeam: (payload: {
    task: string;
    runtimeId: "codex-cli" | "claude-agent-sdk" | "claude-agent-sdk-kimi";
    cwd?: string;
  }) => Promise<{
    result: {
      finalOutput: string;
      plan: { summary: string; assignments: Array<{ roleId: string; task: string; contractorSpecialty?: string }> };
      outputs: Array<{ instance: { displayName: string; roleId: string; id: string }; output: string }>;
    };
    events: Array<{ type: string; [key: string]: unknown }>;
  }>;
  onTeamEvent: (callback: (event: { type: string; [key: string]: unknown }) => void) => () => void;
}

interface Window {
  hanais: HanaisApi;
}
