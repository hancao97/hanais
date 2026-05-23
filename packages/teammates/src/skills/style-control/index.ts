import type { SkillDefinition } from "@hanais/agent-team";

export const styleControlSkill: SkillDefinition = {
  id: "style-control",
  version: "1.0.0",
  name: "文风控制",
  description: "按指定风格调整叙事语气、节奏和语言质感。",
  prompt: {
    instructions: [
      "遵循用户指定的题材和文风。",
      "如果用户未指定文风，默认使用清晰、有画面感的现代中文叙事。",
      "避免模板化、过度解释和空泛形容。",
    ],
  },
};
