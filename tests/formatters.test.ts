import { describe, expect, it } from "vitest";

import {
  formatControlSummary,
  formatSessionSummary,
  formatSessionMessage,
} from "../src/telegram/formatters.js";
import type { SessionMessage, SessionSnapshot } from "../src/types/domain.js";

const makeSession = (
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot => ({
  id: "tmux:taskA",
  name: "taskA",
  cwd: "/Users/tester/Dev/project-a",
  runtimeState: "active",
  updatedAt: "2026-04-01T00:00:00.000Z",
  preview: "继续当前任务",
  recentMessages: [],
  ...overrides,
});

describe("formatControlSummary", () => {
  it("在已绑定窗口时显示友好的当前窗口名", () => {
    const text = formatControlSummary(
      [makeSession(), makeSession({ id: "tmux:taskB", name: "taskB", runtimeState: "idle" })],
      "tmux:taskA",
      "remote",
    );

    expect(text).toContain("当前已绑定：taskA");
    expect(text).toContain("窗口总数：2");
    expect(text).toContain("待重连：0");
  });

  it("在没有窗口时给出下一步提示", () => {
    const text = formatControlSummary([], null, "remote");
    expect(text).toContain("下一步：在专用机上新建 tmux session 或启动 Codex");
  });

  it("在总控未绑定窗口时说明绑定只是默认目标", () => {
    const text = formatControlSummary([makeSession()], null, "remote");
    expect(text).toContain("总控本身不承接具体任务");
    expect(text).toContain("对应任务子话题");
  });

  it("会显示槽位仍在但 Codex 未连接", () => {
    const text = formatSessionSummary(
      makeSession({
        runtimeState: "idle",
        codexAttached: false,
        preview: "Codex 未运行，等待在该槽位重新启动",
      }),
    );

    expect(text).toContain("Codex：未连接");
    expect(text).toContain("状态：idle");
  });

  it("会把 footer 状态展示到面板里", () => {
    const text = formatSessionSummary(
      makeSession({
        codexFooterStatus: {
          modelLabel: "gpt-5.4 xhigh fast",
          contextLeft: "97% left",
          cwdLabel: "~/Dev",
        },
      }),
    );

    expect(text).toContain("模型：gpt-5.4 xhigh fast");
    expect(text).toContain("上下文：97% left");
    expect(text).toContain("界面目录：~/Dev");
  });
});

describe("formatSessionMessage", () => {
  it("tmux 输出不加角色前缀", () => {
    const message: SessionMessage = {
      id: "1",
      sessionId: "tmux:taskA",
      role: "assistant",
      text: "原始 tmux 输出",
      timestamp: "2026-04-01T00:00:00.000Z",
      source: "tmux",
    };

    expect(formatSessionMessage(message, 100)).toEqual(["原始 tmux 输出"]);
  });

  it("assistant 语义消息不再强制加角色前缀", () => {
    const message: SessionMessage = {
      id: "2",
      sessionId: "tmux:taskA",
      role: "assistant",
      text: "这是语义化回复",
      timestamp: "2026-04-01T00:00:00.000Z",
      source: "session_file",
    };

    expect(formatSessionMessage(message, 100)).toEqual(["这是语义化回复"]);
  });

  it("结构化工具输出沿用原始输出格式，不加角色前缀", () => {
    const message: SessionMessage = {
      id: "3",
      sessionId: "tmux:taskA",
      role: "tool",
      text: "pnpm test\nAll green",
      timestamp: "2026-04-01T00:00:00.000Z",
      source: "session_file",
      kind: "tool",
      toolName: "exec_command",
    };

    expect(formatSessionMessage(message, 100)).toEqual(["pnpm test\nAll green"]);
  });

  it("长工具输出会尽量按自然小节切块，而不是从中间截断", () => {
    const message: SessionMessage = {
      id: "4",
      sessionId: "tmux:taskA",
      role: "tool",
      text: "当前进度：\n- 已完成 bridge 体检\n\n下一步：\n1. 优化 TG 渲染\n2. 补格式化测试",
      timestamp: "2026-04-01T00:00:00.000Z",
      source: "session_file",
      kind: "tool",
      toolName: "exec_command",
    };

    expect(formatSessionMessage(message, 28)).toEqual([
      "当前进度：\n- 已完成 bridge 体检",
      "下一步：\n1. 优化 TG 渲染\n2. 补格式化测试",
    ]);
  });
});
