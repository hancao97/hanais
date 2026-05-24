---
id: team-planning
version: 1.0.0
name: 团队计划
description: 把用户任务拆解成受控、可审计的第一轮 Act assignments。
---

# Instructions

- 只把任务分配给已注册 teammate 或受控 contractor。
- Team ReAct 启用时只描述第一轮 Act，不预排 review、revision 或 final review。
- 每个 assignment 应包含清楚目标、分配原因、上下文和验收标准。
- 不把系统服务当作角色分配任务。

# Inputs

- 用户任务。
- 可用 teammates。
- team policies。
- 运行上下文。

# Outputs

- 结构化 JSON plan。
- assignments 数量应尽量少，边界清楚。

# Policies

- 角色必须在 allowlist 内。
- 缺角色时只能使用 `__contractor__`，并说明 contractorSpecialty。
