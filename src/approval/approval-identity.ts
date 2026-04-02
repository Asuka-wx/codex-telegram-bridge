import type { ApprovalRequest } from "../types/domain.js";

export const getApprovalIdentity = (
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

export const approvalsRepresentSamePrompt = (
  left?: Partial<ApprovalRequest> | null,
  right?: Partial<ApprovalRequest> | null,
): boolean => {
  const leftKeys = collectApprovalPromptKeys(left);
  const rightKeys = collectApprovalPromptKeys(right);
  return leftKeys.some((key) => rightKeys.includes(key));
};

export const shouldReplaceApprovalIdentity = (
  current?: Partial<ApprovalRequest> | null,
  incoming?: Partial<ApprovalRequest> | null,
): boolean => {
  return getApprovalIdentityPriority(incoming) > getApprovalIdentityPriority(current);
};

const getApprovalIdentityPriority = (
  approval?: Partial<ApprovalRequest> | null,
): number => {
  if (!approval) {
    return 0;
  }

  if (approval.rawMethod !== "tmux/paneApproval" && approval.callId) {
    return 2;
  }

  if (approval.signature || approval.command || approval.body) {
    return 1;
  }

  return 0;
};

const collectApprovalPromptKeys = (
  approval?: Partial<ApprovalRequest> | null,
): string[] => {
  return [
    normalizeApprovalPromptKey(approval?.signature),
    normalizeApprovalPromptKey(approval?.command),
    normalizeApprovalPromptKey(extractCommandFromApprovalBody(approval?.body)),
  ].filter((value): value is string => Boolean(value));
};

const normalizeApprovalPromptKey = (value?: string | null): string => {
  return (
    value
      ?.replace(/\s+/g, " ")
      .replace(/^\$\s*/, "")
      .trim() ?? ""
  );
};

const extractCommandFromApprovalBody = (body?: string | null): string => {
  if (!body) {
    return "";
  }

  const commandLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("$ "));

  return commandLine?.replace(/^\$\s*/, "").trim() ?? "";
};
