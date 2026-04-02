import { homedir } from "node:os";
import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const isTestEnv =
  process.env.VITEST === "true" || process.env.NODE_ENV === "test";

const parseInteger = (value: string, fieldName: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} 必须是大于 0 的整数`);
  }
  return parsed;
};

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: isTestEnv
    ? z.string().optional().default("0:test-token")
    : z.string().min(1),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().optional().default(""),
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional().default(""),
  TELEGRAM_CONTROL_CHAT_ID: z.string().optional(),
  TELEGRAM_STRICT_SECURITY: z
    .string()
    .optional()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),
  TELEGRAM_ENABLE_FORUM_TOPICS: z
    .string()
    .optional()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),
  TELEGRAM_CONTROL_TOPIC_NAME: z.string().optional().default("总控"),
  TELEGRAM_MESSAGE_MAX_LENGTH: z
    .string()
    .optional()
    .default("3500"),
  CODEX_BIN: z.string().optional().default("codex"),
  CODEX_SESSIONS_DIR: z.string().optional(),
  BRIDGE_DATA_DIR: z.string().optional(),
  PROJECT_ROOT: z.string().optional(),
  SESSION_ACTIVITY_WINDOW_SECONDS: z
    .string()
    .optional()
    .default("45"),
  TMUX_BOOTSTRAP_SESSIONS: z.string().optional().default(""),
  TMUX_BOOTSTRAP_LAYOUT: z.string().optional().default(""),
});

const parsed = envSchema.parse(process.env);

const parseChatIds = (raw: string, fieldName: string): Set<number> => {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const result = new Set<number>();
  for (const value of values) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`${fieldName} 包含无效 ID：${value}`);
    }
    result.add(parsed);
  }

  return result;
};

const parseTmuxBootstrapSessionNames = (
  rawSessions: string,
  rawLayout: string,
): Set<string> => {
  const result = new Set<string>();

  for (const raw of rawSessions.split(",")) {
    const value = raw.trim();
    if (value) {
      result.add(value);
    }
  }

  for (const raw of rawLayout.split(",")) {
    const entry = raw.trim();
    if (!entry) {
      continue;
    }

    const sessionName = entry.split(":")[0]?.trim();
    if (sessionName) {
      result.add(sessionName);
    }
  }

  return result;
};

export const config = {
  telegram: {
    token: parsed.TELEGRAM_BOT_TOKEN,
    allowedChatIds: parseChatIds(
      parsed.TELEGRAM_ALLOWED_CHAT_IDS,
      "TELEGRAM_ALLOWED_CHAT_IDS",
    ),
    allowedUserIds: parseChatIds(
      parsed.TELEGRAM_ALLOWED_USER_IDS,
      "TELEGRAM_ALLOWED_USER_IDS",
    ),
    controlChatId: parsed.TELEGRAM_CONTROL_CHAT_ID
      ? parseInteger(parsed.TELEGRAM_CONTROL_CHAT_ID, "TELEGRAM_CONTROL_CHAT_ID")
      : null,
    strictSecurity: parsed.TELEGRAM_STRICT_SECURITY,
    enableForumTopics: parsed.TELEGRAM_ENABLE_FORUM_TOPICS,
    controlTopicName: parsed.TELEGRAM_CONTROL_TOPIC_NAME.trim() || "总控",
    messageMaxLength: parseInteger(
      parsed.TELEGRAM_MESSAGE_MAX_LENGTH,
      "TELEGRAM_MESSAGE_MAX_LENGTH",
    ),
  },
  codex: {
    bin: parsed.CODEX_BIN,
    sessionsDir:
      parsed.CODEX_SESSIONS_DIR !== undefined && parsed.CODEX_SESSIONS_DIR.trim() !== ""
        ? path.resolve(parsed.CODEX_SESSIONS_DIR)
        : path.join(homedir(), ".codex", "sessions"),
    projectRoot:
      parsed.PROJECT_ROOT !== undefined && parsed.PROJECT_ROOT.trim() !== ""
        ? path.resolve(parsed.PROJECT_ROOT)
        : path.resolve(process.cwd(), ".."),
    sessionActivityWindowSeconds: parseInteger(
      parsed.SESSION_ACTIVITY_WINDOW_SECONDS,
      "SESSION_ACTIVITY_WINDOW_SECONDS",
    ),
  },
  tmux: {
    stableSessionNames: parseTmuxBootstrapSessionNames(
      parsed.TMUX_BOOTSTRAP_SESSIONS,
      parsed.TMUX_BOOTSTRAP_LAYOUT,
    ),
  },
  dataDir:
    parsed.BRIDGE_DATA_DIR !== undefined && parsed.BRIDGE_DATA_DIR.trim() !== ""
      ? path.resolve(parsed.BRIDGE_DATA_DIR)
      : path.resolve(process.cwd(), ".data"),
} as const;

export const isChatAllowed = (chatId: number): boolean => {
  if (config.telegram.allowedChatIds.size === 0) {
    return true;
  }

  return config.telegram.allowedChatIds.has(chatId);
};

export const isUserAllowed = (userId: number): boolean => {
  if (config.telegram.allowedUserIds.size === 0) {
    return true;
  }

  return config.telegram.allowedUserIds.has(userId);
};

export const validateTelegramSecurityConfig = (): void => {
  if (!config.telegram.strictSecurity) {
    return;
  }

  const missing: string[] = [];

  if (config.telegram.allowedChatIds.size === 0) {
    missing.push("TELEGRAM_ALLOWED_CHAT_IDS");
  }

  if (config.telegram.allowedUserIds.size === 0) {
    missing.push("TELEGRAM_ALLOWED_USER_IDS");
  }

  if (config.telegram.controlChatId === null) {
    missing.push("TELEGRAM_CONTROL_CHAT_ID");
  }

  if (missing.length > 0) {
    throw new Error(
      `Telegram 安全配置不完整，拒绝启动。缺少：${missing.join(", ")}`,
    );
  }
};
