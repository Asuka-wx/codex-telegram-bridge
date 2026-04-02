import type { ApprovalRequest } from "../types/domain.js";
import type { ActiveApprovalState } from "./approval-types.js";
import {
  approvalsRepresentSamePrompt,
  getApprovalIdentity,
  shouldReplaceApprovalIdentity,
} from "./approval-identity.js";

export const shouldIgnoreIncomingApproval = (
  activeState: ActiveApprovalState | undefined,
  activeApproval: ApprovalRequest | undefined,
  incomingApproval: ApprovalRequest,
): boolean => {
  if (!activeState || !activeApproval) {
    return false;
  }

  const incomingApprovalId = getApprovalIdentity(incomingApproval);
  if (activeState.callId === incomingApprovalId) {
    return false;
  }

  return (
    approvalsRepresentSamePrompt(activeApproval, incomingApproval) &&
    !shouldReplaceApprovalIdentity(activeApproval, incomingApproval)
  );
};

export const shouldUpgradeApprovalIdentity = (
  activeApproval: ApprovalRequest | undefined,
  incomingApproval: ApprovalRequest,
): boolean => {
  if (!activeApproval) {
    return false;
  }

  return (
    approvalsRepresentSamePrompt(activeApproval, incomingApproval) &&
    shouldReplaceApprovalIdentity(activeApproval, incomingApproval)
  );
};
