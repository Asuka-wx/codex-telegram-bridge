import type { SyncMode } from "../app/state-store.js";
import type { ApprovalActionKey } from "../types/domain.js";

export type TelegramChatIntent =
  | { type: "mode"; mode: SyncMode }
  | { type: "sessions" }
  | { type: "bindLatest" }
  | { type: "chatInfo" }
  | { type: "groupReady" }
  | { type: "setControl" }
  | { type: "clearControl" }
  | { type: "status" }
  | { type: "interrupt" }
  | { type: "key"; key: "Enter" | "y" | "p" | "Escape" | "C-c" };

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

export const parseChatIntent = (text: string): TelegramChatIntent | null => {
  const normalized = text.trim();
  if (["当前信息", "本群信息", "聊天信息", "chat info", "current info"].includes(normalized)) {
    return { type: "chatInfo" };
  }
  if (["检查群准备", "群准备", "group ready", "check group ready"].includes(normalized)) {
    return { type: "groupReady" };
  }
  if (["设为总控", "设为总控群", "当前群设为总控", "set control", "set as control"].includes(normalized)) {
    return { type: "setControl" };
  }
  if (["取消总控", "清除总控群", "clear control"].includes(normalized)) {
    return { type: "clearControl" };
  }
  if (["总控", "窗口列表", "会话列表", "sessions", "session list"].includes(normalized)) {
    return { type: "sessions" };
  }
  if (["绑定最新窗口", "绑定最新", "接上当前窗口", "bind latest", "bind latest session"].includes(normalized)) {
    return { type: "bindLatest" };
  }
  if (["本地模式", "切到本地模式", "local mode"].includes(normalized)) {
    return { type: "mode", mode: "local" };
  }
  if (["提醒模式", "切到提醒模式", "混合模式", "切到混合模式", "hybrid mode", "notify mode"].includes(normalized)) {
    return { type: "mode", mode: "hybrid" };
  }
  if (["远程模式", "切到远程模式", "remote mode"].includes(normalized)) {
    return { type: "mode", mode: "remote" };
  }
  if (["状态", "查看状态", "当前状态", "status"].includes(normalized)) {
    return { type: "status" };
  }
  if (["中断", "停止", "停止当前任务", "interrupt", "stop"].includes(normalized)) {
    return { type: "interrupt" };
  }
  if (["回车", "继续", "enter", "continue"].includes(normalized)) {
    return { type: "key", key: "Enter" };
  }
  if (["允许", "同意", "allow", "approve"].includes(normalized)) {
    return { type: "key", key: "y" };
  }
  if (["允许并记住", "持续允许", "记住这次选择", "allow and remember"].includes(normalized)) {
    return { type: "key", key: "p" };
  }
  if (["拒绝", "不同意", "reject", "deny"].includes(normalized)) {
    return { type: "key", key: "Escape" };
  }
  if (["取消", "取消确认", "cancel"].includes(normalized)) {
    return { type: "key", key: "Escape" };
  }
  return null;
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
