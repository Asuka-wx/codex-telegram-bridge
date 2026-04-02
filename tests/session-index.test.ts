import path from "node:path";
import os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { SessionIndex } from "../src/codex/session-index.js";
import type { SessionMessage, SessionSnapshot } from "../src/types/domain.js";

describe("SessionIndex", () => {
  const writableConfig = config as unknown as {
    codex: {
      sessionsDir: string;
    };
  };

  const originalSessionsDir = writableConfig.codex.sessionsDir;

  afterEach(() => {
    writableConfig.codex.sessionsDir = originalSessionsDir;
  });

  it("在 sessions 目录还不存在时不会启动失败", async () => {
    writableConfig.codex.sessionsDir = path.join(
      os.tmpdir(),
      `codex-telegram-bridge-missing-${Date.now()}`,
      "sessions",
    );

    const index = new SessionIndex() as unknown as {
      loadExistingFiles(): Promise<void>;
    };

    await expect(index.loadExistingFiles()).resolves.toBeUndefined();
  });

  it("会持续追踪已知旧会话所在目录，而不只盯今天和昨天", () => {
    const index = new SessionIndex() as unknown as {
      cursors: Map<string, { bytesRead: number; carry: string }>;
      getLikelyActiveDirectories(): string[];
    };

    const trackedDir = path.join(
      "/Users/tester/.codex/sessions",
      "2026",
      "03",
      "28",
    );
    index.cursors = new Map([
      [
        path.join(trackedDir, "rollout-old.jsonl"),
        { bytesRead: 10, carry: "" },
      ],
    ]);

    expect(index.getLikelyActiveDirectories()).toContain(trackedDir);
  });

  it("会把审批、命令输出和运行状态恢复成结构化快照", () => {
    const index = new SessionIndex();
    const writableIndex = index as unknown as {
      handleLine(filePath: string, line: Record<string, unknown>): void;
      sessions: Map<string, SessionSnapshot>;
    };

    const filePath = "/tmp/rollout-structured.jsonl";
    const messages: SessionMessage[] = [];
    index.on("sessionMessage", (message) => {
      messages.push(message);
    });

    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "session-structured",
        cwd: "/Users/tester/Dev/codex-telegram-bridge",
        source: "cli",
        timestamp: "2026-04-01T09:59:58.000Z",
      },
    });
    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T10:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-1",
      },
    });
    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T10:00:02.000Z",
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        cwd: "/Users/tester/Dev/codex-telegram-bridge",
      },
    });
    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T10:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-approval-1",
        arguments: JSON.stringify({
          cmd: "mktemp /tmp/codex-approval.XXXXXX",
          justification: "无害审批测试",
          sandbox_permissions: "require_escalated",
          prefix_rule: ["mktemp", "/tmp/codex-approval"],
        }),
      },
    });

    const waitingApproval = writableIndex.sessions.get("session-structured");
    expect(waitingApproval?.runtimeState).toBe("waitingApproval");
    expect(waitingApproval?.pendingApprovals).toHaveLength(1);
    expect(waitingApproval?.pendingApprovals?.[0]).toMatchObject({
      callId: "call-approval-1",
      command: "mktemp /tmp/codex-approval.XXXXXX",
      justification: "无害审批测试",
      signature: "mktemp /tmp/codex-approval.XXXXXX",
    });

    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T10:00:04.000Z",
      type: "event_msg",
      payload: {
        type: "exec_command_end",
        call_id: "call-approval-1",
        turn_id: "turn-1",
        command: ["/bin/zsh", "-lc", "mktemp /tmp/codex-approval.XXXXXX"],
        aggregated_output: "/tmp/codex-approval.abcd12\n",
        status: "completed",
      },
    });
    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T10:00:05.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-approval-1",
        output: "Command executed",
      },
    });
    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T10:00:06.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: "已完成",
      },
    });

    const completed = writableIndex.sessions.get("session-structured");
    expect(completed?.pendingApprovals).toEqual([]);
    expect(completed?.runtimeState).toBe("idle");
    expect(completed?.recentMessages.at(-1)).toMatchObject({
      role: "tool",
      text: "/tmp/codex-approval.abcd12",
      callId: "call-approval-1",
      turnId: "turn-1",
    });
    expect(messages).toHaveLength(1);
  });

  it("审批被取消时会清空待审批队列，但不会误发命令输出", () => {
    const index = new SessionIndex();
    const writableIndex = index as unknown as {
      handleLine(filePath: string, line: Record<string, unknown>): void;
      sessions: Map<string, SessionSnapshot>;
    };

    const filePath = "/tmp/rollout-cancelled.jsonl";
    const messages: SessionMessage[] = [];
    index.on("sessionMessage", (message) => {
      messages.push(message);
    });

    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T11:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "session-cancelled",
        cwd: "/Users/tester/Dev/codex-telegram-bridge",
      },
    });
    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T11:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-2",
      },
    });
    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T11:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-cancelled-1",
        arguments: JSON.stringify({
          cmd: "mktemp /tmp/codex-cancelled.XXXXXX",
          sandbox_permissions: "require_escalated",
        }),
      },
    });
    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T11:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-cancelled-1",
        output: "aborted by user after 19.8s",
      },
    });

    const cancelled = writableIndex.sessions.get("session-cancelled");
    expect(cancelled?.pendingApprovals).toEqual([]);
    expect(cancelled?.runtimeState).toBe("active");
    expect(cancelled?.preview).toContain("审批已取消");
    expect(messages).toEqual([]);
  });

  it("连续多个审批时会保留最早未解决审批为 activeApproval，并在解决后切到下一张", () => {
    const index = new SessionIndex();
    const writableIndex = index as unknown as {
      handleLine(filePath: string, line: Record<string, unknown>): void;
      sessions: Map<string, SessionSnapshot>;
    };

    const filePath = "/tmp/rollout-approval-queue.jsonl";
    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T13:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "session-queue",
        cwd: "/Users/tester/Dev/codex-telegram-bridge",
      },
    });
    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T13:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-queue",
      },
    });

    for (const suffix of ["1", "2", "3"]) {
      writableIndex.handleLine(filePath, {
        timestamp: `2026-04-01T13:00:0${Number(suffix) + 1}.000Z`,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: `call-${suffix}`,
          arguments: JSON.stringify({
            cmd: `mktemp /tmp/queue-${suffix}.XXXXXX`,
            sandbox_permissions: "require_escalated",
          }),
        },
      });
    }

    const queued = writableIndex.sessions.get("session-queue");
    expect(queued?.pendingApprovals?.map((approval) => approval.callId)).toEqual([
      "call-1",
      "call-2",
      "call-3",
    ]);
    expect(queued?.activeApproval?.callId).toBe("call-1");

    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T13:00:06.000Z",
      type: "event_msg",
      payload: {
        type: "exec_command_end",
        call_id: "call-1",
        turn_id: "turn-queue",
        command: ["/bin/zsh", "-lc", "mktemp /tmp/queue-1.XXXXXX"],
        aggregated_output: "/tmp/queue-1.ABCD\n",
      },
    });

    const afterFirst = writableIndex.sessions.get("session-queue");
    expect(afterFirst?.pendingApprovals?.map((approval) => approval.callId)).toEqual([
      "call-2",
      "call-3",
    ]);
    expect(afterFirst?.activeApproval?.callId).toBe("call-2");

    writableIndex.handleLine(filePath, {
      timestamp: "2026-04-01T13:00:07.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-2",
        output: "aborted by user after 12.0s",
      },
    });

    const afterSecond = writableIndex.sessions.get("session-queue");
    expect(afterSecond?.pendingApprovals?.map((approval) => approval.callId)).toEqual([
      "call-3",
    ]);
    expect(afterSecond?.activeApproval?.callId).toBe("call-3");
  });
});
