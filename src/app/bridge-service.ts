import { SessionIndex } from "../codex/session-index.js";
import { ApprovalCoordinator } from "../approval/approval-coordinator.js";
import { TelegramBotService } from "../telegram/bot.js";
import {
  hasStructuredApprovalWaiting,
  hasTmuxFallbackApproval,
} from "../approval/linked-approval.js";
import { buildLinkedApprovalPlan } from "../approval/linked-approval-plan.js";
import { TmuxService } from "../tmux/service.js";
import type {
  ApprovalActionKey,
  ApprovalRequest,
  SessionSnapshot,
} from "../types/domain.js";
import { logger } from "../utils/logger.js";
import { StateStore } from "./state-store.js";

export class BridgeService {
  private static readonly LINKED_APPROVAL_RESYNC_DELAYS_MS = [300, 900, 1800] as const;

  readonly sessionIndex = new SessionIndex();

  readonly tmux = new TmuxService(this.sessionIndex);

  readonly stateStore = new StateStore();

  readonly approvals = new ApprovalCoordinator((sessionId) =>
    this.getSessionFresh(sessionId),
  );

  readonly telegram = new TelegramBotService(this, this.approvals);

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
      const sessions = this.tmux.refreshSessionFacts(message.sessionId);
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
    key: ApprovalActionKey,
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
      const { sessions, linkedTargets, structuredSession } =
        this.getLinkedTargetContext(session.linkedSessionId);
      const linkedStillWaiting =
        linkedTargets.some((candidate) => candidate.runtimeState === "waitingApproval") ||
        hasStructuredApprovalWaiting(structuredSession);
      if (linkedStillWaiting) {
        await this.syncLinkedApprovalsWithResync(
          session.linkedSessionId,
          linkedTargets,
          "paneChanged",
        );
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
    const { sessions, linkedTargets } = this.getLinkedTargetContext(structuredSession.id);
    const structuredStillWaiting = hasStructuredApprovalWaiting(structuredSession);

    for (const target of linkedTargets) {
      if (!structuredStillWaiting && !hasTmuxFallbackApproval(target)) {
        this.telegram.clearApprovalTracking(target.id);
      }
    }

    await this.syncLinkedApprovalsWithResync(
      structuredSession.id,
      linkedTargets,
      "sessionUpdated",
      structuredSession,
    );

    this.queueBackgroundUiSync(sessions);
    await this.syncStructuredPanelsIfNeeded(sessions);
  }

  private async handleStructuredApprovalUpdated(
    approval: ApprovalRequest,
  ): Promise<void> {
    const { sessions, linkedTargets } = this.getLinkedTargetContext(approval.sessionId);

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
      await this.syncLinkedApprovalsWithResync(
        approval.sessionId,
        linkedTargets,
        "approvalUpdated",
      );
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
    const plan = buildLinkedApprovalPlan(structuredSession, sessions);
    let delivered = false;
    for (const skipped of plan.skips) {
      if (skipped.selection.reason === "pane_not_aligned") {
        logger.info("app", "linked 审批同步跳过：pane 前台尚未对齐", {
          linkedSessionId,
          targetSessionId: skipped.target.id,
          activeApprovalCallId: structuredSession?.activeApproval?.callId ?? null,
          visibleApprovalCallId: skipped.target.visibleApproval?.callId ?? null,
          pendingCount: structuredSession?.pendingApprovals?.length ?? 0,
          screenHasApprovalPrompt: Boolean(skipped.target.screenPreview),
        });
      }
    }

    for (const dispatch of plan.dispatches) {
      if (dispatch.selection.kind === "fallback") {
        logger.info("app", "linked 审批同步发送 Telegram 卡片（tmux 兜底）", {
          linkedSessionId,
          targetSessionId: dispatch.target.id,
          approvalSignature: dispatch.selection.approval.signature ?? null,
        });
        await this.telegram.sendApprovalRequest({
          ...dispatch.selection.approval,
          sessionId: dispatch.target.id,
          linkedSessionId,
        });
        delivered = true;
        continue;
      }

      logger.info("app", "linked 审批同步发送 Telegram 卡片", {
        linkedSessionId,
        targetSessionId: dispatch.target.id,
        activeApprovalCallId: dispatch.selection.activeApproval.callId ?? null,
        approvalToSendCallId: dispatch.selection.approval.callId ?? null,
        visibleApprovalCallId: dispatch.target.visibleApproval?.callId ?? null,
        paneVisibleDiffersFromStructuredActive:
          dispatch.selection.paneVisibleDiffersFromStructuredActive,
        fallbackToSingleVisiblePrompt: dispatch.selection.fallbackToSingleVisiblePrompt,
      });
      await this.telegram.sendApprovalRequest({
        ...dispatch.selection.approval,
        sessionId: dispatch.target.id,
        linkedSessionId,
      });
      delivered = true;
    }

    if (!delivered && !structuredSession?.activeApproval && !(structuredSession?.pendingApprovals?.[0])) {
      logger.info("app", "linked 审批同步跳过：当前没有 activeApproval", {
        linkedSessionId,
        targetSessionIds: sessions.map((session) => session.id),
      });
    }

    return delivered;
  }

  private async syncLinkedApprovalsWithResync(
    linkedSessionId: string,
    linkedTargets: SessionSnapshot[],
    source: "paneChanged" | "sessionUpdated" | "approvalUpdated" | "resync",
    structuredSession?: SessionSnapshot,
  ): Promise<boolean> {
    const delivered = await this.syncActiveApprovalsToTelegram(
      linkedTargets,
      linkedSessionId,
    );

    const currentStructuredSession =
      structuredSession ?? this.sessionIndex.getSession(linkedSessionId);
    if (hasStructuredApprovalWaiting(currentStructuredSession) && !delivered) {
      logger.info("app", "linked 审批首拍未送达，等待重试", {
        source,
        linkedSessionId,
        activeApprovalCallId: currentStructuredSession?.activeApproval?.callId ?? null,
        pendingCount: currentStructuredSession?.pendingApprovals?.length ?? 0,
        targetSessionIds: linkedTargets.map((target) => target.id),
      });
      this.scheduleApprovalResync(linkedSessionId);
    } else {
      this.clearApprovalResync(linkedSessionId);
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
    const { linkedTargets, structuredSession } = this.getLinkedTargetContext(linkedSessionId);
    const delivered = await this.syncLinkedApprovalsWithResync(
      linkedSessionId,
      linkedTargets,
      "resync",
    );
    if (delivered) {
      logger.info("app", "linked 审批重试送达成功", {
        linkedSessionId,
        attempt: attempt + 1,
      });
      this.clearApprovalResync(linkedSessionId);
      return;
    }

    const stillWaiting = hasStructuredApprovalWaiting(structuredSession);
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

  private getLinkedTargetContext(linkedSessionId: string): {
    sessions: SessionSnapshot[];
    linkedTargets: SessionSnapshot[];
    structuredSession: SessionSnapshot | undefined;
  } {
    const sessions = this.getTelegramManagedSessions(
      this.tmux.refreshSessionFacts(linkedSessionId),
    );
    return {
      sessions,
      linkedTargets: sessions.filter(
        (candidate) => candidate.linkedSessionId === linkedSessionId,
      ),
      structuredSession: this.sessionIndex.getSession(linkedSessionId),
    };
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
