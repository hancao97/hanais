# Agent Teams 方案设计

## 背景

我们希望建设一套 agent teams 方案，底层可以接入不同 agent runtime。当前原型先接：

- Claude Agent SDK
- Codex CLI

后续可以继续接：

- qagent
- 未来可能接入的其他 runtime

公司已有一套基于 workflow 的 pipeline 编排。新的 team 编排不应该替代 pipeline，也不应该复刻一套 pipeline DAG。更合理的架构是：

```text
GUI / Product Surface
  创建、配置、运行、观察、恢复
        |
        +--------------------+--------------------+
        |                                         |
        v                                         v
Pipeline Orchestrator                    Team Orchestrator
  确定性流程编排                           动态/半动态团队协作
  DAG / SOP / retry / gate                 lead / member / handoff / review
        |                                         |
        +--------------------+--------------------+
                             |
                             v
Role Definition Layer
  identity / skills / tools / constraints / output schema
                             |
                             v
Runtime Adapter Layer
  claude-agent-sdk adapter / codex-cli adapter / qagent adapter
                             |
                             v
Agent Runtime
```

核心原则：

- `role definition` 是底座，pipeline 和 team 都复用。
- `pipeline` 和 `team` 是平行编排，不是父子关系。
- `pipeline` 适合确定性的 SOP/DAG。
- `team` 适合 Claude Code agent teams 类似的动态协作。
- runtime adapter 负责屏蔽 Claude Agent SDK、Codex CLI、qagent 等 runtime 的差异。

## 社区方案参考

### LangGraph

LangGraph 适合作为多 agent graph/state/checkpoint 的设计参考。它的 multi-agent 模式覆盖 supervisor、handoff、自定义 graph 等能力。

适合借鉴：

- 状态流转
- supervisor pattern
- checkpoint/resume
- human-in-the-loop

不建议直接作为唯一抽象，因为我们已有 Claude Agent SDK、Codex CLI、qagent 等 runtime 诉求，且已有 pipeline 编排。

参考：https://docs.langchain.com/oss/python/langchain/multi-agent/index

### CrewAI

CrewAI 的 `role / goal / backstory / tools / task` 模型比较适合借鉴角色定义，但它自己的执行模型不一定适合直接承载我们的 Claude Agent SDK、Codex CLI 和 qagent。

适合借鉴：

- 人类可读的角色描述
- task/crew 的简单心智模型
- role 的 goal、constraint、tool 声明

参考：https://docs.crewai.com/

### Microsoft Agent Framework

MAF 适合做 workflow/orchestration 参考，也可以做 POC。但不要把业务层的 team API 直接绑定到 MAF schema。

适合借鉴：

- agent orchestration
- handoff
- group chat
- workflow executor

参考：https://learn.microsoft.com/en-us/agent-framework/

### OpenAI Agents SDK / Swarm

OpenAI Agents SDK 和 Swarm 的 handoff、guardrail、trace 概念值得参考。

适合借鉴：

- handoff API 语义
- guardrail
- tracing
- lightweight agent transfer

参考：

- https://openai.github.io/openai-agents-python/
- https://github.com/openai/swarm

### MCP / A2A

MCP 适合后续统一工具、上下文和资源访问。A2A 更适合未来跨服务 agent 互操作，不建议作为 MVP 依赖。

参考：

- https://modelcontextprotocol.io/
- https://google-a2a.github.io/A2A/latest/

## 我们应该自研什么

建议自研一层薄的 team orchestrator，而不是直接采用某个社区框架作为产品级抽象。

自研范围：

1. 角色定义规范
2. skill 注入规范
3. runtime adapter 接口
4. team session 管理
5. lead/supervisor 协作策略
6. task board / team message / artifact 模型
7. event 和 trace 归一化
8. policy、budget、timeout、permission 约束

不建议 MVP 里做：

- 复杂长期记忆
- 无限制 group chat
- 完整跨服务 A2A
- 重新实现一个 pipeline DAG engine

## 角色定义

角色不是简单的 prompt。角色应该由两部分组成：

- `identity`：这个角色是谁、职责边界是什么、以什么判断标准工作。
- `skills`：这个角色具备哪些可注入能力，包括提示词片段、工具权限、知识包、流程习惯、输出格式等。

可以理解为：

```text
Role = Identity + Skill References + Runtime Preferences + Policies
```

其中：

- `identity` 偏稳定，描述角色人格、职责、边界、沟通风格和验收标准。
- `skills` 可组合、可复用、可版本化，可以在不同角色之间共享。
- `runtime` 是默认运行时偏好，不应该写死在角色里无法覆盖。
- `team` 和 `pipeline` 只引用角色，不重复定义角色细节。

### RoleDefinition 草案

```yaml
id: implementer
version: 1

identity:
  name: Implementation Agent
  title: 实现工程师
  summary: 负责在代码仓库中完成明确范围内的实现任务。
  mission: 根据任务要求修改代码，并完成必要验证。
  responsibilities:
    - 阅读相关代码后再修改。
    - 保持改动范围聚焦。
    - 运行和报告必要的验证命令。
  boundaries:
    - 不处理未被分配的产品决策。
    - 不做无关重构。
    - 不覆盖用户已有改动。
  communicationStyle:
    - 直接说明做了什么。
    - 明确列出验证结果。
    - 对不确定点提出具体问题。
  successCriteria:
    - 变更满足任务要求。
    - 相关测试或检查通过，或明确说明无法运行的原因。
    - 输出包含 changedFiles 和 verification。

skills:
  - id: repo-code-editing
    version: ">=1.0.0"
  - id: test-runner
    version: ">=1.0.0"

runtime:
  preferred: codex-cli
  fallback: claude-agent-sdk

tools:
  allow:
    - shell
    - git

outputs:
  schema:
    type: object
    required: [changedFiles, verification]
    properties:
      changedFiles:
        type: array
        items:
          type: string
      verification:
        type: array
        items:
          type: string
```

### SkillDefinition 草案

skill 是可注入能力包，应该可以被多个角色复用。

```yaml
id: repo-code-editing
version: 1.0.0
name: 仓库代码编辑
description: 让 agent 能够安全地阅读、修改、验证仓库代码。

prompt:
  instructions:
    - 修改前先定位相关文件。
    - 优先遵循仓库现有风格。
    - 保留无关用户改动。
    - 修改后运行最小必要验证。

tools:
  allow:
    - shell
    - git

context:
  required:
    - repoPath
  optional:
    - ticketUrl
    - designDoc

policies:
  maxToolCalls: 80
  requireVerification: true
```

skill 不应该只是工具列表，它还可以包含：

- prompt instructions
- tool allow/deny
- context requirements
- output schema fragment
- runtime capability requirements
- policy defaults
- examples

## Team 定义

team 定义不应该重复写完整角色，而应该引用底层角色。

```yaml
id: feature_delivery_team
version: 1
name: 功能交付团队
description: 用于完成代码实现、审查和验证的动态 agent team。

lead:
  type: builtin
  id: team_lead

teammates:
  - role: implementer
    required: true
  - role: reviewer
    required: true
  - role: researcher
    required: false

policies:
  maxRounds: 6
  maxWallTimeSeconds: 1800
  maxCostUsd: 5
  requireFinalReview: true

runtimeOverrides:
  implementer: codex-cli
  reviewer: codex-cli
```

为了降低用户理解负担，第一版不暴露多个 team mode。只做一种内置模式：

```text
builtin team_lead + user-defined teammates
```

也就是：

- 系统内置 `team_lead` 角色。
- 用户只需要传入 teammates。
- teammates 使用标准 RoleDefinition 格式。
- teammate 的 skills 使用常规 SkillDefinition/skill 包。
- `team_lead` 负责拆解、分配、协调、审查请求和最终汇总。
- 运行时禁止随意发明新角色。

这样用户的心智是：

```text
我提供一组可用专家，系统内置 lead 自动组织他们完成任务。
```

而不是：

```text
我要理解 supervisor / group chat / producer reviewer / parallel review 等多种编排模式。
```

后续如果确实有场景需要更多 team mode，可以作为高级能力加入，但不建议进入第一版 API。

### 内置 team_lead

`team_lead` 是内部内置角色，不要求用户定义。它的职责是：

- 理解用户任务和上下文。
- 读取 teammates 的 identity、skills、工具权限和输出 schema。
- 判断任务需要调用哪些 teammate。
- 创建 task board。
- 必要时基于已有 teammate 创建多个 role instance。
- 收集 teammate 输出。
- 请求 reviewer 或其他 teammate 检查结果。
- 汇总最终答复。

`team_lead` 不应该具备无限权限。它必须受 team policy 约束：

- 只能调用用户传入的 teammates。
- 不能创建新的 RoleDefinition。
- 只能基于已有 teammate 创建 RoleInstance。
- 不能突破 teammate 的 tool policy。
- 不能突破 maxRounds、maxInstances、maxCost、maxWallTime。

`team_lead` 可以由 Claude Agent SDK、Codex CLI 或 qagent 执行，但对外不作为普通 teammate 暴露。

### 禁止运行时发明新角色

第一版明确禁止 agent 在运行时随意发明新角色。

允许：

- 使用用户传入的 teammate。
- 基于已有 teammate 创建多个 RoleInstance。
- 向用户建议“缺少某类专家”，作为后续配置建议。

不允许：

- lead 自动创建全新的 `database_expert`、`security_architect` 等 RoleDefinition。
- lead 绕过 role registry 临时拼一个新专家 prompt。
- lead 给未注册角色分配任务。

如果未来要支持临时新增专家，应该走 `ProposedRoleDefinition` + GUI/user 审批，不进入 MVP。

### 动态角色实例

team 运行时应该支持动态创建“角色实例”，但不允许 agent 在运行中随意创建全新的“角色定义”。

需要区分两个概念：

- `RoleDefinition`：稳定的角色定义，例如 `frontend_engineer`。
- `RoleInstance`：某次 team run 中基于角色定义创建的运行实例，例如 `frontend_engineer#1`、`frontend_engineer#2`。

你举的例子应该建模为：

```text
frontend_engineer RoleDefinition
  -> frontend_engineer#repo-a RoleInstance
  -> frontend_engineer#repo-b RoleInstance
```

而不是在运行中临时生成两个新的角色定义。

推荐接口：

```ts
export interface RoleInstance {
  id: string;
  roleId: string;
  displayName: string;
  runtimeId: string;
  assignedTask: string;
  context: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  parentInstanceId?: string;
}
```

TeamSession 应增加：

```ts
roleInstances: Record<string, RoleInstance>;
```

动态创建实例应该由 team runner 执行，内置 `team_lead` 只能提出申请：

```ts
export interface SpawnRoleRequest {
  roleId: string;
  count?: number;
  reason: string;
  assignments: Array<{
    task: string;
    context: Record<string, unknown>;
  }>;
}
```

runner 收到申请后检查 policy：

- 这个 role 是否允许被复制。
- 最大实例数是否超限。
- 成本/时间预算是否足够。
- 是否允许并行修改多个仓库。
- 每个实例的 context 是否隔离清楚。
- 是否需要 GUI/user 审批。

示例 team policy：

```yaml
policies:
  maxRounds: 6
  maxWallTimeSeconds: 1800
  allowDynamicRoleInstances: true
  maxRoleInstances: 6
  roleInstanceLimits:
    frontend_engineer:
      maxInstances: 3
      requiresApproval: false
    implementer:
      maxInstances: 2
      requiresApproval: true
```

### 动态实例的典型流程

```text
用户提交任务
  -> lead 拆解后发现涉及两个前端仓库
  -> lead 发出 SpawnRoleRequest(frontend_engineer, count=2)
  -> runner 校验 policy
  -> 创建 frontend_engineer#web-app 和 frontend_engineer#admin-console
  -> 两个实例并行运行，各自拿到不同 repo/context
  -> lead 汇总两个实例输出
  -> reviewer 审查整体改动
```

这种设计的好处：

- GUI 可以清楚展示“同一个角色的多个实例”。
- 成本和并发可以被 runner 控制。
- role identity 和 skills 仍然复用，不会因为运行中动态生成角色而失控。
- 后续可以支持 worktree、repo lock、artifact merge 等工程策略。

如果确实需要临时创建全新的角色定义，例如 lead 认为需要一个之前不存在的“数据库迁移专家”，建议作为 `ProposedRoleDefinition`，必须经过 GUI/user 或 policy 审批后才能加入 team。

## TeamSession 运行态

一次 team run 应该创建一个 `TeamSession`。这是 GUI 需要展示和操作的核心对象。

```ts
export interface TeamSession {
  id: string;
  teamId: string;
  task: string;
  lead: BuiltinTeamLeadSessionRef;
  teammateRoleIds: string[];
  roleInstances: Record<string, RoleInstance>;
  sharedContext: Record<string, unknown>;
  memberSessions: Record<string, AgentSessionRef>;
  taskBoard: TeamTask[];
  messages: TeamMessage[];
  artifacts: ArtifactRef[];
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
}
```

GUI 可以基于它展示：

- team 成员
- 每个成员当前任务
- task board
- agent 消息
- tool call / artifact
- review 状态
- 最终输出
- 是否需要人工介入

## Runtime Adapter

runtime adapter 是让 Claude Agent SDK、Codex CLI、qagent 可以被同一套 team 编排调用的关键。

```ts
export interface AgentRuntime {
  id: string;
  kind: "claude-agent-sdk" | "codex-cli" | "qagent" | string;

  capabilities(): Promise<RuntimeCapabilities>;

  run(request: AgentRunRequest): AsyncIterable<AgentEvent>;

  cancel?(sessionId: string): Promise<void>;
}

export interface AgentRunRequest {
  sessionId: string;
  role: ResolvedRole;
  task: string;
  context: AgentContext;
  tools: ToolDefinition[];
  limits?: RunLimits;
  inputArtifacts?: ArtifactRef[];
}
```

注意这里传入的是 `ResolvedRole`，不是原始 `RoleDefinition`。

`ResolvedRole` 是角色定义和 skill 注入后的结果：

```text
ResolvedRole =
  Role.identity
  + Role.constraints
  + Skill.prompt.instructions
  + Skill.tools
  + Skill.context requirements
  + Team/runtime overrides
```

这样可以让 team runner 在调用 runtime 前完成统一解析，避免每个 runtime adapter 重复理解 role/skill 规则。

## Team 默认执行逻辑

第一版只保留一种内置 team 协作逻辑：

```text
用户提交 task
  -> 创建 TeamSession
  -> 解析 team、role、skills，生成 ResolvedRole
  -> 内置 team_lead 分析任务并创建 task board
  -> team runner 根据 lead assignment 调用成员 agent
  -> 成员 agent 产出结果、artifact、handoff request
  -> reviewer 可触发返工
  -> team_lead 汇总 final output
  -> TeamSession completed
```

team_lead 可以动态分配任务，但必须受 policy 约束：

- 最大轮数
- 最大时间
- 最大成本
- 可调用成员范围
- 每个成员可用工具
- 是否需要 final review
- 是否允许并行

## Pipeline 和 Team 的区别

Pipeline：

- 适合流程已知的任务。
- 强确定性。
- 每一步的输入输出比较固定。
- 更适合审批、审计、生产 SOP。

Team：

- 适合流程未知或需要探索的任务。
- lead 可以动态拆解。
- 成员可以并行工作。
- 更接近 Claude Code agent teams。
- 更适合研发、调研、复杂问题分析。

两者应该共享：

- role definition
- skill definition
- runtime adapter
- tool registry
- artifact model
- event/trace model
- GUI 的运行记录和观测能力

两者不应该共享：

- 控制流语义
- 用户配置心智
- 执行停止条件

## MVP 建议

第一阶段先实现：

1. `RoleDefinition`
2. `SkillDefinition`
3. `TeamDefinition`
4. `ResolvedRole` 解析器
5. `AgentRuntime` adapter 接口
6. Claude Agent SDK adapter
7. Codex CLI adapter
8. 内置 `team_lead` 协作 runner
9. `TeamSession` 状态模型
10. JSONL trace

第二阶段再实现：

- session resume
- GUI 人工介入
- budget/cost 统计
- MCP tool registry
- 更严格的 output schema validation

## 推荐 API

```ts
await teamRunner.run({
  team: "feature_delivery_team",
  roles: roleRegistry,
  skills: skillRegistry,
  runtimeRegistry: {
    "codex-cli": codexCliRuntime,
    "claude-agent-sdk": claudeAgentSdkRuntime,
  },
  task: "实现登录页并补充验证",
  context: {
    repoPath: "/path/to/repo",
    ticketUrl: "https://example.com/ticket/123",
  },
});
```

也可以由 GUI 组装成：

```json
{
  "team": "feature_delivery_team",
  "task": "实现登录页并补充验证",
  "context": {
    "repoPath": "/path/to/repo"
  }
}
```

后端根据 team 引用解析 roles 和 skills。

## 当前判断

我们可以自研达到 Claude Code agent teams 的核心效果，前提是运行时使用 Claude Agent SDK，而不是自己重写单 agent loop。

自研部分重点是：

- team session
- lead/team 协作协议
- role identity
- skill 注入
- runtime adapter
- trace 和 GUI 观测

不要把重点放在重新实现 workflow DAG。pipeline 已经负责确定性编排，team 要负责动态协作编排。
