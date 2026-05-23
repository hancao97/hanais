import { buildRolePrompt, buildTeamLeadPlanningPrompt, buildTeamLeadSynthesisPrompt, extractPlan } from "./prompts.js";
import type {
  AgentEvent,
  AgentRuntime,
  ResolvedRole,
  RoleDefinition,
  RoleInstance,
  SkillDefinition,
  TeamAssignment,
  TeamDefinition,
  TeamPlan,
  TeamSession,
  TeamRunEvent,
  TeamRunRequest,
  TeamRunResult,
} from "./types.js";

export class TeamRunner {
  async run(request: TeamRunRequest): Promise<TeamRunResult> {
    const startedAt = Date.now();
    const policies = {
      allowParallelAssignments: true,
      allowDynamicRoleInstances: true,
      allowBuiltinContractor: true,
      maxRoleInstances: 6,
      maxBuiltinContractors: 2,
      ...(request.team.policies ?? {}),
    };

    const resolvedTeammates = resolveTeammates(request);
    const leadRuntimeId = request.team.lead?.runtime ?? "codex-cli";
    const leadRuntime = requireRuntime(request.runtimeRegistry, leadRuntimeId);
    const session: TeamSession = {
      id: `team_${Date.now()}`,
      teamId: request.team.id,
      task: request.task,
      lead: { id: "team_lead" as const, runtimeId: leadRuntimeId },
      teammateRoleIds: resolvedTeammates.map((role) => role.id),
      roleInstances: {},
      sharedContext: request.context ?? {},
      taskBoard: [],
      messages: [],
      artifacts: [],
      status: "running" as const,
    };

    emit(request.onEvent, { type: "session_started", session });

    const planningPrompt = buildTeamLeadPlanningPrompt({
      task: request.task,
      context: request.context ?? {},
      teammates: resolvedTeammates,
      policies,
    });

    const leadPlanText = await collectRuntimeOutput({
      runtime: leadRuntime,
      role: createBuiltinLeadRole(leadRuntimeId),
      sessionId: `${session.id}_lead_plan`,
      task: planningPrompt,
      context: request.context ?? {},
      timeoutMs: policyTimeoutMs(policies, startedAt),
      onAgentEvent: (event) => emit(request.onEvent, { type: "agent_event", event }),
    });

    emit(request.onEvent, { type: "lead_output", content: leadPlanText });

    const plan = normalizePlan(
      extractPlan(leadPlanText) ?? fallbackPlan(request.task, resolvedTeammates),
      resolvedTeammates,
      request.team,
      policies,
    );

    emit(request.onEvent, { type: "plan_created", assignments: plan.assignments });

    const runnableAssignments = plan.assignments.map((assignment, index) =>
      createRoleInstance({
        assignment,
        index,
        resolvedTeammates,
        request,
        policies,
      }),
    );

    for (const { instance } of runnableAssignments) {
      session.roleInstances[instance.id] = instance;
      session.taskBoard.push({
        id: `task_${instance.id}`,
        title: instance.assignedTask,
        roleInstanceId: instance.id,
        status: "pending",
      });
    }

    const runOne = async (entry: { instance: RoleInstance; role: ResolvedRole }) => {
      const { instance, role } = entry;
      instance.status = "running";
      updateTaskStatus(session, instance.id, "running");
      emit(request.onEvent, { type: "role_instance_started", instance: { ...instance } });

      const runtime = requireRuntime(request.runtimeRegistry, instance.runtimeId);
      const prompt = buildRolePrompt({
        role,
        task: instance.assignedTask,
        context: { ...(request.context ?? {}), ...(instance.context ?? {}) },
      });

      const output = await collectRuntimeOutput({
        runtime,
        role,
        sessionId: `${session.id}_${instance.id}`,
        task: prompt,
        context: { ...(request.context ?? {}), ...(instance.context ?? {}) },
        timeoutMs: policyTimeoutMs(policies, startedAt),
        onAgentEvent: (event) => emit(request.onEvent, { type: "agent_event", instanceId: instance.id, event }),
      });

      instance.status = "completed";
      updateTaskStatus(session, instance.id, "completed");
      emit(request.onEvent, { type: "role_instance_completed", instance: { ...instance }, output });
      return { instance: { ...instance }, output };
    };

    const outputs = policies.allowParallelAssignments
      ? await Promise.all(runnableAssignments.map(runOne))
      : await runSequentially(runnableAssignments, runOne);

    const synthesisPrompt = buildTeamLeadSynthesisPrompt({
      task: request.task,
      plan,
      outputs: outputs.map((item) => ({
        instanceName: item.instance.displayName,
        roleId: item.instance.roleId,
        output: item.output,
      })),
    });

    const finalOutput = await collectRuntimeOutput({
      runtime: leadRuntime,
      role: createBuiltinLeadRole(leadRuntimeId),
      sessionId: `${session.id}_lead_final`,
      task: synthesisPrompt,
      context: request.context ?? {},
      timeoutMs: policyTimeoutMs(policies, startedAt),
      onAgentEvent: (event) => emit(request.onEvent, { type: "agent_event", event }),
    });

    session.status = "completed";
    emit(request.onEvent, { type: "final_output", output: finalOutput });
    return { session, plan, outputs, finalOutput };
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

function createBuiltinLeadRole(runtimeId: string): ResolvedRole {
  return {
    id: "team_lead",
    displayName: "内置 Team Lead",
    runtimeId,
    isBuiltin: true,
    identity: {
      name: "Builtin Team Lead",
      title: "内置 Team Lead",
      summary: "系统内置协调者，负责读取用户传入 teammates 并组织团队执行。",
      mission: "用已有 teammate 和受控 contractor 完成用户任务。",
      responsibilities: ["拆解任务", "分配工作", "汇总结果"],
      boundaries: ["不能发明新 RoleDefinition", "只能调用已传入 teammate 或内置 contractor"],
      communicationStyle: ["清晰", "具体", "可审计"],
      successCriteria: ["计划可执行", "最终输出忠实反映 teammate 结果"],
    },
    skills: [],
  };
}

function createBuiltinContractorRole(input: {
  specialty: string;
  runtimeId: string;
}): ResolvedRole {
  return {
    id: "__contractor__",
    displayName: `外包-${input.specialty}`,
    runtimeId: input.runtimeId,
    isBuiltin: true,
    contractorSpecialty: input.specialty,
    identity: {
      name: `Contractor ${input.specialty}`,
      title: `外包-${input.specialty}`,
      summary: "系统内置外包角色，仅在已有 teammates 无法覆盖任务时临时加入。",
      mission: `以 ${input.specialty} 专项能力完成被分配的有限任务。`,
      responsibilities: ["只完成分配任务", "说明假设和限制", "输出可被 team_lead 汇总的结果"],
      boundaries: ["不是新的用户 RoleDefinition", "不能继续邀请其他角色", "不能扩大任务范围"],
      communicationStyle: ["直接", "说明约束"],
      successCriteria: ["完成专项任务", "明确输出可用范围"],
    },
    skills: [
      {
        id: "builtin-contractor",
        version: "1.0.0",
        name: "内置外包专项能力",
        description: "临时补足团队缺失能力的受控内置能力。",
        prompt: {
          instructions: [
            "只处理被分配的专项任务。",
            "不要声称自己是用户注册角色。",
            "输出中说明你作为外包角色的专项范围。",
          ],
        },
      },
    ],
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

    if (assignment.roleId === "__contractor__" && allowContractor && contractorCount < maxContractors) {
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

function createRoleInstance(input: {
  assignment: TeamAssignment;
  index: number;
  resolvedTeammates: ResolvedRole[];
  request: TeamRunRequest;
  policies: Record<string, unknown>;
}): { instance: RoleInstance; role: ResolvedRole } {
  const teammate = input.resolvedTeammates.find((role) => role.id === input.assignment.roleId);
  const isContractor = input.assignment.roleId === "__contractor__";
  const role = teammate ?? createBuiltinContractorRole({
    specialty: input.assignment.contractorSpecialty || "通用专项",
    runtimeId: input.request.team.lead?.runtime ?? "codex-cli",
  });

  const roleLimit = input.request.team.policies?.roleInstanceLimits?.[role.id];
  if (roleLimit?.maxInstances === 0) {
    throw new Error(`Role ${role.id} is not allowed to create instances`);
  }

  const instanceId = isContractor
    ? `contractor_${slug(input.assignment.contractorSpecialty || "general")}_${input.index + 1}`
    : `${role.id}_${input.index + 1}`;

  return {
    role,
    instance: {
      id: instanceId,
      roleId: role.id,
      displayName: input.assignment.instanceName || role.displayName,
      runtimeId: role.runtimeId,
      assignedTask: input.assignment.task,
      context: input.assignment.context ?? {},
      status: "pending",
      contractorSpecialty: input.assignment.contractorSpecialty,
    },
  };
}

async function collectRuntimeOutput(input: {
  runtime: AgentRuntime;
  role: ResolvedRole;
  sessionId: string;
  task: string;
  context: Record<string, unknown>;
  timeoutMs?: number;
  onAgentEvent?: (event: AgentEvent) => void;
}): Promise<string> {
  let final = "";
  for await (const event of input.runtime.run({
    sessionId: input.sessionId,
    role: input.role,
    task: input.task,
    context: input.context,
    limits: { timeoutMs: input.timeoutMs },
  })) {
    input.onAgentEvent?.(event);
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
  return final.trim();
}

function requireRuntime(registry: Record<string, AgentRuntime>, runtimeId: string): AgentRuntime {
  const runtime = registry[runtimeId];
  if (!runtime) {
    throw new Error(`Missing runtime: ${runtimeId}`);
  }
  return runtime;
}

function updateTaskStatus(
  session: { taskBoard: Array<{ roleInstanceId?: string; status: "pending" | "running" | "completed" | "failed" }> },
  instanceId: string,
  status: "pending" | "running" | "completed" | "failed",
) {
  const task = session.taskBoard.find((item) => item.roleInstanceId === instanceId);
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

function emit(callback: ((event: TeamRunEvent) => void) | undefined, event: TeamRunEvent) {
  callback?.(event);
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
