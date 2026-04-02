import { SessionIndex } from "../codex/session-index.js";
import { TelegramBotService } from "../telegram/bot.js";
import { hasVisibleApprovalPrompt, TmuxService } from "../tmux/service.js";
import type { ApprovalRequest, SessionSnapshot } from "../types/domain.js";
import { logger } from "../utils/logger.js";
import { StateStore } from "./state-store.js";

export class BridgeService {
  private static readonly LINKED_APPROVAL_RESYNC_DELAYS_MS = [300, 900, 1800] as const;

  readonly sessionIndex = new SessionIndex();

  readonly tmux = new TmuxService(this.sessionIndex);

  readonly stateStore = new StateStore();

  readonly telegram = new TelegramBotService(this);

  private readonly topicPanelSignatures = new Map<string, string>();

  private readonly approvalResyncTimerByLinkedSessionId = new Map<string, NodeJS.Timeout>();

  // 背景事件只维护内部状态，不主动刷新 TG 面板，避免持续刷屏污染话题。
  private readonly backgroundUiSyncEnabled = false;

  async start(): Promise<void> {
    await this.stateStore.load();
    this.tmux.setPersistentSessionHints([
      ...this.stateStore.listSelectedSessions().map((binding) => binding.sessionId),
      ...this.stateStore.listTopicBindings().map((binding) => binding.sessionId),
    ]);
    await this.sessionIndex.start();
    await this.tmux.start();
    const initialSessions = this.getTelegramManagedSessions(this.tmux.listSessions());
    await this.reconcileSelections(initialSessions);
    await this.reconcileTopicBindings(initialSessions);

    this.sessionIndex.on("sessionUpdated", (session) => {
      void this.handleStructuredSessionUpdated(session);
    });

    this.sessionIndex.on("sessionMessage", (message) => {
      const sessions = this.getTelegramManagedSessions(
        this.tmux.refreshSessionFacts(message.sessionId),
      );
      const targets = sessions.filter(
        (session) => session.linkedSessionId === message.sessionId,
      );
      for (const target of targets) {
        void this.telegram.forwardSessionMessage({
          ...message,
          sessionId: target.id,
        });
      }
      this.queueBackgroundUiSync(sessions);
    });

    this.sessionIndex.on("approvalUpdated", (approval) => {
      void this.handleStructuredApprovalUpdated(approval);
    });

    this.tmux.on("paneOpened", (session) => {
      void this.handlePaneOpened(session);
    });

    this.tmux.on("paneChanged", (session) => {
      void this.handlePaneChanged(session);
    });

    this.tmux.on("paneClosed", (session) => {
      void this.handlePaneClosed(session);
    });

    this.tmux.on("approvalRequested", (approval) => {
      const session = this.tmux.getSession(approval.sessionId);
      if (session?.linkedSessionId) {
        return;
      }
      void this.telegram.sendApprovalRequest(approval);
    });

    this.tmux.on("paneOutput", (message) => {
      const session = this.tmux.getSession(message.sessionId);
      if (session?.linkedSessionId) {
        return;
      }
      void this.telegram.forwardSessionMessage(message);
    });

    const sessions = this.getTelegramManagedSessions(this.tmux.listSessions());
    for (const session of sessions) {
      this.topicPanelSignatures.set(session.id, buildSessionStateSignature(session));
    }
    this.queueBackgroundUiSync(sessions);
    await this.syncBackgroundTopics(sessions);
    await this.telegram.start();
  }

  async listSessions(): Promise<SessionSnapshot[]> {
    return this.getTelegramManagedSessions(this.tmux.listSessions());
  }

  async refreshSessions(): Promise<SessionSnapshot[]> {
    const sessions = this.getTelegramManagedSessions(await this.tmux.refreshNow());
    await this.reconcileSelections(sessions);
    await this.reconcileTopicBindings(sessions);
    return sessions;
  }

  async getSession(sessionId: string): Promise<SessionSnapshot | null> {
    const resolved = this.tmux.resolveSessionId(sessionId) ?? sessionId;
    return this.tmux.getSession(resolved);
  }

  async getSessionFresh(sessionId: string): Promise<SessionSnapshot | null> {
    const sessions = await this.refreshSessions();
    const resolved = this.tmux.resolveSessionId(sessionId) ?? sessionId;
    return sessions.find((session) => session.id === resolved) ?? null;
  }

  async sendUserInput(sessionId: string, text: string): Promise<{ mode: "send" }> {
    const resolved = this.tmux.resolveSessionId(sessionId) ?? sessionId;
    await this.tmux.sendUserInput(resolved, text);
    return { mode: "send" };
  }

  async interruptSession(sessionId: string): Promise<boolean> {
    const resolved = this.tmux.resolveSessionId(sessionId) ?? sessionId;
    return this.tmux.interruptSession(resolved);
  }

  async sendControl(
    sessionId: string,
    key: "Enter" | "y" | "p" | "Escape" | "n" | "C-c",
  ): Promise<boolean> {
    const resolved = this.tmux.resolveSessionId(sessionId) ?? sessionId;
    return this.tmux.sendControl(resolved, key);
  }

  async resolveApproval(
    approvalOrSessionId: ApprovalRequest | string,
    decision:
      | "accept"
      | "acceptRemember"
      | "acceptForSession"
      | "decline"
      | "cancel",
  ): Promise<void> {
    const sessionId =
      typeof approvalOrSessionId === "string"
        ? approvalOrSessionId
        : approvalOrSessionId.sessionId;
    const session = await this.getSessionFresh(sessionId);
    if (!session || session.runtimeState !== "waitingApproval") {
      return;
    }
    const key =
      decision === "accept"
        ? "y"
        : decision === "acceptRemember" || decision === "acceptForSession"
          ? "p"
          : "Escape";
    await this.tmux.sendControl(sessionId, key);
  }

  private async reconcileSelections(sessions: SessionSnapshot[]): Promise<void> {
    const fallback = sessions[0]?.id ?? null;
    for (const binding of this.stateStore.listSelectedSessions()) {
      if (sessions.some((session) => session.id === binding.sessionId)) {
        continue;
      }

      const byLinkedSession = sessions.find(
        (session) => session.linkedSessionId === binding.sessionId,
      );
      if (byLinkedSession) {
        await this.stateStore.setSelectedSession(binding.chatId, byLinkedSession.id);
        continue;
      }

      const resolved = this.tmux.resolveSessionId(binding.sessionId);
      if (resolved) {
        await this.stateStore.setSelectedSession(binding.chatId, resolved);
        continue;
      }
      if (fallback) {
        await this.stateStore.setSelectedSession(binding.chatId, fallback);
      } else {
        await this.stateStore.clearSelectedSession(binding.chatId);
      }
    }
  }

  private async reconcileTopicBindings(sessions: SessionSnapshot[]): Promise<void> {
    const activeIds = new Set(sessions.map((session) => session.id));
    for (const binding of this.stateStore.listTopicBindings()) {
      if (activeIds.has(binding.sessionId)) {
        continue;
      }

      const byLinkedSession = sessions.find(
        (session) => session.linkedSessionId === binding.sessionId,
      );
      if (byLinkedSession) {
        await this.stateStore.rekeyTopicBinding(binding.sessionId, byLinkedSession.id);
        continue;
      }

      const resolved = this.tmux.resolveSessionId(binding.sessionId);
      if (!resolved) {
        continue;
      }
      await this.stateStore.rekeyTopicBinding(binding.sessionId, resolved);
    }
  }

  private async handlePaneOpened(session: SessionSnapshot): Promise<void> {
    this.topicPanelSignatures.set(session.id, buildSessionStateSignature(session));
    if (!session.linkedSessionId && session.runtimeState !== "waitingApproval") {
      this.telegram.clearApprovalTracking(session.id);
    }
    const sessions = this.getTelegramManagedSessions(this.tmux.listSessions());
    if (session.linkedSessionId) {
      const linkedTargets = sessions.filter(
        (candidate) => candidate.linkedSessionId === session.linkedSessionId,
      );
      const linkedStillWaiting = linkedTargets.some(
        (candidate) => candidate.runtimeState === "waitingApproval",
      );
      if (!linkedStillWaiting) {
        this.telegram.clearApprovalTracking(session.id);
      }
    }
    this.queueBackgroundUiSync(sessions);
    await this.syncBackgroundTopics(sessions);
    await this.telegram.forwardSystemNotice(
      `检测到新窗口：${session.name ?? session.id}`,
      session.id,
    );
  }

  private async handlePaneChanged(session: SessionSnapshot): Promise<void> {
    this.topicPanelSignatures.set(session.id, buildSessionStateSignature(session));
    if (!session.linkedSessionId && session.runtimeState !== "waitingApproval") {
      this.telegram.clearApprovalTracking(session.id);
    }
    if (session.linkedSessionId) {
      const sessions = this.getTelegramManagedSessions(
        this.tmux.refreshSessionFacts(session.linkedSessionId),
      );
      const linkedTargets = sessions.filter(
        (candidate) => candidate.linkedSessionId === session.linkedSessionId,
      );
      const linkedStillWaiting = linkedTargets.some(
        (candidate) => candidate.runtimeState === "waitingApproval",
      );
      if (linkedStillWaiting) {
        const delivered = await this.syncActiveApprovalsToTelegram(
          linkedTargets,
          session.linkedSessionId,
        );
        if (!delivered) {
          logger.info("app", "linked 审批首拍未送达，等待重试", {
            source: "paneChanged",
            linkedSessionId: session.linkedSessionId,
            targetSessionIds: linkedTargets.map((target) => target.id),
          });
          this.scheduleApprovalResync(session.linkedSessionId);
        } else {
          this.clearApprovalResync(session.linkedSessionId);
        }
      } else {
        this.telegram.clearApprovalTracking(session.id);
        this.clearApprovalResync(session.linkedSessionId);
      }
      await this.syncStructuredPanelsIfNeeded(sessions);
      return;
    }

    this.queueBackgroundUiSync(this.getTelegramManagedSessions(this.tmux.listSessions()));
  }

  private async handlePaneClosed(session: SessionSnapshot): Promise<void> {
    this.topicPanelSignatures.delete(session.id);
    this.telegram.clearApprovalTracking(session.id);
    const sessions = this.getTelegramManagedSessions(this.tmux.listSessions());
    await this.reconcileSelections(sessions);
    this.queueBackgroundUiSync(sessions);
    await this.syncBackgroundTopics(sessions);
    await this.telegram.forwardSystemNotice(
      `窗口已关闭：${session.name ?? session.id}`,
      session.id,
    );
  }

  private async handleStructuredSessionUpdated(
    structuredSession: SessionSnapshot,
  ): Promise<void> {
    const sessions = this.getTelegramManagedSessions(
      this.tmux.refreshSessionFacts(structuredSession.id),
    );
    const linkedTargets = sessions.filter(
      (session) => session.linkedSessionId === structuredSession.id,
    );
    const structuredStillWaiting =
      structuredSession.runtimeState === "waitingApproval" &&
      Boolean(structuredSession.activeApproval ?? structuredSession.pendingApprovals?.[0]);

    for (const target of linkedTargets) {
      if (!structuredStillWaiting) {
        this.telegram.clearApprovalTracking(target.id);
      }
    }

    const delivered = await this.syncActiveApprovalsToTelegram(
      linkedTargets,
      structuredSession.id,
    );
    if (structuredStillWaiting && !delivered) {
      logger.info("app", "linked 审批首拍未送达，等待重试", {
        source: "sessionUpdated",
        linkedSessionId: structuredSession.id,
        activeApprovalCallId: structuredSession.activeApproval?.callId ?? null,
        pendingCount: structuredSession.pendingApprovals?.length ?? 0,
        targetSessionIds: linkedTargets.map((target) => target.id),
      });
      this.scheduleApprovalResync(structuredSession.id);
    } else {
      this.clearApprovalResync(structuredSession.id);
    }

    this.queueBackgroundUiSync(sessions);
    await this.syncStructuredPanelsIfNeeded(sessions);
  }

  private async handleStructuredApprovalUpdated(
    approval: ApprovalRequest,
  ): Promise<void> {
    const sessions = this.getTelegramManagedSessions(
      this.tmux.refreshSessionFacts(approval.sessionId),
    );
    const linkedTargets = sessions.filter(
      (session) => session.linkedSessionId === approval.sessionId,
    );

    if (approval.status !== "pending") {
      for (const target of linkedTargets) {
        if (approval.callId) {
          this.telegram.handleApprovalResolution(target.id, approval.callId);
        }
        if (target.runtimeState !== "waitingApproval") {
          this.telegram.clearApprovalTracking(target.id);
        }
      }
      this.clearApprovalResync(approval.sessionId);
    } else {
      const delivered = await this.syncActiveApprovalsToTelegram(
        linkedTargets,
        approval.sessionId,
      );
      if (!delivered) {
        logger.info("app", "linked 审批首拍未送达，等待重试", {
          source: "approvalUpdated",
          linkedSessionId: approval.sessionId,
          approvalCallId: approval.callId ?? null,
          targetSessionIds: linkedTargets.map((target) => target.id),
        });
        this.scheduleApprovalResync(approval.sessionId);
      } else {
        this.clearApprovalResync(approval.sessionId);
      }
    }

    this.queueBackgroundUiSync(sessions);
    await this.syncStructuredPanelsIfNeeded(sessions);
  }

  private async syncStructuredPanelsIfNeeded(
    sessions: SessionSnapshot[],
  ): Promise<void> {
    if (!this.backgroundUiSyncEnabled) {
      return;
    }

    let changed = false;

    for (const session of sessions) {
      const signature = buildSessionStateSignature(session);
      if (this.topicPanelSignatures.get(session.id) === signature) {
        continue;
      }

      this.topicPanelSignatures.set(session.id, signature);
      changed = true;
    }

    if (!changed) {
      return;
    }

    await this.syncControlTopicsAndBindings(sessions);
  }

  private async syncControlTopicsAndBindings(
    sessions: SessionSnapshot[],
  ): Promise<void> {
    await this.reconcileSelections(sessions);
    await this.reconcileTopicBindings(sessions);
    await this.telegram.syncControlTopics(sessions);
  }

  private async syncActiveApprovalsToTelegram(
    sessions: SessionSnapshot[],
    linkedSessionId: string,
  ): Promise<boolean> {
    const structuredSession = this.sessionIndex.getSession(linkedSessionId);
    const activeApproval =
      structuredSession?.activeApproval ??
      structuredSession?.pendingApprovals?.[0] ??
      null;
    if (!activeApproval) {
      logger.info("app", "linked 审批同步跳过：当前没有 activeApproval", {
        linkedSessionId,
        targetSessionIds: sessions.map((session) => session.id),
      });
      return false;
    }

    let delivered = false;
    for (const session of sessions) {
      const visibleApproval = session.visibleApproval;
      const visibleApprovalId = getApprovalIdentity(visibleApproval);
      const visiblePendingApproval = visibleApprovalId
        ? (structuredSession?.pendingApprovals?.find(
            (approval) => getApprovalIdentity(approval) === visibleApprovalId,
          ) ?? null)
        : null;
      const approvalToSend = visiblePendingApproval ?? activeApproval;
      const approvalToSendId = getApprovalIdentity(approvalToSend);
      const matchesVisibleApproval =
        visibleApproval && visibleApprovalId === approvalToSendId;
      const canFallbackToSingleVisiblePrompt =
        !visibleApproval &&
        (structuredSession?.pendingApprovals?.length ?? 0) <= 1 &&
        hasVisibleApprovalPrompt(session.screenPreview ?? "");
      if (!matchesVisibleApproval && !canFallbackToSingleVisiblePrompt) {
        logger.info("app", "linked 审批同步跳过：pane 前台尚未对齐", {
          linkedSessionId,
          targetSessionId: session.id,
          activeApprovalCallId: activeApproval.callId ?? null,
          visibleApprovalCallId: visibleApproval?.callId ?? null,
          pendingCount: structuredSession?.pendingApprovals?.length ?? 0,
          screenHasApprovalPrompt: hasVisibleApprovalPrompt(session.screenPreview ?? ""),
        });
        continue;
      }

      logger.info("app", "linked 审批同步发送 Telegram 卡片", {
        linkedSessionId,
        targetSessionId: session.id,
        activeApprovalCallId: activeApproval.callId ?? null,
        approvalToSendCallId: approvalToSend.callId ?? null,
        visibleApprovalCallId: visibleApproval?.callId ?? null,
        paneVisibleDiffersFromStructuredActive:
          Boolean(visiblePendingApproval) &&
          approvalToSendId !== getApprovalIdentity(activeApproval),
        fallbackToSingleVisiblePrompt: !matchesVisibleApproval,
      });
      await this.telegram.sendApprovalRequest({
        ...approvalToSend,
        sessionId: session.id,
        linkedSessionId,
      });
      delivered = true;
    }

    return delivered;
  }

  private scheduleApprovalResync(linkedSessionId: string, attempt = 0): void {
    if (attempt >= BridgeService.LINKED_APPROVAL_RESYNC_DELAYS_MS.length) {
      this.clearApprovalResync(linkedSessionId);
      return;
    }
    if (this.approvalResyncTimerByLinkedSessionId.has(linkedSessionId)) {
      return;
    }

    const delayMs = BridgeService.LINKED_APPROVAL_RESYNC_DELAYS_MS[attempt];
    const timer = setTimeout(() => {
      this.approvalResyncTimerByLinkedSessionId.delete(linkedSessionId);
      void this.runApprovalResync(linkedSessionId, attempt);
    }, delayMs);
    logger.info("app", "linked 审批已计划重试", {
      linkedSessionId,
      attempt: attempt + 1,
      delayMs,
    });
    timer.unref();
    this.approvalResyncTimerByLinkedSessionId.set(linkedSessionId, timer);
  }

  private async runApprovalResync(
    linkedSessionId: string,
    attempt: number,
  ): Promise<void> {
    logger.info("app", "linked 审批开始重试", {
      linkedSessionId,
      attempt: attempt + 1,
    });
    const sessions = this.getTelegramManagedSessions(
      this.tmux.refreshSessionFacts(linkedSessionId),
    );
    const linkedTargets = sessions.filter(
      (candidate) => candidate.linkedSessionId === linkedSessionId,
    );
    const delivered = await this.syncActiveApprovalsToTelegram(
      linkedTargets,
      linkedSessionId,
    );
    if (delivered) {
      logger.info("app", "linked 审批重试送达成功", {
        linkedSessionId,
        attempt: attempt + 1,
      });
      this.clearApprovalResync(linkedSessionId);
      return;
    }

    const structuredSession = this.sessionIndex.getSession(linkedSessionId);
    const stillWaiting =
      structuredSession?.runtimeState === "waitingApproval" &&
      Boolean(structuredSession.activeApproval ?? structuredSession.pendingApprovals?.[0]);
    if (!stillWaiting) {
      logger.info("app", "linked 审批重试结束：审批已不再等待", {
        linkedSessionId,
        attempt: attempt + 1,
      });
      this.clearApprovalResync(linkedSessionId);
      return;
    }

    this.scheduleApprovalResync(linkedSessionId, attempt + 1);
  }

  private clearApprovalResync(linkedSessionId: string): void {
    const timer = this.approvalResyncTimerByLinkedSessionId.get(linkedSessionId);
    if (timer) {
      clearTimeout(timer);
      this.approvalResyncTimerByLinkedSessionId.delete(linkedSessionId);
    }
  }

  private getTelegramManagedSessions(
    sessions: SessionSnapshot[],
  ): SessionSnapshot[] {
    return sessions;
  }

  private queueBackgroundUiSync(sessions: SessionSnapshot[]): void {
    if (!this.backgroundUiSyncEnabled) {
      return;
    }
    this.telegram.requestControlPanelSync(sessions);
  }

  private async syncBackgroundTopics(sessions: SessionSnapshot[]): Promise<void> {
    if (!this.backgroundUiSyncEnabled) {
      return;
    }
    await this.telegram.syncControlTopics(sessions);
  }
}

const buildSessionStateSignature = (session: SessionSnapshot): string => {
  return JSON.stringify({
    id: session.id,
    codexAttached: session.codexAttached ?? null,
    runtimeState: session.runtimeState,
    activeApproval: session.activeApproval?.callId ?? null,
    preview: session.preview ?? null,
    footer: session.codexFooterStatus ?? null,
  });
};

const getApprovalIdentity = (approval?: ApprovalRequest | null): string => {
  if (!approval) {
    return "";
  }

  return approval.callId ?? approval.signature ?? approval.command ?? String(approval.requestId);
};
