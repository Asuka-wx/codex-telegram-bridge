import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { config } from "../config.js";
import type { TopicBinding } from "../types/domain.js";
import { logger } from "../utils/logger.js";

export type SyncMode = "local" | "hybrid" | "remote";

interface PersistedState {
  selectedSessionsByChat: Record<string, string>;
  topicBindings: Record<string, TopicBinding>;
  syncModeByChat: Record<string, SyncMode>;
  syncModeByChatSession: Record<string, SyncMode>;
  controlPanelMessageIdByChat: Record<string, number>;
  controlPanelThreadIdByChat: Record<string, number>;
  controlChatIdOverride: number | null;
  allowedChatIdOverrides: number[];
}

const createDefaultState = (): PersistedState => ({
  selectedSessionsByChat: {},
  topicBindings: {},
  syncModeByChat: {},
  syncModeByChatSession: {},
  controlPanelMessageIdByChat: {},
  controlPanelThreadIdByChat: {},
  controlChatIdOverride: null,
  allowedChatIdOverrides: [],
});

const buildChatSessionKey = (chatId: number, sessionId: string): string =>
  `${chatId}:${sessionId}`;

export class StateStore {
  private readonly filePath = path.join(config.dataDir, "state.json");

  private state: PersistedState = createDefaultState();

  private saveQueue: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    await fs.mkdir(config.dataDir, { recursive: true });
    let raw = "";

    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.state = createDefaultState();
        return;
      }

      logger.warn("读取 state 文件失败，已回退到默认状态", {
        filePath: this.filePath,
        error,
      });
      this.state = createDefaultState();
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      const parsedBindings = parsed.topicBindings ?? {};
      const normalizedBindings = Object.values(parsedBindings).reduce<Record<string, TopicBinding>>(
        (accumulator, binding) => {
          if (!binding) {
            return accumulator;
          }
          const key = buildTopicBindingKey(binding.chatId, binding.sessionId);
          accumulator[key] = binding;
          return accumulator;
        },
        {},
      );
      const cleanedBindings = cleanupLegacyDuplicateTopicBindings(normalizedBindings);
      const controlChatId = parsed.controlChatIdOverride ?? config.telegram.controlChatId ?? null;

      this.state = {
        selectedSessionsByChat: normalizeSelectedSessions(
          parsed.selectedSessionsByChat ?? {},
          cleanedBindings,
          controlChatId,
        ),
        topicBindings: cleanedBindings,
        syncModeByChat: parsed.syncModeByChat ?? {},
        syncModeByChatSession: parsed.syncModeByChatSession ?? {},
        controlPanelMessageIdByChat: parsed.controlPanelMessageIdByChat ?? {},
        controlPanelThreadIdByChat: parsed.controlPanelThreadIdByChat ?? {},
        controlChatIdOverride: parsed.controlChatIdOverride ?? null,
        allowedChatIdOverrides: parsed.allowedChatIdOverrides ?? [],
      };
    } catch (error) {
      await this.backupCorruptedState(raw, error);
      this.state = createDefaultState();
    }
  }

  getSelectedSession(chatId: number): string | null {
    return this.state.selectedSessionsByChat[String(chatId)] ?? null;
  }

  listSelectedSessions(): Array<{ chatId: number; sessionId: string }> {
    return Object.entries(this.state.selectedSessionsByChat).map(([chatId, sessionId]) => ({
      chatId: Number.parseInt(chatId, 10),
      sessionId,
    }));
  }

  async setSelectedSession(chatId: number, sessionId: string): Promise<void> {
    this.state.selectedSessionsByChat[String(chatId)] = sessionId;
    await this.save();
  }

  async clearSelectedSession(chatId: number): Promise<void> {
    delete this.state.selectedSessionsByChat[String(chatId)];
    await this.save();
  }

  getSyncMode(chatId: number): SyncMode {
    return this.state.syncModeByChat?.[String(chatId)] ?? "remote";
  }

  async setSyncMode(chatId: number, mode: SyncMode): Promise<void> {
    this.state.syncModeByChat[String(chatId)] = mode;
    await this.save();
  }

  getSessionSyncMode(chatId: number, sessionId: string): SyncMode | null {
    return this.state.syncModeByChatSession[buildChatSessionKey(chatId, sessionId)] ?? null;
  }

  async setSessionSyncMode(
    chatId: number,
    sessionId: string,
    mode: SyncMode,
  ): Promise<void> {
    this.state.syncModeByChatSession[buildChatSessionKey(chatId, sessionId)] = mode;
    await this.save();
  }

  async clearSessionSyncMode(chatId: number, sessionId: string): Promise<void> {
    delete this.state.syncModeByChatSession[buildChatSessionKey(chatId, sessionId)];
    await this.save();
  }

  getControlPanelMessageId(chatId: number): number | null {
    return this.state.controlPanelMessageIdByChat[String(chatId)] ?? null;
  }

  getControlPanelThreadId(chatId: number): number | null {
    return this.state.controlPanelThreadIdByChat[String(chatId)] ?? null;
  }

  async setControlPanelMessageId(
    chatId: number,
    messageId: number,
    threadId?: number | null,
  ): Promise<void> {
    this.state.controlPanelMessageIdByChat[String(chatId)] = messageId;
    if (threadId === undefined || threadId === null) {
      delete this.state.controlPanelThreadIdByChat[String(chatId)];
    } else {
      this.state.controlPanelThreadIdByChat[String(chatId)] = threadId;
    }
    await this.save();
  }

  async clearControlPanelMessageId(chatId: number): Promise<void> {
    delete this.state.controlPanelMessageIdByChat[String(chatId)];
    delete this.state.controlPanelThreadIdByChat[String(chatId)];
    await this.save();
  }

  getControlChatId(): number | null {
    return this.state.controlChatIdOverride ?? config.telegram.controlChatId;
  }

  async setControlChatIdOverride(chatId: number): Promise<void> {
    this.state.controlChatIdOverride = chatId;
    await this.save();
  }

  async handoffControlChat(toChatId: number): Promise<number | null> {
    const previous = this.getControlChatId();
    const previousSelectedSession =
      previous !== null ? this.getSelectedSession(previous) : null;
    this.state.controlChatIdOverride = toChatId;
    if (previous !== null && previous !== toChatId) {
      this.state.syncModeByChat[String(previous)] = "local";
    }
    if (toChatId < 0) {
      delete this.state.selectedSessionsByChat[String(toChatId)];
    } else if (previousSelectedSession && !this.getSelectedSession(toChatId)) {
      this.state.selectedSessionsByChat[String(toChatId)] = previousSelectedSession;
    }
    await this.save();
    return previous !== toChatId ? previous : null;
  }

  async clearControlChatIdOverride(): Promise<void> {
    this.state.controlChatIdOverride = null;
    await this.save();
  }

  isAllowedChat(chatId: number): boolean {
    return (
      config.telegram.allowedChatIds.has(chatId) ||
      this.state.allowedChatIdOverrides.includes(chatId)
    );
  }

  async addAllowedChatOverride(chatId: number): Promise<void> {
    if (this.state.allowedChatIdOverrides.includes(chatId)) {
      return;
    }
    this.state.allowedChatIdOverrides.push(chatId);
    await this.save();
  }

  async removeAllowedChatOverride(chatId: number): Promise<void> {
    this.state.allowedChatIdOverrides = this.state.allowedChatIdOverrides.filter(
      (value) => value !== chatId,
    );
    await this.save();
  }

  getTopicBindingBySession(sessionId: string): TopicBinding | null {
    return (
      Object.values(this.state.topicBindings).find(
        (binding) => binding.sessionId === sessionId,
      ) ?? null
    );
  }

  getTopicBindingBySessionForChat(sessionId: string, chatId: number): TopicBinding | null {
    return this.state.topicBindings[buildTopicBindingKey(chatId, sessionId)] ?? null;
  }

  listTopicBindings(): TopicBinding[] {
    return Object.values(this.state.topicBindings);
  }

  listTopicBindingsByChat(chatId: number): TopicBinding[] {
    return Object.values(this.state.topicBindings).filter(
      (binding) => binding.chatId === chatId,
    );
  }

  getTopicBindingByTopic(topicId: number): TopicBinding | null {
    return (
      Object.values(this.state.topicBindings).find((binding) => binding.topicId === topicId) ?? null
    );
  }

  getTopicBindingByTopicForChat(topicId: number, chatId: number): TopicBinding | null {
    return (
      Object.values(this.state.topicBindings).find(
        (binding) => binding.topicId === topicId && binding.chatId === chatId,
      ) ?? null
    );
  }

  async setTopicBinding(binding: TopicBinding): Promise<void> {
    this.state.topicBindings[buildTopicBindingKey(binding.chatId, binding.sessionId)] = binding;
    await this.save();
  }

  async rekeyTopicBinding(fromSessionId: string, toSessionId: string): Promise<void> {
    if (fromSessionId === toSessionId) {
      return;
    }

    const bindings = Object.entries(this.state.topicBindings).filter(
      ([, binding]) => binding.sessionId === fromSessionId,
    );
    if (bindings.length === 0) {
      return;
    }

    for (const [key, binding] of bindings) {
      delete this.state.topicBindings[key];
      this.state.topicBindings[buildTopicBindingKey(binding.chatId, toSessionId)] = {
        ...binding,
        sessionId: toSessionId,
      };
    }
    await this.save();
  }

  async archiveTopicBinding(sessionId: string, chatId: number, archivedAt: string): Promise<void> {
    const binding = this.state.topicBindings[buildTopicBindingKey(chatId, sessionId)];
    if (!binding) {
      return;
    }
    this.state.topicBindings[buildTopicBindingKey(chatId, sessionId)] = {
      ...binding,
      archivedAt,
    };
    await this.save();
  }

  async reopenTopicBinding(sessionId: string, chatId: number): Promise<void> {
    const binding = this.state.topicBindings[buildTopicBindingKey(chatId, sessionId)];
    if (!binding) {
      return;
    }
    this.state.topicBindings[buildTopicBindingKey(chatId, sessionId)] = {
      ...binding,
      archivedAt: null,
    };
    await this.save();
  }

  async clearTopicPanelMessageId(sessionId: string, chatId: number): Promise<void> {
    const binding = this.state.topicBindings[buildTopicBindingKey(chatId, sessionId)];
    if (!binding) {
      return;
    }

    this.state.topicBindings[buildTopicBindingKey(chatId, sessionId)] = {
      ...binding,
      panelMessageId: null,
    };
    await this.save();
  }

  async pruneArchivedTopicBindings(chatId: number, keepLatest: number): Promise<void> {
    const archived = this.listTopicBindingsByChat(chatId)
      .filter((binding) => binding.archivedAt)
      .sort((left, right) =>
        (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""),
      );

    const stale = archived.slice(keepLatest);
    if (stale.length === 0) {
      return;
    }

    for (const binding of stale) {
      delete this.state.topicBindings[buildTopicBindingKey(binding.chatId, binding.sessionId)];
    }
    await this.save();
  }

  async removeTopicBinding(sessionId: string, chatId: number): Promise<void> {
    delete this.state.topicBindings[buildTopicBindingKey(chatId, sessionId)];
    await this.save();
  }

  private async save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    const runSave = async (): Promise<void> => {
      await fs.mkdir(config.dataDir, { recursive: true });
      const tempFilePath = `${this.filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;

      try {
        await fs.writeFile(tempFilePath, snapshot, "utf8");
        await fs.rename(tempFilePath, this.filePath);
      } finally {
        await fs.rm(tempFilePath, { force: true }).catch(() => undefined);
      }
    };

    this.saveQueue = this.saveQueue.then(runSave, runSave);
    await this.saveQueue;
  }

  private async backupCorruptedState(raw: string, error: unknown): Promise<void> {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}.json`;

    try {
      await fs.writeFile(backupPath, raw, "utf8");
      logger.warn("state 文件损坏，已备份并回退到默认状态", {
        filePath: this.filePath,
        backupPath,
        error,
      });
    } catch (backupError) {
      logger.warn("state 文件损坏，备份失败，已回退到默认状态", {
        filePath: this.filePath,
        error,
        backupError,
      });
    }
  }
}

const buildTopicBindingKey = (chatId: number, sessionId: string): string => {
  return `${chatId}:${sessionId}`;
};

const cleanupLegacyDuplicateTopicBindings = (
  bindings: Record<string, TopicBinding>,
): Record<string, TopicBinding> => {
  const next = { ...bindings };

  for (const binding of Object.values(bindings)) {
    const stableName = inferStableTmuxSessionName(binding.sessionId);
    if (!stableName) {
      continue;
    }

    const canonicalSessionId = `tmux:${stableName}`;
    if (binding.sessionId === canonicalSessionId) {
      continue;
    }

    const canonicalKey = buildTopicBindingKey(binding.chatId, canonicalSessionId);
    if (!bindings[canonicalKey]) {
      continue;
    }

    delete next[buildTopicBindingKey(binding.chatId, binding.sessionId)];
  }

  return next;
};

const normalizeSelectedSessions = (
  selectedSessionsByChat: Record<string, string>,
  bindings: Record<string, TopicBinding>,
  controlChatId: number | null,
): Record<string, string> => {
  const next = { ...selectedSessionsByChat };

  if (controlChatId !== null && controlChatId < 0) {
    delete next[String(controlChatId)];
  }

  for (const [chatId, sessionId] of Object.entries(selectedSessionsByChat)) {
    const stableName = inferStableTmuxSessionName(sessionId);
    if (!stableName) {
      continue;
    }

    const canonicalSessionId = `tmux:${stableName}`;
    if (sessionId === canonicalSessionId) {
      continue;
    }

    const canonicalKey = buildTopicBindingKey(Number.parseInt(chatId, 10), canonicalSessionId);
    if (bindings[canonicalKey]) {
      next[chatId] = canonicalSessionId;
    }
  }

  return next;
};

const inferStableTmuxSessionName = (sessionId: string): string | null => {
  if (!sessionId.startsWith("tmux:")) {
    return null;
  }

  const remainder = sessionId.slice("tmux:".length);
  const directName = remainder.split(":")[0]?.trim();
  if (directName && config.tmux.stableSessionNames.has(directName)) {
    return directName;
  }

  const legacyName = remainder.match(/^([A-Za-z0-9_-]+?)_\d+_\d+_%\d+_.+$/)?.[1] ?? null;
  if (legacyName && config.tmux.stableSessionNames.has(legacyName)) {
    return legacyName;
  }

  return null;
};
