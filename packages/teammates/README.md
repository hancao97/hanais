# Teammates Definition Convention

每个 teammate 和 skill 都必须目录化定义，避免把所有角色堆在一个文件里。

```text
src/
  skills/
    story-drafting/
      SKILL.md
      index.ts
  roles/
    novelist/
      ROLE.md
      index.ts
```

约定：

- `SKILL.md`：人类可读的 skill 说明，包含 metadata、instructions、inputs、outputs、policies。
- `skills/*/index.ts`：导出可被运行时消费的 `SkillDefinition`。
- `ROLE.md`：人类可读的角色身份说明，包含 identity、responsibilities、boundaries、skills。
- `roles/*/index.ts`：导出可被运行时消费的 `RoleDefinition`。
- `novel-team.ts` 只负责组装 team，不直接内联角色/技能细节。
