import type { SessionMessage } from "../types/domain.js";

const TOOL_OUTPUT_PREVIEW_MAX_LINES = 8;
const TOOL_OUTPUT_PREVIEW_MAX_CHARS = 700;
const COLLAPSE_TOOL_OUTPUT_LINE_THRESHOLD = 18;
const COLLAPSE_TOOL_OUTPUT_CHAR_THRESHOLD = 1_200;

type TelegramChunkPayload = {
  text: string;
  parseMode?: "HTML";
};

export const shouldCollapseTelegramToolOutput = (
  message: SessionMessage,
): boolean => {
  if (message.kind !== "tool" && message.role !== "tool") {
    return false;
  }

  const text = message.text.trim();
  if (!text) {
    return false;
  }

  const lineCount = text.split("\n").length;
  return (
    text.length > COLLAPSE_TOOL_OUTPUT_CHAR_THRESHOLD ||
    lineCount > COLLAPSE_TOOL_OUTPUT_LINE_THRESHOLD
  );
};

export const shouldCollapseTelegramSemanticMessage = (
  message: SessionMessage,
): boolean => {
  void message;
  return false;
};

export const shouldCollapseTelegramMessage = (
  message: SessionMessage,
): boolean => {
  return shouldCollapseTelegramToolOutput(message);
};

export const formatCollapsedTelegramMessagePreview = (
  message: SessionMessage,
): TelegramChunkPayload => {
  const text = message.text.trim() || "(空内容)";
  const lines = text.split("\n");
  const previewLines = buildToolPreviewLines(lines, TOOL_OUTPUT_PREVIEW_MAX_LINES);
  let preview = previewLines.join("\n");
  if (preview.length > TOOL_OUTPUT_PREVIEW_MAX_CHARS) {
    preview = `${preview.slice(0, TOOL_OUTPUT_PREVIEW_MAX_CHARS - 3)}...`;
  }

  const omittedLines = Math.max(0, lines.length - previewLines.length);
  const suffix =
    omittedLines > 0 || preview.length < text.length
      ? "其余内容已折叠，点击下方按钮查看完整内容。"
      : "点击下方按钮查看完整内容。";

  return {
    text: [
      "<b>【长工具输出已折叠】</b>",
      `<b>长度：</b><code>${lines.length} 行 / ${text.length} 字符</code>`,
      "<b>预览：</b>",
      `<pre>${escapeHtml(preview)}</pre>`,
      escapeHtml(suffix),
    ].join("\n"),
    parseMode: "HTML",
  };
};

export const formatTelegramChunk = (
  message: SessionMessage,
  chunk: string,
): TelegramChunkPayload => {
  if (!shouldUseRichTelegramFormatting(message)) {
    return { text: chunk };
  }

  const richText = formatRichTelegramText(message, chunk);
  if (richText) {
    return {
      text: richText,
      parseMode: "HTML",
    };
  }

  if (looksPreformattedChunk(chunk)) {
    return {
      text: `<pre>${escapeHtml(chunk)}</pre>`,
      parseMode: "HTML",
    };
  }

  return {
    text: chunk,
  };
};

export const shouldBufferSemanticMessage = (message: SessionMessage): boolean => {
  return (
    message.source === "session_file" &&
    message.role === "assistant" &&
    message.phase === "commentary"
  );
};

export const canMergeSemanticMessages = (
  left: SessionMessage,
  right: SessionMessage,
): boolean => {
  return (
    shouldBufferSemanticMessage(left) &&
    shouldBufferSemanticMessage(right) &&
    left.sessionId === right.sessionId &&
    left.source === right.source &&
    left.role === right.role &&
    (left.phase ?? null) === (right.phase ?? null)
  );
};

export const mergeSemanticMessages = (
  left: SessionMessage,
  right: SessionMessage,
): SessionMessage => {
  return {
    ...right,
    id: `${left.id}+${right.id}`,
    text: [left.text.trim(), right.text.trim()].filter(Boolean).join("\n\n"),
    timestamp: right.timestamp,
    turnId: right.turnId ?? left.turnId ?? null,
  };
};

const buildToolPreviewLines = (lines: string[], maxLines: number): string[] => {
  const picked: string[] = [];
  const seen = new Set<string>();
  const nonEmptyLines = lines.filter((line) => line.trim());

  const pushLine = (line: string): void => {
    const normalized = line.trim();
    if (!normalized || seen.has(normalized) || picked.length >= maxLines) {
      return;
    }
    seen.add(normalized);
    picked.push(line);
  };

  for (const line of nonEmptyLines) {
    if (isHighSignalToolPreviewLine(line.trim())) {
      pushLine(line);
    }
    if (picked.length >= maxLines) {
      return picked;
    }
  }

  if (picked.length > 0) {
    return picked;
  }

  for (let index = nonEmptyLines.length - 1; index >= 0; index -= 1) {
    pushLine(nonEmptyLines[index] ?? "");
    if (picked.length >= maxLines) {
      return picked;
    }
  }

  for (const line of nonEmptyLines) {
    pushLine(line);
    if (picked.length >= maxLines) {
      break;
    }
  }

  return picked;
};

const isHighSignalToolPreviewLine = (line: string): boolean => {
  return (
    looksErrorSummaryLine(line) ||
    looksKeyValueStatusLine(line) ||
    looksCommandResultLine(line) ||
    /^> /.test(line) ||
    /^[$]/.test(line) ||
    /^[✓✔✖✗]/.test(line) ||
    /^(Error|[A-Z][A-Za-z0-9]+Error):/.test(line) ||
    /\bexit\s+\d+\b/i.test(line) ||
    /^(处理结果|当前进度|验证结果|结论|下一步|这部分在|代码片段|附加日志|现在的变化)(：|:|$)/.test(
      line,
    )
  );
};

const formatRichTelegramText = (
  message: SessionMessage,
  text: string,
): string | null => {
  const semanticAssistant =
    message.source === "session_file" && message.role === "assistant";
  const lines = text.split("\n");
  let usedMarkup = false;

  const formatted = lines
    .map((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return "";
      }

      if (isDividerLine(trimmed)) {
        usedMarkup = true;
        return "";
      }

      const sectionLabel = getSectionLabel(trimmed, lines[index + 1]?.trim() ?? "");
      if (sectionLabel) {
        usedMarkup = true;
        const sectionBody = new RegExp(`^${escapeRegExp(sectionLabel)}[：:]?$`).test(trimmed)
          ? ""
          : trimmed;
        const renderedSectionBody = renderSemanticParagraph(
          sectionBody,
          semanticAssistant,
        );
        return sectionBody
          ? `${renderSectionHeading(sectionLabel)}\n${renderedSectionBody}`
          : renderSectionHeading(sectionLabel);
      }

      if (trimmed.startsWith("• ")) {
        usedMarkup = true;
        return formatBulletLine(trimmed.slice(2), "•");
      }

      if (trimmed.startsWith("- ")) {
        usedMarkup = true;
        return formatBulletLine(trimmed.slice(2), "•");
      }

      if (/^\d+\.\s+/.test(trimmed)) {
        usedMarkup = true;
        return formatNumberedLine(trimmed);
      }

      if (
        trimmed.startsWith("└ ") ||
        trimmed.startsWith("├ ") ||
        trimmed.startsWith("│ ")
      ) {
        usedMarkup = true;
        return `<code>${escapeHtml(trimmed)}</code>`;
      }

      if (looksCommandResultLine(trimmed)) {
        usedMarkup = true;
        return `<code>${escapeHtml(trimmed)}</code>`;
      }

      if (looksErrorSummaryLine(trimmed)) {
        usedMarkup = true;
        return formatErrorSummaryLine(trimmed);
      }

      if (looksKeyValueStatusLine(trimmed)) {
        usedMarkup = true;
        return formatKeyValueLine(trimmed);
      }

      const maybeRichParagraph = renderSemanticParagraph(line, semanticAssistant);
      if (maybeRichParagraph !== escapeHtml(line)) {
        usedMarkup = true;
        return maybeRichParagraph;
      }

      return maybeRichParagraph;
    })
    .join("\n")
    .trim();

  return usedMarkup ? formatted : null;
};

const looksPreformattedChunk = (text: string): boolean => {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");

  if (lines.length === 0) {
    return false;
  }

  const codeLikeLineCount = lines.filter(isCodeLikeLine).length;
  if (codeLikeLineCount >= Math.max(2, Math.ceil(lines.length / 2))) {
    return true;
  }

  return false;
};

const renderSectionHeading = (label: string): string => {
  return `<b><u>【${escapeHtml(label)}】</u></b>`;
};

const renderSemanticParagraph = (
  line: string,
  semanticAssistant: boolean,
): string => {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }

  const richParagraph = formatParagraphLine(trimmed);
  if (!semanticAssistant) {
    return richParagraph;
  }

  if (shouldQuoteSemanticParagraph(trimmed)) {
    return `<blockquote>${richParagraph}</blockquote>`;
  }

  return richParagraph;
};

const shouldQuoteSemanticParagraph = (text: string): boolean => {
  if (text.length < 14) {
    return false;
  }

  return (
    /[，。；：]/.test(text) ||
    /\bTG\b|\bTelegram\b/i.test(text) ||
    text.startsWith("现在的变化") ||
    text.startsWith("验证")
  );
};

const shouldUseRichTelegramFormatting = (message: SessionMessage): boolean => {
  return (
    message.source === "tmux" ||
    message.kind === "tool" ||
    message.role === "tool" ||
    (message.source === "session_file" && message.role === "assistant")
  );
};

const isDividerLine = (line: string): boolean => /^[-─━]{8,}$/.test(line);

const getSectionLabel = (line: string, nextLine: string): string | null => {
  if (line.startsWith("当前进度")) {
    return "当前进度";
  }
  if (line.startsWith("验证结果")) {
    return "验证结果";
  }
  if (line.startsWith("结论")) {
    return "结论";
  }
  if (line.startsWith("下一步")) {
    return "下一步";
  }
  if (line.startsWith("说明")) {
    return "说明";
  }
  if (line.startsWith("处理结果")) {
    return "处理结果";
  }
  if (line.startsWith("现在的变化")) {
    return "现在的变化";
  }
  if (line.startsWith("验证")) {
    return "验证结果";
  }
  if (line.startsWith("剩余风险")) {
    return "剩余风险";
  }
  if (line.startsWith("后续建议")) {
    return "后续建议";
  }
  if (line.startsWith("常用入口")) {
    return "常用入口";
  }
  if (line.startsWith("设计意图")) {
    return "设计意图";
  }
  if (line.startsWith("群准备检查")) {
    return "群准备检查";
  }
  if (line.startsWith("当前聊天信息")) {
    return "当前聊天信息";
  }
  if (
    line.endsWith("：") &&
    line.length <= 24 &&
    (nextLine.startsWith("- ") ||
      nextLine.startsWith("• ") ||
      /^\d+\.\s+/.test(nextLine))
  ) {
    return line.slice(0, -1);
  }
  return null;
};

const formatBulletLine = (text: string, marker: string): string => {
  const labelMatch = text.match(/^([^：:]{1,24})([：:])\s*(.*)$/);
  if (labelMatch) {
    const [, head = "", , body = ""] = labelMatch;
    return `${marker} <b>${escapeHtml(head)}：</b>${formatValueText(head, body)}`;
  }
  if (looksStandalonePathLike(text) || looksStandaloneCommand(text)) {
    return `${marker} <code>${escapeHtml(text)}</code>`;
  }
  return `${marker} ${formatInlineText(text)}`;
};

const formatNumberedLine = (text: string): string => {
  const match = text.match(/^(\d+)\.\s+(.*)$/);
  if (!match) {
    return formatInlineText(text);
  }

  const [, index = "", body = ""] = match;
  return `<b>${escapeHtml(index)}.</b> ${formatInlineText(body)}`;
};

const formatParagraphLine = (line: string): string => {
  if (looksStandalonePathLike(line.trim()) || looksStandaloneCommand(line.trim())) {
    return `<code>${escapeHtml(line.trim())}</code>`;
  }
  return formatInlineText(line);
};

const formatInlineText = (text: string): string => {
  const tokens: string[] = [];
  let working = text;

  const stash = (html: string): string => {
    const token = `@@TOKEN_${tokens.length}@@`;
    tokens.push(html);
    return token;
  };

  working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string) =>
    stash(`<code>${escapeHtml(label)}</code>`),
  );

  working = working.replace(/`([^`]+)`/g, (_match, code: string) =>
    stash(`<code>${escapeHtml(code)}</code>`),
  );

  working = working.replace(
    /(?<!\w)(pnpm [\w:-]+|npm run [\w:-]+|tmux [\w:-]+|\/[a-z][\w-]*)(?!\w)/g,
    (match: string) => stash(`<code>${escapeHtml(match)}</code>`),
  );

  working = working.replace(
    /(?<!\w)((?:~\/|\.{1,2}\/|\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+(?::\d+)?)?)(?!\w)/g,
    (match: string) => stash(`<code>${escapeHtml(match)}</code>`),
  );

  working = working.replace(
    /\b([A-Za-z0-9._-]+\.(?:log|txt|md|json|js|jsx|ts|tsx|sh|plist|yaml|yml))\b/g,
    (match: string) => stash(`<code>${escapeHtml(match)}</code>`),
  );

  working = working.replace(/\b(task[A-Za-z0-9_-]+)\b/g, (match: string) =>
    stash(`<code>${escapeHtml(match)}</code>`),
  );

  let escaped = escapeHtml(working);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = `@@TOKEN_${index}@@`;
    escaped = escaped.replace(token, tokens[index] ?? "");
  }
  return escaped;
};

const formatKeyValueLine = (line: string): string => {
  const match = line.match(/^([^：:]{1,24})([：:])\s*(.*)$/);
  if (!match) {
    return formatInlineText(line);
  }

  const [, label = "", , value = ""] = match;
  return `<b>${escapeHtml(label)}：</b>${formatValueText(label, value)}`;
};

const formatValueText = (label: string, value: string): string => {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return "";
  }

  if (shouldRenderValueAsCode(label, trimmedValue)) {
    return `<code>${escapeHtml(trimmedValue)}</code>`;
  }

  return formatInlineText(trimmedValue);
};

const shouldRenderValueAsCode = (label: string, value: string): boolean => {
  if (looksStandalonePathLike(value) || looksStandaloneCommand(value)) {
    return true;
  }

  if (/^(exit \d+|[A-Z_]{2,}|[a-f0-9]{7,}|call_[A-Za-z0-9]+)$/i.test(value)) {
    return true;
  }

  return /^(窗口|目录|界面目录|当前已绑定|会话|模型|上下文|文件|路径|日志|命令|Command|cwd|sessionId|callId|turnId|requestId|chatId|currentControlChatId|错误|失败|异常|Error)$/.test(
    label,
  );
};

const looksStandalonePathLike = (text: string): boolean => {
  return /^(?:~\/|\.{1,2}\/|\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+(?::\d+)?)?$/.test(
    text,
  );
};

const looksStandaloneCommand = (text: string): boolean => {
  return /^(?:(?:pnpm|npm|tmux|git|node|npx|python|python3|bash|zsh|sh|launchctl|codex|rg|sed|cat|tail|grep|find|ls|pwd|mkdir|rm|cp|mv|curl|wget|tsx|vitest|tsc|eslint)\b.*|\/[a-z][\w-]*(?:\s+.*)?)$/i.test(
    text,
  );
};

const looksErrorSummaryLine = (line: string): boolean => {
  return /^(错误|失败|异常|Error|[A-Z][A-Za-z0-9]+Error)[：:]/.test(line);
};

const formatErrorSummaryLine = (line: string): string => {
  const match = line.match(/^([^：:]{1,32})([：:])\s*(.*)$/);
  if (!match) {
    return `<b>错误：</b>${formatInlineText(line)}`;
  }

  const [, label = "", , value = ""] = match;
  return `<b>${escapeHtml(label)}：</b>${formatValueText(label, value)}`;
};

const looksCommandResultLine = (line: string): boolean => {
  return (
    line.startsWith("$ ") ||
    line.startsWith("> ") ||
    line.startsWith("/status") ||
    line.startsWith("/sessions") ||
    line.startsWith("/bind") ||
    /^Ran\b/.test(line) ||
    /^Edited\b/.test(line) ||
    /^Waited\b/.test(line) ||
    /^Search(ed)?\b/.test(line)
  );
};

const looksKeyValueStatusLine = (line: string): boolean => {
  return /^(窗口|目录|消息模式|状态|最近更新|预览|当前模式|当前已绑定|窗口总数|运行中|提示|chatId|chatType|botStatus|canManageTopics|isForum|currentControlChatId|isAllowedChat|会话|模型|上下文|界面目录|文件|路径|日志|命令|结果|输出|原因|影响|建议|风险|callId|turnId|requestId|sessionId)(：|:)/.test(
    line,
  );
};

const isCodeLikeLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  if (
    trimmed.startsWith("$ ") ||
    trimmed.startsWith("> ") ||
    trimmed.startsWith("| ") ||
    trimmed.startsWith("at ") ||
    trimmed.startsWith("diff --git") ||
    trimmed.startsWith("@@") ||
    trimmed.startsWith("import ") ||
    trimmed.startsWith("export ") ||
    trimmed.startsWith("const ") ||
    trimmed.startsWith("let ") ||
    trimmed.startsWith("function ") ||
    trimmed.startsWith("class ") ||
    trimmed.startsWith("interface ") ||
    trimmed.startsWith("type ") ||
    trimmed.startsWith("return ") ||
    trimmed.startsWith("if (") ||
    trimmed.startsWith("for (") ||
    trimmed.startsWith("while (")
  ) {
    return true;
  }

  if (
    trimmed.includes("=>") ||
    trimmed.includes("::") ||
    trimmed.includes("</") ||
    trimmed.includes("/>") ||
    /^\s*[[\]{}();,]+$/.test(line) ||
    /^([A-Z][A-Za-z0-9]+Error|Error):/.test(trimmed)
  ) {
    return true;
  }

  return false;
};

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
