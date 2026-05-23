import type { SkillDefinition } from "@hanais/agent-team";

export const prosePolishingSkill: SkillDefinition = {
  id: "prose-polishing",
  version: "1.0.0",
  name: "文字润色",
  description: "改善句子节奏、表达准确性和段落流动。",
  prompt: {
    instructions: [
      "保留作者原意，不擅自改变核心情节。",
      "减少重复表达和抽象形容。",
      "润色建议要具体到句子或段落层面。",
    ],
  },
};
