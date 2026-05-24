import { loadSystemRoles, loadSystemSkills } from "./definition-loader.js";
import type { ResolvedRole, RoleDefinition, RuntimeId, SkillDefinition, SystemAgentRoleId, SystemServiceId } from "./types.js";

export const TEAM_LEAD_ROLE_ID = "team_lead" satisfies SystemAgentRoleId;
export const BUILTIN_CONTRACTOR_ROLE_ID = "__contractor__" satisfies SystemAgentRoleId;

export interface SystemServiceDefinition {
  id: SystemServiceId;
  name: string;
  description: string;
}

export const builtinSystemServices: SystemServiceDefinition[] = [
  {
    id: "mailbox",
    name: "Team Mailbox",
    description: "系统消息总线、任务队列和 artifact 收件箱。不是 agent 角色，不具备 runtime。",
  },
  {
    id: "state_store",
    name: "Team State Store",
    description: "负责把运行快照、事件、work item、message、review 和 artifact 持久化。",
  },
  {
    id: "review_gate",
    name: "Review Gate",
    description: "负责触发审核、校验审核协议、决定是否进入下一轮 Act 或阻塞。",
  },
  {
    id: "human_input_gateway",
    name: "Human Input Gateway",
    description: "负责把 blocked 状态转成可持久化、可回答的人工介入请求。",
  },
];

export const builtinSystemSkills: SkillDefinition[] = loadDefinitions(
  () => loadSystemSkills(["contractor-execution", "team-planning", "team-synthesis"]),
  createFallbackSystemSkills(),
);

export const builtinSystemRoles: RoleDefinition[] = loadDefinitions(
  () => loadSystemRoles(["contractor", "team-lead"]),
  createFallbackSystemRoles(),
);

export const builtinTeamLeadDefinition = requireBuiltinRole(TEAM_LEAD_ROLE_ID);
export const builtinContractorDefinition = requireBuiltinRole(BUILTIN_CONTRACTOR_ROLE_ID);

export function createBuiltinTeamLeadRole(runtimeId: RuntimeId): ResolvedRole {
  return resolveBuiltinRole({
    definition: builtinTeamLeadDefinition,
    runtimeId,
    isBuiltin: true,
  });
}

export function createBuiltinContractorRole(input: {
  specialty: string;
  runtimeId: RuntimeId;
}): ResolvedRole {
  const role = resolveBuiltinRole({
    definition: builtinContractorDefinition,
    runtimeId: input.runtimeId,
    isBuiltin: true,
  });
  return {
    ...role,
    displayName: `外包-${input.specialty}`,
    contractorSpecialty: input.specialty,
    identity: {
      ...role.identity,
      name: `Contractor ${input.specialty}`,
      title: `外包-${input.specialty}`,
      mission: `以 ${input.specialty} 专项能力完成被分配的有限任务。`,
    },
  };
}

function resolveBuiltinRole(input: {
  definition: RoleDefinition;
  runtimeId: RuntimeId;
  isBuiltin: boolean;
}): ResolvedRole {
  return {
    id: input.definition.id,
    displayName: input.definition.identity.title,
    runtimeId: input.runtimeId,
    isBuiltin: input.isBuiltin,
    identity: input.definition.identity,
    skills: resolveBuiltinSkills(input.definition),
    outputSchema: input.definition.outputs?.schema,
  };
}

function resolveBuiltinSkills(role: RoleDefinition): SkillDefinition[] {
  const skillsById = new Map(builtinSystemSkills.map((skill) => [skill.id, skill]));
  return role.skills
    .map((skillRef) => skillsById.get(skillRef.id))
    .filter((skill): skill is SkillDefinition => Boolean(skill));
}

function requireBuiltinRole(roleId: SystemAgentRoleId): RoleDefinition {
  const role = builtinSystemRoles.find((item) => item.id === roleId);
  if (!role) {
    throw new Error(`Missing builtin system role: ${roleId}`);
  }
  return role;
}

function loadDefinitions<T>(loader: () => T[], fallback: T[]): T[] {
  try {
    const loaded = loader();
    return loaded.length > 0 ? loaded : fallback;
  } catch {
    return fallback;
  }
}

function createFallbackSystemRoles(): RoleDefinition[] {
  return [
    {
      id: TEAM_LEAD_ROLE_ID,
      version: 1,
      identity: {
        name: "Builtin Team Lead",
        title: "内置 Team Lead",
        summary: "系统级协调者，负责读取用户传入 teammates 并组织团队执行。",
        mission: "在受控协议下完成 Plan、Act 调度、Review Gate 接入和最终汇总。",
        responsibilities: ["拆解任务", "分配工作", "维护执行边界", "汇总最终结果"],
        boundaries: ["不能发明新 RoleDefinition", "不能把系统服务当作 teammate", "只能调用已注册 teammate 或内置 contractor"],
        communicationStyle: ["清晰", "具体", "可审计"],
        successCriteria: ["计划可执行", "Act 任务边界清楚", "最终输出忠实反映 teammate 结果和 review 结论"],
      },
      skills: [
        { id: "team-planning", version: ">=1.0.0" },
        { id: "team-synthesis", version: ">=1.0.0" },
      ],
    },
    {
      id: BUILTIN_CONTRACTOR_ROLE_ID,
      version: 1,
      identity: {
        name: "Builtin Contractor",
        title: "内置外包角色",
        summary: "系统内置外包角色，仅在已有 teammates 无法覆盖任务时临时加入。",
        mission: "以限定 specialty 完成被分配的局部任务，并清楚说明假设和适用范围。",
        responsibilities: ["只完成被分配的专项任务", "说明任务假设、限制和交付范围", "输出可被 team_lead 汇总的结果"],
        boundaries: ["不是新的用户 RoleDefinition", "不能继续邀请其他角色", "不能扩大任务范围"],
        communicationStyle: ["直接", "说明约束", "不伪装成用户 teammate"],
        successCriteria: ["完成专项任务", "明确输出可用范围", "不污染团队角色边界"],
      },
      skills: [{ id: "contractor-execution", version: ">=1.0.0" }],
    },
  ];
}

function createFallbackSystemSkills(): SkillDefinition[] {
  return [
    {
      id: "team-planning",
      version: "1.0.0",
      name: "团队计划",
      description: "把用户任务拆解成受控、可审计的第一轮 Act assignments。",
      prompt: {
        instructions: ["只把任务分配给已注册 teammate 或受控 contractor。", "Team ReAct 启用时只描述第一轮 Act。"],
      },
    },
    {
      id: "team-synthesis",
      version: "1.0.0",
      name: "团队汇总",
      description: "基于 teammate 产物、review 结论和人工介入意见生成最终交付。",
      prompt: {
        instructions: ["先输出最终成品。", "不虚构未完成的 teammate 贡献。"],
      },
    },
    {
      id: "contractor-execution",
      version: "1.0.0",
      name: "受控外包执行",
      description: "以限定 specialty 完成局部外包任务，并说明假设、限制和交付范围。",
      prompt: {
        instructions: ["只处理被分配的专项任务。", "不声称自己是用户注册 teammate。"],
      },
    },
  ];
}
