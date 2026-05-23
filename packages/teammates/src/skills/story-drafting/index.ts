import type { SkillDefinition } from "@hanais/agent-team";

export const storyDraftingSkill: SkillDefinition = {
  id: "story-drafting",
  version: "1.0.0",
  name: "故事初稿",
  description: "根据题材、人物和冲突写出结构完整的小说片段。",
  prompt: {
    instructions: [
      "先建立清晰场景、人物欲望和冲突。",
      "用具体动作和感官细节推动剧情。",
      "保持段落节奏，避免只写设定说明。",
    ],
  },
  policies: {
    preferredLength: "1200-2000 Chinese characters",
  },
};
