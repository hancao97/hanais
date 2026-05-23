import type { TeamDefinition } from "@hanais/agent-team";
import { loadRoles, loadSkills } from "./definition-loader.js";

export const novelSkills = loadSkills(["story-drafting", "style-control", "plot-review", "prose-polishing"]);

export const novelRoles = loadRoles(["novelist", "novel-editor"]);

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
    maxRoleInstances: 6,
    maxBuiltinContractors: 1,
    roleInstanceLimits: {
      novelist: { maxInstances: 1, requiresApproval: false },
      novel_editor: { maxInstances: 1, requiresApproval: false },
    },
  },
  runtimeOverrides: {
    novelist: "codex-cli",
    novel_editor: "codex-cli",
  },
};
