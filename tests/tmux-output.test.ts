import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { SessionIndex } from "../src/codex/session-index.js";
import {
  assignLinkedSessionIds,
  buildControlSequence,
  extractApprovalActions,
  extractApprovalSignature,
  computeCaptureDelta,
  extractCodexFooterStatus,
  normalizeCaptureForOutput,
  shouldConfirmApprovalShortcut,
  splitTmuxFormatLine,
  TmuxService,
} from "../src/tmux/service.js";
import type { SessionSnapshot } from "../src/types/domain.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("tmux 输出归一化", () => {
  it("会忽略 Working 状态行和输入提示行", () => {
    const capture = [
      "真正的输出",
      "• Working (12s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
      "› Write tests for @filename",
      "gpt-5.4 xhigh fast · 88% left · ~/Dev · Main [default]",
    ].join("\n");

    expect(normalizeCaptureForOutput(capture)).toBe("真正的输出");
  });

  it("会忽略输入栏换行后的续行，避免把用户长句后半截当输出", () => {
    const capture = [
      "真正的输出",
      "› 这是一个很长很长的输入，前半句在这里",
      "  后半句被 tmux 自动换到了下一行",
      "  最后一段也还在输入栏里",
      "",
      "gpt-5.4 xhigh fast · 88% left · ~/Dev · Main [default]",
    ].join("\n");

    expect(normalizeCaptureForOutput(capture)).toBe("真正的输出");
  });

  it("会忽略底部状态栏上方整块输入区，避免本地删字触发 TG 连续推送", () => {
    const capture = [
      "真正的输出",
      "",
      "› 这是正在编辑中的长输入",
      "  第二行正在编辑",
      "  第三行正在编辑",
      "",
      "gpt-5.4 xhigh fast · 88% left · ~/Dev · Main [default]",
    ].join("\n");

    expect(normalizeCaptureForOutput(capture)).toBe("真正的输出");
  });

  it("会忽略缺少 Main [default] 尾巴的底部状态栏变体", () => {
    const capture = [
      "真正的输出",
      "",
      "› Improve documentation in @filename",
      "",
      "gpt-5.4 xhigh fast · 97% left · ~/Dev",
    ].join("\n");

    expect(normalizeCaptureForOutput(capture)).toBe("真正的输出");
  });

  it("不会误删真正的缩进输出内容", () => {
    const capture = [
      "第一行输出",
      "  这是正常的缩进正文",
      "  这是正文第二行",
    ].join("\n");

    expect(normalizeCaptureForOutput(capture)).toBe(capture);
  });
});

describe("tmux 输出增量计算", () => {
  it("不会因为 Working 秒数变化而产出新消息", () => {
    const previous = [
      "第一段真实输出",
      "• Working (1s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
    ].join("\n");
    const current = [
      "第一段真实输出",
      "• Working (2s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
    ].join("\n");

    expect(computeCaptureDelta(previous, current)).toBe("");
  });

  it("会在忽略 Working 状态行后保留真正新增的内容", () => {
    const previous = [
      "第一段真实输出",
      "• Working (1s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
    ].join("\n");
    const current = [
      "第一段真实输出",
      "第二段真实输出",
      "• Working (2s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
    ].join("\n");

    expect(computeCaptureDelta(previous, current).trim()).toBe("第二段真实输出");
  });

  it("窗口滑动时，不会把旧正文整段重发回 Telegram", () => {
    const previous = [
      "第一段",
      "第二段",
      "第三段",
    ].join("\n");
    const current = [
      "第二段",
      "第三段",
      "第四段",
    ].join("\n");

    expect(computeCaptureDelta(previous, current).trim()).toBe("第四段");
  });
});

describe("稳定槽位配置", () => {
  it("开源默认值下不预置 taskA/taskB 这类私有槽位", () => {
    expect(config.tmux.stableSessionNames.has("taskA")).toBe(false);
    expect(config.tmux.stableSessionNames.has("taskB")).toBe(false);
  });
});

describe("session-index 的 cwd 查询", () => {
  it("会返回同 cwd 的全部 session，并保持最新优先", () => {
    const newerUpdatedAt = new Date(Date.now() - 5_000).toISOString();
    const olderUpdatedAt = new Date(Date.now() - 10_000).toISOString();
    const otherUpdatedAt = new Date(Date.now() - 2_000).toISOString();

    const index = new SessionIndex();
    const writableIndex = index as unknown as {
      sessions: Map<string, SessionSnapshot>;
    };
    writableIndex.sessions = new Map<string, SessionSnapshot>([
      [
        "session-old",
        {
          id: "session-old",
          cwd: "/Users/tester/Dev/project-a",
          runtimeState: "idle",
          recentMessages: [],
          updatedAt: olderUpdatedAt,
        },
      ],
      [
        "session-new",
        {
          id: "session-new",
          cwd: "/Users/tester/Dev/project-a",
          runtimeState: "active",
          recentMessages: [],
          updatedAt: newerUpdatedAt,
        },
      ],
      [
        "session-other",
        {
          id: "session-other",
          cwd: "/Users/tester/Dev/project-b",
          runtimeState: "active",
          recentMessages: [],
          updatedAt: otherUpdatedAt,
        },
      ],
    ]);

    expect(index.findSessionsByCwd("/Users/tester/Dev/project-a").map((session) => session.id)).toEqual([
      "session-new",
      "session-old",
    ]);
  });
});

describe("tmux session 绑定分配", () => {
  const makeSession = (overrides: Partial<SessionSnapshot>): SessionSnapshot => ({
    id: "session-1",
    cwd: "/Users/tester/Dev/project-a",
    runtimeState: "active",
    recentMessages: [],
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  });

  it("同 cwd 的多个 pane 会优先分配到不同的 session", () => {
    const sessionsByCwd = new Map<string, SessionSnapshot[]>([
      [
        "/Users/tester/Dev/project-a",
        [
          makeSession({ id: "session-new", updatedAt: "2026-04-01T10:00:00.000Z" }),
          makeSession({ id: "session-old", updatedAt: "2026-04-01T09:00:00.000Z" }),
        ],
      ],
    ]);

    const result = assignLinkedSessionIds(
      [
        { paneKey: "tmux:taskA", cwd: "/Users/tester/Dev/project-a", previousLinkedSessionId: null },
        { paneKey: "tmux:taskB", cwd: "/Users/tester/Dev/project-a", previousLinkedSessionId: null },
      ],
      sessionsByCwd,
    );

    expect(result.get("tmux:taskA")).toBe("session-new");
    expect(result.get("tmux:taskB")).toBe("session-old");
  });

  it("候选不足时不会让多个 pane 共享同一个 session", () => {
    const sessionsByCwd = new Map<string, SessionSnapshot[]>([
      [
        "/Users/tester/Dev/project-a",
        [makeSession({ id: "session-only" })],
      ],
    ]);

    const result = assignLinkedSessionIds(
      [
        { paneKey: "tmux:taskA", cwd: "/Users/tester/Dev/project-a", previousLinkedSessionId: null },
        { paneKey: "tmux:taskB", cwd: "/Users/tester/Dev/project-a", previousLinkedSessionId: null },
      ],
      sessionsByCwd,
    );

    expect(result.get("tmux:taskA")).toBe("session-only");
    expect(result.get("tmux:taskB")).toBeNull();
  });

  it("同 cwd 存在测试遗留 pane 时，会优先把结构化 session 绑定到稳定槽位", () => {
    const makeSession = (overrides: Partial<SessionSnapshot>): SessionSnapshot => ({
      id: "session-1",
      cwd: "/Users/tester/Dev/codex-telegram-bridge",
      runtimeState: "active",
      recentMessages: [],
      updatedAt: "2026-04-01T00:00:00.000Z",
      ...overrides,
    });

    const sessionsByCwd = new Map<string, SessionSnapshot[]>([
      [
        "/Users/tester/Dev/codex-telegram-bridge",
        [makeSession({ id: "session-taskb" })],
      ],
    ]);

    const result = assignLinkedSessionIds(
      [
        {
          paneKey: "tmux:approvalProbe",
          cwd: "/Users/tester/Dev/codex-telegram-bridge",
          previousLinkedSessionId: null,
          preferStableSlot: false,
        },
        {
          paneKey: "tmux:taskB",
          cwd: "/Users/tester/Dev/codex-telegram-bridge",
          previousLinkedSessionId: null,
          preferStableSlot: true,
        },
      ],
      sessionsByCwd,
    );

    expect(result.get("tmux:taskB")).toBe("session-taskb");
    expect(result.get("tmux:approvalProbe")).toBeNull();
  });

  it("旧绑定 session 仍存在但已空闲时，会切到同 cwd 下更新且活跃的新 session", () => {
    const sessionsByCwd = new Map<string, SessionSnapshot[]>([
      [
        "/Users/tester/Dev",
        [
          makeSession({
            id: "session-current",
            cwd: "/Users/tester/Dev",
            runtimeState: "active",
            updatedAt: new Date().toISOString(),
          }),
          makeSession({
            id: "session-previous",
            cwd: "/Users/tester/Dev",
            runtimeState: "idle",
            updatedAt: "2026-04-02T14:14:46.995Z",
          }),
        ],
      ],
    ]);

    const result = assignLinkedSessionIds(
      [
        {
          paneKey: "tmux:taskB",
          cwd: "/Users/tester/Dev",
          previousLinkedSessionId: "session-previous",
        },
      ],
      sessionsByCwd,
    );

    expect(result.get("tmux:taskB")).toBe("session-current");
  });
});

describe("tmux 结构化事实水合", () => {
  it("已绑定结构化 session 时，会优先采用结构化消息和审批状态", () => {
    const indexStub = {
      getSession: () =>
        ({
          id: "session-structured",
          cwd: "/Users/tester/Dev/project-a",
          runtimeState: "waitingApproval",
          preview: "等待审批：mktemp /tmp/codex-approval.XXXXXX",
          recentMessages: [
            {
              id: "m1",
              sessionId: "session-structured",
              role: "assistant",
              text: "我先执行一个无害探针。",
              timestamp: "2026-04-01T10:00:00.000Z",
              source: "session_file",
              kind: "chat",
            },
          ],
          pendingApprovals: [
            {
              requestId: "call-1",
              sessionId: "session-structured",
              callId: "call-1",
              kind: "command",
              title: "命令执行需要确认",
              body: "Would you like to run the following command?\n$ mktemp /tmp/codex-approval.XXXXXX",
              createdAt: "2026-04-01T10:00:01.000Z",
              rawMethod: "session/exec_command_approval",
              command: "mktemp /tmp/codex-approval.XXXXXX",
              signature: "mktemp /tmp/codex-approval.XXXXXX",
            },
          ],
          activeApproval: {
            requestId: "call-1",
            sessionId: "session-structured",
            callId: "call-1",
            kind: "command",
            title: "命令执行需要确认",
            body: "Would you like to run the following command?\n$ mktemp /tmp/codex-approval.XXXXXX",
            createdAt: "2026-04-01T10:00:01.000Z",
            rawMethod: "session/exec_command_approval",
            command: "mktemp /tmp/codex-approval.XXXXXX",
            signature: "mktemp /tmp/codex-approval.XXXXXX",
          },
          latestTurnId: "turn-1",
        }) satisfies SessionSnapshot,
    } as unknown as SessionIndex;

    const service = new TmuxService(indexStub) as unknown as {
      panes: Map<string, SessionSnapshot>;
      refreshSessionFacts(linkedSessionId?: string): SessionSnapshot[];
    };

    service.panes = new Map([
      [
        "tmux:taskA",
        {
          id: "tmux:taskA",
          linkedSessionId: "session-structured",
          runtimeState: "idle",
          preview: "旧的 tmux 预览",
          recentMessages: [],
          screenPreview: [
            "Would you like to run the following command?",
            "$ mktemp /tmp/codex-approval.XXXXXX",
            "1. Yes, proceed (y)",
          ].join("\n"),
        },
      ],
    ]);

    const sessions = service.refreshSessionFacts("session-structured");
    expect(sessions[0]).toMatchObject({
      id: "tmux:taskA",
      runtimeState: "waitingApproval",
      preview: "我先执行一个无害探针。",
      latestTurnId: "turn-1",
    });
    expect(sessions[0]?.activeApproval?.callId).toBe("call-1");
    expect(sessions[0]?.pendingApprovals).toHaveLength(1);
    expect(sessions[0]?.recentMessages[0]?.role).toBe("assistant");
  });

  it("当前屏幕没显示审批时，会回退到结构化 activeApproval", () => {
    const indexStub = {
      getSession: () =>
        ({
          id: "session-structured",
          cwd: "/Users/tester/Dev/project-a",
          runtimeState: "waitingApproval",
          recentMessages: [],
          pendingApprovals: [
            {
              requestId: "call-2",
              sessionId: "session-structured",
              callId: "call-2",
              kind: "command",
              title: "命令执行需要确认",
              body: "$ touch /tmp/example",
              createdAt: "2026-04-01T10:05:00.000Z",
              rawMethod: "session/exec_command_approval",
              command: "touch /tmp/example",
              signature: "touch /tmp/example",
            },
          ],
          activeApproval: {
            requestId: "call-2",
            sessionId: "session-structured",
            callId: "call-2",
            kind: "command",
            title: "命令执行需要确认",
            body: "$ touch /tmp/example",
            createdAt: "2026-04-01T10:05:00.000Z",
            rawMethod: "session/exec_command_approval",
            command: "touch /tmp/example",
            signature: "touch /tmp/example",
          },
        }) satisfies SessionSnapshot,
    } as unknown as SessionIndex;

    const service = new TmuxService(indexStub) as unknown as {
      panes: Map<string, SessionSnapshot>;
      refreshSessionFacts(linkedSessionId?: string): SessionSnapshot[];
    };

    service.panes = new Map([
      [
        "tmux:taskB",
        {
          id: "tmux:taskB",
          linkedSessionId: "session-structured",
          runtimeState: "idle",
          preview: "旧的 tmux 预览",
          recentMessages: [],
          screenPreview: "普通输出，没有审批菜单",
        },
      ],
    ]);

    const sessions = service.refreshSessionFacts("session-structured");
    expect(sessions[0]?.activeApproval?.callId).toBe("call-2");
    expect(sessions[0]?.runtimeState).toBe("waitingApproval");
  });

  it("linked pane 只有本地 MCP 授权菜单时，也会水合成可投递审批", () => {
    const indexStub = {
      getSession: () =>
        ({
          id: "session-structured",
          cwd: "/Users/tester/Dev/project-a",
          runtimeState: "active",
          preview: "继续当前任务",
          recentMessages: [],
          pendingApprovals: [],
          activeApproval: null,
          latestTurnId: "turn-mcp-1",
        }) satisfies SessionSnapshot,
    } as unknown as SessionIndex;

    const service = new TmuxService(indexStub) as unknown as {
      panes: Map<string, SessionSnapshot>;
      refreshSessionFacts(linkedSessionId?: string): SessionSnapshot[];
    };

    service.panes = new Map([
      [
        "tmux:taskA",
        {
          id: "tmux:taskA",
          linkedSessionId: "session-structured",
          runtimeState: "idle",
          preview: "旧的 tmux 预览",
          recentMessages: [],
          updatedAt: "2026-04-02T15:08:00.000Z",
          screenPreview: [
            "Field 1/1",
            "Allow the chrome_devtools MCP server to run tool \"evaluate_script\"?",
            "",
            "function: () => Array.from(document.querySelectorAll('button'))",
            "",
            "› 1. Allow",
            "2. Allow for this session",
            "3. Always allow",
            "4. Cancel",
            "enter to submit | esc to cancel",
          ].join("\n"),
        },
      ],
    ]);

    const sessions = service.refreshSessionFacts("session-structured");
    expect(sessions[0]).toMatchObject({
      id: "tmux:taskA",
      runtimeState: "waitingApproval",
    });
    expect(sessions[0]?.activeApproval).toMatchObject({
      rawMethod: "tmux/paneApproval",
      kind: "mcpElicitation",
      linkedSessionId: "session-structured",
      signature:
        "function: () => Array.from(document.querySelectorAll('button'))",
    });
    expect(sessions[0]?.activeApproval?.actions).toEqual([
      { key: "Enter", label: "允许" },
      { key: "DownEnter", label: "本会话允许" },
      { key: "DownDownEnter", label: "总是允许" },
      { key: "Escape", label: "取消" },
    ]);
  });
});

describe("footer 状态提取", () => {
  it("会从完整 footer 中提取模型、上下文和目录", () => {
    const capture = [
      "正文",
      "gpt-5.4 xhigh fast · 97% left · ~/Dev · Main [default]",
    ].join("\n");

    expect(extractCodexFooterStatus(capture)).toEqual({
      modelLabel: "gpt-5.4 xhigh fast",
      contextLeft: "97% left",
      cwdLabel: "~/Dev",
      scopeLabel: "Main [default]",
    });
  });

  it("兼容没有 Main [default] 尾巴的 footer", () => {
    const capture = [
      "正文",
      "gpt-5.4 xhigh fast · 97% left · ~/Dev",
    ].join("\n");

    expect(extractCodexFooterStatus(capture)).toEqual({
      modelLabel: "gpt-5.4 xhigh fast",
      contextLeft: "97% left",
      cwdLabel: "~/Dev",
      scopeLabel: null,
    });
  });
});

describe("审批动作提取", () => {
  it("会从本地审批提示里提取 3 个真实动作", () => {
    const capture = [
      "Would you like to run the following command?",
      "Reason: harmless approval test",
      "$ ps -p 1 -o pid,ppid,command",
      "1. Yes, proceed (y)",
      "2. Yes, and don't ask again for commands that start with `ps -p` (p)",
      "3. No, and tell Codex what to do differently (esc)",
      "Press enter to confirm or esc to cancel",
      "› 1. Yes, proceed (y)",
    ].join("\n");

    expect(extractApprovalActions(capture)).toEqual([
      { key: "y", label: "允许一次" },
      { key: "p", label: "允许并记住" },
      { key: "Escape", label: "拒绝" },
    ]);
  });

  it("会兼容长选项换行后的审批菜单", () => {
    const capture = [
      "Would you like to run the following command?",
      "$ ps -p 1 -o pid,ppid,command",
      "1. Yes, proceed (y)",
      "2. Yes, and don't ask again for commands that start with",
      "   `ps -p` (p)",
      "3. No, and tell Codex what to do differently (esc)",
      "Press enter to confirm or esc to cancel",
      "› 1. Yes, proceed (y)",
    ].join("\n");

    expect(extractApprovalActions(capture)).toEqual([
      { key: "y", label: "允许一次" },
      { key: "p", label: "允许并记住" },
      { key: "Escape", label: "拒绝" },
    ]);
  });

  it("没有 › 当前选中行时，也能识别活跃审批块", () => {
    const capture = [
      "Would you like to run the following command?",
      "Reason: harmless approval test",
      "$ /bin/ps -p 1 -o pid,ppid,command",
      "1. Yes, proceed (y)",
      "2. Yes, and don't ask again for commands that start with `ps -p` (p)",
      "3. No, and tell Codex what to do differently (esc)",
      "Press enter to confirm or esc to cancel",
      "gpt-5.4 xhigh fast · 97% left · ~/Dev",
    ].join("\n");

    expect(extractApprovalActions(capture)).toEqual([
      { key: "y", label: "允许一次" },
      { key: "p", label: "允许并记住" },
      { key: "Escape", label: "拒绝" },
    ]);
    expect(extractApprovalSignature(capture)).toBe("$ /bin/ps -p 1 -o pid,ppid,command");
  });

  it("当前选中的是第 1 个选项时，也能提取完整 3 个动作", () => {
    const capture = [
      "Would you like to run the following command?",
      "Reason: harmless approval test",
      "$ /bin/ps -p 1 -o pid,ppid,command",
      "› 1. Yes, proceed (y)",
      "2. Yes, and don't ask again for commands that start with `ps -p` (p)",
      "3. No, and tell Codex what to do differently (esc)",
      "Press enter to confirm or esc to cancel",
      "gpt-5.4 xhigh fast · 97% left · ~/Dev",
    ].join("\n");

    expect(extractApprovalActions(capture)).toEqual([
      { key: "y", label: "允许一次" },
      { key: "p", label: "允许并记住" },
      { key: "Escape", label: "拒绝" },
    ]);
  });

  it("同一条审批在菜单细节变化时签名保持稳定", () => {
    const first = [
      "Would you like to run the following command?",
      "Reason: harmless approval test",
      "$ ps -p 1 -o pid,ppid,command",
      "1. Yes, proceed (y)",
      "2. Yes, and don't ask again for commands that start with `ps -p` (p)",
      "3. No, and tell Codex what to do differently (esc)",
      "› 1. Yes, proceed (y)",
    ].join("\n");
    const second = [
      "Would you like to run the following command?",
      "Reason: harmless approval test",
      "$ ps -p 1 -o pid,ppid,command",
      "1. Yes, proceed (y)",
      "2. Yes, and don't ask again for commands that start with",
      "   `ps -p` (p)",
      "3. No, and tell Codex what to do differently (esc)",
      "Press enter to confirm or esc to cancel",
      "› 2. Yes, and don't ask again for commands that start with `ps -p` (p)",
    ].join("\n");

    expect(extractApprovalSignature(first)).toBe(extractApprovalSignature(second));
  });

  it("滚动区里残留旧审批时，不会继续识别成当前审批", () => {
    const capture = [
      "Would you like to run the following command?",
      "$ ps -p 1 -o pid,ppid,command",
      "1. Yes, proceed (y)",
      "2. Yes, and don't ask again for commands that start with",
      "   `ps -p` (p)",
      "3. No, and tell Codex what to do differently (esc)",
      "Press enter to confirm or esc to cancel",
      "",
      "› Implement {feature}",
      "",
      "gpt-5.4 xhigh fast · 62% left · ~/Dev · Main [default]",
    ].join("\n");

    expect(extractApprovalActions(capture)).toEqual([]);
    expect(extractApprovalSignature(capture)).toBe("");
  });

  it("命令行发生换行时，也能提取完整稳定签名", () => {
    const capture = [
      "Would you like to run the following command?",
      "$ ps -p 1 -o user,pid,ppid,",
      "  command",
      "1. Yes, proceed (y)",
      "2. Yes, and don't ask again for commands that start with `ps -p` (p)",
      "3. No, and tell Codex what to do differently (esc)",
      "Press enter to confirm or esc to cancel",
    ].join("\n");

    expect(extractApprovalSignature(capture)).toBe(
      "$ ps -p 1 -o user,pid,ppid, command",
    );
  });

  it("会识别 MCP 工具授权菜单，并映射为可远程点击的动作", () => {
    const capture = [
      "Field 1/1",
      "Allow the chrome_devtools MCP server to run tool \"evaluate_script\"?",
      "",
      "function: () => Array.from(document.querySelectorAll('button'))",
      "",
      "› 1. Allow",
      "2. Allow for this session",
      "3. Always allow",
      "4. Cancel",
      "enter to submit | esc to cancel",
      "gpt-5.4 xhigh fast · 97% left · ~/Dev",
    ].join("\n");

    expect(extractApprovalSignature(capture)).toBe(
      "function: () => Array.from(document.querySelectorAll('button'))",
    );
    expect(extractApprovalActions(capture)).toEqual([
      { key: "Enter", label: "允许" },
      { key: "DownEnter", label: "本会话允许" },
      { key: "DownDownEnter", label: "总是允许" },
      { key: "Escape", label: "取消" },
    ]);
  });

  it("审批快捷键默认只发送单键，是否补 Enter 交给运行时判定", () => {
    expect(buildControlSequence("y")).toEqual(["y"]);
    expect(buildControlSequence("p")).toEqual(["p"]);
    expect(buildControlSequence("Escape")).toEqual(["Escape"]);
    expect(buildControlSequence("DownEnter")).toEqual(["Down", "Enter"]);
    expect(buildControlSequence("DownDownEnter")).toEqual(["Down", "Down", "Enter"]);
    expect(buildControlSequence("DownDownDownEnter")).toEqual([
      "Down",
      "Down",
      "Down",
      "Enter",
    ]);
  });

  it("只有快捷键后仍停留在同一张审批上时，才允许补发 Enter", () => {
    expect(shouldConfirmApprovalShortcut("y", "$ first", "$ first")).toBe(true);
    expect(shouldConfirmApprovalShortcut("p", "$ first", "$ first")).toBe(true);
    expect(shouldConfirmApprovalShortcut("y", "$ first", "$ second")).toBe(false);
    expect(shouldConfirmApprovalShortcut("y", "$ first", "")).toBe(false);
    expect(shouldConfirmApprovalShortcut("Escape", "$ first", "$ first")).toBe(false);
  });
});

describe("tmux 审批控制发送", () => {
  const makeApprovalCapture = (command: string): string =>
    [
      "Would you like to run the following command?",
      `$ ${command}`,
      "1. Yes, proceed (y)",
      "2. Yes, and don't ask again for commands that start with `mktemp` (p)",
      "3. No, and tell Codex what to do differently (esc)",
      "Press enter to confirm or esc to cancel",
      "gpt-5.4 xhigh fast · 97% left · ~/Dev",
    ].join("\n");

  const makePane = (): SessionSnapshot => ({
    id: "tmux:taskB",
    runtimeState: "waitingApproval",
    recentMessages: [],
    rawPaneId: "%1",
    codexAttached: true,
  });

  it("仍停留在同一张审批时，会补发 Enter 完成确认", async () => {
    vi.useFakeTimers();

    const capture = makeApprovalCapture("mktemp /tmp/first.XXXXXX");
    const service = new TmuxService(new SessionIndex()) as unknown as {
      panes: Map<string, SessionSnapshot>;
      sendControl(
        sessionId: string,
        key: "Enter" | "y" | "p" | "Escape" | "n" | "C-c",
      ): Promise<boolean>;
      ensurePaneReadyForInput: ReturnType<typeof vi.fn>;
      capturePane: ReturnType<typeof vi.fn>;
      tmux: ReturnType<typeof vi.fn>;
    };

    service.panes = new Map([["tmux:taskB", makePane()]]);
    service.ensurePaneReadyForInput = vi.fn(async () => undefined);
    service.capturePane = vi
      .fn()
      .mockResolvedValueOnce(capture)
      .mockResolvedValueOnce(capture);
    service.tmux = vi.fn(async () => "");

    const pending = service.sendControl("tmux:taskB", "y");
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(true);
    expect(service.tmux).toHaveBeenNthCalledWith(1, [
      "send-keys",
      "-t",
      "%1",
      "y",
    ]);
    expect(service.tmux).toHaveBeenNthCalledWith(2, [
      "send-keys",
      "-t",
      "%1",
      "Enter",
    ]);
  });

  it("快捷键后如果已经切到下一张审批，不会再补发 Enter", async () => {
    vi.useFakeTimers();

    const firstCapture = makeApprovalCapture("mktemp /tmp/first.XXXXXX");
    const secondCapture = makeApprovalCapture("mktemp /tmp/second.XXXXXX");
    const service = new TmuxService(new SessionIndex()) as unknown as {
      panes: Map<string, SessionSnapshot>;
      sendControl(
        sessionId: string,
        key: "Enter" | "y" | "p" | "Escape" | "n" | "C-c",
      ): Promise<boolean>;
      ensurePaneReadyForInput: ReturnType<typeof vi.fn>;
      capturePane: ReturnType<typeof vi.fn>;
      tmux: ReturnType<typeof vi.fn>;
    };

    service.panes = new Map([["tmux:taskB", makePane()]]);
    service.ensurePaneReadyForInput = vi.fn(async () => undefined);
    service.capturePane = vi
      .fn()
      .mockResolvedValueOnce(firstCapture)
      .mockResolvedValueOnce(secondCapture);
    service.tmux = vi.fn(async () => "");

    const pending = service.sendControl("tmux:taskB", "y");
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(true);
    expect(service.tmux).toHaveBeenCalledTimes(1);
    expect(service.tmux).toHaveBeenCalledWith([
      "send-keys",
      "-t",
      "%1",
      "y",
    ]);
  });
});

describe("tmux 元信息解析", () => {
  it("优先兼容 bridge 自己的固定分隔符", () => {
    const line = "taskA__CODEX_BRIDGE_FIELD__1__CODEX_BRIDGE_FIELD__1";

    expect(splitTmuxFormatLine(line)).toEqual(["taskA", "1", "1"]);
  });

  it("兼容 launchd 下可能出现的字面量 \\t 分隔", () => {
    const line = "taskA\\t1\\t1\\t%1\\t/Users/tester/Dev\\tnode\\t123\\t1\\t1\\t0";

    expect(splitTmuxFormatLine(line)).toEqual([
      "taskA",
      "1",
      "1",
      "%1",
      "/Users/tester/Dev",
      "node",
      "123",
      "1",
      "1",
      "0",
    ]);
  });
});
