import { describe, expect, it } from "vitest";

import {
  hasStructuredApprovalWaiting,
  hasTmuxFallbackApproval,
  selectLinkedApprovalForTarget,
} from "../src/approval/linked-approval.js";
import type { ApprovalRequest, SessionSnapshot } from "../src/types/domain.js";

const createApproval = (
  requestId: string,
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest => ({
  requestId,
  sessionId: "session-1",
  callId: requestId,
  kind: "command",
  title: "命令执行需要确认",
  body: "$ mktemp /tmp/a",
  createdAt: "2026-04-01T00:00:00.000Z",
  rawMethod: "exec_command",
  command: "mktemp /tmp/a",
  signature: "mktemp /tmp/a",
  actions: [
    { key: "y", label: "允许一次" },
    { key: "Escape", label: "拒绝" },
  ],
  ...overrides,
});

const createSession = (
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot => ({
  id: "tmux:taskA",
  linkedSessionId: "session-1",
  runtimeState: "idle",
  recentMessages: [],
  pendingApprovals: [],
  activeApproval: null,
  visibleApproval: null,
  screenPreview: "",
  ...overrides,
});

describe("linked approval selection", () => {
  it("没有结构化审批时，会回退选择 tmux fallback 审批", () => {
    const fallbackApproval = createApproval("fallback-1", {
      sessionId: "tmux:taskA",
      callId: undefined,
      rawMethod: "tmux/paneApproval",
      signature: "$ mktemp /tmp/a",
      command: undefined,
    });

    expect(
      selectLinkedApprovalForTarget(
        undefined,
        createSession({
          runtimeState: "waitingApproval",
          activeApproval: fallbackApproval,
          visibleApproval: fallbackApproval,
        }),
      ),
    ).toEqual({
      kind: "fallback",
      approval: fallbackApproval,
    });
  });

  it("pane 前台显示结构化审批时，会选择当前可见那张", () => {
    const activeApproval = createApproval("call-1");
    const visibleApproval = createApproval("call-2", {
      command: "mktemp /tmp/b",
      signature: "mktemp /tmp/b",
      body: "$ mktemp /tmp/b",
    });
    const structuredSession = createSession({
      id: "session-1",
      runtimeState: "waitingApproval",
      activeApproval,
      pendingApprovals: [activeApproval, visibleApproval],
    });

    const result = selectLinkedApprovalForTarget(
      structuredSession,
      createSession({
        runtimeState: "waitingApproval",
        visibleApproval,
      }),
    );

    expect(result).toMatchObject({
      kind: "structured",
      approval: visibleApproval,
      activeApproval,
      paneVisibleDiffersFromStructuredActive: true,
    });
  });

  it("前台还没切到审批时，会返回 pane_not_aligned", () => {
    const activeApproval = createApproval("call-1");
    const structuredSession = createSession({
      id: "session-1",
      runtimeState: "waitingApproval",
      activeApproval,
      pendingApprovals: [activeApproval],
    });

    expect(
      selectLinkedApprovalForTarget(
        structuredSession,
        createSession({
          runtimeState: "active",
          screenPreview: "普通输出",
        }),
      ),
    ).toEqual({
      kind: "none",
      reason: "pane_not_aligned",
    });
  });

  it("只有一张待审批且屏幕已进入审批态时，会允许单张 fallback 对齐", () => {
    const activeApproval = createApproval("call-1");
    const structuredSession = createSession({
      id: "session-1",
      runtimeState: "waitingApproval",
      activeApproval,
      pendingApprovals: [activeApproval],
    });

    const result = selectLinkedApprovalForTarget(
      structuredSession,
      createSession({
        runtimeState: "waitingApproval",
        screenPreview: [
          "Would you like to run the following command?",
          "$ mktemp /tmp/a",
          "1. Yes, proceed (y)",
          "2. No (esc)",
          "Press enter to confirm or esc to cancel",
        ].join("\n"),
      }),
    );

    expect(result).toMatchObject({
      kind: "structured",
      approval: activeApproval,
      fallbackToSingleVisiblePrompt: true,
    });
  });

  it("能识别结构化审批是否仍在等待", () => {
    expect(
      hasStructuredApprovalWaiting(
        createSession({
          id: "session-1",
          runtimeState: "waitingApproval",
          activeApproval: createApproval("call-1"),
        }),
      ),
    ).toBe(true);

    expect(
      hasStructuredApprovalWaiting(
        createSession({
          id: "session-1",
          runtimeState: "active",
          activeApproval: null,
        }),
      ),
    ).toBe(false);
  });

  it("能识别 tmux fallback 审批", () => {
    const fallbackApproval = createApproval("fallback-1", {
      sessionId: "tmux:taskA",
      callId: undefined,
      rawMethod: "tmux/paneApproval",
    });

    expect(
      hasTmuxFallbackApproval(
        createSession({
          runtimeState: "waitingApproval",
          visibleApproval: fallbackApproval,
        }),
      ),
    ).toBe(true);
  });
});
