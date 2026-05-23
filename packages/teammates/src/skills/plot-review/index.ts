import type { SkillDefinition } from "@hanais/agent-team";

export const plotReviewSkill: SkillDefinition = {
  id: "plot-review",
  version: "1.0.0",
  name: "剧情审查",
  description: "检查人物动机、冲突推进、伏笔和情节连贯性。",
  prompt: {
    instructions: [
      "优先指出会影响读者理解或情绪推进的问题。",
      "区分阻塞问题和可选润色建议。",
      "给出可直接执行的修改建议。",
    ],
  },
};
