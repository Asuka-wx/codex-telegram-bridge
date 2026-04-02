import { describe, expect, it, vi } from "vitest";

import { TelegramBotService } from "../src/telegram/bot.js";
import type { ApprovalRequest, SessionSnapshot } from "../src/types/domain.js";

const createBridgeStub = () =>
  ({
    stateStore: {
      getControlChatId: () => null,
      getTopicBindingBySessionForChat: () => null,
      listSelectedSessions: () => [{ chatId: 123456, sessionId: "tmux:taskB" }],
      getSessionSyncMode: () => null,
      getSyncMode: () => "remote",
    },
    getSessionFresh: async () => ({
      id: "tmux:taskB",
      runtimeState: "waitingApproval",
      recentMessages: [],
    }),
  }) as const;

const createApproval = (
  requestId: string,
  signature: string,
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
});

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("审批队列", () => {
  it("同一 session 已有活动审批时，后来的审批不会接管当前有效 token", async () => {
    const service = new TelegramBotService(
      createBridgeStub() as never,
    ) as unknown as {
      bot: {
        api: {
          sendMessage: ReturnType<typeof vi.fn>;
        };
      };
      safeTelegram: (
        action: string,
        fn: () => Promise<void>,
      ) => Promise<boolean>;
      sendApprovalRequest(approval: ApprovalRequest): Promise<void>;
      approvalSessionByToken: Map<string, string>;
      activeApprovalStateBySession: Map<
        string,
        { requestToken: string; callId: string }
      >;
    };

    service.bot.api.sendMessage = vi.fn(async () => ({ message_id: 1 }));
    service.safeTelegram = async (_action, fn) => {
      await fn();
      return true;
    };

    const first = createApproval("1", "$ mktemp first");
    const second = createApproval("2", "$ mktemp second");

    await service.sendApprovalRequest(first);
    await service.sendApprovalRequest(second);

    const firstToken = "1";
    const secondToken = "2";

    expect(firstToken).toBeTruthy();
    expect(secondToken).toBeTruthy();
    expect(firstToken).not.toBe(secondToken);
    expect(service.approvalSessionByToken.get(firstToken)).toBe("tmux:taskB");
    expect(service.approvalSessionByToken.get(secondToken)).toBeUndefined();
    expect(service.activeApprovalStateBySession.get("tmux:taskB")).toEqual({
      requestToken: firstToken,
      callId: firstToken,
    });
  });

  it("当前审批 resolved 后，下一张审批需要重新显式发卡才会激活", async () => {
    const service = new TelegramBotService(
      createBridgeStub() as never,
    ) as unknown as {
      bot: {
        api: {
          sendMessage: ReturnType<typeof vi.fn>;
        };
      };
      safeTelegram: (
        action: string,
        fn: () => Promise<void>,
      ) => Promise<boolean>;
      sendApprovalRequest(approval: ApprovalRequest): Promise<void>;
      approvalSessionByToken: Map<string, string>;
      activeApprovalStateBySession: Map<
        string,
        { requestToken: string; callId: string }
      >;
      handleApprovalResolution(sessionId: string, approvalId: string): void;
    };

    service.bot.api.sendMessage = vi.fn(async () => ({ message_id: 1 }));
    service.safeTelegram = async (_action, fn) => {
      await fn();
      return true;
    };

    const first = createApproval("1", "$ mktemp first");
    const second = createApproval("2", "$ mktemp second");

    await service.sendApprovalRequest(first);
    const firstToken = "1";

    await service.sendApprovalRequest(second);
    service.handleApprovalResolution("tmux:taskB", firstToken);

    expect(service.approvalSessionByToken.get(firstToken)).toBeUndefined();
    expect(service.activeApprovalStateBySession.get("tmux:taskB")).toBeUndefined();

    await service.sendApprovalRequest(second);

    expect(service.approvalSessionByToken.get("2")).toBe("tmux:taskB");
    expect(service.activeApprovalStateBySession.get("tmux:taskB")).toEqual({
      requestToken: "2",
      callId: "2",
    });
  });

  it("审批点击会先答复 Telegram callback，再等待重型刷新和控制注入", async () => {
    const approval = createApproval("1", "$ mktemp first");
    const deferred = createDeferred<SessionSnapshot | null>();
    const bridge = {
      ...createBridgeStub(),
      getSessionFresh: vi.fn(() => deferred.promise),
      sendControl: vi.fn(async () => true),
    };
    const service = new TelegramBotService(
      bridge as never,
    ) as unknown as {
      bot: {
        api: {
          sendMessage: ReturnType<typeof vi.fn>;
        };
      };
      safeTelegram: (
        action: string,
        fn: () => Promise<void>,
      ) => Promise<boolean>;
      handleApprovalTokenAction(
        ctx: unknown,
        requestToken: string,
        key: "y" | "p" | "Escape",
      ): Promise<void>;
      approvalSessionByToken: Map<string, string>;
      approvalSignatureByToken: Map<string, string>;
      activeApprovalStateBySession: Map<
        string,
        { requestToken: string; callId: string }
      >;
      pendingApprovalByToken: Map<string, ApprovalRequest>;
      pendingApprovalSubmitTokens: Set<string>;
    };

    service.bot.api.sendMessage = vi.fn(async () => ({ message_id: 1 }));
    service.safeTelegram = async (_action, fn) => {
      await fn();
      return true;
    };
    service.pendingApprovalByToken.set("1", approval);
    service.approvalSessionByToken.set("1", "tmux:taskB");
    service.approvalSignatureByToken.set("1", "1");
    service.activeApprovalStateBySession.set("tmux:taskB", {
      requestToken: "1",
      callId: "1",
    });

    const ctx = {
      chat: { id: 123456 },
      callbackQuery: {
        message: {
          message_id: 99,
          message_thread_id: 18,
        },
      },
      answerCallbackQuery: vi.fn(async () => undefined),
      editMessageReplyMarkup: vi.fn(async () => undefined),
    };

    const pending = service.handleApprovalTokenAction(ctx, "1", "y");
    await Promise.resolve();

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "已收到审批动作，正在校验并提交。",
    });
    expect(bridge.getSessionFresh).toHaveBeenCalledWith("tmux:taskB");
    expect(bridge.sendControl).not.toHaveBeenCalled();
    expect(service.pendingApprovalSubmitTokens.has("1")).toBe(true);

    deferred.resolve({
      id: "tmux:taskB",
      runtimeState: "waitingApproval",
      recentMessages: [],
      activeApproval: approval,
      pendingApprovals: [approval],
    });
    await pending;

    expect(bridge.sendControl).toHaveBeenCalledWith("tmux:taskB", "y");
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledTimes(1);
  });

  it("tmux 兜底卡升级成结构化审批时，会沿用原 token 而不是重复发卡", async () => {
    const fallbackApproval: ApprovalRequest = {
      requestId: "tmux-fallback-1",
      requestToken: "fallback-token-1",
      sessionId: "tmux:taskB",
      kind: "command",
      title: "窗口等待确认",
      body: "$ mktemp /tmp/first",
      createdAt: "2026-04-01T00:00:00.000Z",
      rawMethod: "tmux/paneApproval",
      signature: "$ mktemp /tmp/first",
      actions: [
        { key: "y", label: "允许一次" },
        { key: "Escape", label: "拒绝" },
      ],
    };
    const structuredApproval: ApprovalRequest = {
      ...fallbackApproval,
      requestId: "call-1",
      callId: "call-1",
      signature: "mktemp /tmp/first",
      command: "mktemp /tmp/first",
      rawMethod: "exec_command",
    };

    const service = new TelegramBotService(
      createBridgeStub() as never,
    ) as unknown as {
      bot: {
        api: {
          sendMessage: ReturnType<typeof vi.fn>;
        };
      };
      safeTelegram: (
        action: string,
        fn: () => Promise<void>,
      ) => Promise<boolean>;
      sendApprovalRequest(approval: ApprovalRequest): Promise<void>;
      approvalSessionByToken: Map<string, string>;
      approvalSignatureByToken: Map<string, string>;
      activeApprovalStateBySession: Map<
        string,
        { requestToken: string; callId: string }
      >;
      pendingApprovalByToken: Map<string, ApprovalRequest>;
      approvalTokenBySessionSignature: Map<string, string>;
      activeApprovalSignatureByTarget: Map<string, string>;
    };

    service.bot.api.sendMessage = vi.fn(async () => ({ message_id: 1 }));
    service.safeTelegram = async (_action, fn) => {
      await fn();
      return true;
    };

    await service.sendApprovalRequest(fallbackApproval);
    expect(service.bot.api.sendMessage).toHaveBeenCalledTimes(1);

    await service.sendApprovalRequest(structuredApproval);

    expect(service.bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(service.activeApprovalStateBySession.get("tmux:taskB")).toEqual({
      requestToken: "fallback-token-1",
      callId: "call-1",
    });
    expect(
      service.approvalTokenBySessionSignature.get(
        "tmux:taskB__CODEX_BRIDGE_APPROVAL__call-1",
      ),
    ).toBe("fallback-token-1");
    expect(
      service.activeApprovalSignatureByTarget.get("123456:0:tmux:taskB"),
    ).toBe("call-1");
    expect(
      service.pendingApprovalByToken.get("fallback-token-1")?.callId,
    ).toBe("call-1");
  });

  it("已经升级成结构化审批后，后续同一审批的 tmux 兜底重发会被忽略", async () => {
    const fallbackApproval: ApprovalRequest = {
      requestId: "tmux-fallback-1",
      requestToken: "fallback-token-1",
      sessionId: "tmux:taskB",
      kind: "command",
      title: "窗口等待确认",
      body: "$ mktemp /tmp/first",
      createdAt: "2026-04-01T00:00:00.000Z",
      rawMethod: "tmux/paneApproval",
      signature: "$ mktemp /tmp/first",
      actions: [
        { key: "y", label: "允许一次" },
        { key: "Escape", label: "拒绝" },
      ],
    };
    const structuredApproval: ApprovalRequest = {
      ...fallbackApproval,
      requestId: "call-1",
      callId: "call-1",
      signature: "mktemp /tmp/first",
      command: "mktemp /tmp/first",
      rawMethod: "exec_command",
    };

    const service = new TelegramBotService(
      createBridgeStub() as never,
    ) as unknown as {
      bot: {
        api: {
          sendMessage: ReturnType<typeof vi.fn>;
        };
      };
      safeTelegram: (
        action: string,
        fn: () => Promise<void>,
      ) => Promise<boolean>;
      sendApprovalRequest(approval: ApprovalRequest): Promise<void>;
      activeApprovalStateBySession: Map<
        string,
        { requestToken: string; callId: string }
      >;
    };

    service.bot.api.sendMessage = vi.fn(async () => ({ message_id: 1 }));
    service.safeTelegram = async (_action, fn) => {
      await fn();
      return true;
    };

    await service.sendApprovalRequest(fallbackApproval);
    await service.sendApprovalRequest(structuredApproval);
    await service.sendApprovalRequest(fallbackApproval);

    expect(service.bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(service.activeApprovalStateBySession.get("tmux:taskB")).toEqual({
      requestToken: "fallback-token-1",
      callId: "call-1",
    });
  });

  it("并发发卡时，不会让旧兜底审批把结构化身份再覆盖回去", async () => {
    const firstGate = createDeferred<void>();
    const fallbackApproval: ApprovalRequest = {
      requestId: "tmux-fallback-1",
      requestToken: "fallback-token-1",
      sessionId: "tmux:taskB",
      kind: "command",
      title: "窗口等待确认",
      body: "$ mktemp /tmp/first",
      createdAt: "2026-04-01T00:00:00.000Z",
      rawMethod: "tmux/paneApproval",
      signature: "$ mktemp /tmp/first",
      actions: [
        { key: "y", label: "允许一次" },
        { key: "Escape", label: "拒绝" },
      ],
    };
    const structuredApproval: ApprovalRequest = {
      ...fallbackApproval,
      requestId: "call-1",
      callId: "call-1",
      signature: "mktemp /tmp/first",
      command: "mktemp /tmp/first",
      rawMethod: "exec_command",
    };

    const service = new TelegramBotService(
      createBridgeStub() as never,
    ) as unknown as {
      bot: {
        api: {
          sendMessage: ReturnType<typeof vi.fn>;
        };
      };
      safeTelegram: (
        action: string,
        fn: () => Promise<void>,
      ) => Promise<boolean>;
      sendApprovalRequest(approval: ApprovalRequest): Promise<void>;
      activeApprovalStateBySession: Map<
        string,
        { requestToken: string; callId: string }
      >;
    };

    service.bot.api.sendMessage = vi.fn(async () => ({ message_id: 1 }));
    let safeTelegramCount = 0;
    service.safeTelegram = async (_action, fn) => {
      safeTelegramCount += 1;
      if (safeTelegramCount === 1) {
        await firstGate.promise;
      }
      await fn();
      return true;
    };

    const first = service.sendApprovalRequest(fallbackApproval);
    const second = service.sendApprovalRequest(structuredApproval);
    const third = service.sendApprovalRequest(fallbackApproval);

    await Promise.resolve();
    firstGate.resolve();
    await Promise.all([first, second, third]);

    expect(service.bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(service.activeApprovalStateBySession.get("tmux:taskB")).toEqual({
      requestToken: "fallback-token-1",
      callId: "call-1",
    });
  });

  it("点击 tmux 兜底卡时，如果当前已升级成结构化审批，仍会继续提交动作", async () => {
    const fallbackApproval: ApprovalRequest = {
      requestId: "tmux-fallback-1",
      requestToken: "fallback-token-1",
      sessionId: "tmux:taskB",
      kind: "command",
      title: "窗口等待确认",
      body: "$ mktemp /tmp/first",
      createdAt: "2026-04-01T00:00:00.000Z",
      rawMethod: "tmux/paneApproval",
      signature: "$ mktemp /tmp/first",
      actions: [
        { key: "y", label: "允许一次" },
        { key: "Escape", label: "拒绝" },
      ],
    };
    const structuredApproval: ApprovalRequest = {
      ...fallbackApproval,
      requestId: "call-1",
      callId: "call-1",
      signature: "mktemp /tmp/first",
      command: "mktemp /tmp/first",
      rawMethod: "exec_command",
    };
    const bridge = {
      ...createBridgeStub(),
      getSessionFresh: vi.fn(async () => ({
        id: "tmux:taskB",
        runtimeState: "waitingApproval",
        recentMessages: [],
        activeApproval: structuredApproval,
        pendingApprovals: [structuredApproval],
      })),
      sendControl: vi.fn(async () => true),
    };
    const service = new TelegramBotService(
      bridge as never,
    ) as unknown as {
      bot: {
        api: {
          sendMessage: ReturnType<typeof vi.fn>;
        };
      };
      safeTelegram: (
        action: string,
        fn: () => Promise<void>,
      ) => Promise<boolean>;
      handleApprovalTokenAction(
        ctx: unknown,
        requestToken: string,
        key: "y" | "p" | "Escape",
      ): Promise<void>;
      approvalSessionByToken: Map<string, string>;
      approvalSignatureByToken: Map<string, string>;
      activeApprovalStateBySession: Map<
        string,
        { requestToken: string; callId: string }
      >;
      pendingApprovalByToken: Map<string, ApprovalRequest>;
      approvalTokenBySessionSignature: Map<string, string>;
      pendingApprovalSubmitTokens: Set<string>;
    };

    service.bot.api.sendMessage = vi.fn(async () => ({ message_id: 1 }));
    service.safeTelegram = async (_action, fn) => {
      await fn();
      return true;
    };
    service.pendingApprovalByToken.set("fallback-token-1", fallbackApproval);
    service.approvalSessionByToken.set("fallback-token-1", "tmux:taskB");
    service.approvalSignatureByToken.set("fallback-token-1", "$ mktemp /tmp/first");
    service.activeApprovalStateBySession.set("tmux:taskB", {
      requestToken: "fallback-token-1",
      callId: "$ mktemp /tmp/first",
    });

    const ctx = {
      chat: { id: 123456 },
      callbackQuery: {
        message: {
          message_id: 99,
          message_thread_id: 18,
        },
      },
      answerCallbackQuery: vi.fn(async () => undefined),
      editMessageReplyMarkup: vi.fn(async () => undefined),
    };

    await service.handleApprovalTokenAction(
      ctx,
      "fallback-token-1",
      "Escape",
    );

    expect(bridge.sendControl).toHaveBeenCalledWith("tmux:taskB", "Escape");
    expect(service.activeApprovalStateBySession.get("tmux:taskB")).toEqual({
      requestToken: "fallback-token-1",
      callId: "call-1",
    });
    expect(
      service.approvalTokenBySessionSignature.get(
        "tmux:taskB__CODEX_BRIDGE_APPROVAL__call-1",
      ),
    ).toBe("fallback-token-1");
  });

  it("点击结构化审批卡时，不会被 tmux fallback 版本反向降级", async () => {
    const structuredApproval: ApprovalRequest = {
      ...createApproval("call-1", "mktemp /tmp/first"),
      requestToken: "structured-token-1",
      command: "mktemp /tmp/first",
      rawMethod: "exec_command",
    };
    const fallbackApproval: ApprovalRequest = {
      ...createApproval("tmux-fallback-1", "$ mktemp /tmp/first"),
      requestToken: "fallback-token-1",
      callId: undefined,
      rawMethod: "tmux/paneApproval",
    };
    const bridge = {
      ...createBridgeStub(),
      getSessionFresh: vi.fn(async () => ({
        id: "tmux:taskB",
        runtimeState: "waitingApproval",
        recentMessages: [],
        activeApproval: fallbackApproval,
        pendingApprovals: [structuredApproval],
      })),
      sendControl: vi.fn(async () => true),
    };
    const service = new TelegramBotService(
      bridge as never,
    ) as unknown as {
      bot: {
        api: {
          sendMessage: ReturnType<typeof vi.fn>;
        };
      };
      safeTelegram: (
        action: string,
        fn: () => Promise<void>,
      ) => Promise<boolean>;
      handleApprovalTokenAction(
        ctx: unknown,
        requestToken: string,
        key: "y" | "p" | "Escape",
      ): Promise<void>;
      approvalSessionByToken: Map<string, string>;
      approvalSignatureByToken: Map<string, string>;
      activeApprovalStateBySession: Map<
        string,
        { requestToken: string; callId: string }
      >;
      pendingApprovalByToken: Map<string, ApprovalRequest>;
      approvalTokenBySessionSignature: Map<string, string>;
    };

    service.bot.api.sendMessage = vi.fn(async () => ({ message_id: 1 }));
    service.safeTelegram = async (_action, fn) => {
      await fn();
      return true;
    };
    service.pendingApprovalByToken.set("structured-token-1", structuredApproval);
    service.approvalSessionByToken.set("structured-token-1", "tmux:taskB");
    service.approvalSignatureByToken.set("structured-token-1", "call-1");
    service.activeApprovalStateBySession.set("tmux:taskB", {
      requestToken: "structured-token-1",
      callId: "call-1",
    });
    service.approvalTokenBySessionSignature.set(
      "tmux:taskB__CODEX_BRIDGE_APPROVAL__call-1",
      "structured-token-1",
    );

    const ctx = {
      chat: { id: 123456 },
      callbackQuery: {
        message: {
          message_id: 99,
          message_thread_id: 18,
        },
      },
      answerCallbackQuery: vi.fn(async () => undefined),
      editMessageReplyMarkup: vi.fn(async () => undefined),
    };

    await service.handleApprovalTokenAction(
      ctx,
      "structured-token-1",
      "y",
    );

    expect(bridge.sendControl).toHaveBeenCalledWith("tmux:taskB", "y");
    expect(service.activeApprovalStateBySession.get("tmux:taskB")).toEqual({
      requestToken: "structured-token-1",
      callId: "call-1",
    });
    expect(
      service.approvalTokenBySessionSignature.get(
        "tmux:taskB__CODEX_BRIDGE_APPROVAL__call-1",
      ),
    ).toBe("structured-token-1");
  });

  it("审批提交失败时会恢复 token，避免把审批卡卡死", async () => {
    const approval = createApproval("1", "$ mktemp first");
    const bridge = {
      ...createBridgeStub(),
      getSessionFresh: vi.fn(async () => ({
        id: "tmux:taskB",
        runtimeState: "waitingApproval",
        recentMessages: [],
        activeApproval: approval,
        pendingApprovals: [approval],
      })),
      sendControl: vi.fn(async () => false),
    };
    const service = new TelegramBotService(
      bridge as never,
    ) as unknown as {
      bot: {
        api: {
          sendMessage: ReturnType<typeof vi.fn>;
        };
      };
      safeTelegram: (
        action: string,
        fn: () => Promise<void>,
      ) => Promise<boolean>;
      handleApprovalTokenAction(
        ctx: unknown,
        requestToken: string,
        key: "y" | "p" | "Escape",
      ): Promise<void>;
      approvalSessionByToken: Map<string, string>;
      approvalSignatureByToken: Map<string, string>;
      activeApprovalStateBySession: Map<
        string,
        { requestToken: string; callId: string }
      >;
      pendingApprovalByToken: Map<string, ApprovalRequest>;
      pendingApprovalSubmitTokens: Set<string>;
    };

    service.bot.api.sendMessage = vi.fn(async () => ({ message_id: 1 }));
    service.safeTelegram = async (_action, fn) => {
      await fn();
      return true;
    };
    service.pendingApprovalByToken.set("1", approval);
    service.approvalSessionByToken.set("1", "tmux:taskB");
    service.approvalSignatureByToken.set("1", "1");
    service.activeApprovalStateBySession.set("tmux:taskB", {
      requestToken: "1",
      callId: "1",
    });

    const ctx = {
      chat: { id: 123456 },
      callbackQuery: {
        message: {
          message_id: 99,
          message_thread_id: 18,
        },
      },
      answerCallbackQuery: vi.fn(async () => undefined),
      editMessageReplyMarkup: vi.fn(async () => undefined),
    };

    await service.handleApprovalTokenAction(ctx, "1", "y");

    expect(service.pendingApprovalSubmitTokens.has("1")).toBe(false);
    expect(service.approvalSessionByToken.get("1")).toBe("tmux:taskB");
    expect(service.approvalSignatureByToken.get("1")).toBe("1");
    expect(service.bot.api.sendMessage).toHaveBeenCalledWith(
      123456,
      "没有找到目标窗口，审批卡已恢复，可重试。",
      { message_thread_id: 18 },
    );
  });
});
