export type RuntimeId = string;
export type SystemAgentRoleId = "team_lead" | "__contractor__";
export type SystemServiceId = "mailbox" | "state_store" | "review_gate" | "human_input_gateway";

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
  maxReviewRounds?: number;
  maxWallTimeSeconds?: number;
  maxCostUsd?: number;
  enableTeamReAct?: boolean;
  requireFinalReview?: boolean;
  reviewerRoleIds?: string[];
  requireStrictReviewJson?: boolean;
  reviewRepairAttempts?: number;
  allowHumanInput?: boolean;
  enablePeerToPeerAct?: boolean;
  maxPeerTurnsPerAct?: number;
  maxPeerMessagesPerPairPerTurn?: number;
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
  goal: string;
  assignment: TeamAssignment;
  status: "pending" | "claimed" | "running" | "completed" | "reviewing" | "blocked" | "failed";
  sequence: number;
  dependencies: string[];
  inputs: WorkItemInput[];
  expectedArtifacts: ExpectedArtifact[];
  acceptanceCriteria: string[];
  attempts: number;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
  result?: WorkItemResult;
  error?: WorkItemError;
}

export interface WorkItemInput {
  kind: "context" | "artifact" | "message" | "file";
  name?: string;
  value?: unknown;
  artifactId?: string;
  uri?: string;
}

export interface ExpectedArtifact {
  name: string;
  kind: string;
  required?: boolean;
  description?: string;
}

export interface WorkItemResult {
  output: string;
  artifactIds: string[];
  completedBy: string;
  completedAt: string;
}

export interface WorkItemError {
  message: string;
  stack?: string;
  failedAt: string;
  retryable?: boolean;
}

export interface TeamMessage {
  id: string;
  from: string;
  to?: string;
  type?: TeamMessageType;
  content: string;
  createdAt: string;
  episodeId?: string;
  workItemId?: string;
  artifactIds?: string[];
  metadata?: Record<string, unknown>;
}

export type TeamMessageType =
  | "task_request"
  | "artifact_delivery"
  | "review_request"
  | "change_request"
  | "question"
  | "answer"
  | "blocked"
  | "approval"
  | "handoff"
  | "escalation"
  | "status_report";

export interface ArtifactRef {
  id: string;
  name: string;
  kind: string;
  content?: string;
  uri?: string;
  workItemId?: string;
  roleInstanceId?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export type TeamSessionPhase =
  | "planning"
  | "dispatching"
  | "reviewing"
  | "waiting_for_human"
  | "synthesizing"
  | "completed"
  | "failed"
  | "cancelled";

export interface ReviewTask {
  id: string;
  targetWorkItemId: string;
  reviewerRoleId: string;
  reviewerInstanceId?: string;
  round: number;
  status: "pending" | "running" | "completed" | "blocked" | "failed";
  policy?: ReviewPolicy;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: ReviewResult;
}

export interface ReviewPolicy {
  requireFreshContext?: boolean;
  forbidSelfReview?: boolean;
  maxRounds?: number;
  strictSchema?: boolean;
  acceptanceCriteria?: string[];
}

export interface ReviewResult {
  outcome: "approved" | "changes_requested" | "blocked";
  summary: string;
  findings: ReviewFinding[];
  requiredChanges?: string[];
  evidence?: string[];
}

export interface ReviewFinding {
  severity: "blocking" | "major" | "minor" | "note";
  message: string;
  evidence?: string;
  target?: string;
}

export interface HumanInputRequest {
  id: string;
  sessionId: string;
  workItemId?: string;
  fromRoleId: string;
  toRoleId?: string;
  question: string;
  options?: string[];
  status: "pending" | "answered" | "cancelled";
  answer?: string;
  reason?: string;
  context?: Record<string, unknown>;
  answeredBy?: string;
  createdAt: string;
  answeredAt?: string;
}

export interface ActEpisode {
  id: string;
  round: number;
  goal: string;
  status: "planned" | "running" | "reviewing" | "completed" | "blocked" | "failed";
  participants: ActParticipant[];
  communicationRules: CommunicationRule[];
  inputArtifactIds: string[];
  expectedArtifacts: ExpectedArtifact[];
  acceptanceCriteria: string[];
  reviewPolicy?: ActReviewPolicy;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ActParticipant {
  roleId: string;
  instanceId: string;
  displayName: string;
  responsibility: string;
  visibleToPeers: boolean;
}

export interface CommunicationRule {
  from: string;
  to: string;
  allowedMessageTypes: TeamMessageType[];
  maxTurns?: number;
  maxMessagesPerPairPerTurn?: number;
}

export interface ActReviewPolicy {
  required: boolean;
  reviewerRoleIds: string[];
  trigger: "on_artifact_ready" | "on_all_work_items_done";
}

export interface TeamSession {
  id: string;
  teamId: string;
  task: string;
  createdAt: string;
  updatedAt: string;
  currentPhase: TeamSessionPhase;
  lead: {
    id: "team_lead";
    runtimeId: RuntimeId;
  };
  teammateRoleIds: string[];
  roleInstances: Record<string, RoleInstance>;
  actEpisodes: ActEpisode[];
  workItems: Record<string, TeamWorkItem>;
  reviews: ReviewTask[];
  humanInputs: HumanInputRequest[];
  sharedContext: Record<string, unknown>;
  taskBoard: TeamTask[];
  messages: TeamMessage[];
  artifacts: ArtifactRef[];
  plan?: TeamPlan;
  finalOutput?: string;
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

export interface RuntimeFailure {
  category: "timeout" | "runtime_error" | "cancelled" | "unknown";
  message: string;
  retryable: boolean;
  stack?: string;
}

export interface TeamRunRequest {
  team: TeamDefinition;
  roles: RoleDefinition[];
  skills: SkillDefinition[];
  runtimeRegistry: Record<RuntimeId, AgentRuntime>;
  task: string;
  context?: Record<string, unknown>;
  stateStore?: TeamStateStore;
  onEvent?: (event: TeamRunEvent) => void;
  requestHumanInput?: (request: HumanInputRequest) => Promise<string | undefined>;
}

export interface TeamResumeRequest {
  sessionId: string;
  team: TeamDefinition;
  roles: RoleDefinition[];
  skills: SkillDefinition[];
  runtimeRegistry: Record<RuntimeId, AgentRuntime>;
  context?: Record<string, unknown>;
  stateStore: TeamStateStore;
  onEvent?: (event: TeamRunEvent) => void;
  requestHumanInput?: (request: HumanInputRequest) => Promise<string | undefined>;
}

export interface TeamRunEventEnvelope {
  eventId?: string;
  sessionId?: string;
  sequence?: number;
  timestamp?: string;
}

export type TeamRunEvent = TeamRunEventEnvelope &
  (
    | { type: "session_started"; session: TeamSession }
    | { type: "session_resumed"; session: TeamSession }
    | { type: "session_updated"; session: TeamSession }
    | { type: "lead_output"; content: string }
    | { type: "plan_created"; assignments: TeamAssignment[] }
    | { type: "act_episode_created"; episode: ActEpisode }
    | { type: "peer_turn_started"; episodeId: string; turn: number; instanceId: string }
    | { type: "peer_turn_completed"; episodeId: string; turn: number; instanceId: string; output: string; messages: TeamMessage[] }
    | { type: "team_message_posted"; message: TeamMessage }
    | { type: "work_item_posted"; from: "team_lead"; to: "mailbox"; workItem: TeamWorkItem; content: string }
    | { type: "work_item_claimed"; from: "mailbox"; to: string; workItem: TeamWorkItem; instance: RoleInstance; content: string }
    | { type: "work_item_started"; workItem: TeamWorkItem; instance: RoleInstance }
    | { type: "work_item_completed"; from: string; to: "mailbox"; workItem: TeamWorkItem; instance: RoleInstance; content: string }
    | { type: "work_item_failed"; workItem: TeamWorkItem; instance: RoleInstance; error: string }
    | { type: "assignment_sent"; from: "team_lead"; to: string; instance: RoleInstance; assignment: TeamAssignment; content: string }
    | { type: "role_instance_started"; instance: RoleInstance }
    | { type: "role_instance_completed"; instance: RoleInstance; output: string }
    | { type: "teammate_response"; from: string; to: "team_lead"; instance: RoleInstance; content: string }
    | { type: "review_requested"; review: ReviewTask }
    | { type: "review_gate_failed"; review: ReviewTask; errors: string[]; rawOutput: string }
    | { type: "review_completed"; review: ReviewTask }
    | { type: "human_input_requested"; request: HumanInputRequest }
    | { type: "human_input_answered"; request: HumanInputRequest }
    | { type: "agent_event"; instanceId?: string; event: AgentEvent }
    | { type: "runtime_session_started"; runtimeId: string; roleId: string; runtimeSessionId: string }
    | { type: "runtime_session_completed"; runtimeId: string; roleId: string; runtimeSessionId: string }
    | { type: "runtime_session_failed"; runtimeId: string; roleId: string; runtimeSessionId: string; failure: RuntimeFailure }
    | { type: "runtime_session_cancelled"; runtimeId: string; roleId: string; runtimeSessionId: string }
    | { type: "final_artifact_created"; artifact: ArtifactRef }
    | { type: "final_output"; output: string }
    | { type: "error"; error: string }
  );

export interface TeamSessionSummary {
  id: string;
  teamId: string;
  task: string;
  status: TeamSession["status"];
  currentPhase: TeamSessionPhase;
  createdAt: string;
  updatedAt: string;
  workItemCount: number;
  completedWorkItemCount: number;
  actEpisodeCount: number;
  reviewCount: number;
  humanInputCount: number;
  storagePath?: string;
}

export interface TeamStateStore {
  createSession(session: TeamSession): Promise<void>;
  updateSession(session: TeamSession): Promise<void>;
  appendEvent(sessionId: string, event: TeamRunEvent): Promise<void>;
  getSession(sessionId: string): Promise<TeamSession | undefined>;
  listSessions(limit?: number): Promise<TeamSessionSummary[]>;
  listEvents?(sessionId: string): Promise<TeamRunEvent[]>;
}

export interface TeamAssignment {
  roleId: string;
  task: string;
  reason?: string;
  instanceName?: string;
  context?: Record<string, unknown>;
  contractorSpecialty?: string;
  dependencies?: string[];
  expectedArtifacts?: ExpectedArtifact[];
  acceptanceCriteria?: string[];
  requiresReview?: boolean;
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
