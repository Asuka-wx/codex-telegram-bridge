import { describe, expect, it } from "vitest";

import {
  isBuiltInTelegramCommand,
  parseApprovalAction,
  parseApprovalDecision,
  parseToolOutputAction,
  parseTrailingSegment,
} from "../src/telegram/callbacks.js";
import { getGroupReadinessAdvice } from "../src/telegram/group-readiness.js";
import type { ApprovalRequest } from "../src/types/domain.js";

describe("telegram callback 解析", () => {
  it("能正确解析带冒号的审批 sessionId", () => {
    expect(parseApprovalDecision("approval:tmux:taskApproval:cancel")).toEqual({
      sessionId: "tmux:taskApproval",
      decision: "cancel",
    });
  });

  it("能正确解析带冒号的控制回调 sessionId", () => {
    expect(parseTrailingSegment("control:key:tmux:taskApproval:C-c", "control:key:")).toEqual({
      sessionId: "tmux:taskApproval",
      suffix: "C-c",
    });
  });

  it("能正确解析新的允许并记住审批按钮", () => {
    expect(parseApprovalDecision("approval:tmux:taskApproval:acceptRemember")).toEqual({
      sessionId: "tmux:taskApproval",
      decision: "acceptRemember",
    });
  });

  it("能正确解析动态审批动作按钮", () => {
    expect(parseApprovalAction("approvalKey:tmux:taskApproval:Escape")).toEqual({
      sessionId: "tmux:taskApproval",
      key: "Escape",
    });
  });

  it("能正确解析新的菜单式审批动作按钮", () => {
    expect(parseApprovalAction("approvalKey:tmux:taskApproval:DownEnter")).toEqual({
      sessionId: "tmux:taskApproval",
      key: "DownEnter",
    });
  });

  it("能正确解析长输出查看原文按钮", () => {
    expect(parseToolOutputAction("toolOutput:abc123:open")).toEqual({
      requestToken: "abc123",
      action: "open",
    });
  });

  it("审批请求对象允许携带稳定签名", () => {
    const request: ApprovalRequest = {
      requestId: "1",
      sessionId: "tmux:taskB",
      kind: "command",
      title: "窗口等待确认",
      body: "body",
      createdAt: "2026-04-01T00:00:00.000Z",
      rawMethod: "tmux/paneApproval",
      signature: "$ ps -p 1 -o pid,ppid,command",
    };

    expect(request.signature).toBe("$ ps -p 1 -o pid,ppid,command");
  });

  it("能正确解析带冒号的模式切换 sessionId", () => {
    expect(parseTrailingSegment("sessionMode:set:tmux:taskApproval:hybrid", "sessionMode:set:")).toEqual({
      sessionId: "tmux:taskApproval",
      suffix: "hybrid",
    });
  });

  it("只把 bridge 自己的 slash 命令识别为内建命令", () => {
    expect(isBuiltInTelegramCommand("/status")).toBe(true);
    expect(isBuiltInTelegramCommand("/bind latest")).toBe(true);
    expect(isBuiltInTelegramCommand("/status@codex_bot")).toBe(true);
    expect(isBuiltInTelegramCommand("/model")).toBe(false);
    expect(isBuiltInTelegramCommand("/Users/tester/Dev")).toBe(false);
  });

  it("群准备检查会在 forum 没开时先要求开启 Topics", () => {
    expect(
      getGroupReadinessAdvice({
        chatId: -1001,
        currentControlChatId: null,
        status: "administrator",
        canManageTopics: "true",
        isForum: "false",
        enableForumTopics: true,
      }).nextStep,
    ).toContain("切换成 forum / Topics 模式");
  });

  it("群准备检查会在缺少 topics 权限时先要求补权限", () => {
    expect(
      getGroupReadinessAdvice({
        chatId: -1001,
        currentControlChatId: null,
        status: "administrator",
        canManageTopics: "false",
        isForum: "true",
        enableForumTopics: true,
      }).nextStep,
    ).toContain("打开 Topics 管理权限");
  });
});
