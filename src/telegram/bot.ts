import { randomBytes } from "node:crypto";

import { Bot, InlineKeyboard, type Context, GrammyError, HttpError } from "grammy";

import type { BridgeService } from "../app/bridge-service.js";
import type { SyncMode } from "../app/state-store.js";
import { config, isUserAllowed } from "../config.js";
import type {
  ApprovalRequest,
  SessionMessage,
  SessionSnapshot,
  TopicBinding,
} from "../types/domain.js";
import { logger } from "../utils/logger.js";
import {
  isBuiltInTelegramCommand,
  parseApprovalTokenAction,
  parseChatIntent,
  parseSessionSelection,
  parseToolOutputAction,
  parseTrailingSegment,
  type TelegramChatIntent,
} from "./callbacks.js";
import {
  formatApprovalRequest,
  formatControlSummary,
  formatSessionMessage,
  formatSessionSummary,
} from "./formatters.js";
import { getGroupReadinessAdvice } from "./group-readiness.js";
import {
  buildCollapsedToolOutputKeyboard,
  buildControlKeyboard,
  buildSessionControlKeyboard,
  buildSettingsKeyboard,
  renderModeLabel,
} from "./keyboards.js";
import {
  canMergeSemanticMessages,
  formatCollapsedTelegramMessagePreview,
  formatTelegramChunk,
  mergeSemanticMessages,
  shouldBufferSemanticMessage,
  shouldCollapseTelegramMessage,
} from "./message-formatting.js";

type BotContext = Context;

const bi = (zh: string, en: string): string => `${zh} / ${en}`;

const isApprovalLikeKey = (key: "Enter" | "y" | "p" | "Escape" | "C-c"): boolean => {
  return key === "y" || key === "p" || key === "Escape";
};

const MAX_ARCHIVED_TOPIC_BINDINGS = 20;
const APPROVAL_RETRY_DELAY_MS = 5_000;
const MESSAGE_RETRY_DELAY_MS = 5_000;
const MAX_MESSAGE_DELIVERY_ATTEMPTS = 3;
const DELIVERED_MESSAGE_TTL_MS = 5 * 60_000;
const MAX_DELIVERED_MESSAGE_IDS = 2_000;
const COLLAPSED_MESSAGE_TTL_MS = 12 * 60 * 60_000;
const COMMENTARY_MERGE_WINDOW_MS = 1_200;
const APPROVAL_KEY_SEPARATOR = "__CODEX_BRIDGE_APPROVAL__";

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

export class TelegramBotService {
  private readonly bot = new Bot<BotContext>(config.telegram.token);

  private readonly botUserId = Number.parseInt(
    config.telegram.token.split(":")[0] ?? "0",
    10,
  );

  private readonly deliveredMessageIds = new Map<string, number>();

  private readonly telegramBackoffUntil = new Map<string, number>();

  private readonly activeApprovalStateBySession = new Map<
    string,
    { requestToken: string; callId: string }
  >();

  private readonly approvalSessionByToken = new Map<string, string>();

  private readonly approvalSignatureByToken = new Map<string, string>();

  private readonly approvalTokenBySessionSignature = new Map<string, string>();

  private readonly activeApprovalSignatureByTarget = new Map<string, string>();

  private readonly pendingApprovalSubmitTokens = new Set<string>();

  private readonly pendingApprovalByToken = new Map<string, ApprovalRequest>();

  private readonly pendingApprovalRetryTokens = new Set<string>();

  private readonly pendingMessageDeliveries = new Map<string, PendingMessageDelivery>();

  private readonly collapsedMessageByToken = new Map<string, CollapsedMessageDelivery>();

  private readonly pendingMergedMessagesBySession = new Map<string, PendingMergedMessageBuffer>();

  private controlPanelSyncTimer: NodeJS.Timeout | null = null;

  private pendingControlPanelSessions: SessionSnapshot[] | null = null;

  private approvalRetryTimer: NodeJS.Timeout | null = null;

  private messageRetryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly bridge: BridgeService) {
    this.registerHandlers();
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
    const current = this.activeApprovalStateBySession.get(sessionId);
    if (current) {
      this.approvalSessionByToken.delete(current.requestToken);
      this.approvalSignatureByToken.delete(current.requestToken);
      this.pendingApprovalSubmitTokens.delete(current.requestToken);
      this.pendingApprovalRetryTokens.delete(current.requestToken);
      this.pendingApprovalByToken.delete(current.requestToken);
      this.activeApprovalStateBySession.delete(sessionId);
    }
    for (const requestToken of this.getApprovalTokensForSession(sessionId)) {
      this.approvalSessionByToken.delete(requestToken);
      this.approvalSignatureByToken.delete(requestToken);
      this.pendingApprovalSubmitTokens.delete(requestToken);
      this.pendingApprovalRetryTokens.delete(requestToken);
      this.pendingApprovalByToken.delete(requestToken);
    }

    for (const approvalKey of this.getApprovalKeysForSession(sessionId)) {
      this.approvalTokenBySessionSignature.delete(approvalKey);
    }

    for (const key of [...this.activeApprovalSignatureByTarget.keys()]) {
      if (key.endsWith(`:${sessionId}`)) {
        this.activeApprovalSignatureByTarget.delete(key);
      }
    }
  }

  private hasActiveApprovalPressure(sessionId?: string): boolean {
    if (sessionId) {
      return (
        this.getApprovalTokensForSession(sessionId).length > 0 ||
        this.activeApprovalStateBySession.has(sessionId) ||
        [...this.pendingApprovalRetryTokens].some((token) =>
          this.approvalSessionByToken.get(token) === sessionId,
        ) ||
        [...this.pendingApprovalSubmitTokens].some((token) =>
          this.approvalSessionByToken.get(token) === sessionId,
        )
      );
    }

    return (
      this.approvalSessionByToken.size > 0 ||
      this.activeApprovalStateBySession.size > 0 ||
      this.pendingApprovalRetryTokens.size > 0 ||
      this.pendingApprovalSubmitTokens.size > 0
    );
  }

  private clearPendingMessageDeliveriesForSession(sessionId: string): void {
    for (const [key, delivery] of this.pendingMessageDeliveries.entries()) {
      if (delivery.message.sessionId === sessionId) {
        this.pendingMessageDeliveries.delete(key);
      }
    }
  }

  private getApprovalTokensForSession(sessionId: string): string[] {
    return [...this.approvalSessionByToken.entries()]
      .filter(([, mappedSessionId]) => mappedSessionId === sessionId)
      .map(([requestToken]) => requestToken);
  }

  private getApprovalKeysForSession(sessionId: string): string[] {
    return [...this.approvalTokenBySessionSignature.keys()].filter(
      (approvalKey) => getApprovalKeySessionId(approvalKey) === sessionId,
    );
  }

  private findApprovalToken(sessionId: string, approvalId: string): string | null {
    const approvalKey = buildApprovalKey(sessionId, approvalId);
    const token = this.approvalTokenBySessionSignature.get(approvalKey);
    if (token) {
      return token;
    }
    return this.getApprovalTokensForSession(sessionId).find((requestToken) => {
      const approval = this.pendingApprovalByToken.get(requestToken);
      return approval ? getApprovalIdentity(approval) === approvalId : false;
    }) ?? null;
  }

  handleApprovalResolution(sessionId: string, approvalId: string): void {
    for (const [requestToken, approval] of this.pendingApprovalByToken.entries()) {
      if (
        approval.sessionId !== sessionId ||
        getApprovalIdentity(approval) !== approvalId
      ) {
        continue;
      }

      this.pendingApprovalByToken.delete(requestToken);
      this.pendingApprovalSubmitTokens.delete(requestToken);
      this.pendingApprovalRetryTokens.delete(requestToken);
      this.approvalSessionByToken.delete(requestToken);
      this.approvalSignatureByToken.delete(requestToken);
    }

    const approvalKey = buildApprovalKey(sessionId, approvalId);
    this.approvalTokenBySessionSignature.delete(approvalKey);

    const activeState = this.activeApprovalStateBySession.get(sessionId);
    if (activeState?.callId === approvalId) {
      this.activeApprovalStateBySession.delete(sessionId);
    }

    for (const key of [...this.activeApprovalSignatureByTarget.keys()]) {
      if (!key.endsWith(`:${sessionId}`)) {
        continue;
      }
      if (this.activeApprovalSignatureByTarget.get(key) === approvalId) {
        this.activeApprovalSignatureByTarget.delete(key);
      }
    }
  }

  private scheduleApprovalTokenRelease(
    sessionId: string,
    requestToken: string,
    signature: string,
  ): void {
    const timer = setTimeout(() => {
      void (async () => {
        const activeState = this.activeApprovalStateBySession.get(sessionId);
        if (
          activeState &&
          activeState.requestToken === requestToken &&
          activeState.callId === signature
        ) {
          const session = await this.bridge.getSessionFresh(sessionId);
          if (
            session?.runtimeState === "waitingApproval" &&
            getApprovalIdentity(session.activeApproval ?? {}) === signature
          ) {
            this.approvalSessionByToken.set(requestToken, sessionId);
            this.approvalSignatureByToken.set(requestToken, signature);
          }
        }
        this.pendingApprovalSubmitTokens.delete(requestToken);
      })();
    }, 1500);
    timer.unref();
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
      const pending = [...this.pendingApprovalRetryTokens]
        .map((requestToken) => this.pendingApprovalByToken.get(requestToken))
        .filter((approval): approval is ApprovalRequest => approval !== undefined);
      for (const approval of pending) {
        void this.sendApprovalRequest(approval);
      }
      if (this.pendingApprovalRetryTokens.size > 0) {
        this.scheduleApprovalRetry();
      }
    }, APPROVAL_RETRY_DELAY_MS);
    this.approvalRetryTimer.unref();
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
    this.clearPendingMessageDeliveriesForSession(approval.sessionId);

    const targets = this.getDeliveryTargets(approval.sessionId);
    const approvalId = getApprovalIdentity(approval);
    const existingState = this.activeApprovalStateBySession.get(approval.sessionId);
    if (existingState && existingState.callId !== approvalId) {
      logger.info("已存在活动审批，忽略新的发卡请求", {
        sessionId: approval.sessionId,
        activeApprovalId: existingState.callId,
        incomingApprovalId: approvalId,
      });
      return;
    }
    const requestToken =
      approval.requestToken ??
      this.findApprovalToken(approval.sessionId, approvalId) ??
      (existingState && existingState.callId === approvalId
        ? existingState.requestToken
        : createApprovalToken());

    this.approvalTokenBySessionSignature.set(
      buildApprovalKey(approval.sessionId, approvalId),
      requestToken,
    );
    this.approvalSessionByToken.set(requestToken, approval.sessionId);
    this.approvalSignatureByToken.set(requestToken, approvalId);

    const queuedApproval: ApprovalRequest = {
      ...approval,
      requestToken,
      callId: approval.callId ?? approvalId,
      signature: approval.signature ?? approvalId,
    };
    this.pendingApprovalByToken.set(requestToken, queuedApproval);
    this.activeApprovalStateBySession.set(approval.sessionId, {
      requestToken,
      callId: approvalId,
    });

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
      this.pendingApprovalRetryTokens.add(requestToken);
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
      if (this.activeApprovalSignatureByTarget.get(targetKey) === approvalId) {
        continue;
      }
      this.activeApprovalSignatureByTarget.set(targetKey, approvalId);

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
        if (this.activeApprovalSignatureByTarget.get(targetKey) === approvalId) {
          this.activeApprovalSignatureByTarget.delete(targetKey);
        }
        hadFailure = true;
      }
    }

    if (delivered) {
      logger.info("审批消息已送达 Telegram", {
        sessionId: approval.sessionId,
        requestId: approval.requestId,
      });
      this.activeApprovalStateBySession.set(approval.sessionId, {
        requestToken,
        callId: approvalId,
      });
    }

    if (hadFailure) {
      logger.warn("审批消息未即时送达，已进入重试队列", {
        sessionId: approval.sessionId,
        requestId: approval.requestId,
        delivered,
      });
      this.pendingApprovalRetryTokens.add(requestToken);
      this.scheduleApprovalRetry();
    } else {
      this.pendingApprovalRetryTokens.delete(requestToken);
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
        await ctx.editMessageReplyMarkup();
        await ctx.answerCallbackQuery({ text: "这张旧审批卡已失效，请使用最新审批卡。" });
        return;
      }

      if (data.startsWith("approvalToken:")) {
        const { requestToken, key } = parseApprovalTokenAction(data);
        if (!requestToken || !key) {
          await ctx.answerCallbackQuery({ text: "审批参数无效。" });
          return;
        }

        const sessionId = this.approvalSessionByToken.get(requestToken) ?? "";
        const approval = this.pendingApprovalByToken.get(requestToken);
        const approvalId = approval ? getApprovalIdentity(approval) : "";
        const activeState =
          sessionId ? this.activeApprovalStateBySession.get(sessionId) : undefined;
        if (
          !sessionId ||
          !approval ||
          !approvalId ||
          !activeState ||
          activeState.requestToken !== requestToken ||
          activeState.callId !== approvalId
        ) {
          await ctx.editMessageReplyMarkup();
          await ctx.answerCallbackQuery({ text: "这条审批已经失效。" });
          return;
        }

        if (this.pendingApprovalSubmitTokens.has(requestToken)) {
          await ctx.answerCallbackQuery({ text: "审批处理中，请稍候。" });
          return;
        }

        const session = await this.bridge.getSessionFresh(sessionId);
        const expectedApprovalId =
          session?.activeApproval?.callId ??
          session?.activeApproval?.signature ??
          session?.activeApproval?.command ??
          (session?.activeApproval
            ? String(session.activeApproval.requestId)
            : session?.pendingApprovals?.[0]?.callId ??
              session?.pendingApprovals?.[0]?.signature ??
              session?.pendingApprovals?.[0]?.command ??
              (session?.pendingApprovals?.[0]
                ? String(session.pendingApprovals[0].requestId)
                : ""));
        if (
          !session ||
          session.runtimeState !== "waitingApproval" ||
          !expectedApprovalId ||
          expectedApprovalId !== approvalId
        ) {
          this.handleApprovalResolution(sessionId, approvalId);
          await ctx.editMessageReplyMarkup();
          await ctx.answerCallbackQuery({ text: "这条审批已经失效。" });
          return;
        }

        this.approvalSessionByToken.delete(requestToken);
        this.approvalSignatureByToken.delete(requestToken);
        this.pendingApprovalSubmitTokens.add(requestToken);
        const success = await this.bridge.sendControl(sessionId, key);
        if (!success) {
          this.pendingApprovalSubmitTokens.delete(requestToken);
          this.approvalSessionByToken.set(requestToken, sessionId);
          this.approvalSignatureByToken.set(requestToken, approvalId);
        } else {
          this.scheduleApprovalTokenRelease(
            sessionId,
            requestToken,
            approvalId,
          );
        }
        await ctx.answerCallbackQuery({
          text: success ? "已发送审批动作，等待窗口状态更新。" : "没有找到目标窗口。",
        });
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
        const currentThreadId = ctx.callbackQuery.message?.message_thread_id;
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
          await ctx.reply("总控话题只做概览和全局控制。要继续、中断或审批具体任务，请进入对应任务子话题。");
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
          await ctx.reply("总控话题不直接承接任务输入。请进入对应任务子话题里继续对话。");
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
    intent: TelegramChatIntent,
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
          "总控已刷新当前概览。要查看某个任务的详细状态，请进入对应任务子话题。",
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
      const controlPanelThreadId =
        chatId === undefined
          ? null
          : this.bridge.stateStore.getControlPanelThreadId(chatId);
      const callbackMessageId = ctx.callbackQuery?.message?.message_id ?? null;

      if (
        chatId !== undefined &&
        chatId < 0 &&
        controlChatId === chatId &&
        (
          (controlPanelThreadId !== null && controlPanelThreadId === topicId) ||
          (
            controlPanelMessageId !== null &&
            callbackMessageId === controlPanelMessageId
          )
        )
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
      bi("当前聊天信息", "Current Chat Info"),
      `chatId: ${chat?.id ?? "unknown"}`,
      `chatType: ${chat?.type ?? "unknown"}`,
      `chatTitle: ${"title" in (chat ?? {}) ? (chat as { title?: string }).title ?? "" : ""}`,
      `userId: ${actor?.id ?? "unknown"}`,
      `username: ${actor?.username ?? ""}`,
      `currentControlChatId: ${currentControlChatId ?? "unset"}`,
      `isAllowedChat: ${isAllowedChat}`,
      isAllowedChat
        ? bi(
            "下一步：如果你想把当前群设为总控，发送 /setcontrol 或直接发“设为总控”。",
            "Next: if you want to use this chat as the control chat, send /setcontrol.",
          )
        : bi(
            "下一步：当前群还不在允许列表里，但你可以直接发 /setcontrol 把它设为总控并加入运行时允许列表。",
            "Next: this chat is not yet allowlisted, but you can send /setcontrol to make it the control chat and add it to the runtime allowlist.",
          ),
    ].join("\n");
  }

  private renderHelp(): string {
    return [
      bi("Codex Telegram Bridge 已连接。", "Codex Telegram Bridge is connected."),
      "",
      bi("常用入口", "Common Actions"),
      `- ${bi("总控", "Sessions")}`,
      `- ${bi("当前信息", "/chatinfo")}`,
      `- ${bi("检查群准备", "/groupready")}`,
      `- ${bi("设为总控", "/setcontrol")}`,
      `- ${bi("绑定最新窗口", "Bind Latest")}`,
      `- ${bi("状态", "/status")}`,
      `- ${bi("本地模式 / 提醒模式 / 远程模式", "Local / Hybrid / Remote mode")}`,
      "",
      bi("如果你准备切到正式私人群", "If you want to move to a private production-style group"),
      `1. ${bi("先发“当前信息”", "Send /chatinfo")}`,
      `2. ${bi("再发“检查群准备”", "Then send /groupready")}`,
      `3. ${bi("然后发“设为总控”", "Then send /setcontrol")}`,
      `4. ${bi("最后发“绑定最新窗口”", "Finally bind the latest session")}`,
    ].join("\n");
  }

  private async renderGroupReadiness(ctx: BotContext): Promise<string> {
    const chat = ctx.chat;
    if (!chat) {
      return bi("无法识别当前 chat。", "Unable to detect the current chat.");
    }

    if (chat.type === "private") {
      return [
        bi("当前是私聊，不是群组。", "This is a private chat, not a group."),
        bi("如果你准备切到正式群组形态", "If you want to switch to a production-style group"),
        `1. ${bi("把 bot 拉进目标私人群", "Add the bot to your target private group")}`,
        `2. ${bi("在群里发“当前信息”", "Send /chatinfo in that group")}`,
        `3. ${bi("再发“设为总控”", "Then send /setcontrol")}`,
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
      const stillMatched = this.getDeliveryTargets(delivery.message.sessionId).some(
        (target) =>
          target.chatId === delivery.target.chatId &&
          target.threadId === delivery.target.threadId,
      );
      if (!stillMatched || !this.shouldForwardMessageToTarget(delivery.target, delivery.message)) {
        this.pendingMessageDeliveries.delete(delivery.key);
        continue;
      }

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

const buildDeliveryTargetKey = (target: DeliveryTarget): string =>
  `${target.chatId}:${target.threadId ?? 0}`;

const buildMessageDeliveryKey = (messageId: string, target: DeliveryTarget): string =>
  `${messageId}:${buildDeliveryTargetKey(target)}`;

const buildApprovalKey = (sessionId: string, approvalId: string): string =>
  `${sessionId}${APPROVAL_KEY_SEPARATOR}${approvalId}`;

const getApprovalKeySessionId = (approvalKey: string): string =>
  approvalKey.split(APPROVAL_KEY_SEPARATOR, 1)[0] ?? "";

const getApprovalIdentity = (
  approval?: Partial<ApprovalRequest> | null,
): string => {
  if (!approval) {
    return "";
  }
  if (approval.callId) {
    return approval.callId;
  }
  if (approval.signature) {
    return approval.signature;
  }
  if (approval.command) {
    return approval.command;
  }
  return approval.requestId !== undefined ? String(approval.requestId) : "";
};
