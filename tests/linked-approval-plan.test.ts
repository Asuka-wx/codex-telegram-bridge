import { describe, expect, it } from "vitest";

import { buildLinkedApprovalPlan } from "../src/approval/linked-approval-plan.js";
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

describe("linked approval plan", () => {
  it("会把可派发 target 和需要跳过的 target 分开", () => {
    const activeApproval = createApproval("call-1");
    const structuredSession = createSession({
      id: "session-1",
      runtimeState: "waitingApproval",
      activeApproval,
      pendingApprovals: [activeApproval],
    });

    const aligned = createSession({
      id: "tmux:aligned",
      runtimeState: "waitingApproval",
      visibleApproval: activeApproval,
    });
    const notAligned = createSession({
      id: "tmux:not-aligned",
      runtimeState: "active",
      screenPreview: "普通输出",
    });

    const plan = buildLinkedApprovalPlan(structuredSession, [aligned, notAligned]);

    expect(plan.dispatches).toHaveLength(1);
    expect(plan.dispatches[0]?.target.id).toBe("tmux:aligned");
    expect(plan.skips).toHaveLength(1);
    expect(plan.skips[0]?.target.id).toBe("tmux:not-aligned");
    expect(plan.skips[0]?.selection.reason).toBe("pane_not_aligned");
  });

  it("没有结构化审批时，会把 tmux fallback 放进 dispatches", () => {
    const fallbackApproval = createApproval("fallback-1", {
      sessionId: "tmux:taskA",
      callId: undefined,
      rawMethod: "tmux/paneApproval",
      signature: "$ mktemp /tmp/a",
      command: undefined,
    });
    const target = createSession({
      runtimeState: "waitingApproval",
      visibleApproval: fallbackApproval,
      activeApproval: fallbackApproval,
    });

    const plan = buildLinkedApprovalPlan(undefined, [target]);

    expect(plan.dispatches).toHaveLength(1);
    expect(plan.dispatches[0]?.selection.kind).toBe("fallback");
    expect(plan.skips).toHaveLength(0);
  });
});
