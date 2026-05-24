# hanais

## 项目愿景

hanais 的目标是把 agent team 从“prompt 串联 demo”推进成一个强大、可用、稳定、可推广的团队协作型 AI 执行系统。

我们希望它不是单个大模型助手，也不是简单的多角色扮演，而是一套可工程化落地的 agent team 内核：用户提出目标后，系统可以规划任务、拉起合适角色、让角色在受控协议内协作、经过 review gate 审核、必要时引入人工判断，并把每一次运行完整持久化，最终形成可复盘、可调试、可改进的团队执行过程。

长期看，hanais 要成为一套可以被团队内部复用、也可以对外推广的 agent team 解决方案。它应当具备：

- 可理解：角色、技能、任务协议、审查规则和运行历史都清晰可见。
- 可控制：AI 可以协作，但协作发生在明确的 ActEpisode、WorkItem、CommunicationRule 和 ReviewGate 之内。
- 可持续：运行状态、事件、产物和人工介入信息持久化到本地，后续可以继续完善 resume/retry。
- 可扩展：系统内置角色、用户自定义 teammate、runtime adapter、GUI 和文件状态存储分层演进。
- 可验证：用 deterministic fake runtime 验证 orchestration，不把正确性完全压在 prompt 上。

## 当前定位

当前项目处在工程化 Alpha 阶段：核心 agent-team 内核已经具备 Team ReAct 主循环、文件持久化、review gate、人工介入、受控 peer-to-peer Act loop 和 GUI 可观测能力，但还没有完成生产级 runtime 生命周期治理、完整 resume/retry、权限/预算/secret 管理和系统化 CI fixture。

这意味着它已经可以用于内部验证真实 agent team 工作流，但还不应该被视为完全成熟的平台产品。

## 核心执行模型

hanais 的目标执行链路是：

```text
用户任务
-> team_lead 规划
-> ActEpisode
-> teammate 执行 WorkItem
-> peer-to-peer 受控沟通
-> ReviewGate 审核
-> 必要时进入下一轮 Act
-> team_lead 汇总最终结果
```

这个模型接近 Team ReAct，但不是纯靠 prompt 要求模型“自觉协作”。当前内核已经把关键状态显式建模：

- `TeamSession`：一次 team run 的总状态。
- `ActEpisode`：一轮 plan/act/review 循环里的执行单元。
- `TeamWorkItem`：可领取、可执行、可完成、可审核的任务协议对象。
- `CommunicationRule`：限制谁可以向谁发消息、发什么类型、发几轮。
- `ReviewTask` / `ReviewResult`：review gate 的一等协议。
- `HumanInputRequest`：当系统判断需要人类介入时生成的可持久化请求。
- `TeamMessage` / `ArtifactRef`：团队消息和产物。

## 系统角色和用户角色

hanais 明确区分系统级角色、系统服务和用户自定义 teammate。

系统级角色内置在 `@hanais/agent-team`：

- `team_lead`：负责规划、调度、仲裁和最终汇总。
- `__contractor__`：当用户团队缺少某类能力时使用的受控外包角色。

系统服务不是角色：

- `mailbox`：系统任务和消息队列服务。
- `state_store`：状态持久化服务。
- `review_gate`：审核协议服务。
- `human_input_gateway`：人工介入服务。

用户自定义 teammate 定义在 `@hanais/teammates`，例如小说团队里的：

- `novelist`
- `novel_editor`

系统角色和用户角色都采用类似结构定义 identity 和 skills。这样未来系统角色也能像普通角色一样拥有自己的技能、职责边界和演进空间。

## Peer-to-Peer Act

hanais 支持受控的 teammate 直接沟通。它不是让模型无限自由聊天，而是在 ActEpisode 内按协议执行：

```text
work items completed
-> peer turn 1
-> validate messages
-> persist team_message_posted
-> peer turn 2 ... maxPeerTurnsPerAct
-> review gate
```

关键限制：

- 只有本轮 `participants` 可以参与 peer turn。
- 消息必须符合 `communicationRules`。
- teammate 不能直接把消息发给 `mailbox`、`state_store`、`review_gate`、`human_input_gateway`。
- `maxPeerTurnsPerAct` 控制一个 ActEpisode 内最多几轮 peer turn。
- `maxPeerMessagesPerPairPerTurn` 控制同一轮里同一对角色最多几条有效消息。

这两个配置分开很重要：轮次限制不是消息条数限制。同一轮内一对角色可以有多条必要沟通，但必须有上限，保证执行可审计、可停止、可持久化。

## Review Gate

review 是 hanais 的一等能力，不是普通 teammate 输出里顺手写一段评价。

当前内核支持：

- 显式 `reviewerRoleIds` 配置。
- Team ReAct 模式下自动排除 reviewer 的首轮执行任务。
- Act 完成后自动创建 review task。
- 严格 JSON review schema。
- review 输出不合法时触发 repair。
- `approved`、`changes_requested`、`blocked` 三类结论。
- `changes_requested` 自动进入下一轮 Act。
- `blocked` 可触发 `HumanInputRequest`。

这让团队执行从“模型说完成了”变成“产物经过明确审核协议后完成”。

## 持久化

GUI 默认把偏好设置保存到：

```text
~/.hanais/settings.json
```

team run 历史保存到：

```text
~/.hanais/teams
```

每次运行会持久化 session 快照和事件流，便于查看历史任务、调试执行过程、复盘每个 teammate 的贡献。当前已经具备运行历史查看能力；完整 resume/retry 执行恢复仍在路线图中。

## 包结构

```text
packages/agent-team
  src/types.ts                 # 核心协议模型
  src/runner.ts                # TeamRunner 状态机
  src/state-store.ts           # 文件/内存状态存储
  src/prompts.ts               # prompt 构造和 plan 解析
  src/system-roles.ts          # 系统角色/系统服务入口
  src/definition-loader.ts     # 角色和 skill 资产加载器
  src/roles/*                  # 系统角色 identity + skills
  src/skills/*                 # 系统 skill

packages/agent-runtimes
  src/*                        # runtime adapter，目前包含 Codex CLI 和 Claude Agent SDK

packages/teammates
  src/roles/*                  # 用户/业务角色
  src/skills/*                 # 用户/业务 skill
  src/novel-team.ts            # 小说团队定义

packages/gui
  src/main/*                   # Electron main process 和 IPC
  src/preload/*                # preload bridge
  src/renderer/*               # React 验证客户端

docs/research
  *.md                         # reference project 分析、当前能力报告和设计记录
```

## 快速开始

安装依赖：

```bash
pnpm install
```

类型检查：

```bash
pnpm typecheck
```

构建全部包：

```bash
pnpm build
```

运行 agent-team smoke：

```bash
pnpm test:agent-team
```

启动 GUI 开发环境：

```bash
pnpm gui:dev
```

这个命令会启动 Vite dev server，并让 Electron 加载 `http://127.0.0.1:5173`。renderer 支持热更新。

生产构建后启动 GUI：

```bash
pnpm gui:build
pnpm gui:start
```

如需自动打开 DevTools：

```bash
HANAIS_OPEN_DEVTOOLS=1 pnpm gui:dev
```

## Runtime 配置

本地验证优先使用 Codex CLI。Codex CLI 可能出现重连和长时间等待，所以 runtime adapter 默认给了较长超时。

项目也支持通过 Claude Agent SDK 使用 Kimi 的 Anthropic-compatible endpoint。密钥不要提交到 Git，放到项目根目录 `.env.local`：

```bash
KIMI_API_KEY=your-local-key
KIMI_BASE_URL=https://api.moonshot.cn/anthropic
KIMI_MODEL=kimi-k2.5
```

GUI 里选择 `Claude SDK + Kimi` 即可走这个 runtime。

如果 Electron binary 下载卡住，可以先跳过 binary 下载完成源码依赖安装和构建：

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install
pnpm build
```

之后需要启动桌面客户端时，再单独执行：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm --filter @hanais/gui rebuild electron
pnpm gui:start
```

## 角色和 Skill 定义

用户角色和技能按目录定义：

```text
packages/teammates/src/
  roles/
    novelist/
      identity.md
      skills.json
  skills/
    story-drafting/
      SKILL.md
```

系统角色和技能按同样思想定义在：

```text
packages/agent-team/src/
  roles/
    team-lead/
      identity.md
      skills.json
  skills/
    team-planning/
      SKILL.md
```

`identity.md` / `SKILL.md` 是人类可读规范，`skills.json` 描述角色消费哪些技能。运行时代码通过 loader 编译这些声明式资产，不在角色或技能目录里放 `index.ts`。

## 当前内置小说团队

`@hanais/teammates` 当前内置一个小说创作团队，用于验证 agent team 编排能力：

- `novelist`：负责小说初稿、场景、人物行动和叙事冲突。
- `novel_editor`：负责剧情、动机、结构和文字表达审核。

小说团队启用：

- Team ReAct。
- final review。
- 显式 reviewer：`novel_editor`。
- 严格 review JSON。
- human input。
- peer-to-peer Act。
- 持久化历史运行。

## 验证策略

项目不只依赖真实模型输出验证。`@hanais/agent-team` 使用 deterministic fake runtime smoke 覆盖关键 orchestration：

- 系统角色资产加载。
- team_lead 规划后过滤 reviewer 和重复预排任务。
- review repair。
- blocked 后人工介入。
- 文件持久化。
- peer-to-peer Act loop。
- peer turn 和单轮消息上限。
- runtime failure 分类。

常用验证命令：

```bash
pnpm --filter @hanais/agent-team test
pnpm typecheck
pnpm -r build
```

## 设计原则

- 协议优先：关键执行状态进入 TypeScript 类型和 session state，不只写在 prompt 里。
- 角色清晰：系统角色、系统服务和用户 teammate 不混用。
- 审核前置：review gate 是执行循环的一部分，而不是结果附录。
- 人机协同：AI 无法可靠判断时，生成可持久化的人工介入请求。
- 可观测：GUI 要能看历史运行、事件、消息、队列、产物和最终结果。
- 可验证：用 fake runtime 验证编排逻辑，用真实 runtime 验证产品体验。

## 路线图

近期重点：

- 完整 resume/retry：从历史 run 恢复继续执行，而不仅是读取历史状态。
- 更强 review gate：多 reviewer、冲突仲裁、review evidence 和 artifact diff。
- GUI raw inspector：查看 session、events、messages、artifacts 原始数据。
- peer artifact delivery：让 peer loop 中的产物进入正式 artifacts。
- runtime 生命周期治理：cancel、heartbeat、预算、secret redaction、失败分类和 resume safety。
- CI fixture：把 smoke、类型检查和构建纳入稳定验证链路。

中长期方向：

- 多团队配置和可视化编辑。
- 更丰富的系统角色。
- 更细粒度权限和工具治理。
- 任务模板和组织级最佳实践沉淀。
- 面向团队推广的打包、文档和示例库。
