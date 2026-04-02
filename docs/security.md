# 安全边界

这个工具的默认定位不是“公开可交互机器人”，而是“你自己的私有远程控制面板”。

## 推荐前提

- 正式使用建议放在私人群里，并开启 forum topics
- 私聊更适合调试 bot、发现 `chatId/userId`
- 始终开启 `TELEGRAM_STRICT_SECURITY=true`
- 同时配置：
  - `TELEGRAM_ALLOWED_CHAT_IDS`
  - `TELEGRAM_ALLOWED_USER_IDS`
  - `TELEGRAM_CONTROL_CHAT_ID`

## 默认安全行为

### 启动前拦截

严格模式下，如果允许 chat、允许 user、总控 chat 三项配置不完整，bridge 会直接拒绝启动。

### 用户校验

收到 Telegram 消息后，bridge 会校验发送者是否在 `TELEGRAM_ALLOWED_USER_IDS` 中。

### chat 校验

bridge 会校验当前 chat 是否在允许列表中。未授权 chat 默认不能执行正常控制指令。

### 引导命令例外

以下引导命令允许在“尚未加入允许 chat 列表”的场景下使用，用于首次接入：

- `/start`
- `/chatinfo`
- `/setcontrol`
- `/groupready`
- 以及对应的中文意图命令

但即使是这些引导命令，发送者也仍然需要通过用户白名单校验。

## 运行时状态

bridge 会把部分运行时状态保存在 `.data/state.json`，包括：

- 当前总控 chat 覆盖值
- 运行时允许的 chat 覆盖值
- topic 绑定关系
- chat 的已选窗口和同步模式

这意味着：

- `/setcontrol` 不只是一次性动作，它会修改运行时持久状态
- 迁移到新环境时，不建议直接复用旧 `.data` 目录

## 明确不保证的事情

- 不适合公开群
- 不适合多用户协作控制同一个 bridge
- 不建议把私聊当成长期正式控制面
- 不提供细粒度 RBAC
- 不对 Telegram 侧内容做额外加密

## 公开发布前仍需人工确认

- 是否补充开源许可证
- 是否把 bot 默认中文文案改成更通用的多语言形式
- 是否需要把 `/setcontrol` 的行为再收紧，例如要求只能在私聊中执行首次绑定
