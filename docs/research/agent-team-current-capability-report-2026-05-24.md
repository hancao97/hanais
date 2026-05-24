# Agent Team 当前能力验证报告

日期：2026-05-24  
范围：`@hanais/agent-team` 内核、`@hanais/teammates` 小说团队、Electron GUI、文件持久化、deterministic smoke。

## 结论

当前项目已经从“prompt 串联 demo”推进到**可运行的工程化 Alpha 内核**。

它现在具备：

- 系统角色和用户角色分层。
- 系统角色同构资产定义。
- Team ReAct 状态机雏形。
- 受控 peer-to-peer Act loop。
- ActEpisode、WorkItem、ReviewTask、HumanInputRequest 等核心协议对象。
- 文件级运行持久化。
- Review Gate 一等能力。
- blocked 后人工介入再继续执行。
- GUI 展示历史运行、消息、队列、人到人交互和人工介入。
- deterministic fake runtime smoke，可不依赖真实模型验证 orchestration。

但它还没达到“生产级可推广平台”的完整状态。主要缺口是：完整 resume/retry 执行恢复、权限/预算/secret 管理、系统化测试集和 CI fixture。

综合判断：

| 维度 | 当前水平 | 说明 |
| --- | --- | --- |
| 架构分层 | Alpha+ | 系统角色、系统服务、业务 teammate 已区分。 |
| 执行协议 | Alpha+ | 有 Team ReAct 主循环，受控 peer-to-peer Act loop 已 runtime 化。 |
| 持久化 | Alpha | 运行快照和事件已落盘，暂不支持 resume。 |
| Review Gate | Alpha+ | 已有严格 JSON、repair、blocked、人类介入路径。 |
| GUI 可观测性 | Alpha | 能看历史、图、队列、结果；还缺 raw inspector 和恢复操作。 |
| 可验证性 | Alpha+ | 已有 `agent-team` 正式 smoke fixture；还缺 CI 和更细单元测试。 |
| 推广可用性 | Pre-beta | 单团队可试用，离通用方案仍需补 runtime/lifecycle/config。 |

## 已验证命令

本次实际运行：

```bash
pnpm typecheck
pnpm -r build
pnpm --filter @hanais/agent-team test
```

结果：

- `pnpm typecheck` 通过。
- `pnpm -r build` 通过。
- `pnpm --filter @hanais/agent-team test` 通过。
- GUI renderer/main/preload 均构建通过。
- `agent-team` build 会复制 `src/roles` 和 `src/skills` 到 `dist`。

额外 deterministic smoke：

1. 系统角色资产加载验证：
   - `team_lead` 成功加载 `team-planning`、`team-synthesis`。
   - `__contractor__` 成功加载 `contractor-execution`。

2. Review Gate repair 路径：
   - lead 预排 `writer -> editor -> writer`。
   - Team ReAct runtime 只执行 `writer` Act，排除 reviewer。
   - reviewer 第一轮输出非 JSON。
   - Review Gate 触发 repair。
   - repair 后 outcome 为 `changes_requested`。
   - runner 创建第二轮 Act。
   - 第二轮 review `approved`。
   - session `completed`。

3. Human input 路径：
   - 第一轮 review `blocked`。
   - runner 产生 `human_input_requested`。
   - fake human answer 注入下一轮 Act。
   - 第二轮 review `approved`。
   - session `completed`。
   - 文件持久化中 `humanInputs = ["answered"]`。

持久化 smoke 检查：

- `run.json` 存在且 status 为 `completed`。
- `events.jsonl` 有 55 行事件。
- artifacts 包含 `role_output`、`role_output`、`final_output`。

4. Peer-to-peer Act loop 路径：
   - 两个普通 teammate 同在一个 ActEpisode。
   - runner 在普通 work item 完成后启动受控 peer turn。
   - teammate 只能按 `communicationRules` 向本轮 participant 发送允许类型消息。
   - smoke 中产生 `alpha -> beta` 和 `beta -> alpha` 两条 `question`。
   - 记录 `peer_turn_started`、`peer_turn_completed`。
   - peer turn limit 测试覆盖：同一 turn 内同一目标按配置接受多条消息，超过 `maxPeerMessagesPerPairPerTurn` 的消息会被拒绝；系统服务目标会被拒绝。

5. Runtime lifecycle 路径：
   - 每次 runtime 调用记录 `runtime_session_started`。
   - 正常结束记录 `runtime_session_completed`。
   - 异常路径支持分类为 timeout/runtime_error/cancelled/unknown，并记录 `runtime_session_failed` 或 `runtime_session_cancelled`。

## 技术架构

### 包结构

当前核心分层：

```text
packages/agent-team
  src/types.ts                 # 协议模型
  src/runner.ts                # TeamRunner 状态机
  src/state-store.ts           # 文件/内存状态存储
  src/prompts.ts               # prompt 构造和 plan 解析
  src/system-roles.ts          # 系统角色/系统服务入口
  src/definition-loader.ts     # 角色/skill 资产加载器
  src/roles/*                 # 系统角色 identity + skills
  src/skills/*                # 系统 skill

packages/teammates
  src/roles/*                 # 用户/业务角色
  src/skills/*                # 用户/业务 skill
  src/novel-team.ts           # 小说团队定义

packages/agent-runtimes
  Codex CLI / Claude SDK runtime adapter

packages/gui
  Electron main/preload/renderer
```

### 系统角色与业务角色

当前系统角色属于 `@hanais/agent-team`：

```text
packages/agent-team/src/roles/team-lead/identity.md
packages/agent-team/src/roles/team-lead/skills.json
packages/agent-team/src/roles/contractor/identity.md
packages/agent-team/src/roles/contractor/skills.json
```

系统 skill：

```text
packages/agent-team/src/skills/team-planning/SKILL.md
packages/agent-team/src/skills/team-synthesis/SKILL.md
packages/agent-team/src/skills/contractor-execution/SKILL.md
```

业务角色仍属于 `@hanais/teammates`：

```text
packages/teammates/src/roles/novelist
packages/teammates/src/roles/novel-editor
```

这个设计是正确方向：系统角色和业务角色定义形态一致，但归属边界不同。未来系统角色可以继续扩展 identity、skills、policies、outputs schema，而不会污染用户自定义角色包。

### 系统服务

当前明确了四类系统服务：

| 服务 | 定位 |
| --- | --- |
| `mailbox` | 消息总线、work item 队列、artifact 收件箱。不是 agent。 |
| `state_store` | 负责 session、event、message、review、artifact 持久化。 |
| `review_gate` | 触发 review、校验 review 结果、决定下一步。 |
| `human_input_gateway` | 把 blocked 状态转成可回答、可持久化的人工介入请求。 |

这解决了之前 `mailbox` 像角色的问题。GUI 中 `mailbox` 应作为队列/调试视图，而不是“人到人协作图”的参与者。

## 核心协议模型

当前主要协议对象在 `packages/agent-team/src/types.ts`：

### TeamDefinition

定义团队：

- `lead`：内置 `team_lead`。
- `teammates`：业务角色列表。
- `policies`：执行策略。
- `runtimeOverrides`：角色 runtime 覆盖。

小说团队当前配置：

```ts
policies: {
  maxReviewRounds: 2,
  enableTeamReAct: true,
  requireFinalReview: true,
  reviewerRoleIds: ["novel_editor"],
  requireStrictReviewJson: true,
  reviewRepairAttempts: 1,
  allowHumanInput: true,
  maxPeerTurnsPerAct: 3,
  maxPeerMessagesPerPairPerTurn: 3
}
```

### TeamSession

一次运行的总状态，包含：

- `currentPhase`
- `status`
- `plan`
- `roleInstances`
- `actEpisodes`
- `workItems`
- `reviews`
- `humanInputs`
- `messages`
- `artifacts`
- `finalOutput`

当前 phase：

```text
planning -> dispatching -> reviewing -> waiting_for_human -> synthesizing -> completed
```

### ActEpisode

一轮 Act 的结构化执行单元：

- `round`
- `goal`
- `participants`
- `communicationRules`
- `inputArtifactIds`
- `expectedArtifacts`
- `acceptanceCriteria`
- `reviewPolicy`

这是 Team ReAct 的核心。它让“一轮行动”不是模糊 prompt，而是可审计对象。

### TeamWorkItem

具体分配给某个 role instance 的任务：

- `roleId`
- `roleInstanceId`
- `assignment`
- `status`
- `sequence`
- `dependencies`
- `inputs`
- `expectedArtifacts`
- `acceptanceCriteria`
- `attempts`
- `result`
- `error`

当前 work item 已经比最初 task board 强很多，能支撑后续 retry/resume。

### ReviewTask / ReviewResult

Review 是一等对象：

```ts
outcome: "approved" | "changes_requested" | "blocked"
findings: ReviewFinding[]
requiredChanges?: string[]
evidence?: string[]
```

Review Gate 会校验：

- strict 模式必须 JSON。
- `changes_requested` 必须有 `requiredChanges`。
- `approved` 不能包含 `blocking` 或 `major` finding。
- `blocked` 必须有 finding。

### HumanInputRequest

人工介入是一等对象：

- `id`
- `sessionId`
- `workItemId`
- `fromRoleId`
- `toRoleId`
- `question`
- `status`
- `answer`
- `reason`
- `context`

这比“GUI 里加一条聊天消息”强很多，因为它可以被持久化、恢复、审计。

## 内部执行逻辑

当前主流程：

```text
1. create session
2. persist session_started
3. team_lead planning
4. parse/normalize plan
5. resolve reviewerRoleIds
6. select first Act assignments
7. create ActEpisode
8. dispatch work items
9. collect role outputs and artifacts
10. if Team ReAct enabled:
    10.1 Review Gate calls reviewer
    10.2 validate ReviewResult
    10.3 approved -> final synthesis
    10.4 changes_requested -> create revision ActEpisode
    10.5 blocked -> request human input
    10.6 human answered -> create revision ActEpisode with human answer
11. team_lead synthesis
12. create final artifact
13. final_output
```

### Plan 阶段

`team_lead` 会收到：

- 用户任务。
- teammates 调度卡片。
- team policies。
- reviewerRoleIds。

Team ReAct 启用时，prompt 明确要求 assignments 只描述第一轮 Act，不预排审核、修改和复审。

但更重要的是：runner 不只依赖 prompt。即使 lead 预排 editor 或重复 writer，`selectActAssignments()` 也会机械过滤 reviewer 和重复角色。

### Act 阶段

runner 创建 work item 并执行对应 role runtime。

每个 role 会收到：

- 角色 identity。
- 角色 skills instructions。
- 当前 work item。
- 当前 ActEpisode。
- 已完成 teamArtifacts。

普通 Act 当前是 runner 顺序调度 work item，随后进入受控 peer-to-peer Act loop。peer loop 不是无限聊天，而是按 ActEpisode 的 `communicationRules` 逐轮运行：

```text
work items completed
-> peer turn 1
-> validate messages
-> persist team_message_posted
-> peer turn 2 ... maxPeerTurnsPerAct
-> review gate
```

peer message 必须满足：

- `from` 是本轮 participant。
- `to` 是 communicationRules 允许目标。
- `type` 在 allowedMessageTypes 内。
- 不能发给 `mailbox`、`state_store`、`review_gate`、`human_input_gateway`。
- 同一个 peer turn 内，同一对 `from -> to` 最多接受 `maxPeerMessagesPerPairPerTurn` 条消息。
- 整个 ActEpisode 内，每对 `from -> to` 最多参与 `maxPeerTurnsPerAct` 个 peer turn。
- 外层 peer turn 超过 `maxPeerTurnsPerAct` 后停止。

### Peer Turn 限制设计

`maxPeerTurnsPerAct` 不是任务超时时间，也不是限制整个任务复杂度。它只限制一个 ActEpisode 内 teammate 之间的受控互动轮次。

当前实现含义：

```text
maxPeerTurnsPerAct = 3
maxPeerMessagesPerPairPerTurn = 3
```

表示：

- runner 最多启动 3 个 peer turn。
- 每个 turn 中，每个 participant 有一次机会输出结构化 messages。
- 同一 turn 内，同一对 `from -> to` 最多接受 3 条有效消息。
- 同一 ActEpisode 内，同一对 `from -> to` 最多在 3 个 peer turn 中发生沟通，因此上限是 `maxPeerTurnsPerAct * maxPeerMessagesPerPairPerTurn` 条有效消息。
- 不符合 communicationRules 的消息会被丢弃。

这个设计的目标是：允许 teammate 直接沟通，但把自由度限制在可审计、可停止、可持久化的范围内。

### `team_lead` 会话创建

`team_lead` 是 `@hanais/agent-team` 内置系统角色，identity 和 skills 来自：

```text
packages/agent-team/src/roles/team-lead/identity.md
packages/agent-team/src/roles/team-lead/skills.json
packages/agent-team/src/skills/team-planning/SKILL.md
packages/agent-team/src/skills/team-synthesis/SKILL.md
```

每次运行创建一个 `TeamSession`：

```ts
session.lead = { id: "team_lead", runtimeId: leadRuntimeId }
```

然后 runner 为 `team_lead` 创建两个 runtime session：

```text
<teamSessionId>_lead_plan   # Plan 阶段
<teamSessionId>_lead_final  # Final synthesis 阶段
```

两次 runtime 调用都会记录：

```text
runtime_session_started
agent_event
runtime_session_completed
```

`team_lead` 不属于用户 `teammates`，但它和普通角色一样有 identity/skills 资产，只是归属在 `agent-team` 内核。

### Review 阶段

Review Gate 当前由 runner 代码实现，不是只靠 prompt。

流程：

```text
target output -> reviewer runtime -> raw review output
-> parse review JSON
-> validate review protocol
-> invalid? repair once
-> still invalid? blocked
-> outcome decision
```

这已经具备“审核闸门”的基本工程形态。

### Human Input 阶段

当 review blocked 或达到最大 review round 仍有 changes_requested：

```text
review_gate -> HumanInputRequest(pending)
GUI receives human_input_requested
user submits answer
main process resolves runner Promise
HumanInputRequest(answered)
runner creates next revision ActEpisode with human answer
```

这个链路已经是真正闭环，不是 UI 假消息。

### Final 阶段

`team_lead` synthesis 会优先使用最后一轮非 reviewer 的产物作为最终候选。

最终输出会记录：

- `session.finalOutput`
- `final_output` event
- `artifact_final_output`

## 持久化能力

默认路径：

```text
~/.hanais/teams/runs/<runId>/
```

每次运行写入：

```text
run.json
events.jsonl
work-items.json
act-episodes.json
messages.json
reviews.json
human-inputs.json
artifacts.json
artifacts/
```

当前达成：

- 可以看到历史运行摘要。
- 可以读取某次运行 events。
- 可以审计每轮 work/review/human input。

当前部分达成：

- 已有 `TeamRunner.resume()` 基础入口，可以读取历史 session、记录 `session_resumed`，并持久化 pending human input 的回答。

当前未达成：

- 尚不能从某个 runId 完整恢复后继续 Act/review 执行。
- 尚不能 retry 单个 failed work item。
- 尚没有 event compaction / migration / schema versioning。

## GUI 能力

当前 GUI 做到了：

- 运行任务。
- 选择 runtime。
- 显示运行历史。
- 显示队列和消息。
- 显示人到人交互图。
- 隐藏 mailbox-to-agent 的图边，避免 mailbox 被误解成角色。
- 显示系统角色、系统 skill、系统服务 metadata。
- 接收 `human_input_requested` 并提交回答。

仍需加强：

- raw event inspector。
- run detail 页面。
- resume/retry 操作。
- review result 专门视图。
- artifact diff / final artifact preview。
- waiting 状态的更强提示和保护。

## 当前达到的水平

### 一句话评价

当前已经达到：**单团队、单任务、可审计、可持久化、带 review gate 和人工介入闭环的 Agent Team Alpha 内核**。

它不是“最终产品”，但已经具备成为可推广方案的关键骨架。

### 能力等级判断

| 等级 | 状态 | 说明 |
| --- | --- | --- |
| Prompt demo | 已超过 | 不再只是 prompt 串行调用。 |
| Prototype | 已超过 | 有明确协议对象和状态持久化。 |
| Engineering Alpha | 当前水平 | 能跑主循环，能 deterministic 验证关键路径。 |
| Beta | 未达到 | 需要 resume/retry、CI tests、runtime governance。 |
| Production | 未达到 | 需要安全、权限、预算、并发、迁移、操作审计。 |

当前最准确定位：**Engineering Alpha / Pre-beta**。

## 关键优势

1. **系统边界正在变清楚**  
   `agent-team` 管系统角色和运行协议，`teammates` 管业务角色。这是可推广项目的关键。

2. **Review 已进入 runtime 状态机**  
   reviewerRoleIds、ReviewTask、ReviewResult、Review Gate validation 都已经落到代码层。

3. **人工介入不是假 UI**  
   它已经成为 runner 等待/继续执行的一部分。

4. **持久化目录合理**  
   `.hanais/teams/runs` 符合用户期望，也避开了 `sessions` 命名冲突。

5. **有 deterministic 验证能力**  
   fake runtime 能验证 orchestration，不依赖真实 LLM。

## 主要短板

1. **resume/retry 还不完整**  
   已有 `resume()` 基础入口和 pending human input 回答持久化，但还不能从中断点完整恢复后继续 Act/review 执行。这仍是下一阶段最重要的可靠性能力。

2. **peer-to-peer 已 runtime 化，但还不是工具级实时协作**  
   当前 peer loop 是 runner 逐轮调用 participant 输出结构化 messages；后续可以升级为 mailbox-driven streaming/tool-call 协作。

3. **Review Gate 还需要 schema 化和测试化**  
   现在校验逻辑写在 runner 内，后续应抽成独立模块，并增加单元测试。

4. **Plan schema validation 还不够硬**  
   `extractPlan` 和 `sanitizeAssignments` 有基础容错，但没有完整 schema validator 和 repair loop。

5. **runtime lifecycle 仍需治理化**  
   已有 runtime session started/completed/failed/cancelled 事件和基础失败分类；cancel 主动调用、heartbeat、tool error、budget 尚未完整。

6. **安全与推广治理未开始**  
   secret redaction、workspace allowlist、权限策略、event 脱敏、导出策略都还缺。

7. **测试已开始沉淀，但覆盖还不够细**  
   `packages/agent-team/test/smoke.mjs` 已覆盖主路径；还需要 review gate、plan validator、state store 的细粒度单元测试。

## 建议下一阶段优先级

### P0：把 Alpha 变成可恢复 Alpha

- 扩展 `TeamRunner.resume(runId)`，从“加载历史 session/回答 pending human input”升级为“继续 Act/review 执行”。
- 支持 retry failed work item。
- 支持 waiting human input 的跨进程恢复。
- 给 `TeamStateStore` 增加 update human input / append artifact / query work item API。

### P1：把 Review Gate 模块化

- 抽出 `review-gate.ts`。
- 抽出 review result schema。
- 增加 tests：
  - invalid JSON -> repair。
  - changes_requested without requiredChanges -> repair/blocked。
  - approved with major finding -> invalid。
  - blocked -> human input。

### P2：升级受控 peer-to-peer Act

- mailbox 作为系统服务维护可恢复 message queue。
- participant 消息从当前 JSON turn 升级为 runtime tool-call 或 streaming event。
- 支持 peer artifact delivery 进入 artifacts。
- 支持 peer loop 中的 blocked/escalation 自动转 team_lead 或 human。

### P3：测试和 CI

- fake runtime 应作为 test utility。
- CI 跑 typecheck、build、agent-team deterministic tests。

### P4：产品化可观测性

- GUI 增加 run detail。
- GUI 增加 event raw inspector。
- GUI 增加 review/human/artifact 专门面板。
- 支持打开历史 run 并查看完整状态。

## 最终判断

当前版本已经证明了核心路线是对的：

```text
系统角色资产化
业务 teammate 可插拔
Team ReAct 状态机
受控 peer-to-peer Act loop
Review Gate 一等化
Human Input 一等化
Runtime lifecycle 基础事件
运行持久化
GUI 可观测
```

这已经是一个可以继续工程化推进的 agent team 内核，不再只是演示项目。

下一步如果优先补 `完整 resume/retry + review gate tests + peer artifact/tool-call 协作`，项目会从 Engineering Alpha 推进到可内部推广的 Beta。
