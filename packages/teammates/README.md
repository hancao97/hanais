# Teammates Definition Convention

每个 teammate 和 skill 都必须目录化定义，定义文件保持声明式，避免在角色/技能目录里混入运行时代码。

```text
src/
  skills/
    story-drafting/
      SKILL.md
  roles/
    novelist/
      identity.md
      skills.json
```

约定：

- `SKILL.md`：人类可读的 skill 说明，包含 frontmatter、instructions、inputs、outputs、policies。
- `identity.md`：角色身份说明；frontmatter 只保留轻量调度卡片字段，例如 `id`、`title`、`description`。
- `skills.json`：结构化描述该角色创建会话时会消费哪些 skills，以及每个 skill 的用途。
- `novel-team.ts` 只负责组装 team，不直接内联角色/技能细节。
- `definition-loader.ts` 负责把声明式资产编译成运行时消费的 `RoleDefinition` / `SkillDefinition`。
