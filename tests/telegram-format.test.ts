import { describe, expect, it } from "vitest";

import {
  canMergeSemanticMessages,
  formatCollapsedTelegramMessagePreview,
  formatTelegramChunk,
  mergeSemanticMessages,
  shouldBufferSemanticMessage,
  shouldCollapseTelegramMessage,
  shouldCollapseTelegramSemanticMessage,
  shouldCollapseTelegramToolOutput,
} from "../src/telegram/message-formatting.js";
import type { SessionMessage } from "../src/types/domain.js";

const makeTmuxMessage = (text: string): SessionMessage => ({
  id: "1",
  sessionId: "tmux:taskA",
  role: "assistant",
  text,
  timestamp: "2026-04-01T00:00:00.000Z",
  source: "tmux",
});

describe("formatTelegramChunk", () => {
  it("会把代码块型 tmux 输出格式化为 pre", () => {
    const payload = formatTelegramChunk(
      makeTmuxMessage("const x = 1;\nreturn x;"),
      "const x = 1;\nreturn x;",
    );

    expect(payload.parseMode).toBe("HTML");
    expect(payload.text.startsWith("<pre>")).toBe(true);
  });

  it("会把状态和进度类输出做细粒度高亮", () => {
    const payload = formatTelegramChunk(
      makeTmuxMessage("当前进度到这里：\n窗口：taskA\n• Ran pnpm test\n└ exit 0"),
      "当前进度到这里：\n窗口：taskA\n• Ran pnpm test\n└ exit 0",
    );

    expect(payload.parseMode).toBe("HTML");
    expect(payload.text).toContain("<b><u>【当前进度】</u></b>");
    expect(payload.text).toContain("当前进度到这里：");
    expect(payload.text).toContain("<b>窗口：</b><code>taskA</code>");
    expect(payload.text).toContain("• Ran <code>pnpm test</code>");
    expect(payload.text).toContain("<code>└ exit 0</code>");
  });

  it("会把列表和下一步做成更容易扫读的层次", () => {
    const payload = formatTelegramChunk(
      makeTmuxMessage("下一步：\n1. 发 当前信息\n2. 发 设为总控\n- 然后绑定最新窗口"),
      "下一步：\n1. 发 当前信息\n2. 发 设为总控\n- 然后绑定最新窗口",
    );

    expect(payload.parseMode).toBe("HTML");
    expect(payload.text).toContain("<b><u>【下一步】</u></b>");
    expect(payload.text).toContain("<b>1.</b> 发 当前信息");
    expect(payload.text).toContain("• 然后绑定最新窗口");
  });

  it("会把路径和命令从正文里提出来，提升扫读性", () => {
    const payload = formatTelegramChunk(
      makeTmuxMessage("这部分在：\n- codex-telegram-bridge/src/telegram/bot.ts\n- pnpm test"),
      "这部分在：\n- codex-telegram-bridge/src/telegram/bot.ts\n- pnpm test",
    );

    expect(payload.parseMode).toBe("HTML");
    expect(payload.text).toContain("<b><u>【这部分在】</u></b>");
    expect(payload.text).toContain("<code>codex-telegram-bridge/src/telegram/bot.ts</code>");
    expect(payload.text).toContain("<code>pnpm test</code>");
  });

  it("会把命令、错误、日志路径和操作步骤拆成清晰层次", () => {
    const chunk = [
      "处理结果：",
      "命令：pnpm launchd:install",
      "错误：ENOENT: no such file or directory",
      "日志：.data/launchd.err.log",
      "下一步：",
      "1. 先看 launchd.err.log",
      "2. 再重载 bridge",
    ].join("\n");
    const payload = formatTelegramChunk(makeTmuxMessage(chunk), chunk);

    expect(payload.parseMode).toBe("HTML");
    expect(payload.text).toContain("<b><u>【处理结果】</u></b>");
    expect(payload.text).toContain("<b>命令：</b><code>pnpm launchd:install</code>");
    expect(payload.text).toContain("<b>错误：</b><code>ENOENT: no such file or directory</code>");
    expect(payload.text).toContain("<b>日志：</b><code>.data/launchd.err.log</code>");
    expect(payload.text).toContain("<b><u>【下一步】</u></b>");
    expect(payload.text).toContain("<b>1.</b> 先看 <code>launchd.err.log</code>");
  });

  it("普通 tmux 文本不强制套 HTML", () => {
    const payload = formatTelegramChunk(
      makeTmuxMessage("这是普通说明文字"),
      "这是普通说明文字",
    );

    expect(payload).toEqual({ text: "这是普通说明文字" });
  });

  it("超长工具输出会进入折叠模式", () => {
    const message: SessionMessage = {
      ...makeTmuxMessage(Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join("\n")),
      role: "tool",
      kind: "tool",
      source: "session_file",
      toolName: "exec_command",
    };

    expect(shouldCollapseTelegramToolOutput(message)).toBe(true);

    const preview = formatCollapsedTelegramMessagePreview(message);
    expect(preview.parseMode).toBe("HTML");
    expect(preview.text).toContain("【长工具输出已折叠】");
    expect(preview.text).toContain("查看完整内容");
    expect(preview.text).toContain("<pre>line 24");
  });

  it("工具输出预览会优先显示高信号内容，而不是机械截取前几行", () => {
    const message: SessionMessage = {
      ...makeTmuxMessage(
        [
          "(node:123) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.",
          "Use `node --trace-deprecation ...` to show where the warning was created)",
          "",
          "处理结果：",
          "命令：pnpm test",
          "错误：ENOENT: no such file or directory",
          "日志：.data/launchd.err.log",
        ].join("\n"),
      ),
      role: "tool",
      kind: "tool",
      source: "session_file",
      toolName: "exec_command",
    };

    const preview = formatCollapsedTelegramMessagePreview(message);
    expect(preview.text).toContain("处理结果：");
    expect(preview.text).toContain("命令：pnpm test");
    expect(preview.text).toContain("错误：ENOENT: no such file or directory");
    expect(preview.text).not.toContain("punycode");
  });

  it("短工具输出不会被误折叠", () => {
    const message: SessionMessage = {
      ...makeTmuxMessage("pnpm test\nAll green"),
      role: "tool",
      kind: "tool",
      source: "session_file",
      toolName: "exec_command",
    };

    expect(shouldCollapseTelegramToolOutput(message)).toBe(false);
  });

  it("assistant 结构化消息也会做富文本增强", () => {
    const message: SessionMessage = {
      id: "assistant-1",
      sessionId: "tmux:taskA",
      role: "assistant",
      text: "结论：这轮样式已经更适合手机阅读。\n\n现在的变化是：assistant 的说明段会变成更明显的块。\n\n下一步：\n1. 看 launchd.err.log\n2. 再刷新总控",
      timestamp: "2026-04-01T00:00:00.000Z",
      source: "session_file",
      phase: "commentary",
      kind: "chat",
    };

    const payload = formatTelegramChunk(message, message.text);
    expect(payload.parseMode).toBe("HTML");
    expect(payload.text).toContain("<b><u>【结论】</u></b>");
    expect(payload.text).toContain("<blockquote>结论：这轮样式已经更适合手机阅读。</blockquote>");
    expect(payload.text).toContain("<b><u>【现在的变化】</u></b>");
    expect(payload.text).toContain("<blockquote>现在的变化是：assistant 的说明段会变成更明显的块。</blockquote>");
    expect(payload.text).toContain("<b><u>【下一步】</u></b>");
    expect(payload.text).toContain("<b>1.</b> 看 <code>launchd.err.log</code>");
  });

  it("超长 assistant 语义消息会进入折叠模式", () => {
    const message: SessionMessage = {
      id: "assistant-2",
      sessionId: "tmux:taskA",
      role: "assistant",
      text: Array.from({ length: 32 }, (_, index) => `第 ${index + 1} 行语义说明`).join("\n"),
      timestamp: "2026-04-01T00:00:00.000Z",
      source: "session_file",
      phase: "commentary",
      kind: "chat",
    };

    expect(shouldCollapseTelegramSemanticMessage(message)).toBe(false);
    expect(shouldCollapseTelegramMessage(message)).toBe(false);
  });

  it("一般长度的 assistant 说明默认不折叠", () => {
    const message: SessionMessage = {
      id: "assistant-2b",
      sessionId: "tmux:taskA",
      role: "assistant",
      text: Array.from({ length: 15 }, (_, index) => `第 ${index + 1} 行说明`).join("\n"),
      timestamp: "2026-04-01T00:00:00.000Z",
      source: "session_file",
      phase: "commentary",
      kind: "chat",
    };

    expect(shouldCollapseTelegramSemanticMessage(message)).toBe(false);
    expect(shouldCollapseTelegramMessage(message)).toBe(false);
  });

  it("只会缓冲 assistant commentary 消息，并会合并连续进展", () => {
    const first: SessionMessage = {
      id: "assistant-3",
      sessionId: "tmux:taskA",
      role: "assistant",
      text: "先看两件事：",
      timestamp: "2026-04-01T00:00:00.000Z",
      source: "session_file",
      phase: "commentary",
      kind: "chat",
    };
    const second: SessionMessage = {
      ...first,
      id: "assistant-4",
      text: "1. 看预览卡\n2. 看展开内容",
      timestamp: "2026-04-01T00:00:02.000Z",
    };

    expect(shouldBufferSemanticMessage(first)).toBe(true);
    expect(canMergeSemanticMessages(first, second)).toBe(true);

    const merged = mergeSemanticMessages(first, second);
    expect(merged.text).toContain("先看两件事：\n\n1. 看预览卡");
    expect(merged.id).toBe("assistant-3+assistant-4");
  });
});
