# 配置说明

这个项目默认通过仓库根目录下的 `.env` 读取配置。

## 必填项

### `TELEGRAM_BOT_TOKEN`

你的 Telegram Bot token。

补充说明：

- 运行 bridge、`telegram:discover`、`launchd:install` 这类命令时需要真实值
- `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm build` 不需要真实 token

### `TELEGRAM_ALLOWED_CHAT_IDS`

允许操作 bridge 的 chat id 列表，多个值用英文逗号分隔。

示例：

```dotenv
TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890,123456789
```

### `TELEGRAM_ALLOWED_USER_IDS`

允许操作 bridge 的 Telegram user id 列表，多个值用英文逗号分隔。

### `TELEGRAM_CONTROL_CHAT_ID`

默认总控 chat id。严格模式下未配置会拒绝启动。

## 安全相关

### `TELEGRAM_STRICT_SECURITY`

- 默认值：`true`
- 含义：开启后，bridge 启动前必须拿到允许 chat、允许 user、总控 chat 三项配置

### `TELEGRAM_ENABLE_FORUM_TOPICS`

- 默认值：`true`
- 含义：允许 bridge 在论坛群中维护总控话题和任务子话题
- 正式推荐：保持 `true`，把私人群 + forum topics 作为主要使用形态

### `TELEGRAM_CONTROL_TOPIC_NAME`

- 默认值：`总控`
- 含义：论坛群里总控话题的显示名称

## 运行行为

### `TELEGRAM_MESSAGE_MAX_LENGTH`

- 默认值：`3500`
- 含义：单条 Telegram 消息上限，必须是大于 0 的整数

### `SESSION_ACTIVITY_WINDOW_SECONDS`

- 默认值：`45`
- 含义：Codex session 与 tmux pane 做活跃匹配时使用的时间窗口

## 路径相关

### `CODEX_BIN`

- 默认值：`codex`
- 含义：Codex CLI 可执行文件名或绝对路径

### `CODEX_SESSIONS_DIR`

- 默认值：`~/.codex/sessions`
- 含义：bridge 读取 Codex 会话文件的目录

### `BRIDGE_DATA_DIR`

- 默认值：仓库目录下的 `.data`
- 含义：bridge 的状态文件、锁文件、launchd 日志目录

### `PROJECT_ROOT`

- 默认值：仓库父目录
- 含义：tmux bootstrap 在未显式指定路径时的默认工作目录

## tmux bootstrap

默认关闭，只有在你显式开启后，bridge 才会尝试补齐固定 tmux session。

### `TMUX_AUTO_BOOTSTRAP`

- 默认值：`false`
- 含义：是否在启动时自动创建缺失的 tmux session

### `TMUX_BOOTSTRAP_SESSIONS`

- 默认值：空
- 含义：逗号分隔的 tmux session 名称列表

示例：

```dotenv
TMUX_BOOTSTRAP_SESSIONS=taskA,taskB
```

### `TMUX_BOOTSTRAP_LAYOUT`

- 默认值：空
- 含义：`session:/absolute/path` 形式的逗号分隔列表
- 优先级：如果配置了它，会覆盖 `TMUX_BOOTSTRAP_SESSIONS`

示例：

```dotenv
TMUX_BOOTSTRAP_LAYOUT=taskA:/Users/your-name/Dev/project-a,taskB:/Users/your-name/Dev/project-b
```

如果某个路径不存在，bootstrap 脚本会回退到：

1. `PROJECT_ROOT`
2. `HOME`
3. 当前目录
