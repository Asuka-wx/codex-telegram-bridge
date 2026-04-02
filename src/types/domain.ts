export type SessionMessageRole = "user" | "assistant" | "tool" | "system";
export type SessionMessageKind = "chat" | "tool" | "system" | "fallback";

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: SessionMessageRole;
  text: string;
  timestamp: string;
  phase?: string | null;
  kind?: SessionMessageKind;
  source: "session_file" | "app_server" | "tmux";
  turnId?: string | null;
  callId?: string | null;
  toolName?: string | null;
  command?: string | null;
}

export type SessionRuntimeState =
  | "unknown"
  | "idle"
  | "active"
  | "waitingApproval"
  | "waitingUserInput"
  | "error";

export interface CodexFooterStatus {
  modelLabel?: string | null;
  contextLeft?: string | null;
  cwdLabel?: string | null;
  scopeLabel?: string | null;
}

export type ApprovalActionKey =
  | "Enter"
  | "y"
  | "p"
  | "Escape"
  | "n"
  | "C-c"
  | "DownEnter"
  | "DownDownEnter"
  | "DownDownDownEnter";

export interface ApprovalAction {
  label: string;
  key: ApprovalActionKey;
}

export interface SessionSnapshot {
  id: string;
  paneKey?: string;
  filePath?: string;
  cwd?: string;
  source?: string;
  name?: string | null;
  preview?: string | null;
  createdAt?: string;
  updatedAt?: string;
  runtimeState: SessionRuntimeState;
  recentMessages: SessionMessage[];
  pendingApprovals?: ApprovalRequest[];
  activeApproval?: ApprovalRequest | null;
  visibleApproval?: ApprovalRequest | null;
  latestTurnId?: string | null;
  latestCompletedTurnId?: string | null;
  rawThreadStatus?: string;
  rawPaneId?: string;
  tmuxSessionName?: string;
  tmuxWindowIndex?: number;
  tmuxPaneIndex?: number;
  tmuxPaneInMode?: boolean;
  screenPreview?: string;
  linkedSessionId?: string | null;
  codexAttached?: boolean;
  codexFooterStatus?: CodexFooterStatus | null;
  lifecycleState?: "open" | "closed";
}

export type ApprovalKind =
  | "command"
  | "fileChange"
  | "permissions"
  | "toolUserInput"
  | "mcpElicitation";

export interface ApprovalRequest {
  requestId: string | number;
  requestToken?: string;
  sessionId: string;
  linkedSessionId?: string | null;
  callId?: string;
  turnId?: string;
  itemId?: string;
  kind: ApprovalKind;
  title: string;
  body: string;
  createdAt: string;
  rawMethod: string;
  command?: string;
  justification?: string | null;
  sandboxPermissions?: string | null;
  actions?: ApprovalAction[];
  signature?: string;
  status?: "pending" | "approved" | "rejected" | "cancelled";
  resolvedAt?: string | null;
}

export interface TopicBinding {
  sessionId: string;
  chatId: number;
  topicId: number;
  title: string;
  createdAt: string;
  archivedAt?: string | null;
  panelMessageId?: number | null;
}
