import type { ActEpisode, ResolvedRole, TeamAssignment, TeamMessage, TeamPlan } from "./types.js";

export function buildTeamLeadPlanningPrompt(input: {
  task: string;
  context: Record<string, unknown>;
  teammates: ResolvedRole[];
  policies: Record<string, unknown>;
}): string {
  const teammateSummary = input.teammates
    .map((role) => {
      const skills = role.skills.map((skill) => `${skill.name}(${skill.id})`).join(", ");
      return [
        `- roleId: ${role.id}`,
        `  title: ${role.identity.title}`,
        `  description: ${role.identity.summary}`,
        `  sessionSkills: ${skills || "无"}`,
      ].join("\n");
    })
    .join("\n");
  const teamReactEnabled = input.policies.enableTeamReAct === true || input.policies.requireFinalReview === true;
  const reviewerRoleIds = Array.isArray(input.policies.reviewerRoleIds) ? input.policies.reviewerRoleIds.map(String) : [];

  return [
    "你是系统内置的 team_lead。你负责组织用户传入的 teammates 完成任务。",
    "",
    "硬性规则：",
    "1. 你只能把任务分配给下面列出的 roleId。",
    "2. 你不能发明新的用户角色，不能临时创建 database_expert / security_expert 等未注册角色。",
    "3. 如果确实缺少角色，且任务无法由现有 teammate 完成，可以使用特殊 roleId: __contractor__。",
    "4. __contractor__ 表示系统内置外包角色，不是新 RoleDefinition。必须填写 contractorSpecialty。",
    "5. 优先使用已有 teammate；只有明显缺角色时才使用 __contractor__。",
    teamReactEnabled
      ? "6. 当前启用 Team ReAct。assignments 只描述第一轮 Act 的执行任务，不要把审核、修改、复审预排进 assignments；系统会在 Act 后自动触发 Review 和下一轮 Act。"
      : "6. assignments 是有时序的工作队列，必须按实际依赖顺序排列。例如先写初稿，再审核，再修改，再复审。",
    "7. 多轮工作必须复用同一个 roleId。不要为了“初稿/修改/一审/终审”创造多个同类人物或多个实例名。",
    "8. 后续 assignment 会自动收到前序 teammate 输出作为 teamArtifacts，不要要求角色去文件系统寻找前序产物。",
    "9. 输出必须是 JSON，不要输出 Markdown。",
    teamReactEnabled
      ? `10. reviewer 角色不用作为第一轮 assignment；它会作为 Review checkpoint 被系统调用。当前 reviewerRoleIds=${JSON.stringify(reviewerRoleIds)}。`
      : "",
    "11. mailbox、state_store、review_gate、human_input_gateway 是系统服务，不是可分配 teammate。",
    "",
    "可用 teammate 调度卡片：",
    teammateSummary,
    "",
    `team policies: ${JSON.stringify(input.policies)}`,
    `context: ${JSON.stringify(input.context)}`,
    "",
    `用户任务：${input.task}`,
    "",
    "请输出 JSON，格式如下：",
    JSON.stringify(
      {
        summary: "任务拆解摘要",
        assignments: [
          {
            roleId: "已有 roleId 或 __contractor__",
            instanceName: "可选实例名",
            task: "分配给该实例的具体任务",
            reason: "为什么分配给它",
            contractorSpecialty: "当 roleId 为 __contractor__ 时必填",
            context: {},
          },
        ],
      },
      null,
      2,
    ),
  ].join("\n");
}

export function buildTeamLeadSynthesisPrompt(input: {
  task: string;
  plan: TeamPlan;
  outputs: Array<{ instanceName: string; roleId: string; output: string }>;
  finalArtifacts?: Array<{ instanceName: string; roleId: string; output: string }>;
}): string {
  return [
    "你是系统内置的 team_lead。请基于 teammates 的输出生成最终交付结果。",
    "要求：",
    "- 如果任务要求创作、撰写、生成正文或代码，必须先完整输出最终成品，不要只写任务完成汇总。",
    "- 如果 finalArtifacts 不为空，优先把最后一份 finalArtifacts 中的成品作为最终结果主体。",
    "- 最终成品后面可以简短附上 review/修改摘要。",
    "- 不要虚构未完成的内容。",
    "- 如果结果之间有冲突，指出冲突并给出你的判断。",
    "- 用中文输出。",
    "",
    `原始任务：${input.task}`,
    `计划：${JSON.stringify(input.plan, null, 2)}`,
    `最终候选成品：${JSON.stringify(input.finalArtifacts ?? [], null, 2)}`,
    `teammate 输出：${JSON.stringify(input.outputs, null, 2)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildRolePrompt(input: {
  role: ResolvedRole;
  task: string;
  context: Record<string, unknown>;
}): string {
  const { role } = input;
  const skillInstructions = role.skills.flatMap((skill) => skill.prompt?.instructions ?? []);

  return [
    `你正在以「${role.identity.title}」身份工作。`,
    "",
    `身份：${role.identity.name}`,
    `摘要：${role.identity.summary}`,
    `使命：${role.identity.mission}`,
    "",
    "职责：",
    ...role.identity.responsibilities.map((item) => `- ${item}`),
    "",
    "边界：",
    ...role.identity.boundaries.map((item) => `- ${item}`),
    "",
    "技能要求：",
    ...(skillInstructions.length > 0 ? skillInstructions : ["- 按角色职责完成任务。"]),
    "",
    role.contractorSpecialty ? `外包专项：${role.contractorSpecialty}` : "",
    `上下文：${JSON.stringify(input.context)}`,
    "如果上下文里包含 teamArtifacts，请优先基于这些前序产出继续工作，不要假设必须从文件系统读取。",
    "",
    `你的任务：${input.task}`,
    "",
    "请直接输出完成结果，必要时列出假设、限制和下一步建议。",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildPeerTurnPrompt(input: {
  role: ResolvedRole;
  ownInstanceId: string;
  episode: ActEpisode;
  turn: number;
  maxMessagesPerPairPerTurn: number;
  recentMessages: TeamMessage[];
  artifacts: Array<{ id: string; from?: string; roleId?: string; content?: string }>;
}): string {
  const allowedRules = input.episode.communicationRules.filter((rule) => rule.from === input.ownInstanceId);
  const participants = input.episode.participants.map((participant) => ({
    roleId: participant.roleId,
    instanceId: participant.instanceId,
    displayName: participant.displayName,
    responsibility: participant.responsibility,
  }));

  return [
    `你正在参与 ActEpisode ${input.episode.id} 的 peer-to-peer 协作第 ${input.turn} 轮。`,
    "",
    "本轮目标：",
    input.episode.goal,
    "",
    "参与者：",
    JSON.stringify(participants, null, 2),
    "",
    "你只能向 communicationRules 允许的目标发送消息。不要发送给 mailbox、state_store、review_gate、human_input_gateway。",
    `同一轮内，你向同一个目标最多发送 ${input.maxMessagesPerPairPerTurn} 条有效消息；需要更多沟通请等待下一轮 peer turn。`,
    "如果没有必要沟通，输出空 messages 数组。",
    "输出必须是 JSON，不要输出 Markdown。",
    "",
    "你的可用通信规则：",
    JSON.stringify(allowedRules, null, 2),
    "",
    "最近团队消息：",
    JSON.stringify(input.recentMessages.slice(-12), null, 2),
    "",
    "当前 artifacts 摘要：",
    JSON.stringify(input.artifacts.slice(-12), null, 2),
    "",
    "请输出 JSON：",
    JSON.stringify(
      {
        messages: [
          {
            to: "目标 instanceId",
            type: "question | answer | status_report | blocked | handoff",
            content: "具体消息内容",
          },
        ],
      },
      null,
      2,
    ),
  ].join("\n");
}

export function extractPlan(text: string): TeamPlan | undefined {
  const candidates = [text, ...Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)).map((match) => match[1] ?? "")];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart < 0 || objectEnd <= objectStart) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed.slice(objectStart, objectEnd + 1)) as TeamPlan;
      if (Array.isArray(parsed.assignments)) {
        parsed.assignments = sanitizeAssignments(parsed.assignments);
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function sanitizeAssignments(assignments: TeamAssignment[]): TeamAssignment[] {
  return assignments
    .filter((assignment) => typeof assignment.roleId === "string" && typeof assignment.task === "string")
    .map((assignment) => ({
      roleId: assignment.roleId,
      task: assignment.task,
      reason: assignment.reason,
      instanceName: assignment.instanceName,
      context: assignment.context && typeof assignment.context === "object" ? assignment.context : {},
      contractorSpecialty: assignment.contractorSpecialty,
      dependencies: Array.isArray(assignment.dependencies) ? assignment.dependencies.map(String) : undefined,
      expectedArtifacts: Array.isArray(assignment.expectedArtifacts) ? assignment.expectedArtifacts : undefined,
      acceptanceCriteria: Array.isArray(assignment.acceptanceCriteria) ? assignment.acceptanceCriteria.map(String) : undefined,
      requiresReview: assignment.requiresReview === true,
    }));
}
