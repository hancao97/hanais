/// <reference types="vite/client" />

interface HanaisApi {
  metadata: () => Promise<{
    team: unknown;
    roles: Array<{ id: string; identity: { title: string; summary: string }; skills?: Array<{ id: string; version?: string }> }>;
    skills: Array<{ id: string; name: string; description: string }>;
    systemRoles?: Array<{ id: string; identity: { title: string; summary: string } }>;
    systemSkills?: Array<{ id: string; name: string; description: string }>;
    systemServices?: Array<{ id: string; name: string; description: string }>;
    cwd: string;
    settings: UserSettings;
    settingsPath: string;
    teamsPath: string;
    kimiConfigured: boolean;
  }>;
  readSettings: () => Promise<{ settings: UserSettings; settingsPath: string }>;
  writeSettings: (settings: UserSettings) => Promise<{ settings: UserSettings; settingsPath: string }>;
  envStatus: (cwd?: string) => Promise<{ kimiConfigured: boolean }>;
  selectWorkspace: () => Promise<string | undefined>;
  listTeamRuns: () => Promise<{ runs: TeamRunSummary[]; teamsPath: string }>;
  listTeamRunEvents: (sessionId: string) => Promise<{ events: Array<{ type: string; [key: string]: unknown }> }>;
  answerHumanInput: (payload: { requestId: string; answer: string }) => Promise<{ accepted: boolean }>;
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
    history?: TeamRunSummary[];
  }>;
  onTeamEvent: (callback: (event: { type: string; [key: string]: unknown }) => void) => () => void;
}

interface Window {
  hanais: HanaisApi;
}

type RuntimePreference = "codex-cli" | "claude-agent-sdk" | "claude-agent-sdk-kimi";

interface UserSettings {
  runtimeId: RuntimePreference;
  workspaceDir: string;
}

interface TeamRunSummary {
  id: string;
  teamId: string;
  task: string;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  currentPhase: string;
  createdAt: string;
  updatedAt: string;
  workItemCount: number;
  completedWorkItemCount: number;
  actEpisodeCount: number;
  reviewCount: number;
  humanInputCount: number;
  storagePath?: string;
}
