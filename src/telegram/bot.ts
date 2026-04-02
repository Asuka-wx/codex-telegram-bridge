import { randomBytes } from "node:crypto";

import { Bot, InlineKeyboard, type Context, GrammyError, HttpError } from "grammy";

import type { BridgeService } from "../app/bridge-service.js";
import { ApprovalCoordinator } from "../approval/approval-coordinator.js";
import {
  getApprovalIdentity,
} from "../approval/approval-identity.js";
import type { SyncMode } from "../app/state-store.js";
import { config, isUserAllowed } from "../config.js";
import type {
  ApprovalActionKey,
  ApprovalRequest,
  SessionMessage,
  SessionSnapshot,
  TopicBinding,
} from "../types/domain.js";
import { logger } from "../utils/logger.js";
import {
  formatApprovalRequest,
  formatControlSummary,
  formatSessionMessage,
  formatSessionSummary,
} from "./formatters.js";

type BotContext = Context;

const APPROVAL_ACTION_KEYS = [
  "Enter",
  "y",
  "p",
  "Escape",
  "n",
  "C-c",
  "DownEnter",
  "DownDownEnter",
  "DownDownDownEnter",
] as const satisfies ApprovalActionKey[];

export const parseSessionSelection = (data: string): string =>
  data.replace("session:select:", "");

export const parseApprovalDecision = (data: string) => {
  const payload = data.replace("approval:", "");
  const separatorIndex = payload.lastIndexOf(":");
  const decision = separatorIndex === -1 ? "" : payload.slice(separatorIndex + 1);
  return {
    sessionId: separatorIndex === -1 ? "" : payload.slice(0, separatorIndex),
    decision: decision as
      | "accept"
      | "acceptRemember"
      | "acceptForSession"
      | "decline"
      | "cancel",
  };
};

export const parseTrailingSegment = (
  data: string,
  prefix: string,
): { sessionId: string; suffix: string } => {
  const payload = data.replace(prefix, "");
  const separatorIndex = payload.lastIndexOf(":");
  if (separatorIndex === -1) {
    return {
      sessionId: "",
      suffix: "",
    };
  }

  return {
    sessionId: payload.slice(0, separatorIndex),
    suffix: payload.slice(separatorIndex + 1),
  };
};

export const parseApprovalAction = (
  data: string,
): { sessionId: string; key: ApprovalActionKey | "" } => {
  const { sessionId, suffix } = parseTrailingSegment(data, "approvalKey:");
  const key = (
    APPROVAL_ACTION_KEYS.includes(suffix as ApprovalActionKey)
      ? suffix
      : ""
  ) as ApprovalActionKey | "";
  return {
    sessionId,
    key,
  };
};

export const parseApprovalTokenAction = (
  data: string,
): { requestToken: string; key: ApprovalActionKey | "" } => {
  const { sessionId: requestToken, suffix } = parseTrailingSegment(
    data,
    "approvalToken:",
  );
  const key = (
    APPROVAL_ACTION_KEYS.includes(suffix as ApprovalActionKey)
      ? suffix
      : ""
  ) as ApprovalActionKey | "";
  return {
    requestToken,
    key,
  };
};

export const parseToolOutputAction = (
  data: string,
): { requestToken: string; action: "open" | "" } => {
  const { sessionId: requestToken, suffix } = parseTrailingSegment(
    data,
    "toolOutput:",
  );
  return {
    requestToken,
    action: suffix === "open" ? "open" : "",
  };
};

const parseChatIntent = (text: string):
  | { type: "mode"; mode: SyncMode }
  | { type: "sessions" }
  | { type: "bindLatest" }
  | { type: "chatInfo" }
  | { type: "groupReady" }
  | { type: "setControl" }
  | { type: "clearControl" }
  | { type: "status" }
  | { type: "interrupt" }
  | { type: "key"; key: "Enter" | "y" | "p" | "Escape" | "C-c" }
  | null => {
  const normalized = text.trim();
  if (["当前信息", "本群信息", "聊天信息", "chat info"].includes(normalized)) {
    return { type: "chatInfo" };
  }
  if (["检查群准备", "群准备", "group ready"].includes(normalized)) {
    return { type: "groupReady" };
  }
  if (["设为总控", "设为总控群", "当前群设为总控"].includes(normalized)) {
    return { type: "setControl" };
  }
  if (["取消总控", "清除总控群"].includes(normalized)) {
    return { type: "clearControl" };
  }
  if (["总控", "窗口列表", "会话列表"].includes(normalized)) {
    return { type: "sessions" };
  }
  if (["绑定最新窗口", "绑定最新", "接上当前窗口"].includes(normalized)) {
    return { type: "bindLatest" };
  }
  if (["本地模式", "切到本地模式"].includes(normalized)) {
    return { type: "mode", mode: "local" };
  }
  if (["提醒模式", "切到提醒模式", "混合模式", "切到混合模式"].includes(normalized)) {
    return { type: "mode", mode: "hybrid" };
  }
  if (["远程模式", "切到远程模式"].includes(normalized)) {
    return { type: "mode", mode: "remote" };
  }
  if (["状态", "查看状态", "当前状态"].includes(normalized)) {
    return { type: "status" };
  }
  if (["中断", "停止", "停止当前任务"].includes(normalized)) {
    return { type: "interrupt" };
  }
  if (["回车", "继续"].includes(normalized)) {
    return { type: "key", key: "Enter" };
  }
  if (["允许", "同意"].includes(normalized)) {
    return { type: "key", key: "y" };
  }
  if (["允许并记住", "持续允许", "记住这次选择"].includes(normalized)) {
    return { type: "key", key: "p" };
  }
  if (["拒绝", "不同意"].includes(normalized)) {
    return { type: "key", key: "Escape" };
  }
  if (["取消", "取消确认"].includes(normalized)) {
    return { type: "key", key: "Escape" };
  }
  return null;
};

const isApprovalLikeKey = (key: "Enter" | "y" | "p" | "Escape" | "C-c"): boolean => {
  return key === "y" || key === "p" || key === "Escape";
};

const buildSessionControlKeyboard = (
  sessionId: string,
): InlineKeyboard | undefined => {
  const callbackData = [
    `control:status:${sessionId}`,
    `control:key:${sessionId}:Enter`,
    `control:key:${sessionId}:C-c`,
    `sessionMode:set:${sessionId}:local`,
    `sessionMode:set:${sessionId}:hybrid`,
    `sessionMode:set:${sessionId}:remote`,
  ];

  if (callbackData.some((value) => Buffer.byteLength(value, "utf8") > 64)) {
    return undefined;
  }

  return new InlineKeyboard()
    .text("查看状态", callbackData[0] ?? "")
    .row()
    .text("继续", callbackData[1] ?? "")
    .text("中断", callbackData[2] ?? "")
    .row()
    .text("本地模式", callbackData[3] ?? "")
    .text("提醒模式", callbackData[4] ?? "")
    .text("远程模式", callbackData[5] ?? "");
};

const buildControlKeyboard = (chatId: number) => {
  const keyboard = new InlineKeyboard()
    .text("刷新总控", "control:refresh")
    .text("设置", "control:settings")
    .row()
    .text("本地模式", "control:mode:local")
    .text("提醒模式", "control:mode:hybrid")
    .text("远程模式", "control:mode:remote");

  if (chatId > 0) {
    keyboard
      .row()
      .text("绑定最新窗口", "control:bindLatest")
      .text("查看当前状态", "control:currentStatus");
  }

  return keyboard;
};

const buildSettingsKeyboard = (chatId: number) => {
  const keyboard = new InlineKeyboard()
    .text("查看聊天信息", "control:chatInfo")
    .text("检查群准备", "control:groupReady")
    .row()
    .text("设为总控", "control:setControl")
    .text("取消总控", "control:clearControl")
    .row()
    .text("返回总控", "control:back");

  if (chatId > 0) {
    keyboard.row().text("绑定最新窗口", "control:bindLatest");
  }

  return keyboard;
};

const MAX_ARCHIVED_TOPIC_BINDINGS = 20;
const APPROVAL_RETRY_DELAY_MS = 5_000;
const MESSAGE_RETRY_DELAY_MS = 5_000;
const MAX_MESSAGE_DELIVERY_ATTEMPTS = 3;
const DELIVERED_MESSAGE_TTL_MS = 5 * 60_000;
const MAX_DELIVERED_MESSAGE_IDS = 2_000;
const TOOL_OUTPUT_PREVIEW_MAX_LINES = 8;
const TOOL_OUTPUT_PREVIEW_MAX_CHARS = 700;
const COLLAPSE_TOOL_OUTPUT_LINE_THRESHOLD = 18;
const COLLAPSE_TOOL_OUTPUT_CHAR_THRESHOLD = 1_200;
const COLLAPSED_MESSAGE_TTL_MS = 12 * 60 * 60_000;
const COMMENTARY_MERGE_WINDOW_MS = 1_200;
const BUILTIN_TELEGRAM_COMMANDS = new Set([
  "start",
  "help",
  "chatinfo",
  "groupready",
  "setcontrol",
  "clearcontrol",
  "sessions",
  "bind",
  "status",
  "interrupt",
]);

interface DeliveryTarget {
  chatId: number;
  threadId?: number;
}

interface PendingMessageDelivery {
  key: string;
  message: SessionMessage;
  target: DeliveryTarget;
  chunks: string[];
  nextChunkIndex: number;
  attempts: number;
  allowCollapse: boolean;
}

interface CollapsedMessageDelivery {
  target: DeliveryTarget;
  message: SessionMessage;
  chunks: string[];
  expiresAt: number;
}

interface PendingMergedMessageBuffer {
  message: SessionMessage;
  timer: NodeJS.Timeout;
}

interface GroupReadinessAdviceInput {
  chatId: number;
  currentControlChatId: number | null;
  status: string;
  canManageTopics: string;
  isForum: string;
  enableForumTopics: boolean;
}

interface GroupReadinessAdvice {
  recommendedState: string;
  nextStep: string;
}

export class TelegramBotService {
  private readonly bot = new Bot<BotContext>(config.telegram.token);

  private readonly botUserId = Number.parseInt(
    config.telegram.token.split(":")[0] ?? "0",
    10,
  );

  private readonly deliveredMessageIds = new Map<string, number>();

  private readonly telegramBackoffUntil = new Map<string, number>();

  private readonly approvalCoordinator: ApprovalCoordinator;

  private readonly pendingMessageDeliveries = new Map<string, PendingMessageDelivery>();

  private readonly collapsedMessageByToken = new Map<string, CollapsedMessageDelivery>();

  private readonly pendingMergedMessagesBySession = new Map<string, PendingMergedMessageBuffer>();

  private controlPanelSyncTimer: NodeJS.Timeout | null = null;

  private pendingControlPanelSessions: SessionSnapshot[] | null = null;

  private approvalRetryTimer: NodeJS.Timeout | null = null;

  private messageRetryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly bridge: BridgeService,
    approvalCoordinator?: ApprovalCoordinator,
  ) {
    this.approvalCoordinator =
      approvalCoordinator ??
      new ApprovalCoordinator((sessionId) =>
        this.bridge.getSessionFresh(sessionId),
      );
    this.registerHandlers();
  }

  private get activeApprovalStateBySession() {
    return this.approvalCoordinator.activeStateBySession;
  }

  private get approvalSessionByToken() {
    return this.approvalCoordinator.sessionByToken;
  }

  private get approvalSignatureByToken() {
    return this.approvalCoordinator.signatureByToken;
  }

  private get approvalTokenBySessionSignature() {
    return this.approvalCoordinator.tokenBySessionSignature;
  }

  private get activeApprovalSignatureByTarget() {
    return this.approvalCoordinator.activeSignatureByTarget;
  }

  private get pendingApprovalSubmitTokens() {
    return this.approvalCoordinator.pendingSubmitTokens;
  }

  private get pendingApprovalByToken() {
    return this.approvalCoordinator.pendingApprovalMap;
  }

  private get pendingApprovalRetryTokens() {
    return this.approvalCoordinator.pendingRetryTokens;
  }

  private get approvalDispatchQueueBySession() {
    return this.approvalCoordinator.dispatchQueueBySession;
  }

  async start(): Promise<void> {
    await this.bot.start();
    logger.info("Telegram bot 已启动");
  }

  async stop(): Promise<void> {
    if (this.controlPanelSyncTimer) {
      clearTimeout(this.controlPanelSyncTimer);
      this.controlPanelSyncTimer = null;
    }
    if (this.approvalRetryTimer) {
      clearTimeout(this.approvalRetryTimer);
      this.approvalRetryTimer = null;
    }
    if (this.messageRetryTimer) {
      clearTimeout(this.messageRetryTimer);
      this.messageRetryTimer = null;
    }
    for (const pending of this.pendingMergedMessagesBySession.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingMergedMessagesBySession.clear();
    await this.bot.stop();
  }

  requestControlPanelSync(sessions: SessionSnapshot[]): void {
    this.pendingControlPanelSessions = sessions;

    if (this.controlPanelSyncTimer) {
      clearTimeout(this.controlPanelSyncTimer);
    }

    this.controlPanelSyncTimer = setTimeout(() => {
      const payload = this.pendingControlPanelSessions;
      this.pendingControlPanelSessions = null;
      this.controlPanelSyncTimer = null;
      if (!payload) {
        return;
      }
      void this.syncControlPanel(payload, false);
    }, 1200);
    this.controlPanelSyncTimer.unref();
  }

  clearApprovalTracking(sessionId: string): void {
    this.approvalCoordinator.clearApprovalTracking(sessionId);
  }

  private hasActiveApprovalPressure(sessionId?: string): boolean {
    return this.approvalCoordinator.hasActiveApprovalPressure(sessionId);
  }

  private clearPendingMessageDeliveriesForSession(sessionId: string): void {
    for (const [key, delivery] of this.pendingMessageDeliveries.entries()) {
      if (delivery.message.sessionId === sessionId) {
        this.pendingMessageDeliveries.delete(key);
      }
    }
  }

  private scheduleApprovalRetry(): void {
    if (
      this.approvalRetryTimer ||
      this.pendingApprovalRetryTokens.size === 0
    ) {
      return;
    }

    this.approvalRetryTimer = setTimeout(() => {
      this.approvalRetryTimer = null;
      const pending = this.approvalCoordinator.getRetryApprovals();
      for (const approval of pending) {
        void this.sendApprovalRequest(approval);
      }
      if (this.pendingApprovalRetryTokens.size > 0) {
        this.scheduleApprovalRetry();
      }
    }, APPROVAL_RETRY_DELAY_MS);
    this.approvalRetryTimer.unref();
  }

  handleApprovalResolution(
    sessionId: string,
    approvalId: string,
  ): void {
    this.approvalCoordinator.handleApprovalResolution(sessionId, approvalId);
  }

  private async handleApprovalTokenAction(
    ctx: BotContext,
    requestToken: string,
    key: ApprovalActionKey,
  ): Promise<void> {
    const sessionId = this.approvalSessionByToken.get(requestToken) ?? "";
    const approval = this.pendingApprovalByToken.get(requestToken);
    const approvalId = approval ? getApprovalIdentity(approval) : "";
    const activeState =
      sessionId ? this.activeApprovalStateBySession.get(sessionId) : undefined;
    logger.info("收到审批按钮点击", {
      sessionId: sessionId || null,
      requestToken,
      key,
      approvalId: approvalId || null,
      activeApprovalId: activeState?.callId ?? null,
    });
    if (this.pendingApprovalSubmitTokens.has(requestToken)) {
      await this.answerCallbackQuerySafely(ctx, "审批处理中，请稍候。");
      return;
    }
    if (
      !sessionId ||
      !approval ||
      !approvalId ||
      !activeState ||
      activeState.requestToken !== requestToken ||
      activeState.callId !== approvalId
    ) {
      await this.answerCallbackQuerySafely(ctx, "这条审批已经失效。");
      await this.clearApprovalCallbackMarkup(ctx);
      return;
    }

    const callbackAnswer = this.answerCallbackQuerySafely(
      ctx,
      "已收到审批动作，正在校验并提交。",
    );

    const submitted = await this.approvalCoordinator.submitApprovalAction(
      requestToken,
      key,
      (resolvedSessionId, resolvedKey) =>
        this.bridge.sendControl(resolvedSessionId, resolvedKey),
    );
    if (submitted.status === "busy") {
      await callbackAnswer;
      return;
    }
    if (submitted.status === "invalid") {
      await callbackAnswer;
      await this.clearApprovalCallbackMarkup(ctx);
      await this.sendApprovalCallbackFollowUp(ctx, "这条审批已经失效。");
      return;
    }
    if (
      submitted.effectiveApprovalId &&
      approvalId &&
      submitted.effectiveApprovalId !== approvalId
    ) {
      logger.info("审批按钮点击已对齐到结构化审批身份", {
        sessionId: submitted.sessionId,
        requestToken,
        previousApprovalId: approvalId,
        effectiveApprovalId: submitted.effectiveApprovalId,
      });
    }

    if (submitted.status === "failed") {
      await callbackAnswer;
      await this.sendApprovalCallbackFollowUp(
        ctx,
        "没有找到目标窗口，审批卡已恢复，可重试。",
      );
      return;
    }

    if (submitted.status === "error") {
      logger.warn("审批动作提交失败", {
        sessionId: submitted.sessionId,
        approvalId: submitted.effectiveApprovalId ?? approvalId,
        requestToken,
        key,
        error: submitted.error,
      });
      await callbackAnswer;
      await this.sendApprovalCallbackFollowUp(
        ctx,
        "审批提交失败，请稍后重试。",
      );
      return;
    }

    await callbackAnswer;
    await this.clearApprovalCallbackMarkup(ctx);
  }

  private async answerCallbackQuerySafely(
    ctx: BotContext,
    text: string,
  ): Promise<void> {
    try {
      await ctx.answerCallbackQuery({ text });
    } catch (error) {
      logger.warn("Telegram callback 应答失败", {
        text,
        error,
      });
    }
  }

  private async clearApprovalCallbackMarkup(ctx: BotContext): Promise<void> {
    await this.safeTelegram("approval:clearMarkup", async () => {
      await ctx.editMessageReplyMarkup();
    });
  }

  private async sendApprovalCallbackFollowUp(
    ctx: BotContext,
    text: string,
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const threadId = ctx.callbackQuery?.message?.message_thread_id;
    await this.safeTelegram(
      `approval:followUp:${chatId}:${threadId ?? 0}`,
      async () => {
        await this.bot.api.sendMessage(chatId, text, {
          message_thread_id: threadId,
        });
      },
    );
  }

  async syncControlTopics(sessions: SessionMessage[] | SessionSnapshot[]): Promise<void> {
    const controlChatId = this.bridge.stateStore.getControlChatId();
    if (
      controlChatId === null ||
      !config.telegram.enableForumTopics ||
      controlChatId > 0
    ) {
      return;
    }

    const activeSessions = sessions as SessionSnapshot[];
    const activeMap = new Map(activeSessions.map((session) => [session.id, session]));

    for (const session of activeSessions) {
      const existing = this.bridge.stateStore.getTopicBindingBySessionForChat(
        session.id,
        controlChatId,
      );
      const title = session.name ?? session.id;

      if (!existing) {
        const topic = await this.safeTelegramResult(
          "syncControlTopics:createTopic",
          async () =>
            this.bot.api.createForumTopic(
              controlChatId,
              title,
            ),
        );
        if (!topic) {
          continue;
        }
        await this.bridge.stateStore.setTopicBinding({
          sessionId: session.id,
          chatId: controlChatId,
          topicId: topic.message_thread_id,
          title,
          createdAt: new Date().toISOString(),
          archivedAt: null,
          panelMessageId: null,
        });
        const createdBinding = this.bridge.stateStore.getTopicBindingBySessionForChat(
          session.id,
          controlChatId,
        );
        if (createdBinding) {
          await this.syncTopicPanel(session, createdBinding);
        }
        continue;
      }

      if (existing.title !== title) {
        const renamed = await this.safeTelegram("syncControlTopics:rename", async () => {
          await this.bot.api.editForumTopic(
            existing.chatId,
            existing.topicId,
            { name: title },
          );
        });
        if (renamed) {
          await this.bridge.stateStore.setTopicBinding({
            ...existing,
            title,
          });
        }
      }

      if (existing.archivedAt) {
        const reopened = await this.safeTelegram("syncControlTopics:reopen", async () => {
          await this.bot.api.reopenForumTopic(
            existing.chatId,
            existing.topicId,
          );
        });
        if (reopened) {
          await this.bridge.stateStore.reopenTopicBinding(session.id, controlChatId);
        }
      }

      const refreshedBinding = this.bridge.stateStore.getTopicBindingBySessionForChat(
        session.id,
        controlChatId,
      );
      if (refreshedBinding) {
        await this.syncTopicPanel(session, refreshedBinding);
      }
    }

    for (const binding of this.bridge.stateStore.listTopicBindings()) {
      if (binding.chatId !== controlChatId) {
        continue;
      }
      if (binding.archivedAt || activeMap.has(binding.sessionId)) {
        continue;
      }

      const archived = await this.safeTelegram("syncControlTopics:archive", async () => {
        await this.bot.api.sendMessage(
          binding.chatId,
          "该窗口当前已关闭，话题已归档。",
          { message_thread_id: binding.topicId },
        );
        await this.bot.api.closeForumTopic(binding.chatId, binding.topicId);
      });
      if (archived) {
        await this.bridge.stateStore.archiveTopicBinding(
          binding.sessionId,
          controlChatId,
          new Date().toISOString(),
        );
        await this.bridge.stateStore.pruneArchivedTopicBindings(
          controlChatId,
          MAX_ARCHIVED_TOPIC_BINDINGS,
        );
      }
    }
  }

  async syncControlPanel(sessions: SessionSnapshot[], force = true): Promise<void> {
    if (this.hasActiveApprovalPressure()) {
      return;
    }

    const chatId = this.bridge.stateStore.getControlChatId();
    if (chatId === null) {
      return;
    }

    if (chatId > 0 && !force) {
      return;
    }

    const summary = formatControlSummary(
      sessions,
      chatId > 0 ? this.bridge.stateStore.getSelectedSession(chatId) : null,
      this.bridge.stateStore.getSyncMode(chatId),
    );
    const messageId = this.bridge.stateStore.getControlPanelMessageId(chatId);

    if (messageId !== null) {
      const updated = await this.safeTelegram("syncControlPanel:edit", async () => {
        await this.bot.api.editMessageText(chatId, messageId, summary, {
          reply_markup: buildControlKeyboard(chatId),
        });
      });
      if (updated) {
        await this.pinMessage(chatId, messageId);
        return;
      }
      await this.bridge.stateStore.clearControlPanelMessageId(chatId);
    }

    await this.safeTelegram("syncControlPanel:create", async () => {
      const message = await this.bot.api.sendMessage(chatId, summary, {
        reply_markup: buildControlKeyboard(chatId),
      });
      await this.bridge.stateStore.setControlPanelMessageId(
        chatId,
        message.message_id,
        "message_thread_id" in message ? message.message_thread_id ?? null : null,
      );
      await this.pinMessage(chatId, message.message_id);
    });
  }

  private async replyControlOverview(
    ctx: BotContext,
    sessions: SessionSnapshot[],
    prefix?: string,
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const summary = formatControlSummary(
      sessions,
      null,
      this.bridge.stateStore.getSyncMode(chatId),
    );

    await ctx.reply(
      prefix ? `${prefix}\n\n${summary}` : summary,
      {
        reply_markup: buildControlKeyboard(chatId),
      },
    );
  }

  private async syncTopicPanel(
    session: SessionSnapshot,
    binding: TopicBinding,
  ): Promise<void> {
    if (this.hasActiveApprovalPressure(session.id)) {
      return;
    }

    const mode =
      this.bridge.stateStore.getSessionSyncMode(binding.chatId, session.id) ??
      this.bridge.stateStore.getSyncMode(binding.chatId);
    const summary = formatSessionSummary(session, mode);
    const keyboard = buildSessionControlKeyboard(session.id);

    if (binding.panelMessageId) {
      const updated = await this.safeTelegram("syncTopicPanel:edit", async () => {
        await this.bot.api.editMessageText(
          binding.chatId,
          binding.panelMessageId ?? 0,
          summary,
          {
            reply_markup: keyboard,
          },
        );
      });
      if (updated) {
        await this.pinMessage(binding.chatId, binding.panelMessageId);
        return;
      }
      await this.bridge.stateStore.clearTopicPanelMessageId(session.id, binding.chatId);
    }

    const message = await this.safeTelegramResult("syncTopicPanel:create", async () =>
      this.bot.api.sendMessage(binding.chatId, summary, {
        message_thread_id: binding.topicId,
        reply_markup: keyboard,
      }),
    );
    if (!message) {
      return;
    }

    await this.bridge.stateStore.setTopicBinding({
      ...binding,
      panelMessageId: message.message_id,
    });
    await this.pinMessage(binding.chatId, message.message_id);
  }

  async forwardSystemNotice(text: string, sessionId: string): Promise<void> {
    if (this.hasActiveApprovalPressure(sessionId)) {
      return;
    }

    const targets = this.getDeliveryTargets(sessionId);
    for (const target of targets) {
      if (!this.shouldNotifyChat(target.chatId, sessionId, target.threadId)) {
        continue;
      }
      await this.safeTelegram(
        `forwardSystemNotice:${buildDeliveryTargetKey(target)}`,
        async () => {
          await this.bot.api.sendMessage(target.chatId, text, {
            message_thread_id: target.threadId,
          });
        },
      );
    }
  }

  async forwardSessionMessage(message: SessionMessage): Promise<void> {
    if (message.source === "tmux" && this.hasActiveApprovalPressure(message.sessionId)) {
      return;
    }

    if (shouldBufferSemanticMessage(message)) {
      this.queueMergedSemanticMessage(message);
      return;
    }

    await this.flushMergedSemanticMessage(message.sessionId);
    await this.forwardSessionMessageNow(message);
  }

  private async forwardSessionMessageNow(message: SessionMessage): Promise<void> {
    if (message.source === "tmux" && this.hasActiveApprovalPressure(message.sessionId)) {
      return;
    }

    const targets = this.getDeliveryTargets(message.sessionId);
    if (targets.length === 0) {
      return;
    }

    const chunks = formatSessionMessage(message, config.telegram.messageMaxLength);
    for (const target of targets) {
      if (!this.shouldForwardMessageToTarget(target, message)) {
        continue;
      }

      const deliveryKey = buildMessageDeliveryKey(message.id, target);
      if (
        this.wasMessageDeliveredRecently(deliveryKey) ||
        this.pendingMessageDeliveries.has(deliveryKey)
      ) {
        continue;
      }

      const result = await this.deliverMessageChunks(
        message,
        target,
        chunks,
        0,
      );
      if (result.delivered) {
        this.markMessageDelivered(deliveryKey);
        continue;
      }

      this.pendingMessageDeliveries.set(deliveryKey, {
        key: deliveryKey,
        message,
        target,
        chunks,
        nextChunkIndex: result.nextChunkIndex,
        attempts: result.retryable ? 0 : 1,
        allowCollapse: true,
      });
      this.scheduleMessageRetry();
    }
  }

  private queueMergedSemanticMessage(message: SessionMessage): void {
    const existing = this.pendingMergedMessagesBySession.get(message.sessionId);
    if (existing && canMergeSemanticMessages(existing.message, message)) {
      clearTimeout(existing.timer);
      const merged = mergeSemanticMessages(existing.message, message);
      this.pendingMergedMessagesBySession.set(message.sessionId, {
        message: merged,
        timer: this.createMergedMessageTimer(message.sessionId),
      });
      return;
    }

    if (existing) {
      clearTimeout(existing.timer);
      this.pendingMergedMessagesBySession.delete(message.sessionId);
      void this.forwardSessionMessageNow(existing.message);
    }

    this.pendingMergedMessagesBySession.set(message.sessionId, {
      message,
      timer: this.createMergedMessageTimer(message.sessionId),
    });
  }

  private createMergedMessageTimer(sessionId: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      void this.flushMergedSemanticMessage(sessionId);
    }, COMMENTARY_MERGE_WINDOW_MS);
    timer.unref();
    return timer;
  }

  private async flushMergedSemanticMessage(sessionId: string): Promise<void> {
    const pending = this.pendingMergedMessagesBySession.get(sessionId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingMergedMessagesBySession.delete(sessionId);
    await this.forwardSessionMessageNow(pending.message);
  }

  async sendApprovalRequest(approval: ApprovalRequest): Promise<void> {
    await this.approvalCoordinator.enqueueDispatch(
      approval.sessionId,
      async () => this.sendApprovalRequestNow(approval),
    );
  }

  private async sendApprovalRequestNow(approval: ApprovalRequest): Promise<void> {
    this.clearPendingMessageDeliveriesForSession(approval.sessionId);

    const targets = this.getDeliveryTargets(approval.sessionId);
    const prepared = this.approvalCoordinator.prepareApprovalDispatch(approval);
    if (!prepared) {
      return;
    }
    const { approvalId, requestToken, queuedApproval } = prepared;

    const actions = approval.actions?.length
      ? approval.actions
      : [
          { key: "y", label: "允许一次" },
          { key: "Escape", label: "拒绝" },
        ];

    const keyboard = new InlineKeyboard();
    actions.forEach((action, index) => {
      keyboard.text(action.label, `approvalToken:${requestToken}:${action.key}`);
      if (index % 2 === 1 && index < actions.length - 1) {
        keyboard.row();
      }
    });

    if (targets.length === 0) {
      logger.warn("审批消息当前没有可投递目标，已进入重试队列", {
        sessionId: approval.sessionId,
        requestId: approval.requestId,
      });
      this.approvalCoordinator.queueRetry(requestToken);
      this.scheduleApprovalRetry();
      return;
    }

    let delivered = false;
    let hadFailure = false;
    for (const target of targets) {
      if (!this.shouldNotifyChat(target.chatId, approval.sessionId, target.threadId)) {
        continue;
      }

      const targetKey = `${target.chatId}:${target.threadId ?? 0}:${approval.sessionId}`;
      if (!this.approvalCoordinator.beginDispatchToTarget(targetKey, approvalId)) {
        continue;
      }

      const sent = await this.safeTelegram(
        `sendApprovalRequest:${target.chatId}:${target.threadId ?? 0}`,
        async () => {
          await this.bot.api.sendMessage(target.chatId, formatApprovalRequest(queuedApproval), {
            reply_markup: keyboard,
            message_thread_id: target.threadId,
          });
          delivered = true;
        },
      );
      if (!sent) {
        this.approvalCoordinator.rollbackDispatchToTarget(targetKey, approvalId);
        hadFailure = true;
      }
    }

    this.approvalCoordinator.finalizeApprovalDispatch(
      approval,
      requestToken,
      approvalId,
      delivered,
      hadFailure,
    );
    if (hadFailure) {
      this.scheduleApprovalRetry();
    }
  }

  private registerHandlers(): void {
    this.bot.use(async (ctx, next) => {
      if (!(await this.ensureAllowed(ctx))) {
        return;
      }
      await next();
    });

    this.bot.command("start", async (ctx) => {
      await ctx.reply(this.renderHelp());
    });

    this.bot.command("help", async (ctx) => {
      await ctx.reply(this.renderHelp());
    });

    this.bot.command("chatinfo", async (ctx) => {
      await ctx.reply(this.renderChatInfo(ctx));
    });

    this.bot.command("groupready", async (ctx) => {
      await ctx.reply(await this.renderGroupReadiness(ctx));
    });

    this.bot.command("setcontrol", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) {
        return;
      }
      await this.bridge.stateStore.addAllowedChatOverride(chatId);
      const previousControlChatId =
        await this.bridge.stateStore.handoffControlChat(chatId);
      await ctx.reply(`已将当前 chat 设为总控：${chatId}`);
      await this.syncControlPanel(await this.bridge.refreshSessions(), true);
      await this.syncControlTopics(await this.bridge.refreshSessions());
      if (previousControlChatId && previousControlChatId !== chatId) {
        await this.safeTelegram("setcontrol:handoffNotice", async () => {
          await this.bot.api.sendMessage(
            previousControlChatId,
            `总控已切换到 chat ${chatId}。当前 chat 已自动转为本地模式，后续不再作为主控制面。`,
          );
        });
      }
    });

    this.bot.command("clearcontrol", async (ctx) => {
      const chatId = ctx.chat?.id;
      await this.bridge.stateStore.clearControlChatIdOverride();
      if (chatId) {
        await this.bridge.stateStore.removeAllowedChatOverride(chatId);
      }
      await ctx.reply("已清除运行时总控群覆盖，恢复使用 .env 配置。");
      await this.syncControlPanel(await this.bridge.refreshSessions(), true);
      await this.syncControlTopics(await this.bridge.refreshSessions());
    });

    this.bot.command("sessions", async (ctx) => {
      const sessions = await this.bridge.refreshSessions();
      if (sessions.length === 0) {
        await ctx.reply("当前没有发现窗口。bridge 仍在监听；你稍后新建 tmux session 或启动 Codex 后，这里会自动出现。", {
          reply_markup: buildControlKeyboard(ctx.chat.id),
        });
        return;
      }

      const keyboard = new InlineKeyboard();
      for (const session of sessions.slice(0, 12)) {
        keyboard.text(session.name ?? session.id.slice(0, 8), `session:select:${session.id}`);
        keyboard.row();
      }

      const currentSessionId = this.resolveSessionIdFromContext(ctx);
      const message = formatControlSummary(
        sessions,
        currentSessionId,
        this.bridge.stateStore.getSyncMode(ctx.chat.id),
      );

      if (this.isControlOverviewContext(ctx)) {
        await this.syncControlTopics(sessions);
        await this.syncControlPanel(sessions, true);
        await this.replyControlOverview(ctx, sessions, "总控已刷新。");
        return;
      }

      await ctx.reply(message, {
        reply_markup: keyboard.row().text("设置", "control:noop"),
      });
    });

    this.bot.command("bind", async (ctx) => {
      const sessions = await this.bridge.refreshSessions();
      if (sessions.length === 0) {
        await ctx.reply("当前没有可绑定的窗口。你可以先创建 tmux session，bridge 会自动发现。");
        return;
      }

      const raw = ctx.match?.trim() ?? "";
      if (!raw || raw === "latest") {
        const first = sessions[0];
        if (!first) {
          await ctx.reply("当前没有可绑定的会话。");
          return;
        }
        await this.bindSession(ctx, first.id);
        return;
      }

      const index = Number.parseInt(raw, 10);
      if (!Number.isFinite(index) || index < 1 || index > Math.min(sessions.length, 12)) {
        await ctx.reply("绑定参数无效。用法：/bind latest 或 /bind 3");
        return;
      }

      const selected = sessions[index - 1];
      if (!selected) {
        await ctx.reply("没有找到对应编号的会话。");
        return;
      }

      await this.bindSession(ctx, selected.id);
    });

    this.bot.command("status", async (ctx) => {
      if (this.isControlOverviewContext(ctx)) {
        const sessions = await this.bridge.refreshSessions();
        await this.syncControlTopics(sessions);
        await this.syncControlPanel(sessions, true);
        await this.replyControlOverview(ctx, sessions, "当前是总控话题。这里显示的是全局概览，不绑定具体窗口。");
        return;
      }

      const sessionId = this.resolveSessionIdFromContext(ctx);
      if (!sessionId) {
        await ctx.reply("当前没有绑定会话，请先执行 /sessions。");
        return;
      }

      const session = await this.bridge.getSessionFresh(sessionId);
      if (!session) {
        await ctx.reply("没有找到对应窗口。");
        return;
      }

      await ctx.reply(formatSessionSummary(
        session,
        this.getSummaryMode(ctx.chat.id, sessionId),
      ), {
        reply_markup: buildSessionControlKeyboard(sessionId),
      });
    });

    this.bot.command("interrupt", async (ctx) => {
      const sessionId = this.resolveSessionIdFromContext(ctx);
      if (!sessionId) {
        await ctx.reply("当前没有绑定会话。");
        return;
      }

      const interrupted = await this.bridge.interruptSession(sessionId);
      await ctx.reply(interrupted ? "已发送中断请求。" : "当前会话没有正在进行中的 turn。");
    });

    this.bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;

      if (data.startsWith("session:select:")) {
        const sessionId = parseSessionSelection(data);
        await this.bindSession(ctx, sessionId);
        await this.syncControlPanel(await this.bridge.refreshSessions(), true);
        await ctx.answerCallbackQuery({ text: "已绑定会话" });
        return;
      }

      if (data === "control:noop") {
        const chatId = ctx.chat?.id;
        if (!chatId) {
          await ctx.answerCallbackQuery({ text: "找不到 chat。" });
          return;
        }
        await ctx.editMessageReplyMarkup({
          reply_markup: buildSettingsKeyboard(chatId),
        });
        await ctx.answerCallbackQuery({ text: "已打开设置。" });
        return;
      }

      if (data === "control:settings") {
        const chatId = ctx.chat?.id;
        if (!chatId) {
          await ctx.answerCallbackQuery({ text: "找不到 chat。" });
          return;
        }
        await ctx.editMessageReplyMarkup({
          reply_markup: buildSettingsKeyboard(chatId),
        });
        await ctx.answerCallbackQuery({ text: "已打开设置。" });
        return;
      }

      if (data === "control:back") {
        const chatId = ctx.chat?.id;
        if (!chatId) {
          await ctx.answerCallbackQuery({ text: "找不到 chat。" });
          return;
        }
        await ctx.editMessageReplyMarkup({
          reply_markup: buildControlKeyboard(chatId),
        });
        await ctx.answerCallbackQuery({ text: "已返回总控。" });
        return;
      }

      if (data === "control:setControl") {
        const chatId = ctx.chat?.id;
        if (!chatId) {
          await ctx.answerCallbackQuery({ text: "找不到 chat。" });
          return;
        }
      await this.bridge.stateStore.addAllowedChatOverride(chatId);
      const previousControlChatId =
        await this.bridge.stateStore.handoffControlChat(chatId);
      await this.syncControlPanel(await this.bridge.refreshSessions(), true);
        await this.syncControlTopics(await this.bridge.refreshSessions());
        if (previousControlChatId && previousControlChatId !== chatId) {
          await this.safeTelegram("control:setControl:handoffNotice", async () => {
            await this.bot.api.sendMessage(
              previousControlChatId,
              `总控已切换到 chat ${chatId}。当前 chat 已自动转为本地模式。`,
            );
          });
        }
        await ctx.answerCallbackQuery({ text: "已设为总控群。" });
        return;
      }

      if (data === "control:clearControl") {
        const chatId = ctx.chat?.id;
        await this.bridge.stateStore.clearControlChatIdOverride();
        if (chatId) {
          await this.bridge.stateStore.removeAllowedChatOverride(chatId);
        }
        await this.syncControlPanel(await this.bridge.refreshSessions(), true);
        await this.syncControlTopics(await this.bridge.refreshSessions());
        await ctx.answerCallbackQuery({ text: "已清除总控群覆盖。" });
        return;
      }

      if (data === "control:chatInfo") {
        await ctx.reply(this.renderChatInfo(ctx));
        await ctx.answerCallbackQuery({ text: "已发送当前聊天信息。" });
        return;
      }

      if (data === "control:groupReady") {
        await ctx.reply(await this.renderGroupReadiness(ctx));
        await ctx.answerCallbackQuery({ text: "已发送群准备检查。" });
        return;
      }

      if (data === "control:refresh") {
        const sessions = await this.bridge.refreshSessions();
        await this.syncControlTopics(sessions);
        await this.syncControlPanel(sessions, true);
        await ctx.answerCallbackQuery({ text: "总控已刷新。" });
        return;
      }

      if (data === "control:list") {
        const sessions = await this.bridge.refreshSessions();
        await this.syncControlTopics(sessions);
        await this.syncControlPanel(sessions, true);
        await ctx.answerCallbackQuery({ text: "总控已刷新。" });
        return;
      }

      if (data === "control:bindLatest") {
        const sessions = await this.bridge.refreshSessions();
        const first = sessions[0];
        if (!first) {
          await ctx.answerCallbackQuery({ text: "当前没有可绑定的窗口。" });
          return;
        }
        await this.bindSession(ctx, first.id);
        await this.syncControlPanel(await this.bridge.refreshSessions(), true);
        await ctx.answerCallbackQuery({ text: "已绑定最新窗口。" });
        return;
      }

      if (data === "control:currentStatus") {
        const sessions = await this.bridge.refreshSessions();
        await this.syncControlTopics(sessions);
        await this.syncControlPanel(sessions, true);
        const sessionId = this.resolveSessionIdFromContext(ctx);
        const chatId = ctx.chat?.id ?? 0;
        if (!sessionId) {
          await ctx.answerCallbackQuery({ text: "总控已刷新。" });
          return;
        }
        const session = await this.bridge.getSessionFresh(sessionId);
        if (!session) {
          await ctx.answerCallbackQuery({ text: "总控已刷新。" });
          return;
        }
        await ctx.reply(formatSessionSummary(
          session,
          this.getSummaryMode(chatId, sessionId),
        ), {
          reply_markup: buildSessionControlKeyboard(sessionId),
        });
        await ctx.answerCallbackQuery({ text: "已刷新当前状态。" });
        return;
      }

      if (data.startsWith("control:mode:")) {
        const mode = data.replace("control:mode:", "") as SyncMode;
        const chatId = ctx.chat?.id;
        if (!chatId) {
          await ctx.answerCallbackQuery({ text: "找不到 chat。" });
          return;
        }
        await this.bridge.stateStore.setSyncMode(chatId, mode);
        await this.syncControlPanel(await this.bridge.refreshSessions(), true);
        await ctx.answerCallbackQuery({ text: `已切到${mode}` });
        return;
      }

      if (data.startsWith("control:key:")) {
        const { sessionId, suffix: key } = parseTrailingSegment(data, "control:key:");
        if (!sessionId || !key) {
          await ctx.answerCallbackQuery({ text: "控制参数无效。" });
          return;
        }
        const success = await this.bridge.sendControl(
          sessionId,
          key as "Enter" | "y" | "p" | "Escape" | "C-c",
        );
        await ctx.answerCallbackQuery({ text: success ? "已发送控制键。" : "没有找到目标窗口。" });
        return;
      }

      if (data.startsWith("control:status:")) {
        const sessionId = data.replace("control:status:", "");
        const chatId = ctx.chat?.id ?? 0;
        const session = await this.bridge.getSessionFresh(sessionId);
        if (!session) {
          await ctx.answerCallbackQuery({ text: "没有找到目标窗口。" });
          return;
        }
        await ctx.reply(formatSessionSummary(
          session,
          this.getSummaryMode(chatId, sessionId),
        ), {
          reply_markup: buildSessionControlKeyboard(sessionId),
        });
        await ctx.answerCallbackQuery({ text: "已刷新状态。" });
        return;
      }

      if (data.startsWith("mode:set:")) {
        const { sessionId, suffix: mode } = parseTrailingSegment(data, "mode:set:");
        const chatId = ctx.chat?.id;
        if (!chatId || !sessionId || !mode) {
          await ctx.answerCallbackQuery({ text: "模式参数无效。" });
          return;
        }
        await this.bridge.stateStore.setSyncMode(chatId, mode as SyncMode);
        await this.syncControlPanel(await this.bridge.refreshSessions(), true);
        await ctx.answerCallbackQuery({ text: `已切到 ${mode} 模式` });
        const session = await this.bridge.getSessionFresh(sessionId);
        if (session) {
          await ctx.reply(
            `已切换模式：${mode}\n\n${formatSessionSummary(session, mode as SyncMode)}`,
            {
              reply_markup: buildSessionControlKeyboard(sessionId),
            },
          );
        }
        return;
      }

      if (data.startsWith("sessionMode:set:")) {
        const { sessionId, suffix: mode } = parseTrailingSegment(data, "sessionMode:set:");
        const chatId = ctx.chat?.id;
        if (!chatId || !sessionId || !mode) {
          await ctx.answerCallbackQuery({ text: "模式参数无效。" });
          return;
        }
        await this.bridge.stateStore.setSessionSyncMode(chatId, sessionId, mode as SyncMode);
        const session = await this.bridge.getSessionFresh(sessionId);
        await ctx.answerCallbackQuery({
          text: `已将窗口切到 ${renderModeLabel(mode as SyncMode)}`,
        });
        if (session) {
          await ctx.reply(
            `已切换窗口消息模式：${renderModeLabel(mode as SyncMode)}\n\n${formatSessionSummary(session, mode as SyncMode)}`,
            {
              reply_markup: buildSessionControlKeyboard(sessionId),
            },
          );
        }
        return;
      }

      if (data.startsWith("approval:")) {
        await this.answerCallbackQuerySafely(
          ctx,
          "这张旧审批卡已失效，请使用最新审批卡。",
        );
        await this.clearApprovalCallbackMarkup(ctx);
        return;
      }

      if (data.startsWith("approvalToken:")) {
        const { requestToken, key } = parseApprovalTokenAction(data);
        if (!requestToken || !key) {
          await this.answerCallbackQuerySafely(ctx, "审批参数无效。");
          return;
        }
        await this.handleApprovalTokenAction(ctx, requestToken, key);
        return;
      }

      if (data.startsWith("toolOutput:")) {
        const { requestToken, action } = parseToolOutputAction(data);
        if (!requestToken || action !== "open") {
          await ctx.answerCallbackQuery({ text: "输出参数无效。" });
          return;
        }

        this.pruneCollapsedMessages();
        const pending = this.collapsedMessageByToken.get(requestToken);
        const currentThreadId =
          ctx.callbackQuery.message?.message_thread_id;
        if (
          !pending ||
          pending.target.chatId !== (ctx.chat?.id ?? 0) ||
          (pending.target.threadId ?? null) !== (currentThreadId ?? null)
        ) {
          await ctx.answerCallbackQuery({ text: "这条输出已经失效。" });
          return;
        }

        const sent = await this.deliverExpandedCollapsedMessage(
          pending.target,
          pending.message,
          pending.chunks,
          requestToken,
        );
        await ctx.answerCallbackQuery({
          text: sent ? "已发送完整内容。" : "发送失败，请稍后重试。",
        });
        return;
      }
    });

    this.bot.on("message:text", async (ctx) => {
      if (isBuiltInTelegramCommand(ctx.message.text)) {
        return;
      }

      let intent = parseChatIntent(ctx.message.text);
      if (intent) {
        const sessionIdForIntent = this.resolveSessionIdFromContext(ctx);
        const isControlOverview = this.isControlOverviewContext(ctx);
        if (
          !sessionIdForIntent &&
          intent.type !== "sessions" &&
          intent.type !== "bindLatest" &&
          intent.type !== "mode" &&
          intent.type !== "chatInfo" &&
          intent.type !== "groupReady" &&
          intent.type !== "setControl" &&
          intent.type !== "clearControl" &&
          intent.type !== "status"
        ) {
          await ctx.reply("当前没有绑定窗口。先执行 /sessions 或直接发“绑定最新窗口”。");
          return;
        }
        if (
          isControlOverview &&
          (intent.type === "interrupt" || intent.type === "key")
        ) {
          await ctx.reply("总控话题只做概览和全局控制。要继续、中断或审批具体任务，请进入对应的 taskA / taskB 子话题。");
          return;
        }
        if (
          intent.type === "key" &&
          isApprovalLikeKey(intent.key) &&
          sessionIdForIntent
        ) {
          const session = await this.bridge.getSessionFresh(sessionIdForIntent);
          if (!session || session.runtimeState !== "waitingApproval") {
            intent = null;
          }
        }
        if (intent) {
          await this.handleIntent(ctx, sessionIdForIntent ?? "", intent);
          return;
        }
      }

      const sessionId = this.resolveSessionIdFromContext(ctx);
      if (!sessionId) {
        if (this.isControlOverviewContext(ctx)) {
          await ctx.reply("总控话题不直接承接任务输入。请进入对应的 taskA / taskB 子话题里继续对话。");
          return;
        }
        await ctx.reply("当前没有绑定窗口。先执行 /sessions 或直接发“绑定最新窗口”。");
        return;
      }

      const session = await this.bridge.getSessionFresh(sessionId);
      if (!session) {
        await ctx.reply("当前绑定的窗口暂时不可用，请先发“状态”或重新绑定最新窗口。");
        return;
      }

      if (session.codexAttached === false) {
        await ctx.reply(
          "当前 tmux 槽位还在，但 Codex 现在没有运行。\n先在专用机对应槽位里重新启动 Codex，TG 侧会继续复用这个窗口，不需要重新建话题。",
        );
        return;
      }

      await ctx.reply("已收到，正在把消息送进当前窗口。");
      try {
        const result = await this.bridge.sendUserInput(sessionId, ctx.message.text);
        await ctx.reply(result.mode === "send" ? "已把输入打进当前 tmux 窗口。" : "已发送。");
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "发送失败，请稍后再试。";
        await ctx.reply(message);
      }
    });

    this.bot.catch((error) => {
      const ctx = error.ctx;
      logger.error(`Telegram 更新处理失败: ${ctx.update.update_id}`, error.error);

      if (error.error instanceof GrammyError) {
        logger.error("Telegram 返回业务错误", error.error.description);
      } else if (error.error instanceof HttpError) {
        logger.error("Telegram 网络错误", error.error);
      } else {
        logger.error("未知 Telegram 错误", error.error);
      }
    });
  }

  private async bindSession(ctx: BotContext, sessionId: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      throw new Error("无法识别 chat id");
    }

    await this.bridge.stateStore.setSelectedSession(chatId, sessionId);
    const session = await this.bridge.getSessionFresh(sessionId);
    if (!session) {
      await ctx.reply("会话不存在。");
      return;
    }

    await this.syncControlTopics(await this.bridge.refreshSessions());

    const activeControlChatId = this.bridge.stateStore.getControlChatId();
    if (
      config.telegram.enableForumTopics &&
      activeControlChatId !== null &&
      chatId === activeControlChatId
    ) {
      const controlChatId = activeControlChatId;
      const existing = this.bridge.stateStore.getTopicBindingBySessionForChat(
        sessionId,
        controlChatId,
      );
      if (!existing) {
        const topic = await this.safeTelegramResult(
          "bindSession:createTopic",
          async () =>
            this.bot.api.createForumTopic(
              controlChatId,
              session.name ?? session.id.slice(0, 8),
            ),
        );
        if (!topic) {
          await ctx.reply("当前无法创建对应话题，请稍后再试。");
          return;
        }
        await this.bridge.stateStore.setTopicBinding({
          sessionId,
          chatId: controlChatId,
          topicId: topic.message_thread_id,
          title: session.name ?? session.id.slice(0, 8),
          createdAt: new Date().toISOString(),
          archivedAt: null,
        });
        await this.safeTelegram("bindSession:createTopic", async () => {
          await this.bot.api.sendMessage(
            controlChatId,
            `已绑定会话。\n\n${formatSessionSummary(session, this.getSummaryMode(controlChatId, sessionId))}`,
            { message_thread_id: topic.message_thread_id },
          );
        });
      }
    }

    await ctx.reply(`已绑定窗口：\n\n${formatSessionSummary(
      session,
      this.getSummaryMode(chatId, sessionId),
    )}`, {
      reply_markup: buildSessionControlKeyboard(sessionId),
    });
    await this.syncControlPanel(await this.bridge.refreshSessions(), true);
  }

  private getDeliveryTargets(sessionId: string): Array<{ chatId: number; threadId?: number }> {
    const targets: Array<{ chatId: number; threadId?: number }> = [];
    const controlChatId = this.bridge.stateStore.getControlChatId();
    const topicBinding =
      controlChatId === null
        ? null
        : this.bridge.stateStore.getTopicBindingBySessionForChat(
            sessionId,
            controlChatId,
          );

    if (topicBinding && controlChatId !== null && topicBinding.chatId === controlChatId) {
      targets.push({
        chatId: controlChatId,
        threadId: topicBinding.topicId,
      });
    }

    for (const binding of this.bridge.stateStore.listSelectedSessions()) {
      if (binding.sessionId !== sessionId) {
        continue;
      }

      if (
        config.telegram.enableForumTopics &&
        controlChatId !== null &&
        binding.chatId === controlChatId &&
        topicBinding
      ) {
        continue;
      }

      const alreadyIncluded = targets.some(
        (target) =>
          target.chatId === binding.chatId &&
          target.threadId === undefined,
      );
      if (!alreadyIncluded) {
        targets.push({
          chatId: binding.chatId,
        });
      }
    }

    return targets;
  }

  private shouldForwardMessage(chatId: number, message: SessionMessage): boolean {
    return this.shouldForwardMessageToTarget({ chatId }, message);
  }

  private shouldForwardMessageToTarget(
    target: { chatId: number; threadId?: number },
    message: SessionMessage,
  ): boolean {
    const mode = this.getEffectiveMode(
      target.chatId,
      message.sessionId,
      target.threadId,
    );
    if (mode === "remote") {
      if (message.role === "user" && target.chatId < 0) {
        return false;
      }
      return true;
    }
    if (mode === "local") {
      return false;
    }
    return message.role === "assistant" && message.phase === "final_answer";
  }

  private shouldNotifyChat(chatId: number, sessionId?: string, threadId?: number): boolean {
    const mode = this.getEffectiveMode(chatId, sessionId, threadId);
    return mode !== "local";
  }

  private getEffectiveMode(
    chatId: number,
    sessionId?: string,
    threadId?: number,
  ): SyncMode {
    if (threadId !== undefined && sessionId) {
      return (
        this.bridge.stateStore.getSessionSyncMode(chatId, sessionId) ??
        this.bridge.stateStore.getSyncMode(chatId)
      );
    }
    return this.bridge.stateStore.getSyncMode(chatId);
  }

  private getSummaryMode(chatId: number, sessionId: string): SyncMode {
    return (
      this.bridge.stateStore.getSessionSyncMode(chatId, sessionId) ??
      this.bridge.stateStore.getSyncMode(chatId)
    );
  }

  private async handleIntent(
    ctx: BotContext,
    sessionId: string,
    intent:
      | { type: "mode"; mode: SyncMode }
      | { type: "sessions" }
      | { type: "bindLatest" }
      | { type: "chatInfo" }
      | { type: "groupReady" }
      | { type: "setControl" }
      | { type: "clearControl" }
      | { type: "status" }
      | { type: "interrupt" }
      | { type: "key"; key: "Enter" | "y" | "p" | "Escape" | "C-c" },
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (intent.type === "chatInfo") {
      await ctx.reply(this.renderChatInfo(ctx));
      return;
    }

    if (intent.type === "groupReady") {
      await ctx.reply(await this.renderGroupReadiness(ctx));
      return;
    }

    if (intent.type === "setControl") {
      await this.bridge.stateStore.addAllowedChatOverride(chatId);
      const previousControlChatId =
        await this.bridge.stateStore.handoffControlChat(chatId);
      await ctx.reply(`已将当前 chat 设为总控：${chatId}`);
      await this.syncControlPanel(await this.bridge.refreshSessions(), true);
      await this.syncControlTopics(await this.bridge.refreshSessions());
      if (previousControlChatId && previousControlChatId !== chatId) {
        await this.safeTelegram("intent:setControl:handoffNotice", async () => {
          await this.bot.api.sendMessage(
            previousControlChatId,
            `总控已切换到 chat ${chatId}。当前 chat 已自动转为本地模式。`,
          );
        });
      }
      return;
    }

    if (intent.type === "clearControl") {
      await this.bridge.stateStore.removeAllowedChatOverride(chatId);
      await this.bridge.stateStore.clearControlChatIdOverride();
      await ctx.reply("已清除运行时总控群覆盖，恢复使用 .env 配置。");
      await this.syncControlPanel(await this.bridge.refreshSessions(), true);
      await this.syncControlTopics(await this.bridge.refreshSessions());
      return;
    }

    if (intent.type === "sessions") {
      const sessions = await this.bridge.refreshSessions();
      if (sessions.length === 0) {
        await ctx.reply("当前没有发现窗口。bridge 正在监听；你新建 tmux session 或启动 Codex 后，这里会自动出现。", {
          reply_markup: buildControlKeyboard(ctx.chat.id),
        });
        return;
      }
      const message = formatControlSummary(
        sessions,
        this.resolveSessionIdFromContext(ctx),
        this.bridge.stateStore.getSyncMode(chatId),
      );
      await this.syncControlTopics(sessions);
      await this.syncControlPanel(sessions, true);
      if (this.isControlOverviewContext(ctx)) {
        await this.replyControlOverview(ctx, sessions, "总控已刷新。这里默认只显示概览，不直接承接具体任务输入。");
        return;
      }
      await ctx.reply(message);
      return;
    }

    if (intent.type === "bindLatest") {
      const sessions = await this.bridge.refreshSessions();
      const first = sessions[0];
      if (!first) {
        await ctx.reply("当前还没有可绑定的窗口。bridge 正在监听，等你创建窗口后再发一次“绑定最新窗口”。");
        return;
      }
      await this.bindSession(ctx, first.id);
      return;
    }

    if (intent.type === "mode") {
      if (sessionId && !this.isControlOverviewContext(ctx) && chatId < 0) {
        await this.bridge.stateStore.setSessionSyncMode(chatId, sessionId, intent.mode);
        const session = await this.bridge.getSession(sessionId);
        await ctx.reply(
          session
            ? `已将窗口切换到${renderModeLabel(intent.mode)}。\n\n${formatSessionSummary(session, intent.mode)}`
            : `已将窗口切换到${renderModeLabel(intent.mode)}。`,
          session
            ? {
                reply_markup: buildSessionControlKeyboard(sessionId),
              }
            : undefined,
        );
        return;
      }

      await this.bridge.stateStore.setSyncMode(chatId, intent.mode);
      await this.syncControlPanel(await this.bridge.refreshSessions(), true);
      await ctx.reply(`已切换到${renderModeLabel(intent.mode)}。`);
      return;
    }

    if (intent.type === "status") {
      if (!sessionId) {
        const sessions = await this.bridge.refreshSessions();
        await this.syncControlTopics(sessions);
        await this.syncControlPanel(sessions, true);
        await this.replyControlOverview(
          ctx,
          sessions,
          "总控已刷新当前概览。要查看某个任务的详细状态，请进入对应的 taskA / taskB 子话题。",
        );
        return;
      }
      const session = await this.bridge.getSessionFresh(sessionId);
      if (!session) {
        await ctx.reply("没有找到当前窗口。");
        return;
      }
      await ctx.reply(
        formatSessionSummary(
          session,
          this.getSummaryMode(chatId, sessionId),
        ),
        {
          reply_markup: buildSessionControlKeyboard(sessionId),
        },
      );
      return;
    }

    if (intent.type === "interrupt") {
      const success = await this.bridge.interruptSession(sessionId);
      await ctx.reply(success ? "已发送中断。" : "当前窗口没有可中断的任务。");
      return;
    }

    const success = await this.bridge.sendControl(sessionId, intent.key);
    await ctx.reply(success ? "已发送控制键。" : "没有找到当前窗口。");
    }

  private resolveSessionIdFromContext(ctx: BotContext): string | null {
    return this.getContextScope(ctx).sessionId;
  }

  private isControlOverviewContext(ctx: BotContext): boolean {
    return this.getContextScope(ctx).isControlOverview;
  }

  private getContextScope(
    ctx: BotContext,
  ): { sessionId: string | null; isControlOverview: boolean } {
    const topicId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
    const chatId = ctx.chat?.id;
    const controlChatId = this.bridge.stateStore.getControlChatId();

    if (topicId !== undefined) {
      const binding =
        chatId === undefined
          ? this.bridge.stateStore.getTopicBindingByTopic(topicId)
          : this.bridge.stateStore.getTopicBindingByTopicForChat(topicId, chatId);
      if (binding) {
        return {
          sessionId: binding.sessionId,
          isControlOverview: false,
        };
      }

      const controlPanelMessageId =
        chatId === undefined
          ? null
          : this.bridge.stateStore.getControlPanelMessageId(chatId);
      const callbackMessageId = ctx.callbackQuery?.message?.message_id ?? null;

      if (
        chatId !== undefined &&
        chatId < 0 &&
        controlChatId === chatId &&
        controlPanelMessageId !== null &&
        callbackMessageId === controlPanelMessageId
      ) {
        return {
          sessionId: null,
          isControlOverview: true,
        };
      }

      return {
        sessionId: null,
        isControlOverview: false,
      };
    }

    if (chatId === undefined) {
      return {
        sessionId: null,
        isControlOverview: false,
      };
    }

    if (chatId < 0 && controlChatId === chatId) {
      return {
        sessionId: null,
        isControlOverview: true,
      };
    }

    return {
      sessionId: this.bridge.stateStore.getSelectedSession(chatId),
      isControlOverview: false,
    };
  }

  private async ensureAllowed(ctx: BotContext): Promise<boolean> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      throw new Error("未识别到 chat id");
    }

    const actorId =
      ctx.from?.id ??
      ctx.callbackQuery?.from.id ??
      ctx.message?.from?.id;

    const text = "text" in (ctx.message ?? {}) ? ctx.message?.text ?? "" : "";
    const intent = text ? parseChatIntent(text) : null;
    const bootstrapAllowed =
      (text.startsWith("/start") ||
        text.startsWith("/chatinfo") ||
        text.startsWith("/setcontrol") ||
        text.startsWith("/groupready")) ||
      (!!intent &&
        (intent.type === "chatInfo" ||
          intent.type === "setControl" ||
          intent.type === "groupReady"));

    if (!this.bridge.stateStore.isAllowedChat(chatId) && !bootstrapAllowed) {
      logger.warn("拒绝未授权 chat", { chatId });
      return false;
    }

    if (actorId !== undefined && !isUserAllowed(actorId)) {
      if (actorId === this.botUserId) {
        return false;
      }
      logger.warn("拒绝未授权用户", { chatId, actorId });
      return false;
    }

    return true;
  }

  private renderChatInfo(ctx: BotContext): string {
    const chat = ctx.chat;
    const actor = ctx.from ?? ctx.callbackQuery?.from ?? ctx.message?.from;
    const currentControlChatId = this.bridge.stateStore.getControlChatId();
    const chatId = chat?.id ?? 0;
    const isAllowedChat = this.bridge.stateStore.isAllowedChat(chatId);

    return [
      "当前聊天信息：",
      `chatId: ${chat?.id ?? "unknown"}`,
      `chatType: ${chat?.type ?? "unknown"}`,
      `chatTitle: ${"title" in (chat ?? {}) ? (chat as { title?: string }).title ?? "" : ""}`,
      `userId: ${actor?.id ?? "unknown"}`,
      `username: ${actor?.username ?? ""}`,
      `currentControlChatId: ${currentControlChatId ?? "unset"}`,
      `isAllowedChat: ${isAllowedChat}`,
      isAllowedChat
        ? "下一步：如果你想把当前群设为总控，发送 /setcontrol 或直接发“设为总控”。"
        : "下一步：当前群还不在允许列表里，但你可以直接发 /setcontrol 把它设为总控并加入运行时允许列表。",
    ].join("\n");
  }

  private renderHelp(): string {
    return [
      "Codex Telegram Bridge 已连接。",
      "",
      "常用入口：",
      "- 总控",
      "- 当前信息",
      "- 检查群准备",
      "- 设为总控",
      "- 绑定最新窗口",
      "- 状态",
      "- 本地模式 / 提醒模式 / 远程模式",
      "",
      "如果你准备切到正式私人群：",
      "1. 先发“当前信息”",
      "2. 再发“检查群准备”",
      "3. 然后发“设为总控”",
      "4. 最后发“绑定最新窗口”",
    ].join("\n");
  }

  private async renderGroupReadiness(ctx: BotContext): Promise<string> {
    const chat = ctx.chat;
    if (!chat) {
      return "无法识别当前 chat。";
    }

    if (chat.type === "private") {
      return [
        "当前是私聊，不是群组。",
        "如果你准备切到正式群组形态：",
        "1. 把 bot 拉进目标私人群",
        "2. 在群里发“当前信息”",
        "3. 再发“设为总控”",
      ].join("\n");
    }

    const me = await this.bot.api.getMe();
    const member = await this.safeTelegramResult("groupReady:getChatMember", async () =>
      this.bot.api.getChatMember(chat.id, me.id),
    );
    const fullChat = await this.safeTelegramResult("groupReady:getChat", async () =>
      this.bot.api.getChat(chat.id),
    );

    const status =
      member && "status" in member ? String(member.status) : "unknown";
    const canManageTopics =
      member && "can_manage_topics" in member
        ? String((member as { can_manage_topics?: boolean }).can_manage_topics ?? false)
        : "unknown";
    const isForum =
      fullChat && "is_forum" in fullChat
        ? String((fullChat as { is_forum?: boolean }).is_forum ?? false)
        : "unknown";
    const currentControlChatId = this.bridge.stateStore.getControlChatId();
    const isAllowedChat = this.bridge.stateStore.isAllowedChat(chat.id);

    const advice = getGroupReadinessAdvice({
      chatId: chat.id,
      currentControlChatId,
      status,
      canManageTopics,
      isForum,
      enableForumTopics: config.telegram.enableForumTopics,
    });

    return [
      "群准备检查：",
      `chatId: ${chat.id}`,
      `chatType: ${chat.type}`,
      `botStatus: ${status}`,
      `canManageTopics: ${canManageTopics}`,
      `isForum: ${isForum}`,
      `currentControlChatId: ${currentControlChatId ?? "unset"}`,
      `isAllowedChat: ${isAllowedChat}`,
      advice.recommendedState,
      `建议下一步：${advice.nextStep}`,
    ].join("\n");
  }

  private async safeTelegram(
    action: string,
    fn: () => Promise<void>,
  ): Promise<boolean> {
    const blockedUntil = this.telegramBackoffUntil.get(action);
    if (blockedUntil && blockedUntil > Date.now()) {
      return false;
    }

    try {
      await fn();
      return true;
    } catch (error) {
      if (
        error instanceof GrammyError &&
        error.error_code === 400 &&
        (
          error.description.includes("TOPIC_NOT_MODIFIED") ||
          error.description.includes("message is not modified")
        )
      ) {
        return true;
      }
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfterSeconds =
          typeof error.parameters?.retry_after === "number"
            ? error.parameters.retry_after
            : 30;
        this.telegramBackoffUntil.set(
          action,
          Date.now() + retryAfterSeconds * 1000,
        );
        logger.warn(
          `Telegram 限流(${action})，${retryAfterSeconds} 秒内暂停重试`,
        );
        return false;
      }
      logger.warn(`Telegram 调用失败(${action})`, error);
      return false;
    }
  }

  private async safeTelegramResult<T>(
    action: string,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const blockedUntil = this.telegramBackoffUntil.get(action);
    if (blockedUntil && blockedUntil > Date.now()) {
      return null;
    }

    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof GrammyError &&
        error.error_code === 400 &&
        (
          error.description.includes("TOPIC_NOT_MODIFIED") ||
          error.description.includes("message is not modified")
        )
      ) {
        return null;
      }
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfterSeconds =
          typeof error.parameters?.retry_after === "number"
            ? error.parameters.retry_after
            : 30;
        this.telegramBackoffUntil.set(
          action,
          Date.now() + retryAfterSeconds * 1000,
        );
        logger.warn(
          `Telegram 限流(${action})，${retryAfterSeconds} 秒内暂停重试`,
        );
        return null;
      }
      logger.warn(`Telegram 调用失败(${action})`, error);
      return null;
    }
  }

  private async pinMessage(chatId: number, messageId: number): Promise<void> {
    if (this.hasActiveApprovalPressure()) {
      return;
    }

    await this.safeTelegram("pinMessage", async () => {
      await this.bot.api.pinChatMessage(chatId, messageId, {
        disable_notification: true,
      });
    });
  }

  private async deliverMessageChunks(
    message: SessionMessage,
    target: DeliveryTarget,
    chunks: string[],
    startIndex: number,
    options: { allowCollapse?: boolean } = {},
  ): Promise<{ delivered: boolean; nextChunkIndex: number; retryable: boolean }> {
    const action = `forwardSessionMessage:${buildDeliveryTargetKey(target)}`;
    const blockedUntil = this.telegramBackoffUntil.get(action);
    if (blockedUntil && blockedUntil > Date.now()) {
      return {
        delivered: false,
        nextChunkIndex: startIndex,
        retryable: true,
      };
    }

    if (options.allowCollapse !== false && startIndex === 0 && shouldCollapseTelegramMessage(message)) {
      const requestToken = createApprovalToken();
      const preview = formatCollapsedTelegramMessagePreview(message);
      const replyMarkup = buildCollapsedToolOutputKeyboard(requestToken);
      const sent = await this.safeTelegram(action, async () => {
        await this.bot.api.sendMessage(target.chatId, preview.text, {
          message_thread_id: target.threadId,
          parse_mode: preview.parseMode,
          reply_markup: replyMarkup,
        });
      });

      if (!sent) {
        const nextBlockedUntil = this.telegramBackoffUntil.get(action);
        return {
          delivered: false,
          nextChunkIndex: startIndex,
          retryable:
            nextBlockedUntil !== undefined && nextBlockedUntil > Date.now(),
        };
      }

      this.rememberCollapsedMessage(requestToken, target, message, chunks);
      return {
        delivered: true,
        nextChunkIndex: chunks.length,
        retryable: false,
      };
    }

    for (let index = startIndex; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        continue;
      }

      const sent = await this.safeTelegram(action, async () => {
        const payload = formatTelegramChunk(message, chunk);
        await this.bot.api.sendMessage(target.chatId, payload.text, {
          message_thread_id: target.threadId,
          parse_mode: payload.parseMode,
        });
      });

      if (!sent) {
        const nextBlockedUntil = this.telegramBackoffUntil.get(action);
        return {
          delivered: false,
          nextChunkIndex: index,
          retryable:
            nextBlockedUntil !== undefined && nextBlockedUntil > Date.now(),
        };
      }
    }

    return {
      delivered: true,
      nextChunkIndex: chunks.length,
      retryable: false,
    };
  }

  private scheduleMessageRetry(): void {
    if (this.messageRetryTimer || this.pendingMessageDeliveries.size === 0) {
      return;
    }

    this.messageRetryTimer = setTimeout(() => {
      this.messageRetryTimer = null;
      void this.retryPendingMessageDeliveries();
    }, this.getMessageRetryDelay());
    this.messageRetryTimer.unref();
  }

  private getMessageRetryDelay(): number {
    const now = Date.now();
    let earliestBlockedUntil: number | null = null;

    for (const delivery of this.pendingMessageDeliveries.values()) {
      const blockedUntil = this.telegramBackoffUntil.get(
        `forwardSessionMessage:${buildDeliveryTargetKey(delivery.target)}`,
      );
      if (!blockedUntil || blockedUntil <= now) {
        return MESSAGE_RETRY_DELAY_MS;
      }

      earliestBlockedUntil =
        earliestBlockedUntil === null
          ? blockedUntil
          : Math.min(earliestBlockedUntil, blockedUntil);
    }

    if (earliestBlockedUntil === null) {
      return MESSAGE_RETRY_DELAY_MS;
    }

    return Math.max(MESSAGE_RETRY_DELAY_MS, earliestBlockedUntil - now);
  }

  private async retryPendingMessageDeliveries(): Promise<void> {
    const pending = [...this.pendingMessageDeliveries.values()];

    for (const delivery of pending) {
      const result = await this.deliverMessageChunks(
        delivery.message,
        delivery.target,
        delivery.chunks,
        delivery.nextChunkIndex,
        { allowCollapse: delivery.allowCollapse },
      );

      if (result.delivered) {
        this.pendingMessageDeliveries.delete(delivery.key);
        this.markMessageDelivered(delivery.key);
        continue;
      }

      if (!result.retryable) {
        delivery.attempts += 1;
      }
      delivery.nextChunkIndex = result.nextChunkIndex;
      if (result.nextChunkIndex > 0) {
        delivery.allowCollapse = false;
      }

      if (delivery.attempts >= MAX_MESSAGE_DELIVERY_ATTEMPTS) {
        this.pendingMessageDeliveries.delete(delivery.key);
        logger.warn("Telegram 输出发送失败，已放弃重试", {
          sessionId: delivery.message.sessionId,
          messageId: delivery.message.id,
          target: delivery.target,
        });
        continue;
      }

      this.pendingMessageDeliveries.set(delivery.key, delivery);
    }

    if (this.pendingMessageDeliveries.size > 0) {
      this.scheduleMessageRetry();
    }
  }

  private wasMessageDeliveredRecently(messageKey: string): boolean {
    const deliveredAt = this.deliveredMessageIds.get(messageKey);
    return deliveredAt !== undefined && Date.now() - deliveredAt < DELIVERED_MESSAGE_TTL_MS;
  }

  private markMessageDelivered(messageKey: string): void {
    const now = Date.now();
    this.deliveredMessageIds.set(messageKey, now);

    if (this.deliveredMessageIds.size <= MAX_DELIVERED_MESSAGE_IDS) {
      return;
    }

    for (const [key, deliveredAt] of this.deliveredMessageIds.entries()) {
      if (now - deliveredAt > DELIVERED_MESSAGE_TTL_MS) {
        this.deliveredMessageIds.delete(key);
      }
    }

    if (this.deliveredMessageIds.size <= MAX_DELIVERED_MESSAGE_IDS) {
      return;
    }

    const oldestKey = this.deliveredMessageIds.keys().next().value;
    if (oldestKey) {
      this.deliveredMessageIds.delete(oldestKey);
    }
  }

  private rememberCollapsedMessage(
    requestToken: string,
    target: DeliveryTarget,
    message: SessionMessage,
    chunks: string[],
  ): void {
    this.pruneCollapsedMessages();
    this.collapsedMessageByToken.set(requestToken, {
      target,
      message,
      chunks,
      expiresAt: Date.now() + COLLAPSED_MESSAGE_TTL_MS,
    });
  }

  private pruneCollapsedMessages(): void {
    const now = Date.now();
    for (const [requestToken, pending] of this.collapsedMessageByToken.entries()) {
      if (pending.expiresAt <= now) {
        this.collapsedMessageByToken.delete(requestToken);
      }
    }
  }

  private async deliverExpandedCollapsedMessage(
    target: DeliveryTarget,
    message: SessionMessage,
    chunks: string[],
    requestToken: string,
  ): Promise<boolean> {
    const action = `toolOutput:${buildDeliveryTargetKey(target)}:${requestToken}`;
    for (const chunk of chunks) {
      const sent = await this.safeTelegram(action, async () => {
        const payload = formatTelegramChunk(message, chunk);
        await this.bot.api.sendMessage(target.chatId, payload.text, {
          message_thread_id: target.threadId,
          parse_mode: payload.parseMode,
        });
      });
      if (!sent) {
        return false;
      }
    }
    return true;
  }
}

const createApprovalToken = (): string => {
  return randomBytes(6).toString("hex");
};

const buildCollapsedToolOutputKeyboard = (
  requestToken: string,
): InlineKeyboard | undefined => {
  const callbackData = `toolOutput:${requestToken}:open`;
  if (Buffer.byteLength(callbackData, "utf8") > 64) {
    return undefined;
  }

  return new InlineKeyboard().text("查看完整原文", callbackData);
};

const renderModeLabel = (mode: SyncMode): string => {
  if (mode === "local") {
    return "本地模式";
  }
  if (mode === "hybrid") {
    return "提醒模式";
  }
  return "远程模式";
};

export const isBuiltInTelegramCommand = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return false;
  }

  const token = trimmed.split(/\s+/, 1)[0] ?? "";
  const command = token.slice(1).split("@", 1)[0]?.toLowerCase() ?? "";
  return BUILTIN_TELEGRAM_COMMANDS.has(command);
};

export const getGroupReadinessAdvice = ({
  chatId,
  currentControlChatId,
  status,
  canManageTopics,
  isForum,
  enableForumTopics,
}: GroupReadinessAdviceInput): GroupReadinessAdvice => {
  if (currentControlChatId === chatId) {
    return {
      recommendedState: enableForumTopics
        ? "建议目标状态：保持当前总控群可用，Topics 权限和 forum 状态不要被关闭。"
        : "建议目标状态：保持当前总控群可用。",
      nextStep: "当前群已经是总控群。下一步直接发“绑定最新窗口”。",
    };
  }

  if (status !== "administrator" && status !== "creator") {
    return {
      recommendedState: enableForumTopics
        ? "建议目标状态：bot 为 administrator，canManageTopics=true，群已开启 Topics。"
        : "建议目标状态：bot 为 administrator。",
      nextStep: "下一步：先把 bot 提升为管理员。",
    };
  }

  if (enableForumTopics && isForum !== "true") {
    return {
      recommendedState:
        "建议目标状态：bot 为 administrator，canManageTopics=true，群已开启 Topics。",
      nextStep: "下一步：先把群组切换成 forum / Topics 模式，再发“设为总控”。",
    };
  }

  if (enableForumTopics && canManageTopics !== "true") {
    return {
      recommendedState:
        "建议目标状态：bot 为 administrator，canManageTopics=true，群已开启 Topics。",
      nextStep: "下一步：先给 bot 打开 Topics 管理权限，再发“设为总控”。",
    };
  }

  return {
    recommendedState: enableForumTopics
      ? "建议目标状态：bot 为 administrator，canManageTopics=true，群已开启 Topics。"
      : "建议目标状态：bot 为 administrator。",
    nextStep: "下一步：发“设为总控”，然后再发“绑定最新窗口”。",
  };
};

const buildDeliveryTargetKey = (target: DeliveryTarget): string =>
  `${target.chatId}:${target.threadId ?? 0}`;

const buildMessageDeliveryKey = (messageId: string, target: DeliveryTarget): string =>
  `${messageId}:${buildDeliveryTargetKey(target)}`;

type TelegramChunkPayload = {
  text: string;
  parseMode?: "HTML";
};

export const shouldCollapseTelegramToolOutput = (
  message: SessionMessage,
): boolean => {
  if (message.kind !== "tool" && message.role !== "tool") {
    return false;
  }

  const text = message.text.trim();
  if (!text) {
    return false;
  }

  const lineCount = text.split("\n").length;
  return (
    text.length > COLLAPSE_TOOL_OUTPUT_CHAR_THRESHOLD ||
    lineCount > COLLAPSE_TOOL_OUTPUT_LINE_THRESHOLD
  );
};

export const shouldCollapseTelegramSemanticMessage = (
  message: SessionMessage,
): boolean => {
  void message;
  return false;
};

export const shouldCollapseTelegramMessage = (
  message: SessionMessage,
): boolean => {
  return shouldCollapseTelegramToolOutput(message);
};

export const formatCollapsedTelegramMessagePreview = (
  message: SessionMessage,
): TelegramChunkPayload => {
  const text = message.text.trim() || "(空内容)";
  const lines = text.split("\n");
  const previewLines = buildToolPreviewLines(lines, TOOL_OUTPUT_PREVIEW_MAX_LINES);
  let preview = previewLines.join("\n");
  if (preview.length > TOOL_OUTPUT_PREVIEW_MAX_CHARS) {
    preview = `${preview.slice(0, TOOL_OUTPUT_PREVIEW_MAX_CHARS - 3)}...`;
  }

  const omittedLines = Math.max(0, lines.length - previewLines.length);
  const suffix =
    omittedLines > 0 || preview.length < text.length
      ? "其余内容已折叠，点击下方按钮查看完整内容。"
      : "点击下方按钮查看完整内容。";

  return {
    text: [
      "<b>【长工具输出已折叠】</b>",
      `<b>长度：</b><code>${lines.length} 行 / ${text.length} 字符</code>`,
      "<b>预览：</b>",
      `<pre>${escapeHtml(preview)}</pre>`,
      escapeHtml(suffix),
    ].join("\n"),
    parseMode: "HTML",
  };
};

export const formatTelegramChunk = (
  message: SessionMessage,
  chunk: string,
): TelegramChunkPayload => {
  if (!shouldUseRichTelegramFormatting(message)) {
    return { text: chunk };
  }

  const richText = formatRichTelegramText(message, chunk);
  if (richText) {
    return {
      text: richText,
      parseMode: "HTML",
    };
  }

  if (looksPreformattedChunk(chunk)) {
    return {
      text: `<pre>${escapeHtml(chunk)}</pre>`,
      parseMode: "HTML",
    };
  }

  return {
    text: chunk,
  };
};

const buildToolPreviewLines = (lines: string[], maxLines: number): string[] => {
  const picked: string[] = [];
  const seen = new Set<string>();
  const nonEmptyLines = lines.filter((line) => line.trim());

  const pushLine = (line: string): void => {
    const normalized = line.trim();
    if (!normalized || seen.has(normalized) || picked.length >= maxLines) {
      return;
    }
    seen.add(normalized);
    picked.push(line);
  };

  for (const line of nonEmptyLines) {
    if (isHighSignalToolPreviewLine(line.trim())) {
      pushLine(line);
    }
    if (picked.length >= maxLines) {
      return picked;
    }
  }

  if (picked.length > 0) {
    return picked;
  }

  for (let index = nonEmptyLines.length - 1; index >= 0; index -= 1) {
    pushLine(nonEmptyLines[index] ?? "");
    if (picked.length >= maxLines) {
      return picked;
    }
  }

  for (const line of nonEmptyLines) {
    pushLine(line);
    if (picked.length >= maxLines) {
      break;
    }
  }

  return picked;
};

const isHighSignalToolPreviewLine = (line: string): boolean => {
  return (
    looksErrorSummaryLine(line) ||
    looksKeyValueStatusLine(line) ||
    looksCommandResultLine(line) ||
    /^> /.test(line) ||
    /^[$]/.test(line) ||
    /^[✓✔✖✗]/.test(line) ||
    /^(Error|[A-Z][A-Za-z0-9]+Error):/.test(line) ||
    /\bexit\s+\d+\b/i.test(line) ||
    /^(处理结果|当前进度|验证结果|结论|下一步|这部分在|代码片段|附加日志|现在的变化)(：|:|$)/.test(
      line,
    )
  );
};

export const shouldBufferSemanticMessage = (message: SessionMessage): boolean => {
  return (
    message.source === "session_file" &&
    message.role === "assistant" &&
    message.phase === "commentary"
  );
};

export const canMergeSemanticMessages = (
  left: SessionMessage,
  right: SessionMessage,
): boolean => {
  return (
    shouldBufferSemanticMessage(left) &&
    shouldBufferSemanticMessage(right) &&
    left.sessionId === right.sessionId &&
    left.source === right.source &&
    left.role === right.role &&
    (left.phase ?? null) === (right.phase ?? null)
  );
};

export const mergeSemanticMessages = (
  left: SessionMessage,
  right: SessionMessage,
): SessionMessage => {
  return {
    ...right,
    id: `${left.id}+${right.id}`,
    text: [left.text.trim(), right.text.trim()].filter(Boolean).join("\n\n"),
    timestamp: right.timestamp,
    turnId: right.turnId ?? left.turnId ?? null,
  };
};

const formatRichTelegramText = (
  message: SessionMessage,
  text: string,
): string | null => {
  const semanticAssistant =
    message.source === "session_file" && message.role === "assistant";
  const lines = text.split("\n");
  let usedMarkup = false;

  const formatted = lines
    .map((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return "";
      }

      if (isDividerLine(trimmed)) {
        usedMarkup = true;
        return "";
      }

      const sectionLabel = getSectionLabel(trimmed, lines[index + 1]?.trim() ?? "");
      if (sectionLabel) {
        usedMarkup = true;
        const sectionBody = new RegExp(`^${escapeRegExp(sectionLabel)}[：:]?$`).test(trimmed)
          ? ""
          : trimmed;
        const renderedSectionBody = renderSemanticParagraph(
          sectionBody,
          semanticAssistant,
        );
        return sectionBody
          ? `${renderSectionHeading(sectionLabel)}\n${renderedSectionBody}`
          : renderSectionHeading(sectionLabel);
      }

      if (trimmed.startsWith("• ")) {
        usedMarkup = true;
        return formatBulletLine(trimmed.slice(2), "•");
      }

      if (trimmed.startsWith("- ")) {
        usedMarkup = true;
        return formatBulletLine(trimmed.slice(2), "•");
      }

      if (/^\d+\.\s+/.test(trimmed)) {
        usedMarkup = true;
        return formatNumberedLine(trimmed);
      }

      if (
        trimmed.startsWith("└ ") ||
        trimmed.startsWith("├ ") ||
        trimmed.startsWith("│ ")
      ) {
        usedMarkup = true;
        return `<code>${escapeHtml(trimmed)}</code>`;
      }

      if (looksCommandResultLine(trimmed)) {
        usedMarkup = true;
        return `<code>${escapeHtml(trimmed)}</code>`;
      }

      if (looksErrorSummaryLine(trimmed)) {
        usedMarkup = true;
        return formatErrorSummaryLine(trimmed);
      }

      if (looksKeyValueStatusLine(trimmed)) {
        usedMarkup = true;
        return formatKeyValueLine(trimmed);
      }

      const maybeRichParagraph = renderSemanticParagraph(line, semanticAssistant);
      if (maybeRichParagraph !== escapeHtml(line)) {
        usedMarkup = true;
        return maybeRichParagraph;
      }

      return maybeRichParagraph;
    })
    .join("\n")
    .trim();

  return usedMarkup ? formatted : null;
};

const looksPreformattedChunk = (text: string): boolean => {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");

  if (lines.length === 0) {
    return false;
  }

  const codeLikeLineCount = lines.filter(isCodeLikeLine).length;
  if (codeLikeLineCount >= Math.max(2, Math.ceil(lines.length / 2))) {
    return true;
  }

  return false;
};

const renderSectionHeading = (label: string): string => {
  return `<b><u>【${escapeHtml(label)}】</u></b>`;
};

const renderSemanticParagraph = (
  line: string,
  semanticAssistant: boolean,
): string => {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }

  const richParagraph = formatParagraphLine(trimmed);
  if (!semanticAssistant) {
    return richParagraph;
  }

  if (shouldQuoteSemanticParagraph(trimmed)) {
    return `<blockquote>${richParagraph}</blockquote>`;
  }

  return richParagraph;
};

const shouldQuoteSemanticParagraph = (text: string): boolean => {
  if (text.length < 14) {
    return false;
  }

  return (
    /[，。；：]/.test(text) ||
    /\bTG\b|\bTelegram\b/i.test(text) ||
    text.startsWith("现在的变化") ||
    text.startsWith("验证")
  );
};

const shouldUseRichTelegramFormatting = (message: SessionMessage): boolean => {
  return (
    message.source === "tmux" ||
    message.kind === "tool" ||
    message.role === "tool" ||
    (message.source === "session_file" && message.role === "assistant")
  );
};

const isDividerLine = (line: string): boolean => /^[-─━]{8,}$/.test(line);

const getSectionLabel = (line: string, nextLine: string): string | null => {
  if (line.startsWith("当前进度")) {
    return "当前进度";
  }
  if (line.startsWith("验证结果")) {
    return "验证结果";
  }
  if (line.startsWith("结论")) {
    return "结论";
  }
  if (line.startsWith("下一步")) {
    return "下一步";
  }
  if (line.startsWith("说明")) {
    return "说明";
  }
  if (line.startsWith("处理结果")) {
    return "处理结果";
  }
  if (line.startsWith("现在的变化")) {
    return "现在的变化";
  }
  if (line.startsWith("验证")) {
    return "验证结果";
  }
  if (line.startsWith("剩余风险")) {
    return "剩余风险";
  }
  if (line.startsWith("后续建议")) {
    return "后续建议";
  }
  if (line.startsWith("常用入口")) {
    return "常用入口";
  }
  if (line.startsWith("设计意图")) {
    return "设计意图";
  }
  if (line.startsWith("群准备检查")) {
    return "群准备检查";
  }
  if (line.startsWith("当前聊天信息")) {
    return "当前聊天信息";
  }
  if (
    line.endsWith("：") &&
    line.length <= 24 &&
    (nextLine.startsWith("- ") ||
      nextLine.startsWith("• ") ||
      /^\d+\.\s+/.test(nextLine))
  ) {
    return line.slice(0, -1);
  }
  return null;
};

const formatBulletLine = (text: string, marker: string): string => {
  const labelMatch = text.match(/^([^：:]{1,24})([：:])\s*(.*)$/);
  if (labelMatch) {
    const [, head = "", , body = ""] = labelMatch;
    return `${marker} <b>${escapeHtml(head)}：</b>${formatValueText(head, body)}`;
  }
  if (looksStandalonePathLike(text) || looksStandaloneCommand(text)) {
    return `${marker} <code>${escapeHtml(text)}</code>`;
  }
  return `${marker} ${formatInlineText(text)}`;
};

const formatNumberedLine = (text: string): string => {
  const match = text.match(/^(\d+)\.\s+(.*)$/);
  if (!match) {
    return formatInlineText(text);
  }

  const [, index = "", body = ""] = match;
  return `<b>${escapeHtml(index)}.</b> ${formatInlineText(body)}`;
};

const formatParagraphLine = (line: string): string => {
  if (looksStandalonePathLike(line.trim()) || looksStandaloneCommand(line.trim())) {
    return `<code>${escapeHtml(line.trim())}</code>`;
  }
  return formatInlineText(line);
};

const formatInlineText = (text: string): string => {
  const tokens: string[] = [];
  let working = text;

  const stash = (html: string): string => {
    const token = `@@TOKEN_${tokens.length}@@`;
    tokens.push(html);
    return token;
  };

  working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string) =>
    stash(`<code>${escapeHtml(label)}</code>`),
  );

  working = working.replace(/`([^`]+)`/g, (_match, code: string) =>
    stash(`<code>${escapeHtml(code)}</code>`),
  );

  working = working.replace(
    /(?<!\w)(pnpm [\w:-]+|npm run [\w:-]+|tmux [\w:-]+|\/[a-z][\w-]*)(?!\w)/g,
    (match: string) => stash(`<code>${escapeHtml(match)}</code>`),
  );

  working = working.replace(
    /(?<!\w)((?:~\/|\.{1,2}\/|\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+(?::\d+)?)?)(?!\w)/g,
    (match: string) => stash(`<code>${escapeHtml(match)}</code>`),
  );

  working = working.replace(
    /\b([A-Za-z0-9._-]+\.(?:log|txt|md|json|js|jsx|ts|tsx|sh|plist|yaml|yml))\b/g,
    (match: string) => stash(`<code>${escapeHtml(match)}</code>`),
  );

  working = working.replace(/\b(task[A-Za-z0-9_-]+)\b/g, (match: string) =>
    stash(`<code>${escapeHtml(match)}</code>`),
  );

  let escaped = escapeHtml(working);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = `@@TOKEN_${index}@@`;
    escaped = escaped.replace(token, tokens[index] ?? "");
  }
  return escaped;
};

const formatKeyValueLine = (line: string): string => {
  const match = line.match(/^([^：:]{1,24})([：:])\s*(.*)$/);
  if (!match) {
    return formatInlineText(line);
  }

  const [, label = "", , value = ""] = match;
  return `<b>${escapeHtml(label)}：</b>${formatValueText(label, value)}`;
};

const formatValueText = (label: string, value: string): string => {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return "";
  }

  if (shouldRenderValueAsCode(label, trimmedValue)) {
    return `<code>${escapeHtml(trimmedValue)}</code>`;
  }

  return formatInlineText(trimmedValue);
};

const shouldRenderValueAsCode = (label: string, value: string): boolean => {
  if (looksStandalonePathLike(value) || looksStandaloneCommand(value)) {
    return true;
  }

  if (/^(exit \d+|[A-Z_]{2,}|[a-f0-9]{7,}|call_[A-Za-z0-9]+)$/i.test(value)) {
    return true;
  }

  return /^(窗口|目录|界面目录|当前已绑定|会话|模型|上下文|文件|路径|日志|命令|Command|cwd|sessionId|callId|turnId|requestId|chatId|currentControlChatId|错误|失败|异常|Error)$/.test(
    label,
  );
};

const looksStandalonePathLike = (text: string): boolean => {
  return /^(?:~\/|\.{1,2}\/|\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+(?::\d+)?)?$/.test(
    text,
  );
};

const looksStandaloneCommand = (text: string): boolean => {
  return /^(?:(?:pnpm|npm|tmux|git|node|npx|python|python3|bash|zsh|sh|launchctl|codex|rg|sed|cat|tail|grep|find|ls|pwd|mkdir|rm|cp|mv|curl|wget|tsx|vitest|tsc|eslint)\b.*|\/[a-z][\w-]*(?:\s+.*)?)$/i.test(
    text,
  );
};

const looksErrorSummaryLine = (line: string): boolean => {
  return /^(错误|失败|异常|Error|[A-Z][A-Za-z0-9]+Error)[：:]/.test(line);
};

const formatErrorSummaryLine = (line: string): string => {
  const match = line.match(/^([^：:]{1,32})([：:])\s*(.*)$/);
  if (!match) {
    return `<b>错误：</b>${formatInlineText(line)}`;
  }

  const [, label = "", , value = ""] = match;
  return `<b>${escapeHtml(label)}：</b>${formatValueText(label, value)}`;
};

const looksCommandResultLine = (line: string): boolean => {
  return (
    line.startsWith("$ ") ||
    line.startsWith("> ") ||
    line.startsWith("/status") ||
    line.startsWith("/sessions") ||
    line.startsWith("/bind") ||
    /^Ran\b/.test(line) ||
    /^Edited\b/.test(line) ||
    /^Waited\b/.test(line) ||
    /^Search(ed)?\b/.test(line)
  );
};

const looksKeyValueStatusLine = (line: string): boolean => {
  return /^(窗口|目录|消息模式|状态|最近更新|预览|当前模式|当前已绑定|窗口总数|运行中|提示|chatId|chatType|botStatus|canManageTopics|isForum|currentControlChatId|isAllowedChat|会话|模型|上下文|界面目录|文件|路径|日志|命令|结果|输出|原因|影响|建议|风险|callId|turnId|requestId|sessionId)(：|:)/.test(
    line,
  );
};

const isCodeLikeLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  if (
    trimmed.startsWith("$ ") ||
    trimmed.startsWith("> ") ||
    trimmed.startsWith("| ") ||
    trimmed.startsWith("at ") ||
    trimmed.startsWith("diff --git") ||
    trimmed.startsWith("@@") ||
    trimmed.startsWith("import ") ||
    trimmed.startsWith("export ") ||
    trimmed.startsWith("const ") ||
    trimmed.startsWith("let ") ||
    trimmed.startsWith("function ") ||
    trimmed.startsWith("class ") ||
    trimmed.startsWith("interface ") ||
    trimmed.startsWith("type ") ||
    trimmed.startsWith("return ") ||
    trimmed.startsWith("if (") ||
    trimmed.startsWith("for (") ||
    trimmed.startsWith("while (")
  ) {
    return true;
  }

  if (
    trimmed.includes("=>") ||
    trimmed.includes("::") ||
    trimmed.includes("</") ||
    trimmed.includes("/>") ||
    /^\s*[[\]{}();,]+$/.test(line) ||
    /^([A-Z][A-Za-z0-9]+Error|Error):/.test(trimmed)
  ) {
    return true;
  }

  return false;
};

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
