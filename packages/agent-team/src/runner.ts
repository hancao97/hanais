import { buildPeerTurnPrompt, buildRolePrompt, buildTeamLeadPlanningPrompt, buildTeamLeadSynthesisPrompt, extractPlan } from "./prompts.js";
import { BUILTIN_CONTRACTOR_ROLE_ID, TEAM_LEAD_ROLE_ID, createBuiltinContractorRole, createBuiltinTeamLeadRole } from "./system-roles.js";
import type {
  AgentEvent,
  AgentRuntime,
  ActEpisode,
  ArtifactRef,
  CommunicationRule,
  ReviewResult,
  ReviewTask,
  ResolvedRole,
  RoleDefinition,
  RoleInstance,
  RuntimeFailure,
  SkillDefinition,
  TeamAssignment,
  TeamDefinition,
  HumanInputRequest,
  TeamMessage,
  TeamMessageType,
  TeamPlan,
  TeamSession,
  TeamWorkItem,
  TeamRunEvent,
  TeamRunRequest,
  TeamRunResult,
  TeamResumeRequest,
} from "./types.js";

export class TeamRunner {
  async resume(request: TeamResumeRequest): Promise<TeamRunResult> {
    const session = await request.stateStore.getSession(request.sessionId);
    if (!session) {
      throw new Error(`Missing team session: ${request.sessionId}`);
    }
    const record = createSessionRecorder({ request, session });
    await record({ type: "session_resumed", session });

    if (session.status === "waiting") {
      const pending = session.humanInputs.find((item) => item.status === "pending");
      if (pending && request.requestHumanInput) {
        const answer = await request.requestHumanInput(pending);
        if (answer?.trim()) {
          pending.status = "answered";
          pending.answer = answer.trim();
          pending.answeredBy = "user";
          pending.answeredAt = now();
          await record({ type: "human_input_answered", request: { ...pending } });
          await record({ type: "session_updated", session });
        }
      }
    }

    return reconstructRunResult(session);
  }

  async run(request: TeamRunRequest): Promise<TeamRunResult> {
    const startedAt = Date.now();
    const policies = {
      allowParallelAssignments: false,
      allowDynamicRoleInstances: true,
      allowBuiltinContractor: true,
      maxRoleInstances: 6,
      maxBuiltinContractors: 2,
      requireStrictReviewJson: true,
      reviewRepairAttempts: 1,
      allowHumanInput: true,
      enablePeerToPeerAct: true,
      maxPeerTurnsPerAct: 3,
      maxPeerMessagesPerPairPerTurn: 3,
      ...(request.team.policies ?? {}),
    };

    const resolvedTeammates = resolveTeammates(request);
    const leadRuntimeId = request.team.lead?.runtime ?? "codex-cli";
    const leadRuntime = requireRuntime(request.runtimeRegistry, leadRuntimeId);
    const createdAt = now();
    const session: TeamSession = {
      id: `team_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      teamId: request.team.id,
      task: request.task,
      createdAt,
      updatedAt: createdAt,
      currentPhase: "planning",
      lead: { id: TEAM_LEAD_ROLE_ID, runtimeId: leadRuntimeId },
      teammateRoleIds: resolvedTeammates.map((role) => role.id),
      roleInstances: {},
      actEpisodes: [],
      workItems: {},
      reviews: [],
      humanInputs: [],
      sharedContext: request.context ?? {},
      taskBoard: [],
      messages: [],
      artifacts: [],
      status: "running" as const,
    };
    const record = createSessionRecorder({ request, session });

    await request.stateStore?.createSession(session);
    await record({ type: "session_started", session });

    let plan: TeamPlan = { summary: "", assignments: [] };

    try {
      const planningPrompt = buildTeamLeadPlanningPrompt({
        task: request.task,
        context: request.context ?? {},
        teammates: resolvedTeammates,
        policies,
      });

      const leadPlanText = await collectRuntimeOutput({
        runtime: leadRuntime,
        role: createBuiltinTeamLeadRole(leadRuntimeId),
        sessionId: `${session.id}_lead_plan`,
        task: planningPrompt,
        context: request.context ?? {},
        timeoutMs: policyTimeoutMs(policies, startedAt),
        onAgentEvent: async (event) => {
          await record({ type: "agent_event", event });
        },
        record,
      });

      await record({ type: "lead_output", content: leadPlanText });

      plan = normalizePlan(
        extractPlan(leadPlanText) ?? fallbackPlan(request.task, resolvedTeammates),
        resolvedTeammates,
        request.team,
        policies,
      );
      session.plan = plan;

      await record({ type: "plan_created", assignments: plan.assignments });

      const teamReact = createTeamReactConfig({
        teammates: resolvedTeammates,
        policies,
      });

      const roleSessions = new Map<string, { instance: RoleInstance; role: ResolvedRole }>();
      const getRoleSession = (assignment: TeamAssignment) => {
        const key = roleSessionKey(assignment);
        const existing = roleSessions.get(key);
        if (existing) {
          return existing;
        }

        const entry = createRoleSession({
          assignment,
          resolvedTeammates,
          request,
        });
        roleSessions.set(key, entry);
        session.roleInstances[entry.instance.id] = entry.instance;
        return entry;
      };

      const actAssignments = selectActAssignments({
        assignments: plan.assignments,
        reviewerRoleIds: teamReact.reviewers.map((reviewer) => reviewer.id),
        enabled: teamReact.enabled,
      });

      const workItems = actAssignments.map((assignment, index) => {
        const entry = getRoleSession(assignment);
        const workItem = createWorkItem({
          assignment,
          entry,
          sequence: index + 1,
          sessionId: session.id,
        });
        session.workItems[workItem.id] = workItem;
        session.taskBoard.push({
          id: workItem.id,
          title: workItem.title,
          roleInstanceId: entry.instance.id,
          status: "pending",
        });
        return { workItem, entry };
      });

      const actEpisode = createActEpisode({
        id: `act_1`,
        round: 1,
        goal: plan.summary || request.task,
        items: workItems,
        requireFinalReview: policies.requireFinalReview === true,
        reviewerRoleIds: teamReact.reviewers.map((reviewer) => reviewer.id),
        maxPeerTurns: maxPeerTurnsFromPolicies(policies),
        maxPeerMessagesPerPairPerTurn: maxPeerMessagesPerPairPerTurnFromPolicies(policies),
      });
      session.actEpisodes.push(actEpisode);
      await record({ type: "act_episode_created", episode: actEpisode });

      const completedOutputs: Array<{ instance: RoleInstance; output: string }> = [];
      session.currentPhase = "dispatching";
      actEpisode.status = "running";
      actEpisode.startedAt = now();
      await record({ type: "session_updated", session });

      const runOne = async (
        item: { workItem: TeamWorkItem; entry: { instance: RoleInstance; role: ResolvedRole } },
        episode: ActEpisode,
      ) => {
        const { workItem, entry } = item;
        const { instance, role } = entry;
        instance.assignedTask = workItem.title;
        instance.context = workItem.assignment.context ?? {};
        const assignmentContent = workItem.assignment.reason ? `${workItem.title}\n\n分配原因：${workItem.assignment.reason}` : workItem.title;
        await postTeamMessage({
          session,
          record,
          message: {
            id: `msg_${workItem.id}_task`,
            from: TEAM_LEAD_ROLE_ID,
            to: instance.id,
            type: "task_request",
            content: assignmentContent,
            episodeId: episode.id,
            workItemId: workItem.id,
            createdAt: now(),
          },
        });
        await record({
          type: "work_item_posted",
          from: TEAM_LEAD_ROLE_ID,
          to: "mailbox",
          workItem: { ...workItem },
          content: assignmentContent,
        });

        workItem.status = "claimed";
        workItem.claimedAt = now();
        workItem.updatedAt = workItem.claimedAt;
        await record({
          type: "work_item_claimed",
          from: "mailbox",
          to: instance.id,
          workItem: { ...workItem },
          instance: { ...instance },
          content: workItem.title,
        });
        await record({
          type: "assignment_sent",
          from: TEAM_LEAD_ROLE_ID,
          to: instance.id,
          instance: { ...instance },
          assignment: workItem.assignment,
          content: assignmentContent,
        });

        workItem.status = "running";
        workItem.startedAt = now();
        workItem.updatedAt = workItem.startedAt;
        workItem.attempts += 1;
        instance.status = "running";
        updateTaskStatus(session, workItem.id, "running");
        await record({ type: "work_item_started", workItem: { ...workItem }, instance: { ...instance } });
        await record({ type: "role_instance_started", instance: { ...instance } });

        try {
          const runtime = requireRuntime(request.runtimeRegistry, instance.runtimeId);
          const roleContext = {
              ...(request.context ?? {}),
              ...(workItem.assignment.context ?? {}),
              actEpisode: {
              id: episode.id,
              round: episode.round,
              goal: episode.goal,
              participants: episode.participants,
              communicationRules: episode.communicationRules.filter((rule) => rule.from === instance.id || rule.to === instance.id),
              acceptanceCriteria: episode.acceptanceCriteria,
              expectedArtifacts: episode.expectedArtifacts,
            },
            teamArtifacts: completedOutputs.map((item) => ({
              from: item.instance.id,
              roleId: item.instance.roleId,
              output: item.output,
            })),
          };
          const prompt = buildRolePrompt({
            role,
            task: workItem.title,
            context: roleContext,
          });

          const output = await collectRuntimeOutput({
            runtime,
            role,
            sessionId: `${session.id}_${instance.id}`,
            task: prompt,
            context: roleContext,
            timeoutMs: policyTimeoutMs(policies, startedAt),
            onAgentEvent: async (event) => {
              await record({ type: "agent_event", instanceId: instance.id, event });
            },
            record,
          });

          workItem.status = "completed";
          workItem.completedAt = now();
          workItem.updatedAt = workItem.completedAt;
          const artifact = createOutputArtifact({ workItem, instance, output });
          session.artifacts.push(artifact);
          workItem.result = {
            output,
            artifactIds: [artifact.id],
            completedBy: instance.id,
            completedAt: workItem.completedAt,
          };
          instance.status = "completed";
          updateTaskStatus(session, workItem.id, "completed");
          await record({ type: "role_instance_completed", instance: { ...instance }, output });
          await postTeamMessage({
            session,
            record,
            message: {
              id: `msg_${workItem.id}_artifact`,
              from: instance.id,
              to: "mailbox",
              type: "artifact_delivery",
              content: output,
              episodeId: episode.id,
              workItemId: workItem.id,
              artifactIds: [artifact.id],
              createdAt: workItem.completedAt,
            },
          });
          await record({
            type: "work_item_completed",
            from: instance.id,
            to: "mailbox",
            workItem: { ...workItem },
            instance: { ...instance },
            content: output,
          });
          await record({
            type: "teammate_response",
            from: instance.id,
            to: TEAM_LEAD_ROLE_ID,
            instance: { ...instance },
            content: output,
          });
          const result = { instance: { ...instance }, output };
          completedOutputs.push(result);
          return result;
        } catch (error) {
          const failedAt = now();
          const message = error instanceof Error ? error.message : String(error);
          workItem.status = "failed";
          workItem.updatedAt = failedAt;
          workItem.error = {
            message,
            stack: error instanceof Error ? error.stack : undefined,
            failedAt,
            retryable: true,
          };
          instance.status = "failed";
          updateTaskStatus(session, workItem.id, "failed");
          await record({ type: "work_item_failed", workItem: { ...workItem }, instance: { ...instance }, error: message });
          throw error;
        }
      };

      const outputs = policies.allowParallelAssignments
        ? await Promise.all(workItems.map((item) => runOne(item, actEpisode)))
        : await runSequentially(workItems, (item) => runOne(item, actEpisode));

      await runPeerToPeerActLoop({
        session,
        request,
        policies,
        startedAt,
        episode: actEpisode,
        roleEntries: workItems.map((item) => item.entry),
        record,
      });

      if (teamReact.enabled && teamReact.primaryReviewer && outputs.length > 0) {
        session.currentPhase = "reviewing";
        actEpisode.status = "reviewing";
        await record({ type: "session_updated", session });
        const reviewLoopOutcome = await runTeamReactReviewLoop({
          session,
          request,
          policies,
          startedAt,
          reviewer: teamReact.primaryReviewer,
          outputs,
          completedOutputs,
          getRoleSession,
          runOne,
          record,
        });
        if (reviewLoopOutcome === "blocked") {
          blockOpenActEpisodes(session);
          const blockedOutput = "Team ReAct 已进入 blocked 状态，需要人工介入或调整任务后继续。";
          session.finalOutput = blockedOutput;
          await record({ type: "session_updated", session });
          return { session, plan, outputs, finalOutput: blockedOutput };
        }
      }

      completeOpenActEpisodes(session);
      session.currentPhase = "synthesizing";
      await record({ type: "session_updated", session });

      const synthesisPrompt = buildTeamLeadSynthesisPrompt({
        task: request.task,
        plan,
        finalArtifacts: teamReact.primaryReviewer
          ? latestOutputsByNonReviewer(outputs, teamReact.primaryReviewer.id).map((item) => ({
              instanceName: item.instance.displayName,
              roleId: item.instance.roleId,
              output: item.output,
            }))
          : outputs.slice(-1).map((item) => ({
              instanceName: item.instance.displayName,
              roleId: item.instance.roleId,
              output: item.output,
            })),
        outputs: outputs.map((item) => ({
          instanceName: item.instance.displayName,
          roleId: item.instance.roleId,
          output: item.output,
        })),
      });

      const finalOutput = await collectRuntimeOutput({
        runtime: leadRuntime,
        role: createBuiltinTeamLeadRole(leadRuntimeId),
        sessionId: `${session.id}_lead_final`,
        task: synthesisPrompt,
        context: request.context ?? {},
        timeoutMs: policyTimeoutMs(policies, startedAt),
        onAgentEvent: async (event) => {
          await record({ type: "agent_event", event });
        },
        record,
      });

      session.currentPhase = "completed";
      session.status = "completed";
      session.finalOutput = finalOutput;
      const finalArtifact = createFinalArtifact({ session, finalOutput });
      session.artifacts.push(finalArtifact);
      await record({ type: "final_artifact_created", artifact: finalArtifact });
      await record({ type: "final_output", output: finalOutput });
      return { session, plan, outputs, finalOutput };
    } catch (error) {
      session.currentPhase = "failed";
      session.status = "failed";
      const message = error instanceof Error ? error.message : String(error);
      await record({ type: "error", error: message });
      throw error;
    }
  }
}

function resolveTeammates(request: TeamRunRequest): ResolvedRole[] {
  const rolesById = new Map(request.roles.map((role) => [role.id, role]));
  return request.team.teammates.map((teammate) => {
    const role = rolesById.get(teammate.role);
    if (!role) {
      throw new Error(`Team references missing teammate role: ${teammate.role}`);
    }
    return resolveRole(role, request.skills, request.team.runtimeOverrides?.[role.id]);
  });
}

function resolveRole(role: RoleDefinition, skills: SkillDefinition[], runtimeOverride?: string): ResolvedRole {
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const resolvedSkills = role.skills.map((skillRef) => {
    const skill = skillsById.get(skillRef.id);
    if (!skill) {
      throw new Error(`Role ${role.id} references missing skill: ${skillRef.id}`);
    }
    return skill;
  });

  return {
    id: role.id,
    displayName: role.identity.title,
    identity: role.identity,
    skills: resolvedSkills,
    runtimeId: runtimeOverride ?? role.runtime?.preferred ?? "codex-cli",
    outputSchema: role.outputs?.schema,
  };
}

function createTeamReactConfig(input: {
  teammates: ResolvedRole[];
  policies: Record<string, unknown>;
}): { enabled: boolean; reviewers: ResolvedRole[]; primaryReviewer?: ResolvedRole; source: "explicit" | "heuristic" | "none" } {
  const explicitReviewerIds = Array.isArray(input.policies.reviewerRoleIds) ? input.policies.reviewerRoleIds.map(String) : [];
  const explicitReviewers = explicitReviewerIds
    .map((roleId) => input.teammates.find((role) => role.id === roleId))
    .filter((role): role is ResolvedRole => Boolean(role));
  if (explicitReviewerIds.length > 0 && explicitReviewers.length !== explicitReviewerIds.length) {
    const resolvedIds = new Set(explicitReviewers.map((role) => role.id));
    const missing = explicitReviewerIds.filter((roleId) => !resolvedIds.has(roleId));
    throw new Error(`Team reviewerRoleIds reference missing teammate roles: ${missing.join(", ")}`);
  }
  const reviewers = explicitReviewers.length > 0 ? explicitReviewers : maybeReviewerRole(input.teammates);
  const enabled = reviewers.length > 0 && (input.policies.enableTeamReAct === true || input.policies.requireFinalReview === true);
  return {
    enabled,
    reviewers,
    primaryReviewer: reviewers[0],
    source: explicitReviewers.length > 0 ? "explicit" : reviewers.length > 0 ? "heuristic" : "none",
  };
}

function maybeReviewerRole(teammates: ResolvedRole[]): ResolvedRole[] {
  const reviewer = teammates.find((role) => {
    const text = [
      role.id,
      role.displayName,
      role.identity.name,
      role.identity.title,
      role.identity.summary,
      role.identity.mission,
      ...role.identity.responsibilities,
    ]
      .join(" ")
      .toLowerCase();
    return /review|reviewer|editor|审核|审查|编辑|校对/.test(text);
  });
  return reviewer ? [reviewer] : [];
}

function selectActAssignments(input: {
  assignments: TeamAssignment[];
  reviewerRoleIds: string[];
  enabled: boolean;
}): TeamAssignment[] {
  if (!input.enabled || input.reviewerRoleIds.length === 0) {
    return input.assignments;
  }
  const reviewerRoleIds = new Set(input.reviewerRoleIds);
  const firstAssignmentByRole = new Map<string, TeamAssignment>();
  for (const assignment of input.assignments) {
    if (reviewerRoleIds.has(assignment.roleId) || firstAssignmentByRole.has(assignment.roleId)) {
      continue;
    }
    firstAssignmentByRole.set(assignment.roleId, assignment);
  }
  const selected = Array.from(firstAssignmentByRole.values());
  return selected.length > 0 ? selected : input.assignments.slice(0, 1);
}

async function runTeamReactReviewLoop(input: {
  session: TeamSession;
  request: TeamRunRequest;
  policies: Record<string, unknown>;
  startedAt: number;
  reviewer: ResolvedRole;
  outputs: Array<{ instance: RoleInstance; output: string }>;
  completedOutputs: Array<{ instance: RoleInstance; output: string }>;
  getRoleSession: (assignment: TeamAssignment) => { instance: RoleInstance; role: ResolvedRole };
  runOne: (
    item: { workItem: TeamWorkItem; entry: { instance: RoleInstance; role: ResolvedRole } },
    episode: ActEpisode,
  ) => Promise<{ instance: RoleInstance; output: string }>;
  record: (event: TeamRunEvent) => Promise<TeamRunEvent>;
}): Promise<"approved" | "blocked" | "max_rounds"> {
  let maxReviewRounds = maxReviewRoundsFromPolicies(input.policies);
  let humanEscalations = 0;
  let currentTargets = latestOutputsByNonReviewer(input.outputs, input.reviewer.id);
  if (currentTargets.length === 0) {
    return "approved";
  }

  for (let round = 1; round <= maxReviewRounds; round += 1) {
    input.session.currentPhase = "reviewing";
    await input.record({ type: "session_updated", session: input.session });

    const reviews: Array<{
      target: { instance: RoleInstance; output: string };
      reviewTask: ReviewTask;
      result: ReviewResult;
      rawOutput: string;
      reviewerInstance: RoleInstance;
    }> = [];

    for (const target of currentTargets) {
      const review = await runReviewRound({
        ...input,
        target,
        round,
      });
      reviews.push({ ...review, target });
      input.outputs.push({ instance: review.reviewerInstance, output: review.rawOutput });
      input.completedOutputs.push({ instance: review.reviewerInstance, output: review.rawOutput });
    }

    const blocked = reviews.find((review) => review.result.outcome === "blocked");
    if (blocked) {
      const humanAnswer = await requestHumanInputForReview({
        ...input,
        reason: "review_blocked",
        round,
        reviews: [blocked],
      });
      if (!humanAnswer) {
        return "blocked";
      }
      humanEscalations += 1;
      if (humanEscalations <= 1) {
        maxReviewRounds += 1;
      }
      const revisionOutputs = await runRevisionActEpisode({
        ...input,
        round,
        reviews: [blocked],
        humanAnswer,
      });
      input.outputs.push(...revisionOutputs);
      currentTargets = revisionOutputs;
      continue;
    }

    const changeRequests = reviews.filter((review) => review.result.outcome === "changes_requested");
    if (changeRequests.length === 0) {
      return "approved";
    }

    if (round >= maxReviewRounds) {
      const humanAnswer = await requestHumanInputForReview({
        ...input,
        reason: "max_review_rounds",
        round,
        reviews: changeRequests,
      });
      if (!humanAnswer) {
        return "blocked";
      }
      humanEscalations += 1;
      if (humanEscalations <= 1) {
        maxReviewRounds += 1;
      }
      const revisionOutputs = await runRevisionActEpisode({
        ...input,
        round,
        reviews: changeRequests,
        humanAnswer,
      });
      input.outputs.push(...revisionOutputs);
      currentTargets = revisionOutputs;
      continue;
    }

    const revisionOutputs = await runRevisionActEpisode({
      ...input,
      round,
      reviews: changeRequests,
    });
    input.outputs.push(...revisionOutputs);
    currentTargets = revisionOutputs;
  }
  return "max_rounds";
}

type ReviewRoundOutput = {
  target: { instance: RoleInstance; output: string };
  reviewTask: ReviewTask;
  result: ReviewResult;
  rawOutput: string;
  reviewerInstance: RoleInstance;
};

async function runRevisionActEpisode(input: {
  session: TeamSession;
  request: TeamRunRequest;
  policies: Record<string, unknown>;
  startedAt: number;
  reviewer: ResolvedRole;
  round: number;
  reviews: ReviewRoundOutput[];
  humanAnswer?: string;
  getRoleSession: (assignment: TeamAssignment) => { instance: RoleInstance; role: ResolvedRole };
  runOne: (
    item: { workItem: TeamWorkItem; entry: { instance: RoleInstance; role: ResolvedRole } },
    episode: ActEpisode,
  ) => Promise<{ instance: RoleInstance; output: string }>;
  record: (event: TeamRunEvent) => Promise<TeamRunEvent>;
}): Promise<Array<{ instance: RoleInstance; output: string }>> {
  input.session.currentPhase = "dispatching";
  const revisionItems = input.reviews.map((review) => {
    const revisionAssignment = createRevisionAssignment({
      round: input.round,
      target: review.target,
      review,
      humanAnswer: input.humanAnswer,
    });
    const revisionEntry = input.getRoleSession(revisionAssignment);
    const revisionWorkItem = createWorkItem({
      assignment: revisionAssignment,
      entry: revisionEntry,
      sequence: Object.keys(input.session.workItems).length + 1,
      sessionId: input.session.id,
    });
    input.session.workItems[revisionWorkItem.id] = revisionWorkItem;
    input.session.taskBoard.push({
      id: revisionWorkItem.id,
      title: revisionWorkItem.title,
      roleInstanceId: revisionEntry.instance.id,
      status: "pending",
    });
    return { workItem: revisionWorkItem, entry: revisionEntry, review };
  });
  const revisionEpisode = createActEpisode({
    id: `act_${input.session.actEpisodes.length + 1}`,
    round: input.round + 1,
    goal: input.humanAnswer ? `根据审核意见和人工介入完成第 ${input.round + 1} 轮修改。` : `根据审核意见完成第 ${input.round + 1} 轮修改。`,
    items: revisionItems,
    requireFinalReview: true,
    reviewerRoleIds: [input.reviewer.id],
    maxPeerTurns: maxPeerTurnsFromPolicies(input.policies),
    maxPeerMessagesPerPairPerTurn: maxPeerMessagesPerPairPerTurnFromPolicies(input.policies),
  });
  revisionEpisode.inputArtifactIds = input.reviews.flatMap((review) => input.session.workItems[review.reviewTask.targetWorkItemId]?.result?.artifactIds ?? []);
  input.session.actEpisodes.push(revisionEpisode);
  revisionEpisode.status = "running";
  revisionEpisode.startedAt = now();
  await input.record({ type: "act_episode_created", episode: revisionEpisode });
  await input.record({ type: "session_updated", session: input.session });

  const revisionOutputs = input.policies.allowParallelAssignments === true
    ? Promise.all(revisionItems.map((item) => input.runOne({ workItem: item.workItem, entry: item.entry }, revisionEpisode)))
    : runSequentially(revisionItems, (item) => input.runOne({ workItem: item.workItem, entry: item.entry }, revisionEpisode));
  const resolvedOutputs = await revisionOutputs;
  await runPeerToPeerActLoop({
    session: input.session,
    request: input.request,
    policies: input.policies,
    startedAt: input.startedAt,
    episode: revisionEpisode,
    roleEntries: revisionItems.map((item) => item.entry),
    record: input.record,
  });
  return resolvedOutputs;
}

async function runPeerToPeerActLoop(input: {
  session: TeamSession;
  request: TeamRunRequest;
  policies: Record<string, unknown>;
  startedAt: number;
  episode: ActEpisode;
  roleEntries: Array<{ instance: RoleInstance; role: ResolvedRole }>;
  record: (event: TeamRunEvent) => Promise<TeamRunEvent>;
}): Promise<void> {
  const maxTurns = maxPeerTurnsFromPolicies(input.policies);
  const maxMessagesPerPairPerTurn = maxPeerMessagesPerPairPerTurnFromPolicies(input.policies);
  if (input.policies.enablePeerToPeerAct === false || maxTurns <= 0 || input.episode.participants.length < 2) {
    return;
  }

  const participantIds = new Set(input.episode.participants.map((participant) => participant.instanceId));
  const entries = input.roleEntries.filter((entry) => participantIds.has(entry.instance.id));
  if (entries.length < 2) {
    return;
  }

  const peerPairTurnCounts = new Map<string, number>();
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    let messageCount = 0;
    for (const entry of entries) {
      await input.record({ type: "peer_turn_started", episodeId: input.episode.id, turn, instanceId: entry.instance.id });
      const runtime = requireRuntime(input.request.runtimeRegistry, entry.instance.runtimeId);
      const peerOutput = await collectRuntimeOutput({
        runtime,
        role: entry.role,
        sessionId: `${input.session.id}_${entry.instance.id}_${input.episode.id}_peer_${turn}`,
        task: buildRolePrompt({
          role: entry.role,
          task: buildPeerTurnPrompt({
            role: entry.role,
            ownInstanceId: entry.instance.id,
            episode: input.episode,
            turn,
            maxMessagesPerPairPerTurn,
            recentMessages: input.session.messages.filter((message) => message.episodeId === input.episode.id),
            artifacts: input.session.artifacts.map((artifact) => ({
              id: artifact.id,
              from: artifact.roleInstanceId,
              roleId: artifact.metadata?.roleId as string | undefined,
              content: artifact.content?.slice(0, 1000),
            })),
          }),
          context: {
            peerToPeerAct: true,
            episode: input.episode,
            ownInstanceId: entry.instance.id,
            recentMessages: input.session.messages.filter((message) => message.episodeId === input.episode.id).slice(-12),
          },
        }),
        context: {
          peerToPeerAct: true,
          episode: input.episode,
          ownInstanceId: entry.instance.id,
        },
        timeoutMs: policyTimeoutMs(input.policies, input.startedAt),
        onAgentEvent: async (event) => {
          await input.record({ type: "agent_event", instanceId: entry.instance.id, event });
        },
        record: input.record,
      });

      const messages = extractPeerTurnMessages({
        output: peerOutput,
        from: entry.instance.id,
        episode: input.episode,
        peerPairTurnCounts,
        maxMessagesPerPairPerTurn,
      });
      for (const message of messages) {
        await postTeamMessage({ session: input.session, record: input.record, message });
      }
      messageCount += messages.length;
      await input.record({
        type: "peer_turn_completed",
        episodeId: input.episode.id,
        turn,
        instanceId: entry.instance.id,
        output: peerOutput,
        messages,
      });
    }
    if (messageCount === 0) {
      return;
    }
  }
}

function extractPeerTurnMessages(input: {
  output: string;
  from: string;
  episode: ActEpisode;
  peerPairTurnCounts: Map<string, number>;
  maxMessagesPerPairPerTurn: number;
}): TeamMessage[] {
  const parsed = extractJsonObject(input.output);
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const pairCountsThisTurn = new Map<string, number>();
  return messages
    .map((item, index) => normalizePeerTurnMessage(item, index, { ...input, pairCountsThisTurn }))
    .filter((message): message is TeamMessage => Boolean(message));
}

function normalizePeerTurnMessage(
  value: unknown,
  index: number,
  input: {
    from: string;
    episode: ActEpisode;
    peerPairTurnCounts: Map<string, number>;
    pairCountsThisTurn: Map<string, number>;
    maxMessagesPerPairPerTurn: number;
  },
): TeamMessage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const to = typeof record.to === "string" ? record.to : "";
  const type = normalizePeerMessageType(record.type);
  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!to || !type || !content || isSystemServiceRecipient(to)) {
    return undefined;
  }
  const pairKey = `${input.from}->${to}`;
  const rule = findAllowedPeerMessageRule({ episode: input.episode, from: input.from, to, type });
  if (!rule) {
    return undefined;
  }
  const messagesThisTurn = input.pairCountsThisTurn.get(pairKey) ?? 0;
  if (messagesThisTurn >= input.maxMessagesPerPairPerTurn) {
    return undefined;
  }
  if (messagesThisTurn === 0 && !claimAllowedPeerPairTurn({ from: input.from, to, rule, peerPairTurnCounts: input.peerPairTurnCounts })) {
    return undefined;
  }
  input.pairCountsThisTurn.set(pairKey, messagesThisTurn + 1);
  return {
    id: `msg_${input.episode.id}_peer_${Date.now()}_${input.from}_${index}`,
    from: input.from,
    to,
    type,
    content,
    episodeId: input.episode.id,
    createdAt: now(),
  };
}

function normalizePeerMessageType(value: unknown): TeamMessageType | undefined {
  return value === "question" ||
    value === "answer" ||
    value === "status_report" ||
    value === "blocked" ||
    value === "handoff" ||
    value === "artifact_delivery" ||
    value === "review_request" ||
    value === "change_request" ||
    value === "approval"
    ? value
    : undefined;
}

function findAllowedPeerMessageRule(input: {
  episode: ActEpisode;
  from: string;
  to: string;
  type: TeamMessageType;
}): CommunicationRule | undefined {
  return input.episode.communicationRules.find(
    (rule) => rule.from === input.from && rule.to === input.to && rule.allowedMessageTypes.includes(input.type),
  );
}

function claimAllowedPeerPairTurn(input: {
  from: string;
  to: string;
  rule: Pick<CommunicationRule, "maxTurns">;
  peerPairTurnCounts: Map<string, number>;
}): boolean {
  const key = `${input.from}->${input.to}`;
  const current = input.peerPairTurnCounts.get(key) ?? 0;
  if (input.rule.maxTurns !== undefined && current >= input.rule.maxTurns) {
    return false;
  }
  input.peerPairTurnCounts.set(key, current + 1);
  return true;
}

function isSystemServiceRecipient(id: string): boolean {
  return id === "mailbox" || id === "state_store" || id === "review_gate" || id === "human_input_gateway";
}

async function requestHumanInputForReview(input: {
  session: TeamSession;
  request: TeamRunRequest;
  policies: Record<string, unknown>;
  reason: "review_blocked" | "max_review_rounds";
  round: number;
  reviews: ReviewRoundOutput[];
  record: (event: TeamRunEvent) => Promise<TeamRunEvent>;
}): Promise<string | undefined> {
  const allowHumanInput = input.policies.allowHumanInput !== false;
  const firstReview = input.reviews[0];
  if (!firstReview || !allowHumanInput) {
    return undefined;
  }

  const humanRequest: HumanInputRequest = {
    id: `human_${input.session.humanInputs.length + 1}`,
    sessionId: input.session.id,
    workItemId: firstReview.reviewTask.targetWorkItemId,
    fromRoleId: "review_gate",
    toRoleId: "user",
    question: buildHumanReviewQuestion(input),
    status: "pending",
    reason: input.reason,
    context: {
      round: input.round,
      reviews: input.reviews.map((review) => ({
        targetWorkItemId: review.reviewTask.targetWorkItemId,
        reviewerRoleId: review.reviewTask.reviewerRoleId,
        outcome: review.result.outcome,
        summary: review.result.summary,
        requiredChanges: review.result.requiredChanges ?? [],
      })),
    },
    createdAt: now(),
  };
  input.session.humanInputs.push(humanRequest);
  input.session.status = "waiting";
  input.session.currentPhase = "waiting_for_human";
  await input.record({ type: "human_input_requested", request: { ...humanRequest } });
  await input.record({ type: "session_updated", session: input.session });

  const answer = await input.request.requestHumanInput?.(humanRequest);
  if (!answer?.trim()) {
    return undefined;
  }

  humanRequest.status = "answered";
  humanRequest.answer = answer.trim();
  humanRequest.answeredBy = "user";
  humanRequest.answeredAt = now();
  input.session.status = "running";
  input.session.currentPhase = "dispatching";
  await input.record({ type: "human_input_answered", request: { ...humanRequest } });
  await input.record({ type: "session_updated", session: input.session });
  return humanRequest.answer;
}

function buildHumanReviewQuestion(input: {
  reason: "review_blocked" | "max_review_rounds";
  round: number;
  reviews: ReviewRoundOutput[];
}): string {
  const lead = input.reason === "review_blocked" ? "Review Gate 遇到阻塞，需要人工判断后才能继续。" : "Review Gate 已达到最大审核轮次，需要人工决定是否继续修改。";
  const reviewSummary = input.reviews
    .map((review, index) => {
      const requiredChanges = review.result.requiredChanges?.length ? `必须处理：${review.result.requiredChanges.join("；")}` : "无结构化 requiredChanges。";
      return `${index + 1}. ${review.target.instance.displayName} / ${review.reviewTask.id}: ${review.result.summary}\n${requiredChanges}`;
    })
    .join("\n");
  return [lead, `当前轮次：${input.round}`, reviewSummary, "请给出明确处理意见：继续修改、接受风险定稿，或说明需要补充的信息。"].join("\n\n");
}

function createRevisionAssignment(input: {
  round: number;
  target: { instance: RoleInstance; output: string };
  review: {
    reviewTask: ReviewTask;
    result: ReviewResult;
    rawOutput: string;
    reviewerInstance: RoleInstance;
  };
  humanAnswer?: string;
}): TeamAssignment {
  return {
    roleId: input.target.instance.roleId,
    task: [
      `第 ${input.round + 1} 轮 Act：请根据 ${input.review.reviewerInstance.displayName} 的审核意见修改上一版产物。`,
      "要求输出完整修订结果，不要只列修改说明。",
      input.review.result.requiredChanges?.length ? `必须处理的问题：${input.review.result.requiredChanges.join("；")}` : "",
      input.humanAnswer ? `人工介入意见：${input.humanAnswer}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    reason: input.humanAnswer ? "Team ReAct review 和人工介入要求进入下一轮修改。" : "Team ReAct review 要求进入下一轮修改。",
    context: {
      previousOutput: input.target.output,
      reviewResult: input.review.result,
      reviewOutput: input.review.rawOutput,
      humanAnswer: input.humanAnswer,
    },
    dependencies: [input.review.reviewTask.targetWorkItemId],
    acceptanceCriteria: input.review.result.requiredChanges ?? [],
    requiresReview: true,
  };
}

async function runReviewRound(input: {
  session: TeamSession;
  request: TeamRunRequest;
  policies: Record<string, unknown>;
  startedAt: number;
  reviewer: ResolvedRole;
  target: { instance: RoleInstance; output: string };
  round: number;
  getRoleSession: (assignment: TeamAssignment) => { instance: RoleInstance; role: ResolvedRole };
  record: (event: TeamRunEvent) => Promise<TeamRunEvent>;
}): Promise<{
  reviewTask: ReviewTask;
  result: ReviewResult;
  rawOutput: string;
  reviewerInstance: RoleInstance;
}> {
  const reviewerEntry = input.getRoleSession({
    roleId: input.reviewer.id,
    task: `第 ${input.round} 轮审核 ${input.target.instance.displayName} 的产物。`,
    reason: "Team ReAct review checkpoint",
  });
  reviewerEntry.instance.assignedTask = `第 ${input.round} 轮审核 ${input.target.instance.displayName} 的产物。`;
  reviewerEntry.instance.status = "running";
  const targetWorkItemId = findLatestCompletedWorkItemId(input.session, input.target.instance.id) ?? "unknown";
  const reviewTask: ReviewTask = {
    id: `review_${input.session.reviews.length + 1}`,
    targetWorkItemId,
    reviewerRoleId: input.reviewer.id,
    reviewerInstanceId: reviewerEntry.instance.id,
    round: input.round,
    status: "pending",
    policy: {
      forbidSelfReview: true,
      maxRounds: maxReviewRoundsFromPolicies(input.policies),
      strictSchema: input.policies.requireStrictReviewJson !== false,
      acceptanceCriteria: Object.values(input.session.workItems).find((item) => item.id === targetWorkItemId)?.acceptanceCriteria ?? [],
    },
    requestedAt: now(),
  };
  input.session.reviews.push(reviewTask);

  await postTeamMessage({
    session: input.session,
    record: input.record,
    message: {
      id: `msg_${reviewTask.id}_request`,
      from: input.target.instance.id,
      to: reviewerEntry.instance.id,
      type: "review_request",
      content: `请审核 ${input.target.instance.displayName} 的第 ${input.round} 轮产物。`,
      workItemId: targetWorkItemId,
      createdAt: reviewTask.requestedAt,
    },
  });
  await input.record({ type: "review_requested", review: { ...reviewTask } });
  await input.record({ type: "role_instance_started", instance: { ...reviewerEntry.instance } });

  reviewTask.status = "running";
  reviewTask.startedAt = now();
  const runtime = requireRuntime(input.request.runtimeRegistry, reviewerEntry.instance.runtimeId);
  const reviewPrompt = buildReviewPrompt({
    reviewer: input.reviewer,
    target: input.target,
    round: input.round,
    acceptanceCriteria: reviewTask.policy?.acceptanceCriteria ?? [],
  });
  const rawOutput = await collectRuntimeOutput({
    runtime,
    role: input.reviewer,
    sessionId: `${input.session.id}_${reviewerEntry.instance.id}_review_${input.round}`,
    task: buildRolePrompt({
      role: input.reviewer,
      task: reviewPrompt,
      context: {
        teamReact: true,
        reviewTask,
        targetRole: input.target.instance.roleId,
        targetOutput: input.target.output,
      },
    }),
    context: {
      teamReact: true,
      reviewTask,
      targetRole: input.target.instance.roleId,
      targetOutput: input.target.output,
    },
    timeoutMs: policyTimeoutMs(input.policies, input.startedAt),
    onAgentEvent: async (event) => {
      await input.record({ type: "agent_event", instanceId: reviewerEntry.instance.id, event });
    },
    record: input.record,
  });

  const parsed = await parseAndValidateReviewResult({
    rawOutput,
    input,
    reviewTask,
    reviewerEntry,
    runtime,
  });
  const result = parsed.result;
  const reviewOutput = parsed.rawOutput;
  if (parsed.gateErrors.length > 0) {
    await input.record({ type: "review_gate_failed", review: { ...reviewTask }, errors: parsed.gateErrors, rawOutput });
  }
  reviewTask.status = parsed.gateErrors.length > 0 && result.outcome === "blocked" ? "blocked" : "completed";
  reviewTask.completedAt = now();
  reviewTask.result = result;
  reviewerEntry.instance.status = "completed";
  await postTeamMessage({
    session: input.session,
    record: input.record,
    message: {
      id: `msg_${reviewTask.id}_result`,
      from: reviewerEntry.instance.id,
      to: input.target.instance.id,
      type: result.outcome === "approved" ? "approval" : result.outcome === "blocked" ? "blocked" : "change_request",
      content: reviewOutput,
      workItemId: targetWorkItemId,
      createdAt: reviewTask.completedAt,
      metadata: { reviewTaskId: reviewTask.id, outcome: result.outcome },
    },
  });
  await input.record({ type: "review_completed", review: { ...reviewTask } });
  await input.record({ type: "role_instance_completed", instance: { ...reviewerEntry.instance }, output: reviewOutput });

  return { reviewTask, result, rawOutput: reviewOutput, reviewerInstance: { ...reviewerEntry.instance } };
}

function buildReviewPrompt(input: {
  reviewer: ResolvedRole;
  target: { instance: RoleInstance; output: string };
  round: number;
  acceptanceCriteria: string[];
}): string {
  return [
    `你正在进行 Team ReAct 第 ${input.round} 轮 review checkpoint。`,
    `被审核角色：${input.target.instance.displayName}(${input.target.instance.roleId})`,
    "",
    "审核目标：",
    "- 判断产物是否可以进入最终汇总。",
    "- 如果需要修改，给出具体、可执行的 requiredChanges。",
    "- 不要重写整篇产物，除非任务明确要求。",
    "- 输出必须是 JSON，不要输出 Markdown。",
    "",
    input.acceptanceCriteria.length ? `验收标准：${JSON.stringify(input.acceptanceCriteria)}` : "验收标准：按用户任务、角色职责和领域质量判断。",
    "",
    "被审核产物：",
    input.target.output,
    "",
    "请输出 JSON：",
    JSON.stringify(
      {
        outcome: "approved | changes_requested | blocked",
        summary: "审核摘要",
        findings: [
          {
            severity: "blocking | major | minor | note",
            message: "问题或确认点",
            evidence: "产物中的依据",
            target: "对应段落、文件或模块",
          },
        ],
        requiredChanges: ["当 outcome 为 changes_requested 时列出必须修改项"],
        evidence: ["支撑审核结论的证据"],
      },
      null,
      2,
    ),
  ].join("\n");
}

async function parseAndValidateReviewResult(input: {
  rawOutput: string;
  input: {
    session: TeamSession;
    request: TeamRunRequest;
    policies: Record<string, unknown>;
    startedAt: number;
    reviewer: ResolvedRole;
    target: { instance: RoleInstance; output: string };
    round: number;
    record: (event: TeamRunEvent) => Promise<TeamRunEvent>;
  };
  reviewTask: ReviewTask;
  reviewerEntry: { instance: RoleInstance; role: ResolvedRole };
  runtime: AgentRuntime;
}): Promise<{ result: ReviewResult; rawOutput: string; gateErrors: string[] }> {
  const strict = input.reviewTask.policy?.strictSchema !== false;
  let parsed = parseReviewResult(input.rawOutput);
  let errors = validateReviewResult(parsed, { strict });
  const repairAttempts = Math.max(0, Math.min(Number(input.input.policies.reviewRepairAttempts ?? 1), 3));

  for (let attempt = 1; errors.length > 0 && attempt <= repairAttempts; attempt += 1) {
    const repairedOutput = await collectRuntimeOutput({
      runtime: input.runtime,
      role: input.input.reviewer,
      sessionId: `${input.input.session.id}_${input.reviewerEntry.instance.id}_review_${input.input.round}_repair_${attempt}`,
      task: buildRolePrompt({
        role: input.input.reviewer,
        task: buildReviewRepairPrompt({
          rawOutput: parsed.rawOutput,
          errors,
        }),
        context: {
          teamReact: true,
          reviewGateRepair: true,
          reviewTask: input.reviewTask,
          targetRole: input.input.target.instance.roleId,
          targetOutput: input.input.target.output,
        },
      }),
      context: {
        teamReact: true,
        reviewGateRepair: true,
        reviewTask: input.reviewTask,
        targetRole: input.input.target.instance.roleId,
        targetOutput: input.input.target.output,
      },
      timeoutMs: policyTimeoutMs(input.input.policies, input.input.startedAt),
      onAgentEvent: async (event) => {
        await input.input.record({ type: "agent_event", instanceId: input.reviewerEntry.instance.id, event });
      },
      record: input.input.record,
    });
    parsed = parseReviewResult(repairedOutput);
    errors = validateReviewResult(parsed, { strict });
  }

  if (errors.length === 0) {
    return { result: parsed.result, rawOutput: parsed.rawOutput, gateErrors: [] };
  }

  return {
    result: createBlockedReviewResult(errors, parsed.rawOutput),
    rawOutput: parsed.rawOutput,
    gateErrors: errors,
  };
}

function buildReviewRepairPrompt(input: { rawOutput: string; errors: string[] }): string {
  return [
    "Review Gate 拒绝了你的审核输出，因为它不符合结构化审核协议。",
    "请只把原审核结论改写为严格 JSON，不要新增 Markdown，不要重写被审核产物。",
    "",
    `协议错误：${JSON.stringify(input.errors)}`,
    "",
    "原审核输出：",
    input.rawOutput,
    "",
    "必须输出 JSON：",
    JSON.stringify(
      {
        outcome: "approved | changes_requested | blocked",
        summary: "审核摘要",
        findings: [
          {
            severity: "blocking | major | minor | note",
            message: "问题或确认点",
            evidence: "产物中的依据",
            target: "对应段落、文件或模块",
          },
        ],
        requiredChanges: ["当 outcome 为 changes_requested 时列出必须修改项"],
        evidence: ["支撑审核结论的证据"],
      },
      null,
      2,
    ),
  ].join("\n");
}

function parseReviewResult(output: string): { result: ReviewResult; source: "json" | "fallback"; rawOutput: string } {
  const parsed = extractJsonObject(output);
  if (parsed) {
    const outcome = normalizeReviewOutcome(parsed.outcome);
    return {
      source: "json",
      rawOutput: output,
      result: {
        outcome,
        summary: typeof parsed.summary === "string" ? parsed.summary : output.slice(0, 500),
        findings: Array.isArray(parsed.findings) ? parsed.findings.map((finding) => normalizeReviewFinding(finding)) : [],
        requiredChanges: Array.isArray(parsed.requiredChanges) ? parsed.requiredChanges.map(String).filter(Boolean) : undefined,
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String).filter(Boolean) : undefined,
      },
    };
  }

  const lower = output.toLowerCase();
  const outcome =
    /approved|approve|通过|同意|无需修改|无须修改/.test(lower)
      ? "approved"
      : /blocked|阻塞|无法继续/.test(lower)
        ? "blocked"
        : "changes_requested";
  return {
    source: "fallback",
    rawOutput: output,
    result: {
      outcome,
      summary: output.slice(0, 500),
      findings: outcome === "approved" ? [] : [{ severity: "major", message: output.slice(0, 500) }],
      requiredChanges: outcome === "changes_requested" ? [output.slice(0, 500)] : undefined,
    },
  };
}

function validateReviewResult(
  parsed: { result: ReviewResult; source: "json" | "fallback" },
  options: { strict: boolean },
): string[] {
  const errors: string[] = [];
  const result = parsed.result;
  if (options.strict && parsed.source !== "json") {
    errors.push("review output must be parseable JSON");
  }
  if (!["approved", "changes_requested", "blocked"].includes(result.outcome)) {
    errors.push("outcome must be approved, changes_requested, or blocked");
  }
  if (!result.summary.trim()) {
    errors.push("summary is required");
  }
  if (!Array.isArray(result.findings)) {
    errors.push("findings must be an array");
  }
  if (result.findings.some((finding) => !finding.message.trim())) {
    errors.push("each finding must include message");
  }
  if (result.outcome === "changes_requested" && (!result.requiredChanges || result.requiredChanges.length === 0)) {
    errors.push("changes_requested review must include requiredChanges");
  }
  if (result.outcome === "approved" && result.findings.some((finding) => finding.severity === "blocking" || finding.severity === "major")) {
    errors.push("approved review cannot include blocking or major findings");
  }
  if (result.outcome === "blocked" && result.findings.length === 0) {
    errors.push("blocked review must include at least one finding");
  }
  return errors;
}

function createBlockedReviewResult(errors: string[], rawOutput: string): ReviewResult {
  return {
    outcome: "blocked",
    summary: "Review Gate 未收到合格的结构化审核结果，已阻塞等待人工判断。",
    findings: [
      {
        severity: "blocking",
        message: `审核协议校验失败：${errors.join("；")}`,
        evidence: rawOutput.slice(0, 500),
        target: "review_output",
      },
    ],
    evidence: [rawOutput.slice(0, 500)],
  };
}

function extractJsonObject(output: string): Record<string, unknown> | undefined {
  const candidates = [output, ...Array.from(output.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)).map((match) => match[1] ?? "")];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function normalizeReviewOutcome(value: unknown): ReviewResult["outcome"] {
  return value === "approved" || value === "changes_requested" || value === "blocked" ? value : "changes_requested";
}

function normalizeReviewFinding(value: unknown): ReviewResult["findings"][number] {
  if (!value || typeof value !== "object") {
    return { severity: "note", message: String(value) };
  }
  const record = value as Record<string, unknown>;
  const severity =
    record.severity === "blocking" || record.severity === "major" || record.severity === "minor" || record.severity === "note"
      ? record.severity
      : "note";
  return {
    severity,
    message: typeof record.message === "string" ? record.message : JSON.stringify(record),
    evidence: typeof record.evidence === "string" ? record.evidence : undefined,
    target: typeof record.target === "string" ? record.target : undefined,
  };
}

function latestOutputsByNonReviewer(
  outputs: Array<{ instance: RoleInstance; output: string }>,
  reviewerRoleId: string,
): Array<{ instance: RoleInstance; output: string }> {
  const latestByInstance = new Map<string, { instance: RoleInstance; output: string }>();
  for (const item of outputs) {
    if (item.instance.roleId !== reviewerRoleId) {
      latestByInstance.set(item.instance.id, item);
    }
  }
  return Array.from(latestByInstance.values());
}

function findLatestCompletedWorkItemId(session: TeamSession, instanceId: string): string | undefined {
  return Object.values(session.workItems)
    .filter((item) => item.roleInstanceId === instanceId && item.status === "completed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id;
}

function completeOpenActEpisodes(session: TeamSession): void {
  const completedAt = now();
  for (const episode of session.actEpisodes) {
    if (episode.status === "planned" || episode.status === "running" || episode.status === "reviewing") {
      episode.status = "completed";
      episode.completedAt = completedAt;
    }
  }
}

function blockOpenActEpisodes(session: TeamSession): void {
  const completedAt = now();
  for (const episode of session.actEpisodes) {
    if (episode.status === "planned" || episode.status === "running" || episode.status === "reviewing") {
      episode.status = "blocked";
      episode.completedAt = completedAt;
    }
  }
}

function maxReviewRoundsFromPolicies(policies: Record<string, unknown>): number {
  const configured = Number(policies.maxReviewRounds ?? policies.maxRounds ?? 1);
  if (!Number.isFinite(configured) || configured <= 0) {
    return 1;
  }
  return Math.max(1, Math.min(Math.floor(configured), 6));
}

function maxPeerTurnsFromPolicies(policies: Record<string, unknown>): number {
  const configured = Number(policies.maxPeerTurnsPerAct ?? 3);
  if (!Number.isFinite(configured) || configured <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(Math.floor(configured), 12));
}

function maxPeerMessagesPerPairPerTurnFromPolicies(policies: Record<string, unknown>): number {
  const configured = Number(policies.maxPeerMessagesPerPairPerTurn ?? 3);
  if (!Number.isFinite(configured) || configured <= 0) {
    return 1;
  }
  return Math.max(1, Math.min(Math.floor(configured), 12));
}

function createWorkItem(input: {
  assignment: TeamAssignment;
  entry: { instance: RoleInstance; role: ResolvedRole };
  sequence: number;
  sessionId: string;
}): TeamWorkItem {
  const createdAt = now();
  return {
    id: `work_${input.sequence}`,
    roleId: input.entry.role.id,
    roleInstanceId: input.entry.instance.id,
    title: input.assignment.task,
    goal: input.assignment.task,
    assignment: input.assignment,
    status: "pending",
    sequence: input.sequence,
    dependencies: input.assignment.dependencies ?? [],
    inputs: [
      {
        kind: "context",
        name: "assignment.context",
        value: input.assignment.context ?? {},
      },
    ],
    expectedArtifacts:
      input.assignment.expectedArtifacts && input.assignment.expectedArtifacts.length > 0
        ? input.assignment.expectedArtifacts
        : [
            {
              name: `${input.entry.instance.id}-output`,
              kind: "role_output",
              required: true,
              description: "角色完成本次 work item 后返回的主要输出。",
            },
          ],
    acceptanceCriteria: input.assignment.acceptanceCriteria ?? [],
    attempts: 0,
    idempotencyKey: `${input.sessionId}:${input.entry.instance.id}:work_${input.sequence}:${slug(input.assignment.task)}`,
    createdAt,
    updatedAt: createdAt,
  };
}

function createActEpisode(input: {
  id: string;
  round: number;
  goal: string;
  items: Array<{ workItem: TeamWorkItem; entry: { instance: RoleInstance; role: ResolvedRole } }>;
  requireFinalReview: boolean;
  reviewerRoleIds: string[];
  maxPeerTurns: number;
  maxPeerMessagesPerPairPerTurn: number;
}): ActEpisode {
  const leadToParticipantMessages: TeamMessageType[] = ["task_request", "question", "answer", "change_request"];
  const participantToLeadMessages: TeamMessageType[] = ["status_report", "blocked", "escalation", "handoff", "artifact_delivery"];
  const peerMessages: TeamMessageType[] = [
    "question",
    "answer",
    "artifact_delivery",
    "review_request",
    "change_request",
    "blocked",
    "approval",
    "handoff",
  ];
  const participants = input.items.map((item) => ({
    roleId: item.entry.role.id,
    instanceId: item.entry.instance.id,
    displayName: item.entry.instance.displayName,
    responsibility: item.workItem.title,
    visibleToPeers: true,
  }));
  const uniqueParticipants = Array.from(new Map(participants.map((participant) => [participant.instanceId, participant])).values());
  const communicationRules = uniqueParticipants.flatMap((participant) => [
    {
      from: TEAM_LEAD_ROLE_ID,
      to: participant.instanceId,
      allowedMessageTypes: leadToParticipantMessages,
    },
    {
      from: participant.instanceId,
      to: TEAM_LEAD_ROLE_ID,
      allowedMessageTypes: participantToLeadMessages,
    },
    ...uniqueParticipants
      .filter((peer) => peer.instanceId !== participant.instanceId)
      .map((peer) => ({
        from: participant.instanceId,
        to: peer.instanceId,
        allowedMessageTypes: peerMessages,
        maxTurns: input.maxPeerTurns,
        maxMessagesPerPairPerTurn: input.maxPeerMessagesPerPairPerTurn,
      })),
  ]);

  return {
    id: input.id,
    round: input.round,
    goal: input.goal,
    status: "planned",
    participants: uniqueParticipants,
    communicationRules,
    inputArtifactIds: [],
    expectedArtifacts: input.items.flatMap((item) => item.workItem.expectedArtifacts),
    acceptanceCriteria: input.items.flatMap((item) => item.workItem.acceptanceCriteria),
    reviewPolicy: {
      required: input.requireFinalReview || input.items.some((item) => item.workItem.assignment.requiresReview),
      reviewerRoleIds: input.reviewerRoleIds,
      trigger: "on_all_work_items_done",
    },
    createdAt: now(),
  };
}

function createOutputArtifact(input: {
  workItem: TeamWorkItem;
  instance: RoleInstance;
  output: string;
}): ArtifactRef {
  return {
    id: `artifact_${input.workItem.id}_output`,
    name: `${input.instance.id} output`,
    kind: "role_output",
    content: input.output,
    workItemId: input.workItem.id,
    roleInstanceId: input.instance.id,
    createdAt: now(),
  };
}

function createFinalArtifact(input: { session: TeamSession; finalOutput: string }): ArtifactRef {
  return {
    id: "artifact_final_output",
    name: "final output",
    kind: "final_output",
    content: input.finalOutput,
    createdAt: now(),
    metadata: {
      sessionId: input.session.id,
      source: TEAM_LEAD_ROLE_ID,
    },
  };
}

function normalizePlan(
  plan: TeamPlan,
  teammates: ResolvedRole[],
  team: TeamDefinition,
  policies: Record<string, unknown>,
): TeamPlan {
  const teammateIds = new Set(teammates.map((role) => role.id));
  const allowContractor = policies.allowBuiltinContractor !== false;
  const assignments: TeamAssignment[] = [];
  let contractorCount = 0;
  const maxContractors = Number(policies.maxBuiltinContractors ?? 2);

  for (const assignment of plan.assignments) {
    if (teammateIds.has(assignment.roleId)) {
      assignments.push(assignment);
      continue;
    }

    if (assignment.roleId === BUILTIN_CONTRACTOR_ROLE_ID && allowContractor && contractorCount < maxContractors) {
      assignments.push({
        ...assignment,
        contractorSpecialty: assignment.contractorSpecialty || "通用专项",
      });
      contractorCount += 1;
    }
  }

  if (assignments.length === 0) {
    const fallbackRole = teammates[0];
    if (!fallbackRole) {
      throw new Error(`Team ${team.id} has no usable teammates`);
    }
    assignments.push({ roleId: fallbackRole.id, task: plan.summary || "完成用户任务" });
  }

  const maxInstances = Number(policies.maxRoleInstances ?? 6);
  return {
    summary: plan.summary || "team_lead 生成的执行计划",
    assignments: assignments.slice(0, maxInstances),
  };
}

function fallbackPlan(task: string, teammates: ResolvedRole[]): TeamPlan {
  const first = teammates[0];
  if (!first) {
    return { summary: "没有可用 teammate", assignments: [] };
  }
  return {
    summary: "team_lead 输出无法解析，使用首个 teammate 兜底执行。",
    assignments: [{ roleId: first.id, task }],
  };
}

function roleSessionKey(assignment: TeamAssignment): string {
  if (assignment.roleId === BUILTIN_CONTRACTOR_ROLE_ID) {
    return `${BUILTIN_CONTRACTOR_ROLE_ID}:${assignment.contractorSpecialty || "general"}`;
  }
  return assignment.roleId;
}

function createRoleSession(input: {
  assignment: TeamAssignment;
  resolvedTeammates: ResolvedRole[];
  request: TeamRunRequest;
}): { instance: RoleInstance; role: ResolvedRole } {
  const teammate = input.resolvedTeammates.find((role) => role.id === input.assignment.roleId);
  const isContractor = input.assignment.roleId === BUILTIN_CONTRACTOR_ROLE_ID;
  const role = teammate ?? createBuiltinContractorRole({
    specialty: input.assignment.contractorSpecialty || "通用专项",
    runtimeId: input.request.team.lead?.runtime ?? "codex-cli",
  });

  const roleLimit = input.request.team.policies?.roleInstanceLimits?.[role.id];
  if (roleLimit?.maxInstances === 0) {
    throw new Error(`Role ${role.id} is not allowed to create instances`);
  }

  const instanceId = isContractor ? `contractor_${slug(input.assignment.contractorSpecialty || "general")}` : role.id;

  return {
    role,
    instance: {
      id: instanceId,
      roleId: role.id,
      displayName: role.displayName,
      runtimeId: role.runtimeId,
      assignedTask: input.assignment.task,
      context: input.assignment.context ?? {},
      status: "pending",
      contractorSpecialty: input.assignment.contractorSpecialty,
    },
  };
}

function reconstructRunResult(session: TeamSession): TeamRunResult {
  const outputs = Object.values(session.workItems)
    .filter((workItem) => workItem.result)
    .map((workItem) => ({
      instance: session.roleInstances[workItem.roleInstanceId] ?? {
        id: workItem.roleInstanceId,
        roleId: workItem.roleId,
        displayName: workItem.roleId,
        runtimeId: "unknown",
        assignedTask: workItem.title,
        context: {},
        status: "completed" as const,
      },
      output: workItem.result?.output ?? "",
    }));
  return {
    session,
    plan: session.plan ?? { summary: "恢复的历史运行没有 plan 快照。", assignments: [] },
    outputs,
    finalOutput: session.finalOutput ?? "",
  };
}

async function collectRuntimeOutput(input: {
  runtime: AgentRuntime;
  role: ResolvedRole;
  sessionId: string;
  task: string;
  context: Record<string, unknown>;
  timeoutMs?: number;
  onAgentEvent?: (event: AgentEvent) => void | Promise<void>;
  record?: (event: TeamRunEvent) => Promise<TeamRunEvent>;
}): Promise<string> {
  let final = "";
  await input.record?.({
    type: "runtime_session_started",
    runtimeId: input.runtime.id,
    roleId: input.role.id,
    runtimeSessionId: input.sessionId,
  });
  try {
    for await (const event of input.runtime.run({
      sessionId: input.sessionId,
      role: input.role,
      task: input.task,
      context: input.context,
      limits: { timeoutMs: input.timeoutMs },
    })) {
      await input.onAgentEvent?.(event);
      if (event.type === "message") {
        final += event.content;
      }
      if (event.type === "final") {
        final = event.output;
      }
      if (event.type === "error") {
        throw new Error(event.error);
      }
    }
    await input.record?.({
      type: "runtime_session_completed",
      runtimeId: input.runtime.id,
      roleId: input.role.id,
      runtimeSessionId: input.sessionId,
    });
    return final.trim();
  } catch (error) {
    const failure = classifyRuntimeFailure(error);
    await input.record?.({
      type: failure.category === "cancelled" ? "runtime_session_cancelled" : "runtime_session_failed",
      runtimeId: input.runtime.id,
      roleId: input.role.id,
      runtimeSessionId: input.sessionId,
      ...(failure.category === "cancelled" ? {} : { failure }),
    } as TeamRunEvent);
    throw error;
  }
}

function classifyRuntimeFailure(error: unknown): RuntimeFailure {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const category: RuntimeFailure["category"] = /cancel|aborted|abort/.test(lower)
    ? "cancelled"
    : /timeout|timed out|deadline/.test(lower)
      ? "timeout"
      : error instanceof Error
        ? "runtime_error"
        : "unknown";
  return {
    category,
    message,
    retryable: category === "timeout" || category === "runtime_error" || category === "unknown",
    stack: error instanceof Error ? error.stack : undefined,
  };
}

function requireRuntime(registry: Record<string, AgentRuntime>, runtimeId: string): AgentRuntime {
  const runtime = registry[runtimeId];
  if (!runtime) {
    throw new Error(`Missing runtime: ${runtimeId}`);
  }
  return runtime;
}

function updateTaskStatus(
  session: { taskBoard: Array<{ id: string; roleInstanceId?: string; status: "pending" | "running" | "completed" | "failed" }> },
  taskId: string,
  status: "pending" | "running" | "completed" | "failed",
) {
  const task = session.taskBoard.find((item) => item.id === taskId);
  if (task) {
    task.status = status;
  }
}

async function runSequentially<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    results.push(await fn(item));
  }
  return results;
}

async function postTeamMessage(input: {
  session: TeamSession;
  record: (event: TeamRunEvent) => Promise<TeamRunEvent>;
  message: TeamMessage;
}) {
  input.session.messages.push(input.message);
  await input.record({ type: "team_message_posted", message: input.message });
}

function createSessionRecorder(input: {
  request: Pick<TeamRunRequest, "stateStore" | "onEvent">;
  session: TeamSession;
}): (event: TeamRunEvent) => Promise<TeamRunEvent> {
  let sequence = 0;
  let persistQueue = Promise.resolve();
  return async (event) => {
    sequence += 1;
    const timestamp = event.timestamp ?? now();
    input.session.updatedAt = timestamp;
    const recorded = {
      ...event,
      eventId: event.eventId ?? `${input.session.id}_event_${sequence}`,
      sessionId: event.sessionId ?? input.session.id,
      sequence: event.sequence ?? sequence,
      timestamp,
    } as TeamRunEvent;
    persistQueue = persistQueue.then(async () => {
      await input.request.stateStore?.appendEvent(input.session.id, recorded);
      input.request.onEvent?.(recorded);
      await input.request.stateStore?.updateSession(input.session);
    });
    await persistQueue;
    return recorded;
  };
}

function now(): string {
  return new Date().toISOString();
}

function policyTimeoutMs(policies: Record<string, unknown>, startedAt: number): number | undefined {
  const maxWallTimeSeconds = Number(policies.maxWallTimeSeconds ?? 0);
  if (!Number.isFinite(maxWallTimeSeconds) || maxWallTimeSeconds <= 0) {
    return undefined;
  }
  const remaining = maxWallTimeSeconds * 1000 - (Date.now() - startedAt);
  return Math.max(remaining, 1000);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}
