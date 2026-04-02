import { describe, expect, it } from "vitest";

import { ApprovalCoordinator } from "../src/approval/approval-coordinator.js";
import type { ApprovalRequest, SessionSnapshot } from "../src/types/domain.js";

const createApproval = (
  requestId: string,
  signature: string,
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest => ({
  requestId,
  requestToken: requestId,
  callId: requestId,
  sessionId: "tmux:taskB",
  kind: "command",
  title: "窗口等待确认",
  body: signature,
  createdAt: "2026-04-01T00:00:00.000Z",
  rawMethod: "tmux/paneApproval",
  signature,
  actions: [
    { key: "y", label: "允许一次" },
    { key: "Escape", label: "拒绝" },
  ],
  ...overrides,
});

const createSession = (
  approval?: ApprovalRequest | null,
): SessionSnapshot => ({
  id: "tmux:taskB",
  runtimeState: approval ? "waitingApproval" : "idle",
  recentMessages: [],
  activeApproval: approval ?? null,
  pendingApprovals: approval ? [approval] : [],
});

describe("ApprovalCoordinator", () => {
  it("会把 tmux fallback 审批升级成结构化审批身份", () => {
    const coordinator = new ApprovalCoordinator(async () => null);
    const fallbackApproval = createApproval(
      "tmux-fallback-1",
      "$ mktemp /tmp/first",
      {
        requestToken: "fallback-token-1",
        callId: undefined,
      },
    );
    const structuredApproval = createApproval(
      "call-1",
      "mktemp /tmp/first",
      {
        requestToken: undefined,
        command: "mktemp /tmp/first",
        rawMethod: "exec_command",
      },
    );

    const first = coordinator.prepareApprovalDispatch(fallbackApproval);
    const second = coordinator.prepareApprovalDispatch(structuredApproval);

    expect(first?.requestToken).toBe("fallback-token-1");
    expect(second?.requestToken).toBe("fallback-token-1");
    expect(coordinator.activeStateBySession.get("tmux:taskB")).toEqual({
      requestToken: "fallback-token-1",
      callId: "call-1",
    });
    expect(
      coordinator.tokenBySessionSignature.get(
        "tmux:taskB__CODEX_BRIDGE_APPROVAL__call-1",
      ),
    ).toBe("fallback-token-1");
  });

  it("已经升级后，旧 fallback 重发会被忽略", () => {
    const coordinator = new ApprovalCoordinator(async () => null);
    const fallbackApproval = createApproval(
      "tmux-fallback-1",
      "$ mktemp /tmp/first",
      {
        requestToken: "fallback-token-1",
        callId: undefined,
      },
    );
    const structuredApproval = createApproval(
      "call-1",
      "mktemp /tmp/first",
      {
        requestToken: undefined,
        command: "mktemp /tmp/first",
        rawMethod: "exec_command",
      },
    );

    coordinator.prepareApprovalDispatch(fallbackApproval);
    coordinator.prepareApprovalDispatch(structuredApproval);
    const duplicated = coordinator.prepareApprovalDispatch(fallbackApproval);

    expect(duplicated).toBeNull();
    expect(coordinator.activeStateBySession.get("tmux:taskB")).toEqual({
      requestToken: "fallback-token-1",
      callId: "call-1",
    });
  });

  it("beginApprovalAction 会校验 token 是否仍然有效", () => {
    const coordinator = new ApprovalCoordinator(async () => null);
    const approval = createApproval("call-1", "mktemp /tmp/first", {
      command: "mktemp /tmp/first",
      rawMethod: "exec_command",
    });

    coordinator.prepareApprovalDispatch(approval);
    const begin = coordinator.beginApprovalAction("call-1");

    expect(begin).toMatchObject({
      status: "ok",
      sessionId: "tmux:taskB",
      approvalId: "call-1",
      activeApprovalId: "call-1",
    });
    expect(coordinator.pendingSubmitTokens.has("call-1")).toBe(true);
  });

  it("点击 fallback 卡时，如果当前已升级成结构化审批，可以重新绑定到结构化身份", () => {
    const structuredApproval = createApproval(
      "call-1",
      "mktemp /tmp/first",
      {
        command: "mktemp /tmp/first",
        rawMethod: "exec_command",
      },
    );
    const coordinator = new ApprovalCoordinator(async () => createSession(structuredApproval));
    const fallbackApproval = createApproval(
      "tmux-fallback-1",
      "$ mktemp /tmp/first",
      {
        requestToken: "fallback-token-1",
        callId: undefined,
      },
    );

    coordinator.prepareApprovalDispatch(fallbackApproval);
    const begin = coordinator.beginApprovalAction("fallback-token-1");
    expect(begin.status).toBe("ok");

    const nextId = coordinator.rebindApprovalAction(
      "tmux:taskB",
      "fallback-token-1",
      "$ mktemp /tmp/first",
      structuredApproval,
    );

    expect(nextId).toBe("call-1");
    expect(coordinator.activeStateBySession.get("tmux:taskB")).toEqual({
      requestToken: "fallback-token-1",
      callId: "call-1",
    });
  });

  it("点击结构化审批卡时，不会被当前 fallback 前台版本反向降级", () => {
    const structuredApproval = createApproval(
      "call-1",
      "mktemp /tmp/first",
      {
        requestToken: "structured-token-1",
        command: "mktemp /tmp/first",
        rawMethod: "exec_command",
      },
    );
    const fallbackApproval = createApproval(
      "tmux-fallback-1",
      "$ mktemp /tmp/first",
      {
        requestToken: "fallback-token-1",
        callId: undefined,
        rawMethod: "tmux/paneApproval",
      },
    );
    const coordinator = new ApprovalCoordinator(async () =>
      createSession(fallbackApproval),
    );
    coordinator.prepareApprovalDispatch(structuredApproval);
    const begin = coordinator.beginApprovalAction("structured-token-1");

    expect(begin.status).toBe("ok");
    const reconciled = coordinator.reconcileApprovalAction(
      "structured-token-1",
      structuredApproval,
      "call-1",
      createSession(fallbackApproval),
    );

    expect(reconciled).toEqual({
      status: "ready",
      effectiveApprovalId: "call-1",
    });
    expect(coordinator.activeStateBySession.get("tmux:taskB")).toEqual({
      requestToken: "structured-token-1",
      callId: "call-1",
    });
  });

  it("当前审批已经不存在时，会在协调器里直接清掉该审批跟踪", () => {
    const coordinator = new ApprovalCoordinator(async () => createSession(null));
    const approval = createApproval("call-1", "mktemp /tmp/first", {
      command: "mktemp /tmp/first",
      rawMethod: "exec_command",
    });

    coordinator.prepareApprovalDispatch(approval);
    const begin = coordinator.beginApprovalAction("call-1");
    expect(begin.status).toBe("ok");

    const reconciled = coordinator.reconcileApprovalAction(
      "call-1",
      approval,
      "call-1",
      createSession(null),
    );

    expect(reconciled).toEqual({
      status: "invalid",
      effectiveApprovalId: "call-1",
    });
    expect(coordinator.activeStateBySession.get("tmux:taskB")).toBeUndefined();
  });
});
