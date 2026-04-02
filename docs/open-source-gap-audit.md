# 开源差距审计

更新时间：2026-04-02

这份文档只对比两个目录的当前状态：

- 稳定参照版：`../codex-telegram-bridge`
- 当前开源版：当前仓库

目标不是机械追求“完全一致”，而是找出哪些差异会直接伤害开源发布质量、用户体验和后续口碑。

## 当前结论

- 当前仓库已经完成两轮开源清理，最明显的是去掉了作者机器路径、默认 `taskA/taskB` 槽位、写死 `HOME` 等私有假设，并恢复了 `SessionIndex` 的结构化事实解析。
- 但当前仓库还没有达到“可以直接公开”的质量线。主要问题已经收敛到 bridge / tmux 这一层的结构化联动能力，以及公开仓库卫生文件仍未补齐。
- 结论上，后续工作应先做“能力恢复 + 基线收绿”，再做“社区包装 + 发布”。

## 已完成的开源清理

### 1. 运行时路径不再写死作者环境

- `scripts/run-bridge.sh` 改成按当前仓库路径推导 `BRIDGE_ROOT` 和默认工作区根目录，并保留现有 `PATH`，不再写死某台作者机器的 `HOME` 路径。
- `scripts/bootstrap-tmux.sh` 默认不再自动创建 `taskA/taskB`，并增加了路径回退逻辑。
- `.env.example` 把 `PROJECT_ROOT`、`TMUX_BOOTSTRAP_*` 改成留空的可选项。
- LaunchAgent 标签改成中性命名，不再使用作者身份痕迹。

### 2. 配置校验更适合公开仓库

- `src/config.ts` 增加了整数校验。
- 测试环境支持最小假 token。
- `BRIDGE_DATA_DIR`、`PROJECT_ROOT`、`CODEX_SESSIONS_DIR` 支持更通用的解析策略。

### 3. 面向外部用户的文档已经有基础

- `README.md`
- `CONTRIBUTING.md`
- `docs/configuration.md`
- `docs/security.md`

这说明当前仓库并不是“毛坯”，而是已经开始朝开源交付物靠拢。

## P0：发布前必须处理的能力回退

### 1. `SessionIndex` 结构化事实层已恢复，但下游还没完全接回去

当前开源版已经重新支持这些结构化事件：

- `turn_context`
- `response_item`
- `event_msg.exec_command_end`
- 审批队列与 `activeApproval`
- 命令输出形成结构化 tool message

当前真正缺的是下游消费层还没有充分利用这些事实。

涉及文件：

- `src/codex/session-index.ts`
- `tests/session-index.test.ts`

### 2. `BridgeService` 不再消费结构化审批更新

稳定参照版会监听：

- `sessionUpdated`
- `approvalUpdated`

并在结构化会话与 tmux 槽位之间做联动同步，避免 Telegram 过早或错误地发送审批卡片。

当前开源版只监听：

- `sessionMessage`
- tmux 的 `approvalRequested`
- tmux 的 `paneOutput`

直接影响：

- linked session 的审批状态主要退回到 tmux 屏幕解析
- Telegram 面板和审批提示更容易出现“事实滞后于屏幕”的问题

涉及文件：

- `src/app/bridge-service.ts`
- `tests/bridge-service.test.ts` 在当前开源版中已缺失

### 3. `TmuxService` 失去了结构化审批水合与降噪逻辑

稳定参照版的 `TmuxService` 还包含这些能力：

- `hydratePaneSnapshot`
- `visibleApproval`
- `pendingApprovals`
- `activeApproval`
- 只在需要时使用 tmux fallback
- 稳定槽位优先匹配
- 审批出现时抑制普通输出泄漏

当前开源版仍能从屏幕里提取审批菜单，但更多依赖“看见什么就发什么”，缺少和结构化事实的联动。

直接影响：

- 审批串行链路更脆弱
- 输出与审批可能互相污染
- 复杂场景下更容易出现重复通知或错误 target

涉及文件：

- `src/tmux/service.ts`
- `tests/tmux-output.test.ts`
- `tests/approval-queue.test.ts` 在当前开源版中已缺失

### 4. 测试覆盖明显收缩

和稳定参照版相比，当前开源版已经移除了多组关键测试：

- `tests/approval-queue.test.ts`
- `tests/bridge-service.test.ts`
- `tests/session-index.test.ts` 中的大部分结构化恢复场景
- `tests/tmux-output.test.ts` 中的大部分 linked approval / fallback 场景

这不是发布包装问题，而是质量护栏变弱了。

## P1：应尽快收尾的开源清理项

### 1. 示例里仍会出现 `taskA/taskB`

这在 README 和部分测试名里仍然会出现，但现在已经不再作为默认交互文案。

涉及文件：

- `README.md`
- `tests/tmux-output.test.ts`

建议：

- 示例里保留 `taskA/taskB` 作为例子即可，不要写成默认前提

### 2. 依赖清理已进入收尾

- 未使用的 `chokidar` 依赖已经移除
- 后续只需要继续留意是否还有类似“原版遗留但开源版已不用”的包

## P2：公开仓库卫生与发布资产

### 1. 许可证与社区文件已补齐

- `LICENSE`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `.github/ISSUE_TEMPLATE`
- `pull_request_template.md`

这部分已经满足公开仓库的基础卫生要求。

### 2. npm 发布尚未准备好

当前 `package.json` 仍是：

- `"private": true`

如果后续要发 npm，还需要补这些元信息：

- `license`
- `repository`
- `homepage`
- `bugs`
- `files`
- 必要时补 `bin` 或更清晰的安装/运行方式

### 3. 仍可继续补传播材料

如果目标是“获取名气和经济奖励”，建议后续补：

- 一张总控话题 + 任务子话题的示意图
- 一段 30-60 秒 GIF 或短视频
- 一组“为什么不是远程桌面，而是 Telegram 控制面”的定位文案

## 建议的执行顺序

1. 先恢复 `BridgeService`、`TmuxService` 对结构化事实的联动能力。
2. 把测试补回关键场景，至少恢复审批链路和 linked session 的核心覆盖。
3. 再清理剩余示例化私有语境与未使用依赖。
4. 最后补传播素材与仓库展示内容。

## 发布决策建议

- 许可证优先建议：`MIT`
- 分发优先建议：先发 GitHub，再决定是否发 npm

原因：

- 先把采用门槛降到最低，更符合当前“先拿传播和口碑”的目标
- npm 可以后补，但能力缩水版一旦公开，负面第一印象很难修复

## 参考资料

- GitHub License：
  https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-license-to-a-repository
- GitHub Community Profile：
  https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories
- npm Publish：
  https://docs.npmjs.com/cli/v11/commands/npm-publish/
