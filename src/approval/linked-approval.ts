import { hasVisibleApprovalPrompt } from "../tmux/service.js";
import type { ApprovalRequest, SessionSnapshot } from "../types/domain.js";
import { getApprovalIdentity } from "./approval-identity.js";

export type LinkedApprovalSelection =
  | { kind: "none"; reason: "no_active" | "pane_not_aligned" }
  | { kind: "fallback"; approval: ApprovalRequest }
  | {
      kind: "structured";
      approval: ApprovalRequest;
      activeApproval: ApprovalRequest;
      visibleApprovalId: string;
      paneVisibleDiffersFromStructuredActive: boolean;
      fallbackToSingleVisiblePrompt: boolean;
    };

export const selectLinkedApprovalForTarget = (
  structuredSession: SessionSnapshot | undefined,
  target: SessionSnapshot,
): LinkedApprovalSelection => {
  const activeApproval =
    structuredSession?.activeApproval ??
    structuredSession?.pendingApprovals?.[0] ??
    null;

  if (!activeApproval) {
    const paneApproval = target.visibleApproval ?? target.activeApproval ?? null;
    if (paneApproval?.rawMethod === "tmux/paneApproval") {
      return {
        kind: "fallback",
        approval: paneApproval,
      };
    }

    return {
      kind: "none",
      reason: "no_active",
    };
  }

  const visibleApproval = target.visibleApproval;
  const visibleApprovalId = getApprovalIdentity(visibleApproval);
  const visiblePendingApproval = visibleApprovalId
    ? (structuredSession?.pendingApprovals?.find(
        (approval) => getApprovalIdentity(approval) === visibleApprovalId,
      ) ?? null)
    : null;
  const approvalToSend = visiblePendingApproval ?? activeApproval;
  const approvalToSendId = getApprovalIdentity(approvalToSend);
  const matchesVisibleApproval =
    Boolean(visibleApproval) && visibleApprovalId === approvalToSendId;
  const fallbackToSingleVisiblePrompt =
    !visibleApproval &&
    (structuredSession?.pendingApprovals?.length ?? 0) <= 1 &&
    hasVisibleApprovalPrompt(target.screenPreview ?? "");

  if (!matchesVisibleApproval && !fallbackToSingleVisiblePrompt) {
    return {
      kind: "none",
      reason: "pane_not_aligned",
    };
  }

  return {
    kind: "structured",
    approval: approvalToSend,
    activeApproval,
    visibleApprovalId,
    paneVisibleDiffersFromStructuredActive:
      Boolean(visiblePendingApproval) &&
      approvalToSendId !== getApprovalIdentity(activeApproval),
    fallbackToSingleVisiblePrompt: !matchesVisibleApproval,
  };
};

export const hasStructuredApprovalWaiting = (
  session?: SessionSnapshot | null,
): boolean => {
  return Boolean(
    session &&
      session.runtimeState === "waitingApproval" &&
      (session.activeApproval ?? session.pendingApprovals?.[0]),
  );
};

export const hasTmuxFallbackApproval = (session: SessionSnapshot): boolean => {
  if (session.runtimeState !== "waitingApproval") {
    return false;
  }

  const approval = session.visibleApproval ?? session.activeApproval ?? null;
  return approval?.rawMethod === "tmux/paneApproval";
};
