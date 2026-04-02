import type { SyncMode } from "../app/state-store.js";
import type { ApprovalRequest, SessionMessage, SessionSnapshot } from "../types/domain.js";
import { chunkText } from "../utils/chunk-text.js";

const normalize = (text: string): string => text.replace(/\n{3,}/g, "\n\n").trim();

export const formatSessionSummary = (
  session: SessionSnapshot,
  mode?: SyncMode | null,
): string => {
  const parts = [
    `窗口：${session.name ?? session.id}`,
    session.cwd ? `目录：${session.cwd}` : "",
    mode ? `消息模式：${renderModeLabel(mode)}` : "",
    session.codexAttached === false ? "Codex：未连接" : "Codex：已连接",
    session.codexFooterStatus?.modelLabel ? `模型：${session.codexFooterStatus.modelLabel}` : "",
    session.codexFooterStatus?.contextLeft ? `上下文：${session.codexFooterStatus.contextLeft}` : "",
    session.codexFooterStatus?.cwdLabel ? `界面目录：${session.codexFooterStatus.cwdLabel}` : "",
    `状态：${session.runtimeState}`,
    session.updatedAt ? `最近更新：${session.updatedAt}` : "",
    session.preview ? `预览：${session.preview}` : "",
  ].filter(Boolean);

  return normalize(parts.join("\n"));
};

export const formatSessionMessage = (
  message: SessionMessage,
  maxLength: number,
): string[] => {
  if (message.source === "tmux" || message.kind === "tool" || message.role === "tool") {
    const body = normalize(message.text) || "(空内容)";
    return chunkStructuredOutput(body, maxLength);
  }

  const body = normalize(message.text) || "(空内容)";
  if (message.source === "session_file" && message.role === "assistant") {
    return chunkStructuredOutput(body, maxLength);
  }

  const prefix = message.role === "user" ? "你" : "系统";
  return chunkText(`${prefix}：\n${body}`, maxLength);
};

export const formatApprovalRequest = (approval: ApprovalRequest): string => {
  return normalize(`【${approval.title}】\n${approval.body}\n\n会话：${approval.sessionId}`);
};

export const formatControlSummary = (
  sessions: SessionSnapshot[],
  currentSessionId: string | null,
  mode: SyncMode,
): string => {
  const counts = {
    active: sessions.filter((session) => session.runtimeState === "active").length,
    waitingApproval: sessions.filter((session) => session.runtimeState === "waitingApproval").length,
    idle: sessions.filter(
      (session) => session.runtimeState === "idle" && session.codexAttached !== false,
    ).length,
    detached: sessions.filter((session) => session.codexAttached === false).length,
  };

  const currentSessionLabel =
    currentSessionId === null
      ? null
      : sessions.find((session) => session.id === currentSessionId)?.name ??
        currentSessionId;

  const nextStepHint =
    sessions.length === 0
      ? "下一步：在专用机上新建 tmux session 或启动 Codex，bridge 会自动发现。"
      : currentSessionLabel
        ? "下一步：进入对应子话题或直接在当前总控里发“状态 / 继续 / 中断”。"
        : "下一步：总控本身不承接具体任务；请进入对应任务子话题操作。私聊场景如果要直连默认窗口，再用“绑定最新窗口”。";

  const lines = [
    "总控视图",
    `当前模式：${renderModeLabel(mode)}`,
    currentSessionLabel ? `当前已绑定：${currentSessionLabel}` : "当前未绑定窗口",
    `窗口总数：${sessions.length}`,
    `运行中：${counts.active} · 等待确认：${counts.waitingApproval} · 空闲：${counts.idle} · 待重连：${counts.detached}`,
    `提示：${nextStepHint}`,
    "",
    sessions
      .slice(0, 12)
      .map((session, index) => `${index + 1}. ${formatSessionSummary(session)}`)
      .join("\n\n"),
  ];

  return normalize(lines.join("\n"));
};

const renderModeLabel = (mode: SyncMode): string => {
  if (mode === "local") {
    return "本地模式";
  }
  if (mode === "hybrid") {
    return "提醒模式";
  }
  return "远程模式";
};

const chunkStructuredOutput = (text: string, maxLength: number): string[] => {
  if (text.length <= maxLength) {
    return [text];
  }

  const blocks = splitReadableBlocks(text);
  if (blocks.length <= 1) {
    return chunkText(text, maxLength);
  }

  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    const normalized = current.trim();
    if (normalized) {
      chunks.push(normalized);
      current = "";
    }
  };

  for (const block of blocks) {
    if (block.length > maxLength) {
      flush();
      chunks.push(...chunkText(block, maxLength));
      continue;
    }

    const next = current ? `${current}\n\n${block}` : block;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }

    flush();
    current = block;
  }

  flush();
  return chunks.length > 0 ? chunks : chunkText(text, maxLength);
};

const splitReadableBlocks = (text: string): string[] => {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];

  const flush = (): void => {
    const block = current.join("\n").trim();
    if (block) {
      blocks.push(block);
    }
    current = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }

    if (current.length > 0 && isReadableSectionBoundary(trimmed, lines[index + 1]?.trim() ?? "")) {
      flush();
    }

    current.push(line);
  }

  flush();
  return blocks;
};

const isReadableSectionBoundary = (line: string, nextLine: string): boolean => {
  if (line.length > 28) {
    return false;
  }

  if (
    /^(当前进度|验证结果|结论|下一步|说明|常用入口|设计意图|群准备检查|当前聊天信息|处理结果|剩余风险|后续建议)(：|:|$)/.test(
      line,
    )
  ) {
    return true;
  }

  if (
    (line.endsWith("：") || line.endsWith(":")) &&
    (nextLine.startsWith("- ") ||
      nextLine.startsWith("• ") ||
      /^\d+\.\s+/.test(nextLine))
  ) {
    return true;
  }

  return false;
};
