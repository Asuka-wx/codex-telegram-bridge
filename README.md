# Codex Telegram Bridge

[中文](README.md) | [English](README.en.md)

把 macOS 上的 `tmux + Codex` 工作窗口，变成一个可以从 Telegram 远程接管的控制面。

一句话定位：

- 继续保持你原来的 `ssh + tmux + Codex` 工作流，只是在离开电脑时，用 Telegram 接住状态、审批和继续输入。

## 为什么值得用

- 不换工作流：你继续在本机用 `tmux + Codex`，不用改成浏览器面板或远程桌面
- 真正能远程继续：不只是看日志，还能继续发消息、处理中断、执行审批
- 多任务不混乱：用总控话题 + 任务子话题管理多个并行会话
- 手机上也能操作：适合外出、通勤、临时离开电脑时快速接住工作
- 安装门槛更低：支持一键安装脚本和 `launchd` 常驻

## 适合谁

- 已经在本机用 `tmux` 跑多个 Codex 会话的人
- 想在手机上接住审批、继续输入和查看状态的人
- 想要“私人控制面”，而不是远程桌面或通用机器人框架的人

## 你能做什么

- 查看当前活跃窗口和最近输出
- 把后续消息继续送进已有 tmux/Codex 窗口
- 收到状态变化和审批提示
- 在 Telegram 中完成常见确认动作

## 项目边界

- 当前只支持 `macOS`
- 当前工作流基于本机 `tmux`
- 当前依赖本机已安装 `codex`、`tmux`、`node`、`pnpm`
- 正式推荐形态是“私人群 + forum topics”
- 私聊更适合调试 bot、发现 `chatId/userId`，不建议作为长期正式控制面
- 当前 bot 默认交互文案是中文，但 slash 命令同样可用
- 这不是远程桌面，也不是通用 Telegram 机器人框架

## 当前能力

- 自动发现并跟踪 `tmux pane`
- 读取 `~/.codex/sessions` 辅助识别活跃会话
- 提供 Telegram 控制面、状态查看、窗口绑定、模式切换
- 支持把文本继续发送到已有 Codex pane
- 支持中断、常见控制键、审批类操作
- 在论坛群组中自动维护总控话题和任务子话题

## 快速开始

### 1. 一键安装

推荐直接执行：

```bash
./scripts/install.sh
```

这个安装脚本会做这些事：

- 自动检查 `tmux`、`node >= 22`、`pnpm`
- 在已安装 Homebrew 的前提下自动补齐缺失依赖
- 检查 `codex` CLI 是否存在
- 自动创建 `.env`
- 交互式写入 `TELEGRAM_BOT_TOKEN`
- 引导你运行 `telegram:discover`
- 自动 `pnpm install`
- 自动 `pnpm build`
- 在 Telegram allowlist 已补齐时自动安装 `launchd` 常驻服务

### 2. 一键安装的前提

- 当前只支持 `macOS`
- 建议已经安装 `Homebrew`
- 已安装并完成登录的 `codex` CLI
- 你已经创建好一个 Telegram Bot，并拿到了 token

说明：

- 如果脚本发现你还没补齐 `TELEGRAM_ALLOWED_CHAT_IDS` / `TELEGRAM_ALLOWED_USER_IDS` / `TELEGRAM_CONTROL_CHAT_ID`，它会先停在配置引导，不会强行用不安全配置启动 bridge
- 如果你只是想在仓库内手动执行，也可以用 `pnpm setup`

### 3. 手动路径

如果你不想用安装脚本，也可以按传统步骤手动执行：

```bash
pnpm install
cp .env.example .env
```

然后至少填写：

```bash
TELEGRAM_BOT_TOKEN=你的 bot token
```

再运行：

```bash
pnpm telegram:discover
```

接下来 60 秒内，在目标私人群里给 bot 发一条消息。脚本会打印：

- `chat id`
- `user id`
- `chat type`
- `chat title`
- `username`

把发现到的值回填到 `.env`：

```bash
TELEGRAM_ALLOWED_CHAT_IDS=
TELEGRAM_ALLOWED_USER_IDS=
TELEGRAM_CONTROL_CHAT_ID=
```

默认 `TELEGRAM_STRICT_SECURITY=true`。在严格模式下，如果上面三项不完整，bridge 会拒绝启动。

### 4. 手动启动

开发模式：

```bash
pnpm dev
```

构建后启动：

```bash
pnpm build
pnpm start
```

第一次正式跑 bridge 前，不建议跳过 `telegram:discover` 直接启动。先把 `chatId/userId` 配清楚，能明显减少“bot 在群里但命令不响应”的排查成本。

## 正式推荐流程

正式使用建议直接走“私人群 + forum topics”：

1. 把 bot 拉进目标群
2. 在群里发 `/chatinfo` 或直接发“当前信息”
3. 在群里发 `/groupready` 或“检查群准备”
4. 在群里发 `/setcontrol` 或“设为总控”
5. 再发“绑定最新窗口”

推荐保持 `TELEGRAM_ENABLE_FORUM_TOPICS=true`。这样 bridge 会自动维护总控话题和任务子话题，陌生用户也更容易理解“总控 vs 任务话题”的分工。

## 配置说明

完整环境变量说明见：

- [docs/configuration.md](docs/configuration.md)
- [docs/security.md](docs/security.md)

重点说明：

- `CODEX_SESSIONS_DIR` 默认是 `~/.codex/sessions`
- `BRIDGE_DATA_DIR` 默认是仓库目录下的 `.data`
- `TMUX_AUTO_BOOTSTRAP` 默认关闭
- `TMUX_BOOTSTRAP_SESSIONS` 和 `TMUX_BOOTSTRAP_LAYOUT` 默认留空，不会替你自动创建 `taskA/taskB`

## 安全模型

默认安全策略是“先锁死，再放行”：

- 默认开启 `TELEGRAM_STRICT_SECURITY=true`
- 正式使用建议把 bot 放在私人群里，而不是长期依赖私聊
- 建议同时配置 `TELEGRAM_ALLOWED_CHAT_IDS` 和 `TELEGRAM_ALLOWED_USER_IDS`
- 只有被允许的用户，才应该能把某个 chat 设为运行时总控
- 如果你关闭严格模式，任何能触达 bot 的人都有机会触发引导命令，这只适合隔离测试环境

更完整说明见 [docs/security.md](docs/security.md)。

## 可选：tmux bootstrap

如果你想在 bridge 启动时自动补齐固定 tmux session，可以在 `.env` 里显式开启：

```bash
TMUX_AUTO_BOOTSTRAP=true
PROJECT_ROOT=/Users/your-name/Dev
TMUX_BOOTSTRAP_SESSIONS=taskA,taskB
TMUX_BOOTSTRAP_LAYOUT=taskA:/Users/your-name/Dev/project-a,taskB:/Users/your-name/Dev/project-b
```

不配置这些变量时，bridge 不会主动创建 tmux session。

## 可选：launchd 常驻启动

项目内置了 macOS `launchd` 安装脚本，会根据你当前仓库实际路径生成 LaunchAgent 配置，不再依赖写死路径。

安装：

```bash
./scripts/install.sh
```

卸载：

```bash
./scripts/uninstall.sh
```

如果你只想移除 `launchd`，但保留本地依赖和配置：

```bash
pnpm setup:uninstall
```

如果你连 `.env`、`.data`、`dist`、`node_modules` 也想一起清掉：

```bash
./scripts/uninstall.sh --purge
```

对应脚本：

- [scripts/run-bridge.sh](scripts/run-bridge.sh)
- [scripts/bootstrap-tmux.sh](scripts/bootstrap-tmux.sh)
- [src/tools/install-launch-agent.ts](src/tools/install-launch-agent.ts)
- [src/tools/uninstall-launch-agent.ts](src/tools/uninstall-launch-agent.ts)

## 开发与验证

对贡献者来说：

- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`

这几项不需要真实 Telegram token，也不依赖你本地的 `.env`。测试环境会自动注入最小假配置。

真正运行 bridge、`telegram:discover`、`launchd:install` 这类命令时，才需要配置真实 `.env`。

如果你准备参与修改代码，建议再看一遍 [CONTRIBUTING.md](CONTRIBUTING.md)。

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```


- 是否要发布到 npm；如果要，`package.json` 还需要补全发布元信息
