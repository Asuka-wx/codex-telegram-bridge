# Codex Telegram Bridge

[中文](README.md) | [English](README.en.md)

Turn local `tmux + Codex` sessions on macOS into a Telegram control surface you can actually use from your phone.

One-line positioning:

- Keep your existing `ssh + tmux + Codex` workflow, and use Telegram only as the remote layer for status, approvals, and follow-up input.

## Why It Matters

- No workflow rewrite: keep using local `tmux + Codex` instead of switching to a browser dashboard or remote desktop
- Actually remote-usable: not just logs, but approvals, interrupts, and follow-up input
- Clear multi-task control: one control topic plus task-specific topics for parallel work
- Phone-friendly by design: useful when you are away from your machine but still need to keep work moving
- Lower setup friction: one-command installer plus `launchd` service support

## Who It Is For

- people already running multiple Codex sessions in local `tmux`
- people who want to handle approvals, status checks, and follow-up input from Telegram
- people who want a private control surface, not a remote desktop and not a general bot framework

## What You Can Do

- check active windows and recent output
- continue existing Codex sessions from Telegram
- receive status changes and approval prompts
- handle common confirmation actions from a phone or another device

## Scope

- macOS only
- Built around local `tmux`
- Requires local `codex`, `tmux`, `node`, and `pnpm`
- Recommended deployment model: private Telegram group + forum topics
- Private chat is useful for bootstrapping and debugging, but not the preferred long-term control surface
- The default bot UI is currently Chinese, but slash commands are available
- This is not a remote desktop and not a general Telegram bot framework

## Current Capabilities

- auto-discover and track `tmux` panes
- read `~/.codex/sessions` to recover active session facts
- Telegram control panel, status view, binding, and mode switching
- send follow-up text into existing Codex panes
- interrupt, common control keys, and approval actions
- automatically maintain a control topic and task-specific topics in forum groups

## Quick Start

### 1. One-command setup

Recommended:

```bash
./scripts/install.sh --lang en
```

The installer will:

- check `tmux`, `node >= 22`, and `pnpm`
- install missing dependencies through Homebrew when possible
- check whether the `codex` CLI exists
- create `.env`
- prompt for `TELEGRAM_BOT_TOKEN`
- guide you through `telegram:discover`
- run `pnpm install`
- run `pnpm build`
- install the `launchd` service automatically if the Telegram allowlist is complete

### 2. Prerequisites

- macOS
- Homebrew recommended
- `codex` CLI already installed and logged in
- a Telegram Bot token

Notes:

- if the script detects that `TELEGRAM_ALLOWED_CHAT_IDS`, `TELEGRAM_ALLOWED_USER_IDS`, or `TELEGRAM_CONTROL_CHAT_ID` are still missing, it will stop at the configuration step instead of starting the bridge insecurely
- you can also run `pnpm setup`, but `./scripts/install.sh --lang en` is the best path for first-time users

### 3. Manual path

If you prefer the manual route:

```bash
pnpm install
cp .env.example .env
```

Then fill at least:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token
```

Then run:

```bash
pnpm telegram:discover
```

Within 60 seconds, send one message to the bot in your target private group or private chat. The script will print:

- `chat id`
- `user id`
- `chat type`
- `chat title`
- `username`

Then write the discovered values back into `.env`:

```bash
TELEGRAM_ALLOWED_CHAT_IDS=
TELEGRAM_ALLOWED_USER_IDS=
TELEGRAM_CONTROL_CHAT_ID=
```

With `TELEGRAM_STRICT_SECURITY=true`, the bridge refuses to start until these values are complete.

### 4. Manual start

Development:

```bash
pnpm dev
```

Build and start:

```bash
pnpm build
pnpm start
```

Do not skip `telegram:discover` before your first real run. Getting `chatId/userId` right first saves a lot of debugging time.

## Recommended Operating Flow

Recommended production-style flow:

1. add the bot to your target private group
2. send `/chatinfo` or the Chinese phrase `当前信息`
3. send `/groupready` or the Chinese phrase `检查群准备`
4. send `/setcontrol` or the Chinese phrase `设为总控`
5. send the Chinese phrase `绑定最新窗口`

It is recommended to keep `TELEGRAM_ENABLE_FORUM_TOPICS=true`, so the bridge can maintain a control topic plus task-specific topics automatically.

## Configuration

See:

- [docs/configuration.md](docs/configuration.md)
- [docs/security.md](docs/security.md)

Important defaults:

- `CODEX_SESSIONS_DIR` defaults to `~/.codex/sessions`
- `BRIDGE_DATA_DIR` defaults to `.data` under the repository root
- `TMUX_AUTO_BOOTSTRAP` is disabled by default
- `TMUX_BOOTSTRAP_SESSIONS` and `TMUX_BOOTSTRAP_LAYOUT` are empty by default, so the bridge will not create fixed sessions automatically

## Security Model

Default security posture: lock first, then explicitly allow.

- `TELEGRAM_STRICT_SECURITY=true` by default
- recommended usage is a private group, not a long-term private-chat-only control surface
- configure both `TELEGRAM_ALLOWED_CHAT_IDS` and `TELEGRAM_ALLOWED_USER_IDS`
- only allowed users should be able to set a chat as the runtime control chat
- disabling strict mode is only suitable for isolated testing

See [docs/security.md](docs/security.md) for details.

## Optional: tmux bootstrap

If you want the bridge to create fixed `tmux` sessions at startup, explicitly enable it in `.env`:

```bash
TMUX_AUTO_BOOTSTRAP=true
PROJECT_ROOT=/Users/your-name/Dev
TMUX_BOOTSTRAP_SESSIONS=taskA,taskB
TMUX_BOOTSTRAP_LAYOUT=taskA:/Users/your-name/Dev/project-a,taskB:/Users/your-name/Dev/project-b
```

If you leave these variables empty, the bridge will not create sessions automatically.

## Optional: launchd service

Install:

```bash
./scripts/install.sh --lang en
```

Uninstall:

```bash
./scripts/uninstall.sh
```

If you only want to remove the `launchd` service but keep local files:

```bash
pnpm setup:uninstall
```

If you also want to remove `.env`, `.data`, `dist`, and `node_modules`:

```bash
./scripts/uninstall.sh --purge
```

## Development and Verification

For contributors:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

These do not require a real Telegram token or a real local `.env`.

- once the repository metadata is stable, fill in `repository`, `homepage`, and `bugs` in `package.json`
