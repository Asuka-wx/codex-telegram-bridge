import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { z } from "zod";

const TELEGRAM_DISCOVER_DRAIN_MAX_ROUNDS = 200;

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN 不能为空"),
});

const getEnv = () => envSchema.parse(process.env);

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessageLike {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessageLike;
  edited_message?: TelegramMessageLike;
  callback_query?: {
    id: string;
    from: TelegramUser;
    message?: TelegramMessageLike;
    data?: string;
  };
}

export const getNextTelegramUpdateOffset = (
  updates: Array<{ update_id: number }>,
  currentOffset = 0,
): number => {
  let nextOffset = currentOffset;
  for (const update of updates) {
    nextOffset = Math.max(nextOffset, update.update_id + 1);
  }
  return nextOffset;
};

export const drainTelegramUpdateQueue = async (
  fetchUpdates: (offset: number) => Promise<TelegramUpdate[]>,
  initialOffset = 0,
): Promise<number> => {
  let offset = initialOffset;

  for (let round = 0; round < TELEGRAM_DISCOVER_DRAIN_MAX_ROUNDS; round += 1) {
    const updates = await fetchUpdates(offset);
    if (updates.length === 0) {
      return offset;
    }
    offset = getNextTelegramUpdateOffset(updates, offset);
  }

  return offset;
};

export const findRunningBridgePid = async (
  lockFilePath: string,
  isProcessAlive: (pid: number) => boolean = defaultIsProcessAlive,
): Promise<number | null> => {
  let raw = "";
  try {
    raw = await fs.readFile(lockFilePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid)) {
    return null;
  }

  return isProcessAlive(pid) ? pid : null;
};

const request = async <T>(
  apiBase: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> => {
  const response = await fetch(`${apiBase}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body
      ? {
          "content-type": "application/json",
        }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw new Error(`Telegram API 请求失败: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as { ok: boolean; result: T };
  if (!json.ok) {
    throw new Error(`Telegram API 返回失败结果: ${method}`);
  }
  return json.result;
};

const readUpdateMessage = (update: TelegramUpdate): TelegramMessageLike | null => {
  if (update.message) {
    return update.message;
  }
  if (update.edited_message) {
    return update.edited_message;
  }
  if (update.callback_query?.message) {
    return update.callback_query.message;
  }
  return null;
};

const formatChatLabel = (chat: TelegramChat): string => {
  return (
    chat.title ??
    chat.username ??
    [chat.first_name, chat.last_name].filter(Boolean).join(" ") ??
    "unknown"
  );
};

const defaultIsProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
};

const main = async (): Promise<void> => {
  const env = getEnv();
  const apiBase = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const activeBridgePid = await findRunningBridgePid(
    path.resolve(process.cwd(), ".data", "bridge.pid"),
  );
  if (activeBridgePid !== null) {
    throw new Error(
      `检测到 bridge 正在运行 (pid=${activeBridgePid})。请先停止 bridge，再执行 telegram:discover，避免 getUpdates 409 冲突。`,
    );
  }

  const me = await request<TelegramUser>(apiBase, "getMe");
  console.log("Bot 信息：");
  console.log(
    JSON.stringify(
      {
        id: me.id,
        username: me.username ?? null,
        firstName: me.first_name,
      },
      null,
      2,
    ),
  );

  console.log("");
  console.log("接下来 60 秒内，请在目标私聊或目标群里给这个 bot 发一条消息。");
  console.log("我会把 chat id 和 user id 打印出来。");

  let offset = await drainTelegramUpdateQueue((currentOffset) =>
    request<TelegramUpdate[]>(apiBase, "getUpdates", {
      timeout: 0,
      offset: currentOffset,
      allowed_updates: ["message", "edited_message", "callback_query"],
    }),
  );
  const startedAt = Date.now();

  while (Date.now() - startedAt < 60_000) {
    const updates = await request<TelegramUpdate[]>(apiBase, "getUpdates", {
      timeout: 10,
      offset,
      allowed_updates: ["message", "edited_message", "callback_query"],
    });

    for (const update of updates) {
      offset = getNextTelegramUpdateOffset([update], offset);
      const message = readUpdateMessage(update);
      if (!message) {
        continue;
      }

      const actor = update.callback_query?.from ?? message.from ?? null;
      console.log("");
      console.log("捕获到更新：");
      console.log(
        JSON.stringify(
          {
            chat: {
              id: message.chat.id,
              type: message.chat.type,
              label: formatChatLabel(message.chat),
              username: message.chat.username ?? null,
            },
            actor: actor
              ? {
                  id: actor.id,
                  username: actor.username ?? null,
                  firstName: actor.first_name,
                }
              : null,
            hasText: Boolean(message.text ?? update.callback_query?.data),
          },
          null,
          2,
        ),
      );
      console.log("");
      console.log("把上面的 chat.id / actor.id 记下来，填进 .env。");
      return;
    }

    await delay(300);
  }

  throw new Error("60 秒内没有收到任何 Telegram 更新，请确认你已经给 bot 发过消息。");
};

const isDirectExecution = (): boolean => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return pathToFileURL(entry).href === import.meta.url;
};

if (isDirectExecution()) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
