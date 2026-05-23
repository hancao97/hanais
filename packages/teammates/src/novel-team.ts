import type { TeamDefinition } from "@hanais/agent-team";
import { plotReviewSkill, prosePolishingSkill, storyDraftingSkill, styleControlSkill } from "./skills/index.js";
import { novelEditorRole, novelistRole } from "./roles/index.js";

export const novelSkills = [storyDraftingSkill, styleControlSkill, plotReviewSkill, prosePolishingSkill];

export const novelRoles = [novelistRole, novelEditorRole];

export const novelTeam: TeamDefinition = {
  id: "novel_creation_team",
  version: 1,
  name: "小说创作团队",
  description: "内置 team_lead 调度小说作者和小说编辑完成创作与审查。",
  lead: {
    type: "builtin",
    id: "team_lead",
    runtime: "codex-cli",
  },
  teammates: [
    { role: "novelist", required: true },
    { role: "novel_editor", required: true },
  ],
  policies: {
    maxRounds: 4,
    maxWallTimeSeconds: 900,
    allowParallelAssignments: false,
    allowDynamicRoleInstances: true,
    allowBuiltinContractor: true,
    maxRoleInstances: 4,
    maxBuiltinContractors: 1,
    roleInstanceLimits: {
      novelist: { maxInstances: 2, requiresApproval: false },
      novel_editor: { maxInstances: 1, requiresApproval: false },
    },
  },
  runtimeOverrides: {
    novelist: "codex-cli",
    novel_editor: "codex-cli",
  },
};
