# 贡献说明

## 先决条件

- `Node.js >= 22`
- `pnpm`
- `tmux`
- 已安装并完成登录的 `codex`

## 开发环境

```bash
pnpm install
```

如果你只是想快速跑起本地 bridge，可以直接执行：

```bash
./scripts/install.sh
```

## 本地验证

下面这些命令不需要真实 Telegram token，也不依赖你本地的 `.env`：

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

测试环境会自动注入最小假配置。

## 需要真实 `.env` 的场景

只有在这些场景下，才需要配置真实 Telegram Bot token 和 allowlist：

- `pnpm dev`
- `pnpm start`
- `pnpm telegram:discover`
- `pnpm launchd:install`

建议先复制：

```bash
cp .env.example .env
```

然后至少填写：

```dotenv
TELEGRAM_BOT_TOKEN=
```

再通过 `pnpm telegram:discover` 获取 `chatId/userId`，最后补全 allowlist。

## 正式手工验证建议

正式推荐形态是“私人群 + forum topics”：

1. 把 bot 拉进目标群
2. 在群里发 `/chatinfo`
3. 在群里发 `/groupready`
4. 在群里发 `/setcontrol`
5. 再发“绑定最新窗口”

## 不要提交的内容

- `.env`
- `.data`
- 本机日志
- 任意 Telegram token / 用户数据 / 运行时状态文件
