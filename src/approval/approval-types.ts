import type { ApprovalActionKey, ApprovalRequest } from "../types/domain.js";

export interface ActiveApprovalState {
  requestToken: string;
  callId: string;
}

export interface PrepareApprovalDispatchResult {
  approvalId: string;
  requestToken: string;
  queuedApproval: ApprovalRequest;
}

export interface BeginApprovalActionResult {
  status: "ok" | "busy" | "invalid";
  sessionId?: string;
  approval?: ApprovalRequest;
  approvalId?: string;
  activeApprovalId?: string | null;
}

export interface ReconcileApprovalActionResult {
  status: "invalid" | "ready";
  effectiveApprovalId: string;
}

export interface SubmitApprovalActionResult {
  status: "busy" | "invalid" | "failed" | "submitted" | "error";
  sessionId: string | null;
  approvalId: string | null;
  activeApprovalId: string | null;
  effectiveApprovalId?: string;
  error?: unknown;
}

export interface SubmitApprovalActionInput {
  requestToken: string,
  key: ApprovalActionKey,
}
