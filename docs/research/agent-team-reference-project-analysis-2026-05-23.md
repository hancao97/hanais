# Agent Team 参考项目研究报告

日期：2026-05-23

## 结论摘要

当前 `hanais` 已经有了一个正确的底座方向：用 TypeScript monorepo 把 `role definition`、`skill definition`、`team orchestrator` 和 `runtime adapter` 分开，并且已经能通过 GUI 运行一个小说创作团队。这个方向比直接绑定某个 agent 框架更适合作为可推广方案。

但当前项目还处于原型阶段。它缺的不是更多角色，而是把 agent team 做成稳定系统所需的运行协议：持久化状态、可恢复 session、任务队列、review gate、结构化产物、机械校验、运行时健康检查、可观测日志、人工介入闭环和测试基准。

两个参考项目各有强项：

- `gru-ai` 的强项是“组织级 harness”：固定的 directive pipeline、context tree、checkpoint、机械校验脚本、watcher/aggregator、MCP、调度和报告体系。它证明 agent team 要稳定，核心在于流程约束和验证机制，而不是 prompt 更长。
- `hermes-agent-team` 的强项是“产品级控制台”：独立 agent profile、SQLite/RuntimeStore、Kanban 任务队列、MCP 总线、ACP 进程管理、SSE/WS 实时观察、MCP/Skill/模型/导入导出管理。它证明 agent team 要可用，必须把运行态、配置态、任务态都产品化。

建议 `hanais` 的目标定位为：**runtime-agnostic agent team harness**。也就是不照搬 `gru-ai` 的 15 步流程或 `hermes` 的 Kanban/Hermes 绑定，而是在我们现有薄 orchestrator 上补齐一套可持久、可恢复、可验证、可观察的团队运行协议。

## 当前项目现状

### 代码结构

当前仓库是 pnpm monorepo：

- `@hanais/agent-team`：团队编排核心。定义 `TeamDefinition`、`RoleDefinition`、`SkillDefinition`、`AgentRuntime`、`TeamRunner`、事件和 session 模型。
- `@hanais/agent-runtimes`：runtime adapter，目前有 `CodexCliRuntime` 和 `ClaudeAgentSdkRuntime`。
- `@hanais/teammates`：声明式角色/技能资产，当前内置小说作者和小说编辑。
- `@hanais/gui`：Electron + React 验证台，支持运行 team、选择 runtime、展示交互图、队列和最终结果。
- `docs/agent-teams-solution.md`：已有方案文档，明确 pipeline 和 team 是平行编排，role definition 是底座。
- `examples/feature-delivery-team.yaml`：展示了面向代码交付团队的目标 schema。

### 已具备能力

当前实现已经有几个关键正确点：

1. **抽象层分得清楚**：角色/技能、team、runtime adapter 已经解耦。
2. **内置 lead 受控**：`team_lead` 只允许调度已注册 teammate 或受控 `__contractor__`。
3. **声明式角色资产**：`identity.md` 和 `SKILL.md` 可被 loader 编译成运行时定义。
4. **多 runtime 初步支持**：Codex CLI、Claude Agent SDK、Kimi Anthropic-compatible endpoint 都有接入路径。
5. **GUI 可观察原型**：可以看到 lead、mailbox、teammate、final output 的事件图。

### 主要缺口

这些缺口会直接影响“强大、可用、稳定、可推广”：

1. **无持久化 session**  
   `TeamRunner.run()` 的状态主要在内存里。进程退出、GUI 关闭、runtime 超时后，无法从中间步骤恢复。

2. **任务协议太浅**  
   现在 plan assignments 会直接映射到 runtime 调用。缺少独立的 `WorkItem` 生命周期、claim、retry、blocked、review、artifact、handoff、idempotency key。

3. **review 不是一等能力**  
   `requireFinalReview` 只是 policy 字段，没有强制 reviewer、fresh-context review、DOD 验证、禁止 self-review、fix cycle。

4. **结构化输出未被验证**  
   lead plan 只用 `extractPlan()` 尝试解析 JSON；角色输出、最终汇总、产物都没有 schema validator 或 gate。

5. **runtime 管理不完整**  
   当前 adapter 能 run，但缺少进程池、健康检查、取消、重试、恢复、权限模式、成本/token 记录、能力协商和隔离工作区。

6. **用户介入还没有闭环**  
   GUI 的“用户介入”目前只是前端事件，不会真正反馈给运行中的 agent session。

7. **测试体系不足**  
   主项目没有测试文件。对于 agent team，这会让 orchestration regressions 很难被发现。

8. **产品配置能力不足**  
   角色、team、runtime、workspace、API key、skill、MCP、导入导出等都还没有形成可管理的产品面。

## 本轮讨论补充结论

这轮讨论进一步确认了几个产品和架构判断，应该作为下一阶段实现优先级的依据。

### 1. 运行历史应放在 `.hanais/teams`

之前报告中建议的 `.hanais/sessions` 容易和未来其他 session 概念冲突。更合适的目录是：

```text
.hanais/
  settings.json
  teams/
    runs/
      team_<id>/
        run.json
        events.jsonl
        work-items.json
        reviews.json
        human-inputs.json
        artifacts/
```

这里的 `teams` 表达的是 agent team 运行域，`runs` 表达每一次团队任务。这样可以同时满足当前的“查看历史任务信息”和未来的团队配置、team bundle、run report 扩展。

### 2. 当前是中心化编排，不是真正的点对点协作

当前执行链路大致是：

```text
team_lead 计划 -> runner 顺序/并行调用角色 -> 角色输出回 runner/session -> runner 将前序输出作为 teamArtifacts 注入后续角色 -> team_lead 汇总
```

所以当小说作者完成初稿后，图上看起来像“交给 team_lead 再给编辑审核”。本质上这不是小说作者主动把稿件发给编辑，而是系统调度器把前序产物转交给后序角色。

当时这样做有现实原因：实现简单、时序可控、所有结果回到 lead 方便审计、角色不会随意创建/调用其他角色。但它牺牲了真实团队协作感，也限制了作者和编辑之间的自然多轮沟通。

更专业的目标不是让 agent 随意互相聊天，而是做成**受协议约束的角色间通信**：

```text
小说作者 -> mailbox 投递 review_request -> 小说编辑认领 -> 编辑返回 approved / changes_requested / blocked -> 作者修改或 team_lead 仲裁
```

也就是说，消息可以点对点，但每条消息、任务、审核结论都必须进入持久状态。`team_lead` 应从“所有内容的中转站”退到“协调者、监督者和仲裁者”的位置。

### 3. 任务协议需要从 assignment 升级为 WorkItem

当前 assignment 太浅，主要描述“把什么任务给哪个 role”。下一阶段应把它升级为可恢复、可审核的 `WorkItem`：

- `id`、`title`、`goal`
- `roleId`、`roleInstanceId`
- `status`：`pending | claimed | running | completed | reviewing | blocked | failed`
- `dependencies`
- `inputs`
- `expectedArtifacts`
- `acceptanceCriteria`
- `attempts`
- `result`
- `error`
- `createdAt`、`updatedAt`

这样任务才不是一次 prompt 调用，而是团队系统里的可追踪工作单元。

### 4. Review 应是一等协议，而不只是一个角色

不建议只在 team 内部固定塞一个“通用任务审核员”。更合理的是：**review 是系统级协议，reviewer 是可插拔角色**。

系统层应提供：

- `ReviewTask`
- `ReviewPolicy`
- `ReviewResult`
- `approved | changes_requested | blocked`
- 禁止 self-review
- review round / fix cycle
- findings / evidence / requiredChanges

角色层可以选择：

- 显式 reviewer 角色，例如代码团队的 `reviewer`
- 领域编辑角色，例如小说团队的 `novel_editor`
- builtin reviewer fallback，仅在 team 没有合适 reviewer 时使用

这样既能支持通用审核，又不牺牲领域质量。

### 5. Hermes 的多轮 review/checkpoint 值得吸收

`hermes-agent-team` 的关键价值不是 Kanban UI 本身，而是它把复杂任务做成多轮闭环：

```text
lead plan -> worker round 1 -> review checkpoint -> approved / changes_requested / blocked
          -> worker round 2 -> review checkpoint -> ...
```

这和小说创作、代码实现、文档生成都匹配。我们应该吸收这个机制，但不绑定 Hermes Kanban；在 `hanais` 里应该落成 `WorkItem + ReviewResult + round`。

### 6. 人工介入必须持久化

GUI 里的“用户介入”不能只是前端追加一条消息。它应成为状态机对象：

- `HumanInputRequest.id`
- `sessionId`
- `workItemId?`
- `fromRoleId`
- `question`
- `options?`
- `status: pending | answered | cancelled`
- `answer?`
- `createdAt`
- `answeredAt?`

短期不需要打断正在运行的 Codex/Claude 进程，可以先在 work item 边界暂停。session 进入 `waiting`，用户回答后再继续 dispatch。

### 7. 验证应先测编排状态机

这里的“验证”不是先拿真实大模型跑很多样例，而是先用 fake runtime 测 team orchestrator 的确定性：

- lead 输出非法 JSON 时能 fallback 或报明确错误
- work item 失败时 session/work item/event 都落盘
- reviewer 要求修改时能进入下一轮
- resume 时不会重复执行已完成 work item
- pending human input 会把 session 置为 `waiting`
- final output 只能在必要 work item 和 review 完成后产生

真实 runtime smoke test 只做少量路径。最重要的是先把状态机测稳。

### 8. 当前阶段暂缓产品配置能力

角色和 skill 目前仍可以先在代码里改。短期优先补齐可用性：持久化、任务协议、review、人工介入、历史查看和基础测试。MCP、模型、skill、team bundle 的 UI 管理可以放到后面。

### 9. 目标模型应是团队级 ReAct，而不是中心化流水线

更准确的目标不是“lead 拆任务后按顺序调用 agent”，而是一个团队级 ReAct loop：

```text
Plan -> Recruit/Assign -> Act Episode -> Observe -> Review -> Reflect/Replan -> Next Act Episode -> Finalize
```

对应关系是：

- `Plan`：`team_lead` 根据任务、角色能力和策略生成初始工作图。
- `Recruit/Assign`：确定本轮参与者、职责、任务边界和通信规则。
- `Act Episode`：团队成员在受限协议内协作执行，可以直接互相发消息。
- `Observe`：runner 把消息、work item、artifact、review、人类输入和状态变化全部持久化。
- `Review`：领域 reviewer 或通用 reviewer 对关键产物做一等审核。
- `Reflect/Replan`：`team_lead` 根据执行状态和 review 结果决定下一轮、阻塞、人工介入或结束。
- `Finalize`：生成最终结果和 run report。

这个模型比 `gru-ai` 的强流程更保留 agent team 的协作自主性，也比自由群聊 agent 更稳定。可以把它定义为 **bounded team autonomy**：有限自治的团队协作。

### 10. Act Episode 是单轮协作边界

单轮 `Act` 不能是无限开放的自由聊天。它应该是一个明确的 `ActEpisode`：本轮谁参与、谁能看到谁、谁能给谁发什么消息、本轮目标是什么、产物是什么、什么时候进入 review。

这里不建议把 `maxActDurationSeconds` 作为核心约束。复杂任务天然可能很长，硬按物理时间切断会造成不稳定。更优先限制的是结构复杂度：

- 本轮有哪些参与角色
- 每个角色本轮责任是什么
- 谁可以和谁通信
- 允许哪些消息类型
- 每对角色最多往返几次
- 本轮输入和期望产物是什么
- 本轮验收标准是什么
- 什么时候必须进入 review/checkpoint

建议的协议形态：

```ts
interface ActEpisode {
  id: string;
  round: number;
  goal: string;
  participants: Array<{
    roleId: string;
    instanceId: string;
    displayName: string;
    responsibility: string;
    visibleToPeers: boolean;
  }>;
  communicationRules: Array<{
    from: string;
    to: string;
    allowedMessageTypes: Array<
      | "task_request"
      | "artifact_delivery"
      | "review_request"
      | "change_request"
      | "question"
      | "answer"
      | "blocked"
      | "approval"
      | "handoff"
      | "escalation"
      | "status_report"
    >;
    maxTurns?: number;
  }>;
  inputs: ArtifactRef[];
  expectedArtifacts: ExpectedArtifact[];
  acceptanceCriteria: string[];
  reviewPolicy: {
    required: boolean;
    reviewerRoleIds: string[];
    trigger: "on_artifact_ready" | "on_all_work_items_done";
  };
}
```

每个 agent 进入本轮时都应该知道：

```text
你在第几轮 Act 中。
本轮目标是什么。
本轮有哪些队友，他们分别负责什么。
你可以找谁、不能找谁。
你能发送哪些类型的消息。
你需要交付哪些 artifact。
本轮什么时候算完成，什么时候必须交给 review。
```

拿小说团队举例：

```text
Round 1 Plan:
  novelist 写初稿
  novel_editor 做结构、悬疑感、语言和温暖结尾审核

Act Episode:
  novelist -> novel_editor: review_request + draft_v1
  novel_editor -> novelist: changes_requested
  novelist -> novel_editor: artifact_delivery + revised_draft_v1
  novel_editor -> novelist: approved

Review Checkpoint:
  approved -> team_lead final
  changes_requested -> team_lead replan 或进入下一轮 Act
  blocked -> human input 或 escalation
```

因此，mailbox 不能只是 UI 上的消息列表，而应该是团队协议总线。角色间可以直接通信，但每条消息都必须是 typed message，并进入 `.hanais/teams` 的事件和状态文件。

### 11. team_lead 的职责应从中转站降级为协调者

在这个目标模型里，`team_lead` 不应该继续充当所有消息的中转站。它的职责应该是：

- 制定初始计划
- 创建和调整 Act Episode
- 控制参与者、通信规则和轮次预算
- 观察 work item / artifact / review / human input 状态
- 处理冲突、阻塞和升级
- 决定下一轮 act、停止或最终汇总

它不应该做：

- 每条角色间消息都经由自己转发
- 每个产物都由自己转交
- 每次审核都必须由自己发起
- 让角色完全不知道本轮其他队友存在

这会让系统更像真实团队：成员之间能直接协作，但协作发生在明确的团队协议和可持久化边界内。

### 12. 当前实现应直接采用 Plan -> Act -> Review -> NextLoop

后续实现不应停留在“协议先落地，行为以后补”的状态。`hanais` 的 team runner 应直接以 Team ReAct 作为主执行骨架：

```text
Plan
  team_lead 生成初始 plan，并识别本轮执行者与 reviewer/editor

Act
  创建 ActEpisode
  执行本轮所有非 reviewer work items
  产物进入 artifact store
  角色通过 typed mailbox 交付 artifact_delivery

Review
  reviewer/editor 对本轮所有非 reviewer 输出逐一 review
  通过 typed mailbox 产生 review_request、change_request、approval、blocked
  review result 持久化为 ReviewTask / ReviewResult

NextLoop
  如果全部 approved，进入 synthesis/final
  如果存在 changes_requested，创建下一轮 ActEpisode 和修订 work items
  如果 blocked，session 进入 waiting_for_human
  如果达到 maxReviewRounds，带着未完全收敛的状态进入 final 或报告风险
```

这个模型应是默认可运行机制，而不是只用于 smoke test 的旁路。小说团队的最低预期运行链路应是：

```text
team_lead plan
-> novelist act
-> novelist -> novel_editor: review_request
-> novel_editor -> novelist: changes_requested
-> novelist next act
-> novelist -> novel_editor: review_request
-> novel_editor -> novelist: approval
-> team_lead final
```

这也是后续判断“agent team 是否可用”的核心验收标准。

## 参考项目一：gru-ai

### 定位

`gru-ai` 是一个“AI company / conductor framework”。它不只是多 agent 调用器，而是把用户的 directive 变成一套可审计、可恢复、可验证的组织流程。

核心组成：

- CLI：`gru-ai init/start/update`，能把 `.context/`、`.claude/agents/`、skills、hooks scaffold 到项目中。
- Context tree：`.context/directives`、`.context/design`、`.context/lessons`、`.context/reports`、`.context/intel`。
- Pipeline：triage、checkpoint、read、context、audit、brainstorm、clarification、plan、approve、project-brainstorm、setup、execute、review-gate、wrapup、completion。
- Dashboard server：HTTP + WebSocket + watcher + aggregator。
- Platform adapter：Claude Code 为主，也设计了 Codex/Gemini/Aider spawn adapter。
- MCP server：提供 conductor status、backlog、directive、report 等工具。
- Validation hooks：`validate-project-json.sh`、`validate-reviews.sh`、`validate-cast.sh` 等机械 gate。
- Foreman/scheduled runs：定时 scout/report/launch work。

### 最值得借鉴的机制

1. **状态文件就是 checkpoint**  
   `directive.json` 和 `project.json` 是 pipeline 和 task 的 source of truth。任何 session 都可以读这些文件恢复进度。我们应该把 `TeamSession` 和 `WorkItem` 也落成持久状态，而不是只留在内存。

2. **review gate 机械化**  
   `gru-ai` 不让 LLM 自己声明“我 review 过了”，而是用脚本检查 review artifact、builder/reviewer 是否相同、DOD 是否被 reviewer 验证。这个思想必须吸收。

3. **context progressive disclosure**  
   它明确区分 CEO brief、audit、builder context、reviewer context，避免把所有上下文塞进一个长 prompt。我们当前 `teamArtifacts` 直接拼给后续角色，短期可用，长期会产生 context rot。

4. **静态领导层 + 临时执行者**  
   C-suite 具备长期记忆，工程执行者 per-task 新开 session。这个模型可转化为我们系统里的 `persistent role` 和 `ephemeral role instance`。

5. **watcher/aggregator/实时 dashboard**  
   它把文件系统、session log、directive state 聚合成 dashboard state。我们 GUI 现在是单次 run 的事件图，还没有跨 run 的 state aggregation。

6. **平台适配层进一步分离**  
   `PlatformAdapter` 负责监控，`SpawnAdapter` 负责启动。我们当前 `AgentRuntime.run()` 把执行和部分监控混在一起，后续也需要拆成 runtime capability、spawn、stream、cancel、inspect。

7. **基准测试意识**  
   `tests/e2e` 里有 CLI、schema、pipeline、server、multiplatform 等维度的 benchmark 结果。agent team 的正确性需要这样的 harness tests。

### 不建议直接照搬的部分

1. **15 步 pipeline 对 MVP 太重**  
   我们已有公司 workflow pipeline，不应该在 team orchestrator 内复刻一个完整 DAG/pipeline。应该吸收 checkpoint、review、gate，而不是照搬每一步。

2. **对 Claude Code 生态依赖较深**  
   `.claude/agents`、Claude session JSONL、Claude hooks 是它的核心优势，但也限制了泛化。我们目标是 Codex CLI、Claude SDK、qagent 等 runtime-agnostic。

3. **游戏化 dashboard 不是优先级**  
   可视化很有价值，但 pixel-art office 属于体验层。我们应先做好运行协议和状态可靠性，再考虑表现形式。

4. **大量脚本和本地路径带来维护成本**  
   `scheduled-runs.sh`、foreman、launchd、hooks 对个人项目有效，但推广到团队时需要更规范的配置和安全边界。

## 参考项目二：hermes-agent-team

### 定位

`hermes-agent-team` 是一个本地多 Agent Web 控制台。每个 Agent 是独立 Hermes profile，任务通过 Hermes Kanban 持久化并调度，Web UI 提供管理、观察和干预能力。

核心组成：

- Flask + Starlette/Uvicorn：REST API、SSE、Terminal WebSocket、MCP ASGI。
- SQLite + RuntimeStore：持久化 agents、user_tasks、delegations、assignments、kanban_task_links、messages、events、settings、model configs、skills、MCP servers。
- Hermes profiles：每个 agent 有独立 `config.yaml`、`SOUL.md`、skills、memories、workspace。
- MCP bus：`list_workers`、`create_kanban_worker_tasks`、`request_human_input`。
- Kanban-driven execution：用户任务 -> Leader 父任务 -> Worker 子任务 -> Leader review 任务 -> 完成或下一轮。
- ACP/pexpect runtime pool：启动、停止、重启 agent，捕捉终端输出，识别人工确认/输入。
- 管理能力：模型配置、MCP server、skill、SOUL、团队导入导出、初始化清空。

### 最值得借鉴的机制

1. **Kanban-like durable queue**  
   用户任务、delegation、assignment 和 kanban_task_link 分层清楚。我们不一定要用 Hermes Kanban，但应该有自己的 durable work queue。

2. **多轮 review/checkpoint**  
   Worker 完成后不是直接 final，而是创建 Leader review task。Leader 可以完成、继续下一轮、阻塞或请求人工输入。这正是复杂 agent team 稳定执行需要的闭环。

3. **agent profile/workspace 隔离**  
   每个 agent 有独立 profile、skills、MCP、workspace。我们当前 role 只是 prompt identity，未来如果要推广，需要 runtime profile 或至少 workspace/context 隔离。

4. **人工输入作为任务而非聊天消息**  
   `request_human_input` 创建可追踪 human task。这个设计比 GUI 上追加一条自然语言事件可靠。

5. **运行时状态和终端观察**  
   `status`、`runtime_status`、`interaction_state`、`orchestration_state`、`queue_depth` 等字段能支撑 UI 判断 agent 是忙、等人、掉线还是空闲。

6. **配置资产产品化**  
   MCP servers、skills、model configs、SOUL.md、导入导出都被管理起来。这是“可推广解决方案”必须具备的能力。

7. **测试覆盖关键状态机**  
   测试覆盖 Kanban sync、多轮 review、MCP task creation、human input、skill API、model config、transfer、initialization。这类状态机测试对我们特别重要。

### 不建议直接照搬的部分

1. **绑定 Hermes CLI/Kanban**  
   项目稳定性依赖 Hermes CLI 的 profile、acp、kanban、gateway。我们应抽象出 `WorkQueue` 和 `RuntimeProfile`，而不是绑定单一 CLI。

2. **pexpect/TUI 解析脆弱**  
   终端识别对本地 TUI 很实用，但推广方案应优先走结构化 SDK、JSONL 或事件 API。

3. **本地可信环境假设**  
   README 明确不建议公网暴露。我们如果面向团队推广，需要尽早设计权限、secret、workspace 安全边界。

4. **review 质量仍主要靠 prompt**  
   Hermes 的多轮 checkpoint 很好，但缺少 `gru-ai` 那种 review artifact 机械 gate。我们应该把两者结合。

## 三者能力对比

| 维度 | hanais 当前 | gru-ai | hermes-agent-team | 建议方向 |
| --- | --- | --- | --- | --- |
| 角色定义 | `identity.md` + `SKILL.md` loader | `.claude/agents` + registry + roles preset | Hermes profile + SOUL + description | 保留声明式 role/skill，增加 registry、version、capability |
| 执行模型 | lead 规划后直接调用角色 | directive pipeline + subagents | Kanban parent/worker/review task | 引入 Team ReAct：Plan -> ActEpisode -> Review -> Replan |
| 状态持久化 | 内存 session | `.context/directive.json` / `project.json` | SQLite + Kanban links | 先 append-only event log + JSON state，后 SQLite |
| 恢复能力 | 基本没有 | checkpoint/resume | Kanban sync + DB restore | P0 建立 session resume |
| review gate | 未实现 | 强，机械脚本 gate | 有 leader review，但机械 gate 弱 | 引入 reviewer role、DOD、artifact validator |
| runtime 抽象 | 初步 `AgentRuntime.run()` | PlatformAdapter + SpawnAdapter | Hermes profile + ACP pool | 拆分 run/spawn/monitor/cancel/capabilities |
| 可观测 | 单次 GUI events | watcher + dashboard + reports | SSE/WS + terminal + dashboard | 增加 session list、event log、work item trace |
| 人工介入 | 前端本地事件 | CEO gates | human input Kanban task | 人工输入必须进入 durable state |
| 配置管理 | 基本固定在代码 | CLI scaffold/config | UI 管理模型/MCP/skills/import-export | 加 team/role/runtime 配置 UI |
| 测试 | 主项目无测试 | e2e/benchmark/scripts | pytest 覆盖状态机 | 先补状态机单测和 fake runtime e2e |

## 推荐目标架构

建议把 `hanais` 演进为下面几层：

```text
GUI / Product Surface
  team library, run console, session history, human input, review dashboard

Team Orchestrator
  lead planning, act episodes, work item queue, typed mailbox, review loop, synthesis, policies

Durable State Layer
  TeamSession, ActEpisode, TypedMessage, WorkItem, Artifact, Review, EventLog, Checkpoint, Resume

Role Definition Layer
  identity, skills, tools, context requirements, output schema, runtime preference

Context / Harness Layer
  context packs, workspace isolation, DOD, validators, test commands, budget, permissions

Runtime Adapter Layer
  Codex CLI, Claude Agent SDK, qagent, future runtimes

Agent Runtime
```

### 核心设计原则

1. **WorkItem 是中心，不是聊天消息**  
   lead 的 assignment 应该转成持久 `WorkItem`，具备 `pending -> claimed -> running -> completed/blocked/failed/reviewing` 状态。

2. **ActEpisode 是协作边界**  
   每一轮 act 都应明确参与者、职责、可见身份、通信矩阵、允许消息类型、期望产物和 review trigger。限制结构复杂度优先于限制物理时长。

3. **TypedMessage 是团队通信总线**  
   角色之间可以点对点通信，但必须通过 typed mailbox。`review_request`、`artifact_delivery`、`change_request`、`blocked`、`approval` 等消息都要进入持久事件和状态。

4. **EventLog 是事实源**  
   所有状态变化先记录事件，再投影 session snapshot。这样 GUI、恢复、debug、报告都可以复用。

5. **Review 是一等对象**  
   `ReviewRun` 应包含 reviewer、target work item、DOD、findings、outcome、evidence、fix cycle。

6. **Artifact 是交接介质**  
   前序输出不应只塞进 prompt。应落成 artifact：文本、文件路径、diff、测试结果、结构化 JSON。

7. **Runtime 必须能力协商**  
   不同 runtime 支持能力不同：流式输出、工具事件、取消、resume、workspace、permission、model override、token usage。adapter 必须暴露 `capabilities()` 并让 orchestrator 降级。

8. **人工输入进入状态机**  
   需要用户确认时创建 `HumanInputRequest`，session 转 `waiting`，用户回答后恢复 dispatch。

9. **机械 gate 优先于 LLM 判断**  
   schema、DOD artifact、review presence、self-review、超时、预算、workspace 写入范围都应由代码检查。

## 优先级路线图

### P0：把原型变成可恢复系统

目标：一次 team run 即使中断，也能知道运行到哪、哪些 work item 完成、哪些失败、能否重跑。

建议任务：

1. 新增 `TeamStateStore` 接口：`createSession`、`appendEvent`、`getSession`、`listSessions`、`updateWorkItem`。
2. 实现本地文件版 store：`.hanais/teams/runs/<sessionId>/events.jsonl` + `run.json`。
3. 扩展 `TeamSession`：加入 `createdAt`、`updatedAt`、`currentPhase`、`workItems`、`reviews`、`humanInputs`。
4. `TeamRunner` 改为事件驱动：每个状态变化都 `appendEvent`。
5. GUI 增加 session history 和失败 session 查看。
6. 增加 fake runtime 测试：规划、执行、失败、恢复、超时。

验收标准：

- 运行中断后可以从 session 文件看到已完成和未完成 work item。
- 同一个 session resume 不重复创建已完成 work item。
- `pnpm typecheck` 和 orchestrator 单测通过。

### P1：建立 ActEpisode + WorkItem + Review 协议

目标：让 team 不只是“拆任务后调用 agent”，而是有可验证的工作流闭环。

建议任务：

1. 引入 `ActEpisode`，描述本轮目标、参与者、职责、通信规则、输入、期望产物和 review trigger。
2. 引入 `TypedMessage` / mailbox 协议，支持 `review_request`、`artifact_delivery`、`change_request`、`question`、`answer`、`blocked`、`approval`、`handoff`。
3. 引入 `TeamWorkItem` 状态机和 idempotency key。
4. lead plan 输出升级为 `WorkPlan`：act episodes、work items、dependencies、expected artifacts、DOD、review requirement。
5. 增加 schema validation，解析失败进入 repair prompt 或 fallback。
6. 增加 reviewer role 支持：同一个 role 不可 review 自己输出。
7. 增加 `ReviewResult`：`approved | changes_requested | blocked`。
8. 增加 fix cycle：最多 N 轮，重复失败转人工。
9. 让 `requireFinalReview` 真正生效。

验收标准：

- feature delivery team 可以实现：implementer -> reviewer -> fix -> final。
- 小说团队可以实现：novelist -> novel_editor 直接 review_request，editor 直接 approved / changes_requested。
- 单轮 Act 中角色只能向通信矩阵允许的对象发送允许类型的消息。
- reviewer 输出必须包含 finding/evidence/outcome，否则 gate fail。
- builder 不能自审。

### P2：运行时和 workspace 隔离

目标：让多 runtime 变成可控基础设施，而不是单次 spawn。

建议任务：

1. 将 `AgentRuntime` 拆为 `RuntimeAdapter` + `RunHandle`：`start`、`stream`、`cancel`、`resume?`、`inspect?`。
2. 给 runtime 增加 health check 和 capability report。
3. 支持 per-role workspace：临时目录、项目目录、git worktree 三种模式。
4. 记录 stdout/stderr、exit code、timeout、last heartbeat。
5. 为 Codex CLI adapter 增加更严格 JSON event parser 和失败分类。
6. 为 Claude SDK adapter 增加超时、取消、maxTurns、permissionMode 配置透传。

验收标准：

- runtime 超时能被标记为 failed，并保留日志。
- 用户可以取消 session。
- 多个 work item 并行运行时不会覆盖同一输出文件或同一 prompt 文件。

### P3：产品化 team 管理

目标：让团队内部成员可以真正使用、配置和复用。

建议任务：

1. Team/Role/Skill registry：支持从目录或 YAML 加载多个团队，而不是只内置小说团队。
2. GUI 支持创建/编辑 team、选择 role、选择 runtime、配置 workspace。
3. MCP/Skill/Model 配置管理：先做只读展示，再做安装/编辑。
4. 导入导出 team bundle：roles、skills、team definition、runtime preference、示例任务。
5. 增加 run report：计划、执行、review、artifact、失败原因、验证命令。

验收标准：

- 可以通过 GUI 切换 `novel_creation_team` 和 `feature_delivery_team`。
- team bundle 可导出并在另一台机器导入。
- 每次 run 自动生成 report。

### P4：推广级稳定性

目标：从个人可用变成团队可推广。

建议任务：

1. SQLite store 替换或补充文件 store，支持查询、分页、筛选。
2. 权限和 secret 管理：API key 不进 event log，不明文导出。
3. 预算控制：max wall time、max tool calls、max cost、max concurrent runs。
4. 任务基准集：代码修复、文档生成、评审、长任务、多 runtime。
5. CI 中跑 fake runtime deterministic tests。
6. 故障注入测试：runtime crash、JSON parse fail、review fail、resume、duplicate event。

验收标准：

- 核心状态机测试覆盖主要失败路径。
- 常见失败可恢复，不需要清空状态重来。
- 有明确安全边界和本地部署说明。

## 建议先做的 10 个具体改动

1. 在 `@hanais/agent-team` 新增 `TeamStateStore` 和 `InMemoryTeamStateStore`，先不引入 DB。
2. 新增 `FileTeamStateStore`，默认写入 `.hanais/teams/runs`。
3. 把 `TeamRunner.run()` 拆成小阶段：`plan -> createWorkItems -> dispatch -> review? -> synthesize`。
4. 给 `TeamRunEvent` 增加 `eventId`、`sessionId`、`sequence`、`timestamp`。
5. 把 `TeamWorkItem` 放进 `TeamSession`，不要只用 `taskBoard: TeamTask[]`。
6. 增加 `FakeRuntime` 测试工具，不依赖 Codex/Claude 就能测 orchestration。
7. 增加 `extractPlan` 的 schema validator，非法 plan 产生明确 error event。
8. 增加 `reviewer` role 示例，把 `examples/feature-delivery-team.yaml` 变成可运行 fixture。
9. GUI 增加 session/event raw inspector，方便调试。
10. 文档新增 `docs/architecture/team-state-machine.md`，把状态机先固定下来。

## 不建议近期投入的方向

1. 不要先做复杂长期记忆或向量检索。当前最缺的是可靠执行和可恢复状态。
2. 不要先做 game-like UI。可视化重要，但不是稳定性的根。
3. 不要把 team orchestrator 改成 pipeline DAG。公司已有 workflow pipeline，team 应该保持动态协作能力。
4. 不要先接太多 runtime。先把 Codex CLI 和 Claude SDK 的 run/cancel/error/resume 边界打磨好。
5. 不要让 lead 自由发明角色。当前 `__contractor__` 的受控模式是正确的，应继续保留。

## 关键风险

1. **LLM 计划不可控**  
   解决方式：schema validator、repair loop、fallback plan、role allowlist、contractor limit。

2. **多 agent 输出互相污染**  
   解决方式：artifact 交接、context pack、fresh context review，不把完整历史无限塞给后续 agent。

3. **review 流于形式**  
   解决方式：review artifact、DOD evidence、禁止 self-review、机械 gate、fix cycle。

4. **runtime 不稳定**  
   解决方式：adapter capability、timeout、heartbeat、cancel、日志、失败分类、resume。

5. **推广时配置复杂**  
   解决方式：team bundle、runtime preset、环境检测、GUI 配置、清晰错误。

6. **安全边界不足**  
   解决方式：workspace allowlist、secret redaction、权限模式、导出脱敏。

## 最小可信版本定义

如果目标是让团队内部愿意试用，一个最小可信版本应满足：

1. 用户能在 GUI 选择一个 team 和 runtime，提交任务。
2. 系统能持久记录 session、work items、events、artifacts。
3. 运行失败后能看到失败点，并能 retry 未完成 work item。
4. 代码类任务必须有 reviewer gate。
5. 用户介入是可追踪对象，不是临时聊天。
6. 每次运行生成 report，说明计划、成员输出、review、验证、最终结果。
7. 有 fake runtime 测试和至少一个端到端 fixture，CI 可跑。

## 对当前项目的总体建议

`hanais` 不需要追求参考项目的表面积。`gru-ai` 和 `hermes-agent-team` 真正领先的是它们都把 agent team 当作**状态机和运行系统**，而不是 prompt collection。

下一阶段最应该投入的是：

- durable state
- work item protocol
- review/evaluator gate
- runtime lifecycle
- GUI observability
- deterministic tests

这些能力补齐后，再扩展角色库、skills、MCP、导入导出和自动调度，才会变成可推广的解决方案。

## 2026-05-24 实施更新：系统角色、Review Gate、人工介入闭环

本轮优化确认了一个关键分层：`teammates` 包只定义用户/业务角色，例如小说作者、小说编辑；`@hanais/agent-team` 包内化系统级角色和服务。

系统级 agent 角色：

- `team_lead`：内置协调者，负责 Plan、Act 调度和最终汇总。
- `__contractor__`：受控外包角色模板，只在现有 teammates 无法覆盖任务时使用。

系统级角色也应采用和 `teammates` 包同构的定义方式，而不是只写成 TS 常量。当前已落成：

```text
packages/agent-team/src/roles/team-lead/identity.md
packages/agent-team/src/roles/team-lead/skills.json
packages/agent-team/src/roles/contractor/identity.md
packages/agent-team/src/roles/contractor/skills.json
packages/agent-team/src/skills/team-planning/SKILL.md
packages/agent-team/src/skills/team-synthesis/SKILL.md
packages/agent-team/src/skills/contractor-execution/SKILL.md
```

这样系统角色未来可以像普通业务角色一样演进自己的 identity、skill、policy 和输出要求，但它们的归属仍在 `@hanais/agent-team` 内核，不进入用户自定义 `teammates` 包。

系统服务，不是角色：

- `mailbox`：消息总线、work item 队列和 artifact 收件箱。
- `state_store`：运行状态、事件、消息、review、artifact 持久化。
- `review_gate`：触发 review、校验审核协议、决定是否进入下一轮 Act 或阻塞。
- `human_input_gateway`：把 blocked 状态转换成可持久化、可回答的人工介入请求。

这意味着 GUI 的“人到人协作图”默认不应展示 `mailbox`。`mailbox` 应留在队列/调试视图里，帮助观察系统状态，而不是被误解为团队成员。

### 显式 reviewer 配置

`reviewerRoleIds` 被加入 team policy。runtime 不再靠角色名字里是否包含“editor / review / 审核 / 编辑”来决定谁是 reviewer。

例如小说团队明确声明：

```json
{
  "enableTeamReAct": true,
  "requireFinalReview": true,
  "reviewerRoleIds": ["novel_editor"]
}
```

执行含义：

1. Plan 阶段 `team_lead` 只产出第一轮 Act 执行任务。
2. Act 阶段排除 reviewer，不把 `novel_editor` 当普通执行者提前跑。
3. Review 阶段由 `review_gate` 调用 `novel_editor`。
4. Review 结果决定进入下一轮 Act、批准进入 Final，或进入人工介入。

这比 prompt 约束更稳，因为 reviewer 的身份是协议字段，runner 会机械执行。

### Team ReAct 最终形态

当前目标形态固定为：

```text
Plan -> ActEpisode -> Review Gate -> Next ActEpisode -> Review Gate -> Final
```

其中 ActEpisode 是一轮可审计执行单元，包含：

- 本轮目标。
- 本轮参与者清单。
- 每个参与者的责任。
- 本轮输入 artifact。
- 期望 artifact。
- acceptance criteria。
- communication rules。
- review policy。

单轮 Act 内允许 teammate 互相可见，但通信规则需要受控：参与者名单、可发送的消息类型、peer turn 上限都属于协议，而不是让模型自由无限聊天。

### 严格 Review Gate

Review 不再只是“让编辑说几句意见”。现在 reviewer 输出必须满足结构化协议：

```json
{
  "outcome": "approved | changes_requested | blocked",
  "summary": "审核摘要",
  "findings": [
    {
      "severity": "blocking | major | minor | note",
      "message": "问题或确认点",
      "evidence": "产物中的依据",
      "target": "对应段落、文件或模块"
    }
  ],
  "requiredChanges": ["当 outcome 为 changes_requested 时列出必须修改项"],
  "evidence": ["支撑审核结论的证据"]
}
```

runner 会校验：

- strict 模式下必须能解析成 JSON。
- `changes_requested` 必须有 `requiredChanges`。
- `approved` 不能带 `blocking` 或 `major` finding。
- `blocked` 必须有 finding。

如果 reviewer 输出不合规，系统会先触发一次 repair prompt，让 reviewer 把审核意见改写成合规 JSON。仍失败则由 `review_gate` 产生 blocked review result，并进入人工介入。

### 人工介入闭环

人工介入不再是 GUI 里的临时聊天消息，而是 `HumanInputRequest`：

- 有 `id`、`sessionId`、`workItemId`。
- 有来源：通常是 `review_gate`。
- 有问题文本、reason、context。
- 有状态：`pending / answered / cancelled`。
- 会持久化到 `.hanais/teams/runs/<runId>/human-inputs.json`。

GUI 收到 `human_input_requested` 后，用户在介入框提交答案；主进程 resolve runner 内部等待的 Promise；runner 将请求标记为 answered，然后把人工意见注入下一轮 Act 修订任务，继续 review。

### 本轮 smoke 验证结果

fake runtime 已验证两个关键路径：

1. `repair`：lead 预排了 writer、editor、writer，但 Team ReAct 只执行 writer；editor 第一次输出非 JSON，Review Gate repair 后进入修订 Act，第二轮 review approved。
2. `blocked`：第一轮 review 返回 blocked，系统产生 human input request；用户答案注入下一轮 Act，第二轮 review approved。

验证结果显示：

- reviewer 不会被当作 Act work item 提前执行。
- 多轮 ActEpisode 能按 review outcome 推进。
- strict review JSON repair 生效。
- blocked 后人工介入可以唤醒 runner 并继续执行。
