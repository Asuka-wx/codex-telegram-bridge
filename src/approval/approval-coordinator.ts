import { randomBytes } from "node:crypto";

import type {
  ApprovalActionKey,
  ApprovalRequest,
  SessionSnapshot,
} from "../types/domain.js";
import { logger } from "../utils/logger.js";
import type {
  ActiveApprovalState,
  BeginApprovalActionResult,
  PrepareApprovalDispatchResult,
  ReconcileApprovalActionResult,
  SubmitApprovalActionResult,
} from "./approval-types.js";
import {
  approvalsRepresentSamePrompt,
  getApprovalIdentity,
} from "./approval-identity.js";
import {
  shouldIgnoreIncomingApproval,
  shouldUpgradeApprovalIdentity,
} from "./approval-reducer.js";

export class ApprovalCoordinator {
  private readonly activeApprovalStateBySession = new Map<string, ActiveApprovalState>();

  private readonly approvalSessionByToken = new Map<string, string>();

  private readonly approvalSignatureByToken = new Map<string, string>();

  private readonly approvalTokenBySessionSignature = new Map<string, string>();

  private readonly activeApprovalSignatureByTarget = new Map<string, string>();

  private readonly pendingApprovalSubmitTokens = new Set<string>();

  private readonly pendingApprovalByToken = new Map<string, ApprovalRequest>();

  private readonly pendingApprovalRetryTokens = new Set<string>();

  private readonly approvalDispatchQueueBySession = new Map<string, Promise<void>>();

  constructor(
    private readonly getSessionFresh: (sessionId: string) => Promise<SessionSnapshot | null>,
  ) {}

  get activeStateBySession(): Map<string, ActiveApprovalState> {
    return this.activeApprovalStateBySession;
  }

  get sessionByToken(): Map<string, string> {
    return this.approvalSessionByToken;
  }

  get signatureByToken(): Map<string, string> {
    return this.approvalSignatureByToken;
  }

  get tokenBySessionSignature(): Map<string, string> {
    return this.approvalTokenBySessionSignature;
  }

  get activeSignatureByTarget(): Map<string, string> {
    return this.activeApprovalSignatureByTarget;
  }

  get pendingSubmitTokens(): Set<string> {
    return this.pendingApprovalSubmitTokens;
  }

  get pendingApprovalMap(): Map<string, ApprovalRequest> {
    return this.pendingApprovalByToken;
  }

  get pendingRetryTokens(): Set<string> {
    return this.pendingApprovalRetryTokens;
  }

  get dispatchQueueBySession(): Map<string, Promise<void>> {
    return this.approvalDispatchQueueBySession;
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

  hasActiveApprovalPressure(sessionId?: string): boolean {
    if (sessionId) {
      return (
        this.getApprovalTokensForSession(sessionId).length > 0 ||
        this.activeApprovalStateBySession.has(sessionId) ||
        [...this.pendingApprovalRetryTokens].some(
          (token) => this.approvalSessionByToken.get(token) === sessionId,
        ) ||
        [...this.pendingApprovalSubmitTokens].some(
          (token) => this.approvalSessionByToken.get(token) === sessionId,
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

  getRetryApprovals(): ApprovalRequest[] {
    return [...this.pendingApprovalRetryTokens]
      .map((requestToken) => this.pendingApprovalByToken.get(requestToken))
      .filter((approval): approval is ApprovalRequest => approval !== undefined);
  }

  queueRetry(requestToken: string): void {
    this.pendingApprovalRetryTokens.add(requestToken);
  }

  clearRetry(requestToken: string): void {
    this.pendingApprovalRetryTokens.delete(requestToken);
  }

  prepareApprovalDispatch(approval: ApprovalRequest): PrepareApprovalDispatchResult | null {
    const approvalId = getApprovalIdentity(approval);
    let existingState = this.activeApprovalStateBySession.get(approval.sessionId);
    if (existingState && existingState.callId !== approvalId) {
      const existingApproval = this.pendingApprovalByToken.get(
        existingState.requestToken,
      );
      if (shouldIgnoreIncomingApproval(existingState, existingApproval, approval)) {
        logger.info("同一审批已存在更稳定身份，忽略重复发卡请求", {
          sessionId: approval.sessionId,
          activeApprovalId: existingState.callId,
          incomingApprovalId: approvalId,
        });
        return null;
      }

      const upgraded = this.tryUpgradeActiveApprovalIdentity(
        approval.sessionId,
        approval,
      );
      if (!upgraded) {
        logger.info("已存在活动审批，忽略新的发卡请求", {
          sessionId: approval.sessionId,
          activeApprovalId: existingState.callId,
          incomingApprovalId: approvalId,
        });
        return null;
      }
      existingState = this.activeApprovalStateBySession.get(approval.sessionId);
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

    return {
      approvalId,
      requestToken,
      queuedApproval,
    };
  }

  beginDispatchToTarget(targetKey: string, approvalId: string): boolean {
    if (this.activeApprovalSignatureByTarget.get(targetKey) === approvalId) {
      return false;
    }
    this.activeApprovalSignatureByTarget.set(targetKey, approvalId);
    return true;
  }

  rollbackDispatchToTarget(targetKey: string, approvalId: string): void {
    if (this.activeApprovalSignatureByTarget.get(targetKey) === approvalId) {
      this.activeApprovalSignatureByTarget.delete(targetKey);
    }
  }

  finalizeApprovalDispatch(
    approval: ApprovalRequest,
    requestToken: string,
    approvalId: string,
    delivered: boolean,
    hadFailure: boolean,
  ): void {
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
    } else {
      this.pendingApprovalRetryTokens.delete(requestToken);
    }
  }

  beginApprovalAction(requestToken: string): BeginApprovalActionResult {
    if (this.pendingApprovalSubmitTokens.has(requestToken)) {
      return { status: "busy" };
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
      return {
        status: "invalid",
        activeApprovalId: activeState?.callId ?? null,
      };
    }

    this.approvalSessionByToken.delete(requestToken);
    this.approvalSignatureByToken.delete(requestToken);
    this.pendingApprovalSubmitTokens.add(requestToken);

    return {
      status: "ok",
      sessionId,
      approval,
      approvalId,
      activeApprovalId: activeState.callId,
    };
  }

  restoreApprovalAction(
    requestToken: string,
    sessionId: string,
    approvalId: string,
  ): void {
    this.pendingApprovalSubmitTokens.delete(requestToken);
    this.approvalSessionByToken.set(requestToken, sessionId);
    this.approvalSignatureByToken.set(requestToken, approvalId);
  }

  rebindApprovalAction(
    sessionId: string,
    requestToken: string,
    previousApprovalId: string,
    currentApproval: ApprovalRequest,
  ): string {
    return this.rebindApprovalToken(
      sessionId,
      requestToken,
      previousApprovalId,
      currentApproval,
    );
  }

  reconcileApprovalAction(
    requestToken: string,
    submittedApproval: ApprovalRequest,
    submittedApprovalId: string,
    session: SessionSnapshot | null,
  ): ReconcileApprovalActionResult {
    const sessionId = submittedApproval.sessionId;
    const expectedApprovalId =
      session?.activeApproval
        ? getApprovalIdentity(session.activeApproval)
        : session?.pendingApprovals?.[0]
          ? getApprovalIdentity(session.pendingApprovals[0])
          : "";
    if (
      !session ||
      session.runtimeState !== "waitingApproval" ||
      !expectedApprovalId
    ) {
      this.handleApprovalResolution(sessionId, submittedApprovalId);
      return {
        status: "invalid",
        effectiveApprovalId: submittedApprovalId,
      };
    }

    if (expectedApprovalId === submittedApprovalId) {
      return {
        status: "ready",
        effectiveApprovalId: submittedApprovalId,
      };
    }

    const currentApproval =
      session.activeApproval ??
      session.pendingApprovals?.[0] ??
      null;
    if (
      !currentApproval ||
      !approvalsRepresentSamePrompt(submittedApproval, currentApproval)
    ) {
      this.handleApprovalResolution(sessionId, submittedApprovalId);
      return {
        status: "invalid",
        effectiveApprovalId: submittedApprovalId,
      };
    }

    if (!shouldUpgradeApprovalIdentity(submittedApproval, currentApproval)) {
      return {
        status: "ready",
        effectiveApprovalId: submittedApprovalId,
      };
    }

    const effectiveApprovalId = this.rebindApprovalAction(
      sessionId,
      requestToken,
      submittedApprovalId,
      currentApproval,
    );
    return {
      status: "ready",
      effectiveApprovalId,
    };
  }

  async completeApprovalAction(
    requestToken: string,
    sessionId: string,
    approvalId: string,
  ): Promise<void> {
    this.scheduleApprovalTokenRelease(sessionId, requestToken, approvalId);
  }

  async submitApprovalAction(
    requestToken: string,
    key: ApprovalActionKey,
    submitControl: (sessionId: string, key: ApprovalActionKey) => Promise<boolean>,
  ): Promise<SubmitApprovalActionResult> {
    const begin = this.beginApprovalAction(requestToken);
    const sessionId = begin.sessionId ?? null;
    const approvalId = begin.approvalId ?? null;
    const activeApprovalId = begin.activeApprovalId ?? null;
    if (begin.status !== "ok" || !begin.sessionId || !begin.approval || !begin.approvalId) {
      return {
        status: begin.status === "busy" ? "busy" : "invalid",
        sessionId,
        approvalId,
        activeApprovalId,
      };
    }

    let effectiveApprovalId = begin.approvalId;

    try {
      const session = await this.getSessionFresh(begin.sessionId);
      const reconciled = this.reconcileApprovalAction(
        requestToken,
        begin.approval,
        begin.approvalId,
        session,
      );
      if (reconciled.status !== "ready") {
        return {
          status: "invalid",
          sessionId: begin.sessionId,
          approvalId: begin.approvalId,
          activeApprovalId,
          effectiveApprovalId: reconciled.effectiveApprovalId,
        };
      }

      effectiveApprovalId = reconciled.effectiveApprovalId;
      const success = await submitControl(begin.sessionId, key);
      if (!success) {
        this.restoreApprovalAction(
          requestToken,
          begin.sessionId,
          effectiveApprovalId,
        );
        return {
          status: "failed",
          sessionId: begin.sessionId,
          approvalId: begin.approvalId,
          activeApprovalId,
          effectiveApprovalId,
        };
      }

      await this.completeApprovalAction(
        requestToken,
        begin.sessionId,
        effectiveApprovalId,
      );
      return {
        status: "submitted",
        sessionId: begin.sessionId,
        approvalId: begin.approvalId,
        activeApprovalId,
        effectiveApprovalId,
      };
    } catch (error) {
      await this.completeApprovalAction(
        requestToken,
        begin.sessionId,
        effectiveApprovalId,
      );
      return {
        status: "error",
        sessionId: begin.sessionId,
        approvalId: begin.approvalId,
        activeApprovalId,
        effectiveApprovalId,
        error,
      };
    }
  }

  handleApprovalResolution(
    sessionId: string,
    approvalId: string,
  ): void {
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

    for (const [targetKey, signature] of this.activeApprovalSignatureByTarget.entries()) {
      if (!targetKey.endsWith(`:${sessionId}`)) {
        continue;
      }
      if (signature === approvalId) {
        this.activeApprovalSignatureByTarget.delete(targetKey);
      }
    }
  }

  async enqueueDispatch(
    sessionId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previous = this.approvalDispatchQueueBySession.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task);
    this.approvalDispatchQueueBySession.set(sessionId, next);

    try {
      await next;
    } finally {
      if (this.approvalDispatchQueueBySession.get(sessionId) === next) {
        this.approvalDispatchQueueBySession.delete(sessionId);
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

  private tryUpgradeActiveApprovalIdentity(
    sessionId: string,
    approval: ApprovalRequest,
  ): boolean {
    const existingState = this.activeApprovalStateBySession.get(sessionId);
    if (!existingState) {
      return false;
    }

    const existingApproval = this.pendingApprovalByToken.get(
      existingState.requestToken,
    );
    if (!existingApproval) {
      return false;
    }

    if (!approvalsRepresentSamePrompt(existingApproval, approval)) {
      return false;
    }

    if (!shouldUpgradeApprovalIdentity(existingApproval, approval)) {
      return false;
    }

    const nextApprovalId = this.rebindApprovalToken(
      sessionId,
      existingState.requestToken,
      existingState.callId,
      approval,
    );
    logger.info("审批身份已升级到结构化审批", {
      sessionId,
      previousApprovalId: existingState.callId,
      nextApprovalId,
      requestToken: existingState.requestToken,
    });
    return true;
  }

  private rebindApprovalToken(
    sessionId: string,
    requestToken: string,
    previousApprovalId: string,
    approval: ApprovalRequest,
  ): string {
    const nextApprovalId = getApprovalIdentity(approval);
    if (previousApprovalId && previousApprovalId !== nextApprovalId) {
      this.approvalTokenBySessionSignature.delete(
        buildApprovalKey(sessionId, previousApprovalId),
      );
      for (const [targetKey, signature] of this.activeApprovalSignatureByTarget.entries()) {
        if (!targetKey.endsWith(`:${sessionId}`)) {
          continue;
        }
        if (signature === previousApprovalId) {
          this.activeApprovalSignatureByTarget.set(targetKey, nextApprovalId);
        }
      }
    }

    this.approvalTokenBySessionSignature.set(
      buildApprovalKey(sessionId, nextApprovalId),
      requestToken,
    );
    this.approvalSessionByToken.set(requestToken, sessionId);
    this.approvalSignatureByToken.set(requestToken, nextApprovalId);

    const queuedApproval: ApprovalRequest = {
      ...approval,
      requestToken,
      callId: approval.callId ?? nextApprovalId,
      signature: approval.signature ?? nextApprovalId,
    };
    this.pendingApprovalByToken.set(requestToken, queuedApproval);
    this.activeApprovalStateBySession.set(sessionId, {
      requestToken,
      callId: nextApprovalId,
    });
    return nextApprovalId;
  }

  private scheduleApprovalTokenRelease(
    sessionId: string,
    requestToken: string,
    approvalId: string,
  ): void {
    const timer = setTimeout(() => {
      void (async () => {
        const activeState = this.activeApprovalStateBySession.get(sessionId);
        if (
          activeState?.requestToken === requestToken &&
          activeState.callId === approvalId
        ) {
          const session = await this.getSessionFresh(sessionId);
          if (
            session?.runtimeState === "waitingApproval" &&
            getApprovalIdentity(session.activeApproval ?? {}) === approvalId
          ) {
            this.approvalSessionByToken.set(requestToken, sessionId);
            this.approvalSignatureByToken.set(requestToken, approvalId);
          }
        }
        this.pendingApprovalSubmitTokens.delete(requestToken);
      })();
    }, 1500);
    timer.unref();
  }
}

const APPROVAL_KEY_SEPARATOR = "__CODEX_BRIDGE_APPROVAL__";

const buildApprovalKey = (sessionId: string, approvalId: string): string =>
  `${sessionId}${APPROVAL_KEY_SEPARATOR}${approvalId}`;

const getApprovalKeySessionId = (approvalKey: string): string =>
  approvalKey.split(APPROVAL_KEY_SEPARATOR, 1)[0] ?? "";

const createApprovalToken = (): string => {
  return randomBytes(6).toString("hex");
};
