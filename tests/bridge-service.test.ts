import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeService } from "../src/app/bridge-service.js";
import type { ApprovalRequest, SessionSnapshot } from "../src/types/domain.js";

const makeSession = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  id: "tmux:taskA",
  runtimeState: "idle",
  recentMessages: [],
  pendingApprovals: [],
  activeApproval: null,
  ...overrides,
});

const makeApproval = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  requestId: "call-1",
  sessionId: "session-1",
  callId: "call-1",
  kind: "command",
  title: "命令执行需要确认",
  body: "$ mktemp /tmp/codex-approval.XXXXXX",
  createdAt: "2026-04-01T00:00:00.000Z",
  rawMethod: "session/exec_command_approval",
  command: "mktemp /tmp/codex-approval.XXXXXX",
  signature: "call-1",
  actions: [
    { key: "y", label: "允许一次" },
    { key: "Escape", label: "拒绝" },
  ],
  ...overrides,
});

interface BridgeServiceHarness {
  approvalResyncTimerByLinkedSessionId: Map<string, NodeJS.Timeout>;
  topicPanelSignatures: Map<string, string>;
  sessionIndex: {
    getSession: ReturnType<typeof vi.fn>;
  };
  tmux: {
    refreshSessionFacts: ReturnType<typeof vi.fn>;
    listSessions?: ReturnType<typeof vi.fn>;
  };
  telegram: {
    sendApprovalRequest: ReturnType<typeof vi.fn>;
    clearApprovalTracking: ReturnType<typeof vi.fn>;
    requestControlPanelSync: ReturnType<typeof vi.fn>;
    handleApprovalResolution: ReturnType<typeof vi.fn>;
    forwardSystemNotice?: ReturnType<typeof vi.fn>;
  };
  syncStructuredPanelsIfNeeded: ReturnType<typeof vi.fn>;
  handleStructuredApprovalUpdated(approval: ApprovalRequest): Promise<void>;
  handleStructuredSessionUpdated(session: SessionSnapshot): Promise<void>;
  handlePaneOpened(session: SessionSnapshot): Promise<void>;
  handlePaneChanged(session: SessionSnapshot): Promise<void>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BridgeService 结构化事件分发", () => {
  it("pending 审批会转发给已绑定结构化 session 的 tmux 目标", async () => {
    const sessions = [
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
        visibleApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
      }),
      makeSession({
        id: "tmux:taskB",
        linkedSessionId: null,
      }),
    ];

    const bridge = Object.create(BridgeService.prototype) as unknown as BridgeServiceHarness;
    bridge.approvalResyncTimerByLinkedSessionId = new Map();
    bridge.topicPanelSignatures = new Map();
    bridge.sessionIndex = {
      getSession: vi.fn(() => ({
        id: "session-1",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
        pendingApprovals: [makeApproval({ sessionId: "session-1", callId: "call-1" })],
      })),
    } as never;
    bridge.tmux = {
      refreshSessionFacts: vi.fn(() => sessions),
    } as never;
    bridge.telegram = {
      sendApprovalRequest: vi.fn(async () => undefined),
      clearApprovalTracking: vi.fn(),
      requestControlPanelSync: vi.fn(),
      handleApprovalResolution: vi.fn(),
    } as never;
    bridge.syncStructuredPanelsIfNeeded = vi.fn(async () => undefined);

    await bridge.handleStructuredApprovalUpdated(
      makeApproval({ status: "pending" }),
    );

    expect(bridge.tmux.refreshSessionFacts).toHaveBeenCalledWith("session-1");
    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledTimes(1);
    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "tmux:taskA",
        linkedSessionId: "session-1",
        callId: "call-1",
      }),
    );
    expect(bridge.telegram.requestControlPanelSync).not.toHaveBeenCalled();
    expect(bridge.syncStructuredPanelsIfNeeded).toHaveBeenCalledWith([sessions[0], sessions[1]]);
  });

  it("已解决审批会清理不再等待审批的 linked target", async () => {
    const sessions = [
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "idle",
      }),
      makeSession({
        id: "tmux:taskB",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
      }),
    ];

    const bridge = Object.create(BridgeService.prototype) as unknown as BridgeServiceHarness;
    bridge.approvalResyncTimerByLinkedSessionId = new Map();
    bridge.topicPanelSignatures = new Map();
    bridge.sessionIndex = {
      getSession: vi.fn(() => ({
        id: "session-1",
        activeApproval: null,
        pendingApprovals: [],
      })),
    } as never;
    bridge.tmux = {
      refreshSessionFacts: vi.fn(() => sessions),
    } as never;
    bridge.telegram = {
      sendApprovalRequest: vi.fn(async () => undefined),
      clearApprovalTracking: vi.fn(),
      requestControlPanelSync: vi.fn(),
      handleApprovalResolution: vi.fn(),
    } as never;
    bridge.syncStructuredPanelsIfNeeded = vi.fn(async () => undefined);

    await bridge.handleStructuredApprovalUpdated(
      makeApproval({ status: "approved" }),
    );

    expect(bridge.telegram.handleApprovalResolution).toHaveBeenCalledWith("tmux:taskA", "call-1");
    expect(bridge.telegram.sendApprovalRequest).not.toHaveBeenCalled();
    expect(bridge.telegram.clearApprovalTracking).toHaveBeenCalledTimes(1);
    expect(bridge.telegram.clearApprovalTracking).toHaveBeenCalledWith("tmux:taskA");
    expect(bridge.telegram.requestControlPanelSync).not.toHaveBeenCalled();
    expect(bridge.syncStructuredPanelsIfNeeded).toHaveBeenCalledWith(sessions);
  });

  it("存在多个待审批时，只会把当前 activeApproval 发到 TG", async () => {
    const sessions = [
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
        pendingApprovals: [
          makeApproval({ sessionId: "session-1", callId: "call-1" }),
          makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
          makeApproval({ sessionId: "session-1", callId: "call-3", requestId: "call-3" }),
        ],
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
        visibleApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
      }),
    ];

    const bridge = Object.create(BridgeService.prototype) as unknown as BridgeServiceHarness;
    bridge.approvalResyncTimerByLinkedSessionId = new Map();
    bridge.topicPanelSignatures = new Map();
    bridge.sessionIndex = {
      getSession: vi.fn(() => ({
        id: "session-1",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
        pendingApprovals: [
          makeApproval({ sessionId: "session-1", callId: "call-1" }),
          makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
          makeApproval({ sessionId: "session-1", callId: "call-3", requestId: "call-3" }),
        ],
      })),
    } as never;
    bridge.tmux = {
      refreshSessionFacts: vi.fn(() => sessions),
    } as never;
    bridge.telegram = {
      sendApprovalRequest: vi.fn(async () => undefined),
      clearApprovalTracking: vi.fn(),
      requestControlPanelSync: vi.fn(),
      handleApprovalResolution: vi.fn(),
    } as never;
    bridge.syncStructuredPanelsIfNeeded = vi.fn(async () => undefined);

    await bridge.handleStructuredApprovalUpdated(
      makeApproval({ sessionId: "session-1", callId: "call-3", requestId: "call-3", status: "pending" }),
    );

    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledTimes(1);
    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "tmux:taskA",
        linkedSessionId: "session-1",
        callId: "call-1",
      }),
    );
  });

  it("当前审批解决时，会先清理旧卡但不会在结构化事件阶段立刻推送下一张审批", async () => {
    const sessions = [
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
        pendingApprovals: [
          makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
        ],
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
      }),
    ];

    const bridge = Object.create(BridgeService.prototype) as unknown as BridgeServiceHarness;
    bridge.approvalResyncTimerByLinkedSessionId = new Map();
    bridge.topicPanelSignatures = new Map();
    bridge.sessionIndex = {
      getSession: vi.fn(() => ({
        id: "session-1",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
        pendingApprovals: [
          makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
        ],
      })),
    } as never;
    bridge.tmux = {
      refreshSessionFacts: vi.fn(() => sessions),
    } as never;
    bridge.telegram = {
      sendApprovalRequest: vi.fn(async () => undefined),
      clearApprovalTracking: vi.fn(),
      requestControlPanelSync: vi.fn(),
      handleApprovalResolution: vi.fn(),
    } as never;
    bridge.syncStructuredPanelsIfNeeded = vi.fn(async () => undefined);

    await bridge.handleStructuredApprovalUpdated(
      makeApproval({ sessionId: "session-1", callId: "call-1", requestId: "call-1", status: "approved" }),
    );

    expect(bridge.telegram.handleApprovalResolution).toHaveBeenCalledWith("tmux:taskA", "call-1");
    expect(bridge.telegram.sendApprovalRequest).not.toHaveBeenCalled();
  });

  it("pane 还没切到当前 activeApproval 时，不会提前把下一张审批发到 TG", async () => {
    const sessions = [
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
        visibleApproval: null,
      }),
    ];

    const bridge = Object.create(BridgeService.prototype) as unknown as BridgeServiceHarness;
    bridge.approvalResyncTimerByLinkedSessionId = new Map();
    bridge.topicPanelSignatures = new Map();
    bridge.sessionIndex = {
      getSession: vi.fn(() => ({
        id: "session-1",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
        pendingApprovals: [
          makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
        ],
      })),
    } as never;
    bridge.tmux = {
      refreshSessionFacts: vi.fn(() => sessions),
    } as never;
    bridge.telegram = {
      sendApprovalRequest: vi.fn(async () => undefined),
      clearApprovalTracking: vi.fn(),
      requestControlPanelSync: vi.fn(),
      handleApprovalResolution: vi.fn(),
    } as never;
    bridge.syncStructuredPanelsIfNeeded = vi.fn(async () => undefined);

    await bridge.handleStructuredSessionUpdated(
      makeSession({
        id: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
        pendingApprovals: [
          makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
        ],
      }),
    );

    expect(bridge.telegram.sendApprovalRequest).not.toHaveBeenCalled();
  });

  it("结构化 session 更新会刷新 linked pane 状态并在必要时清理旧审批跟踪", async () => {
    const sessions = [
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "idle",
      }),
      makeSession({
        id: "tmux:taskB",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
      }),
    ];

    const bridge = Object.create(BridgeService.prototype) as unknown as BridgeServiceHarness;
    bridge.approvalResyncTimerByLinkedSessionId = new Map();
    bridge.topicPanelSignatures = new Map();
    bridge.sessionIndex = {
      getSession: vi.fn(() => ({
        id: "session-1",
        activeApproval: null,
        pendingApprovals: [],
      })),
    } as never;
    bridge.tmux = {
      refreshSessionFacts: vi.fn(() => sessions),
    } as never;
    bridge.telegram = {
      sendApprovalRequest: vi.fn(async () => undefined),
      clearApprovalTracking: vi.fn(),
      requestControlPanelSync: vi.fn(),
      handleApprovalResolution: vi.fn(),
    } as never;
    bridge.syncStructuredPanelsIfNeeded = vi.fn(async () => undefined);

    await bridge.handleStructuredSessionUpdated(
      makeSession({
        id: "session-1",
        runtimeState: "active",
      }),
    );

    expect(bridge.tmux.refreshSessionFacts).toHaveBeenCalledWith("session-1");
    expect(bridge.telegram.clearApprovalTracking).toHaveBeenCalledTimes(2);
    expect(bridge.telegram.clearApprovalTracking).toHaveBeenNthCalledWith(1, "tmux:taskA");
    expect(bridge.telegram.clearApprovalTracking).toHaveBeenNthCalledWith(2, "tmux:taskB");
    expect(bridge.telegram.requestControlPanelSync).not.toHaveBeenCalled();
    expect(bridge.syncStructuredPanelsIfNeeded).toHaveBeenCalledWith(sessions);
  });

  it("linked pane 短暂离开审批画面时，只要结构化 session 仍在等待审批，就不会提前清掉 TG 跟踪", async () => {
    const sessions = [
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
        visibleApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
      }),
    ];

    const bridge = Object.create(BridgeService.prototype) as unknown as BridgeServiceHarness;
    bridge.approvalResyncTimerByLinkedSessionId = new Map();
    bridge.topicPanelSignatures = new Map();
    bridge.sessionIndex = {
      getSession: vi.fn(() => ({
        id: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
        pendingApprovals: [makeApproval({ sessionId: "session-1", callId: "call-1" })],
      })),
    } as never;
    bridge.tmux = {
      refreshSessionFacts: vi.fn(() => sessions),
      listSessions: vi.fn(() => sessions),
    } as never;
    bridge.telegram = {
      sendApprovalRequest: vi.fn(async () => undefined),
      clearApprovalTracking: vi.fn(),
      requestControlPanelSync: vi.fn(),
      handleApprovalResolution: vi.fn(),
      forwardSystemNotice: vi.fn(async () => undefined),
    } as never;
    bridge.syncStructuredPanelsIfNeeded = vi.fn(async () => undefined);

    await bridge.handlePaneChanged(
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "active",
      }),
    );

    expect(bridge.telegram.clearApprovalTracking).not.toHaveBeenCalled();
    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledTimes(1);
  });

  it("linked pane 切到下一张审批时，会按 pane 实际可见审批继续推送", async () => {
    const sessions = [
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
        visibleApproval: makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
      }),
    ];

    const bridge = Object.create(BridgeService.prototype) as unknown as BridgeServiceHarness;
    bridge.approvalResyncTimerByLinkedSessionId = new Map();
    bridge.topicPanelSignatures = new Map();
    bridge.sessionIndex = {
      getSession: vi.fn(() => ({
        id: "session-1",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
        pendingApprovals: [
          makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
        ],
      })),
    } as never;
    bridge.tmux = {
      refreshSessionFacts: vi.fn(() => sessions),
    } as never;
    bridge.telegram = {
      sendApprovalRequest: vi.fn(async () => undefined),
      clearApprovalTracking: vi.fn(),
      requestControlPanelSync: vi.fn(),
      handleApprovalResolution: vi.fn(),
    } as never;
    bridge.syncStructuredPanelsIfNeeded = vi.fn(async () => undefined);

    await bridge.handlePaneChanged(
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
      }),
    );

    expect(bridge.tmux.refreshSessionFacts).toHaveBeenCalledWith("session-1");
    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledTimes(1);
    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "tmux:taskA",
        linkedSessionId: "session-1",
        callId: "call-2",
      }),
    );
    expect(bridge.syncStructuredPanelsIfNeeded).toHaveBeenCalledWith(sessions);
  });

  it("linked pane 只有 tmux 本地审批时，也会回退发 TG 卡", async () => {
    const sessions = [
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: {
          requestId: "tmux:taskA:function: evaluate_script",
          sessionId: "tmux:taskA",
          linkedSessionId: "session-1",
          kind: "mcpElicitation",
          title: "MCP 工具授权待确认",
          body: "Allow the chrome_devtools MCP server to run tool \"evaluate_script\"?",
          createdAt: "2026-04-02T15:08:00.000Z",
          rawMethod: "tmux/paneApproval",
          signature: "function: evaluate_script",
          actions: [
            { key: "Enter", label: "允许" },
            { key: "DownEnter", label: "本会话允许" },
            { key: "DownDownEnter", label: "总是允许" },
            { key: "Escape", label: "取消" },
          ],
        },
        visibleApproval: {
          requestId: "tmux:taskA:function: evaluate_script",
          sessionId: "tmux:taskA",
          linkedSessionId: "session-1",
          kind: "mcpElicitation",
          title: "MCP 工具授权待确认",
          body: "Allow the chrome_devtools MCP server to run tool \"evaluate_script\"?",
          createdAt: "2026-04-02T15:08:00.000Z",
          rawMethod: "tmux/paneApproval",
          signature: "function: evaluate_script",
          actions: [
            { key: "Enter", label: "允许" },
            { key: "DownEnter", label: "本会话允许" },
            { key: "DownDownEnter", label: "总是允许" },
            { key: "Escape", label: "取消" },
          ],
        },
        pendingApprovals: [],
      }),
    ];

    const bridge = Object.create(BridgeService.prototype) as unknown as BridgeServiceHarness;
    bridge.approvalResyncTimerByLinkedSessionId = new Map();
    bridge.topicPanelSignatures = new Map();
    bridge.sessionIndex = {
      getSession: vi.fn(() => ({
        id: "session-1",
        activeApproval: null,
        pendingApprovals: [],
      })),
    } as never;
    bridge.tmux = {
      refreshSessionFacts: vi.fn(() => sessions),
    } as never;
    bridge.telegram = {
      sendApprovalRequest: vi.fn(async () => undefined),
      clearApprovalTracking: vi.fn(),
      requestControlPanelSync: vi.fn(),
      handleApprovalResolution: vi.fn(),
    } as never;
    bridge.syncStructuredPanelsIfNeeded = vi.fn(async () => undefined);

    await bridge.handlePaneChanged(
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
      }),
    );

    expect(bridge.tmux.refreshSessionFacts).toHaveBeenCalledWith("session-1");
    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledTimes(1);
    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "tmux:taskA",
        linkedSessionId: "session-1",
        rawMethod: "tmux/paneApproval",
        kind: "mcpElicitation",
      }),
    );
  });

  it("当前 pane 前台显示的是另一张 pending 时，会优先按前台那张发卡", async () => {
    const sessions = [
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
        pendingApprovals: [
          makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
          makeApproval({
            sessionId: "session-1",
            callId: "call-3",
            requestId: "call-3",
            command: "ps -p 1 -o pid,etime,command",
            signature: "call-3",
          }),
        ],
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
        visibleApproval: makeApproval({
          sessionId: "session-1",
          callId: "call-3",
          requestId: "call-3",
          command: "ps -p 1 -o pid,etime,command",
          signature: "call-3",
        }),
      }),
    ];

    const bridge = Object.create(BridgeService.prototype) as unknown as BridgeServiceHarness;
    bridge.approvalResyncTimerByLinkedSessionId = new Map();
    bridge.topicPanelSignatures = new Map();
    bridge.sessionIndex = {
      getSession: vi.fn(() => ({
        id: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
        pendingApprovals: [
          makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
          makeApproval({
            sessionId: "session-1",
            callId: "call-3",
            requestId: "call-3",
            command: "ps -p 1 -o pid,etime,command",
            signature: "call-3",
          }),
        ],
      })),
    } as never;
    bridge.tmux = {
      refreshSessionFacts: vi.fn(() => sessions),
    } as never;
    bridge.telegram = {
      sendApprovalRequest: vi.fn(async () => undefined),
      clearApprovalTracking: vi.fn(),
      requestControlPanelSync: vi.fn(),
      handleApprovalResolution: vi.fn(),
    } as never;
    bridge.syncStructuredPanelsIfNeeded = vi.fn(async () => undefined);

    await bridge.handleStructuredSessionUpdated(
      makeSession({
        id: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
        pendingApprovals: [
          makeApproval({ sessionId: "session-1", callId: "call-2", requestId: "call-2" }),
          makeApproval({
            sessionId: "session-1",
            callId: "call-3",
            requestId: "call-3",
            command: "ps -p 1 -o pid,etime,command",
            signature: "call-3",
          }),
        ],
      }),
    );

    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledTimes(1);
    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "tmux:taskA",
        linkedSessionId: "session-1",
        callId: "call-3",
      }),
    );
  });

  it("只有 1 张待审批且屏幕已进入审批态时，即使签名暂未匹配也会发当前卡", async () => {
    const sessions = [
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
        visibleApproval: null,
        screenPreview: [
          "Would you like to run the following command?",
          "$ mktemp /tmp/codex-approval.XXXXXX",
          "1. Yes, proceed (y)",
          "2. Yes, and don't ask again for commands that start with `mktemp` (p)",
          "3. No, and tell Codex what to do differently (esc)",
          "Press enter to confirm or esc to cancel",
        ].join("\n"),
      }),
    ];

    const bridge = Object.create(BridgeService.prototype) as unknown as BridgeServiceHarness;
    bridge.approvalResyncTimerByLinkedSessionId = new Map();
    bridge.topicPanelSignatures = new Map();
    bridge.sessionIndex = {
      getSession: vi.fn(() => ({
        id: "session-1",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
        pendingApprovals: [makeApproval({ sessionId: "session-1", callId: "call-1" })],
      })),
    } as never;
    bridge.tmux = {
      refreshSessionFacts: vi.fn(() => sessions),
    } as never;
    bridge.telegram = {
      sendApprovalRequest: vi.fn(async () => undefined),
      clearApprovalTracking: vi.fn(),
      requestControlPanelSync: vi.fn(),
      handleApprovalResolution: vi.fn(),
    } as never;
    bridge.syncStructuredPanelsIfNeeded = vi.fn(async () => undefined);

    await bridge.handleStructuredApprovalUpdated(
      makeApproval({ status: "pending" }),
    );

    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledTimes(1);
    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "tmux:taskA",
        linkedSessionId: "session-1",
        callId: "call-1",
      }),
    );
  });

  it("结构化 session 仍在等待审批时，不会因为 target 短暂 active 就清掉旧卡跟踪", async () => {
    const sessions = [
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "active",
      }),
    ];

    const bridge = Object.create(BridgeService.prototype) as unknown as BridgeServiceHarness;
    bridge.approvalResyncTimerByLinkedSessionId = new Map();
    bridge.topicPanelSignatures = new Map();
    bridge.sessionIndex = {
      getSession: vi.fn(() => ({
        id: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
        pendingApprovals: [makeApproval({ sessionId: "session-1", callId: "call-1" })],
      })),
    } as never;
    bridge.tmux = {
      refreshSessionFacts: vi.fn(() => sessions),
    } as never;
    bridge.telegram = {
      sendApprovalRequest: vi.fn(async () => undefined),
      clearApprovalTracking: vi.fn(),
      requestControlPanelSync: vi.fn(),
      handleApprovalResolution: vi.fn(),
    } as never;
    bridge.syncStructuredPanelsIfNeeded = vi.fn(async () => undefined);

    await bridge.handleStructuredSessionUpdated(
      makeSession({
        id: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
        pendingApprovals: [makeApproval({ sessionId: "session-1", callId: "call-1" })],
      }),
    );

    expect(bridge.telegram.clearApprovalTracking).not.toHaveBeenCalled();
  });

  it("首拍未对齐时，会在短周期重试后补发当前审批卡", async () => {
    vi.useFakeTimers();

    const initialSessions = [
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
        visibleApproval: null,
        screenPreview: "旧画面",
      }),
    ];
    const retriedSessions = [
      makeSession({
        id: "tmux:taskA",
        linkedSessionId: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
        visibleApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
      }),
    ];

    const bridge = Object.create(BridgeService.prototype) as unknown as BridgeServiceHarness;
    bridge.approvalResyncTimerByLinkedSessionId = new Map();
    bridge.topicPanelSignatures = new Map();
    bridge.sessionIndex = {
      getSession: vi.fn(() => ({
        id: "session-1",
        runtimeState: "waitingApproval",
        activeApproval: makeApproval({ sessionId: "session-1", callId: "call-1" }),
        pendingApprovals: [makeApproval({ sessionId: "session-1", callId: "call-1" })],
      })),
    } as never;
    bridge.tmux = {
      refreshSessionFacts: vi
        .fn()
        .mockReturnValueOnce(initialSessions)
        .mockReturnValueOnce(retriedSessions),
    } as never;
    bridge.telegram = {
      sendApprovalRequest: vi.fn(async () => undefined),
      clearApprovalTracking: vi.fn(),
      requestControlPanelSync: vi.fn(),
      handleApprovalResolution: vi.fn(),
    } as never;
    bridge.syncStructuredPanelsIfNeeded = vi.fn(async () => undefined);

    await bridge.handleStructuredApprovalUpdated(
      makeApproval({ status: "pending" }),
    );

    expect(bridge.telegram.sendApprovalRequest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(350);

    expect(bridge.tmux.refreshSessionFacts).toHaveBeenCalledTimes(2);
    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledTimes(1);
    expect(bridge.telegram.sendApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "tmux:taskA",
        linkedSessionId: "session-1",
        callId: "call-1",
      }),
    );
  });
});
