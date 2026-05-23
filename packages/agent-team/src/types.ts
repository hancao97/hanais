export type RuntimeId = string;

export interface SkillDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  prompt?: {
    instructions?: string[];
    examples?: string[];
  };
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  context?: {
    required?: string[];
    optional?: string[];
  };
  policies?: Record<string, unknown>;
}

export interface RoleDefinition {
  id: string;
  version: number;
  identity: {
    name: string;
    title: string;
    summary: string;
    mission: string;
    responsibilities: string[];
    boundaries: string[];
    communicationStyle?: string[];
    successCriteria?: string[];
  };
  skills: Array<{
    id: string;
    version?: string;
  }>;
  runtime?: {
    preferred?: RuntimeId;
    fallback?: RuntimeId;
  };
  outputs?: {
    schema?: unknown;
  };
}

export interface TeamDefinition {
  id: string;
  version: number;
  name: string;
  description?: string;
  lead?: {
    type: "builtin";
    id: "team_lead";
    runtime?: RuntimeId;
  };
  teammates: Array<{
    role: string;
    required?: boolean;
  }>;
  policies?: TeamPolicies;
  runtimeOverrides?: Record<string, RuntimeId>;
}

export interface TeamPolicies {
  maxRounds?: number;
  maxWallTimeSeconds?: number;
  maxCostUsd?: number;
  requireFinalReview?: boolean;
  allowParallelAssignments?: boolean;
  allowDynamicRoleInstances?: boolean;
  maxRoleInstances?: number;
  allowBuiltinContractor?: boolean;
  maxBuiltinContractors?: number;
  roleInstanceLimits?: Record<
    string,
    {
      maxInstances?: number;
      requiresApproval?: boolean;
    }
  >;
}

export interface ResolvedRole {
  id: string;
  displayName: string;
  identity: RoleDefinition["identity"];
  skills: SkillDefinition[];
  runtimeId: RuntimeId;
  outputSchema?: unknown;
  isBuiltin?: boolean;
  contractorSpecialty?: string;
}

export interface RoleInstance {
  id: string;
  roleId: string;
  displayName: string;
  runtimeId: RuntimeId;
  assignedTask: string;
  context: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  parentInstanceId?: string;
  contractorSpecialty?: string;
}

export interface TeamTask {
  id: string;
  title: string;
  roleInstanceId?: string;
  status: "pending" | "running" | "completed" | "failed";
}

export interface TeamWorkItem {
  id: string;
  roleId: string;
  roleInstanceId: string;
  title: string;
  assignment: TeamAssignment;
  status: "pending" | "claimed" | "running" | "completed" | "blocked" | "failed";
  sequence: number;
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
}

export interface TeamMessage {
  id: string;
  from: string;
  to?: string;
  content: string;
  createdAt: string;
}

export interface ArtifactRef {
  id: string;
  name: string;
  kind: string;
  content?: string;
  uri?: string;
}

export interface TeamSession {
  id: string;
  teamId: string;
  task: string;
  lead: {
    id: "team_lead";
    runtimeId: RuntimeId;
  };
  teammateRoleIds: string[];
  roleInstances: Record<string, RoleInstance>;
  sharedContext: Record<string, unknown>;
  taskBoard: TeamTask[];
  messages: TeamMessage[];
  artifacts: ArtifactRef[];
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
}

export type AgentEvent =
  | { type: "started"; runId: string; roleId: string; timestamp: string }
  | { type: "message"; roleId: string; content: string; timestamp: string }
  | { type: "tool_call"; roleId: string; name: string; args?: unknown; timestamp: string }
  | { type: "final"; roleId: string; output: string; timestamp: string }
  | { type: "error"; roleId: string; error: string; timestamp: string };

export interface AgentRunRequest {
  sessionId: string;
  role: ResolvedRole;
  task: string;
  context: Record<string, unknown>;
  limits?: {
    timeoutMs?: number;
    maxTurns?: number;
  };
}

export interface AgentRuntime {
  id: RuntimeId;
  kind: string;
  capabilities?(): Promise<Record<string, unknown>>;
  run(request: AgentRunRequest): AsyncIterable<AgentEvent>;
  cancel?(sessionId: string): Promise<void>;
}

export interface TeamRunRequest {
  team: TeamDefinition;
  roles: RoleDefinition[];
  skills: SkillDefinition[];
  runtimeRegistry: Record<RuntimeId, AgentRuntime>;
  task: string;
  context?: Record<string, unknown>;
  onEvent?: (event: TeamRunEvent) => void;
}

export type TeamRunEvent =
  | { type: "session_started"; session: TeamSession; timestamp?: string }
  | { type: "lead_output"; content: string; timestamp?: string }
  | { type: "plan_created"; assignments: TeamAssignment[]; timestamp?: string }
  | { type: "work_item_posted"; from: "team_lead"; to: "mailbox"; workItem: TeamWorkItem; content: string; timestamp?: string }
  | { type: "work_item_claimed"; from: "mailbox"; to: string; workItem: TeamWorkItem; instance: RoleInstance; content: string; timestamp?: string }
  | { type: "work_item_completed"; from: string; to: "mailbox"; workItem: TeamWorkItem; instance: RoleInstance; content: string; timestamp?: string }
  | { type: "assignment_sent"; from: "team_lead"; to: string; instance: RoleInstance; assignment: TeamAssignment; content: string; timestamp?: string }
  | { type: "role_instance_started"; instance: RoleInstance; timestamp?: string }
  | { type: "role_instance_completed"; instance: RoleInstance; output: string; timestamp?: string }
  | { type: "teammate_response"; from: string; to: "team_lead"; instance: RoleInstance; content: string; timestamp?: string }
  | { type: "agent_event"; instanceId?: string; event: AgentEvent }
  | { type: "final_output"; output: string; timestamp?: string }
  | { type: "error"; error: string; timestamp?: string };

export interface TeamAssignment {
  roleId: string;
  task: string;
  reason?: string;
  instanceName?: string;
  context?: Record<string, unknown>;
  contractorSpecialty?: string;
}

export interface TeamPlan {
  summary: string;
  assignments: TeamAssignment[];
}

export interface TeamRunResult {
  session: TeamSession;
  plan: TeamPlan;
  outputs: Array<{
    instance: RoleInstance;
    output: string;
  }>;
  finalOutput: string;
}
