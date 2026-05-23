# hanais

Agent teams prototype.

## Packages

- `@hanais/agent-team`: team 编排核心，包含内置 `team_lead`、受控 `外包-xxx` contractor、角色实例、事件和 session 模型。
- `@hanais/agent-runtimes`: runtime adapter，目前包含 Codex CLI 和 Claude Agent SDK。
- `@hanais/teammates`: 示例角色和技能包，目前包含小说作者与小说编辑。
- `@hanais/gui`: Electron + React 验证客户端。

## Commands

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm gui:dev
pnpm gui:start
```

本地验证优先使用 Codex CLI。Codex CLI 可能出现重连和长时间等待，所以 runtime adapter 默认给了较长超时。

GUI 开发使用：

```bash
pnpm gui:dev
```

这个命令会启动 Vite dev server，并让 Electron 加载 `http://127.0.0.1:5173`，renderer 支持热更新。
如需自动打开 DevTools：

```bash
HANAIS_OPEN_DEVTOOLS=1 pnpm gui:dev
```

生产构建后启动使用：

```bash
pnpm gui:build
pnpm gui:start
```

## Kimi / Claude Agent SDK

项目支持通过 Claude Agent SDK 使用 Kimi 的 Anthropic-compatible endpoint。密钥不要提交到 Git，放到项目根目录 `.env.local`：

```bash
KIMI_API_KEY=your-local-key
KIMI_BASE_URL=https://api.moonshot.cn/anthropic
KIMI_MODEL=kimi-k2.5
```

GUI 里选择 `Claude SDK + Kimi` 即可走这个 runtime。

## Role And Skill Layout

角色和技能按目录定义：

```text
packages/teammates/src/
  roles/
    novelist/
      ROLE.md
      index.ts
  skills/
    story-drafting/
      SKILL.md
      index.ts
```

`ROLE.md` / `SKILL.md` 是人类可读规范，`index.ts` 导出运行时消费的定义对象。

如果 Electron binary 下载卡住，可以先用下面命令完成源码依赖安装和构建：

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install
pnpm build
```

之后需要启动桌面客户端时，再单独执行：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm --filter @hanais/gui rebuild electron
pnpm gui:start
```
