import type { ResolvedRole, TeamAssignment, TeamPlan } from "./types.js";

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
        `  summary: ${role.identity.summary}`,
        `  skills: ${skills || "无"}`,
        `  boundaries: ${role.identity.boundaries.join("；")}`,
      ].join("\n");
    })
    .join("\n");

  return [
    "你是系统内置的 team_lead。你负责组织用户传入的 teammates 完成任务。",
    "",
    "硬性规则：",
    "1. 你只能把任务分配给下面列出的 roleId。",
    "2. 你不能发明新的用户角色，不能临时创建 database_expert / security_expert 等未注册角色。",
    "3. 如果确实缺少角色，且任务无法由现有 teammate 完成，可以使用特殊 roleId: __contractor__。",
    "4. __contractor__ 表示系统内置外包角色，不是新 RoleDefinition。必须填写 contractorSpecialty。",
    "5. 优先使用已有 teammate；只有明显缺角色时才使用 __contractor__。",
    "6. 输出必须是 JSON，不要输出 Markdown。",
    "",
    "可用 teammates：",
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
}): string {
  return [
    "你是系统内置的 team_lead。请基于 teammates 的输出汇总最终结果。",
    "要求：",
    "- 不要虚构未完成的内容。",
    "- 明确说明每个 teammate 完成了什么。",
    "- 如果结果之间有冲突，指出冲突并给出你的判断。",
    "- 用中文输出。",
    "",
    `原始任务：${input.task}`,
    `计划：${JSON.stringify(input.plan, null, 2)}`,
    `teammate 输出：${JSON.stringify(input.outputs, null, 2)}`,
  ].join("\n");
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
    "",
    `你的任务：${input.task}`,
    "",
    "请直接输出完成结果，必要时列出假设、限制和下一步建议。",
  ]
    .filter(Boolean)
    .join("\n");
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
    }));
}
