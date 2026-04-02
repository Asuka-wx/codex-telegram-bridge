import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import { config } from "../config.js";
import type {
  ApprovalRequest,
  SessionMessage,
  SessionSnapshot,
} from "../types/domain.js";
import { logger } from "../utils/logger.js";

type SessionIndexEvents = {
  sessionUpdated: [SessionSnapshot];
  sessionMessage: [SessionMessage];
  approvalUpdated: [ApprovalRequest];
};

interface FileCursor {
  bytesRead: number;
  carry: string;
}

type JsonRecord = Record<string, unknown>;

const SESSION_FILE_PATTERN = /rollout-.*\.jsonl$/;
const SESSION_SCAN_INTERVAL_MS = 2_000;
const APPROVAL_ACTIONS = [
  { key: "y", label: "允许一次" },
  { key: "p", label: "允许并记住" },
  { key: "Escape", label: "拒绝" },
] as const;

export class SessionIndex extends EventEmitter<SessionIndexEvents> {
  private readonly sessions = new Map<string, SessionSnapshot>();

  private readonly sessionIdByFilePath = new Map<string, string>();

  private readonly currentTurnIdByFilePath = new Map<string, string>();

  private readonly cursors = new Map<string, FileCursor>();

  private readonly pendingApprovalByCallId = new Map<string, ApprovalRequest>();

  private pollTimer: NodeJS.Timeout | null = null;

  private watcher: FSWatcher | null = null;

  async start(): Promise<void> {
    await this.loadExistingFiles();
    await this.startWatcher();
    this.startPolling();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  listSessions(): SessionSnapshot[] {
    return [...this.sessions.values()].sort((left, right) =>
      (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
    );
  }

  getSession(sessionId: string): SessionSnapshot | undefined {
    return this.sessions.get(sessionId);
  }

  findSessionsByCwd(cwd: string): SessionSnapshot[] {
    return this.listSessions().filter((session) => session.cwd === cwd);
  }

  findLatestByCwd(cwd: string): SessionSnapshot | undefined {
    return this.findSessionsByCwd(cwd)[0];
  }

  private async loadExistingFiles(): Promise<void> {
    const files = await this.walk(config.codex.sessionsDir);
    await Promise.all(
      files
        .filter((filePath) => SESSION_FILE_PATTERN.test(filePath))
        .map((filePath) => this.readAppended(filePath, true)),
    );
  }

  private async startWatcher(): Promise<void> {
    if (this.watcher) {
      return;
    }

    this.watcher = chokidar.watch(path.join(config.codex.sessionsDir, "**", "rollout-*.jsonl"), {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 120,
        pollInterval: 30,
      },
    });

    this.watcher.on("add", (filePath) => {
      void this.readAppended(filePath, true);
    });
    this.watcher.on("change", (filePath) => {
      void this.readAppended(filePath, false);
    });
    this.watcher.on("error", (error) => {
      logger.warn("监听 session 文件失败", { error });
    });

    await new Promise<void>((resolve) => {
      this.watcher?.once("ready", () => resolve());
    });
  }

  private startPolling(): void {
    if (this.pollTimer !== null) {
      return;
    }

    this.pollTimer = setInterval(() => {
      void this.syncRecentFiles();
    }, SESSION_SCAN_INTERVAL_MS);
    this.pollTimer.unref();

    void this.syncRecentFiles();
  }

  private getLikelyActiveDirectories(): string[] {
    const recentDays = [0, 1].map((offset) => {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      return path.join(
        config.codex.sessionsDir,
        String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      );
    });

    const trackedDirectories = [
      ...this.cursors.keys(),
      ...this.sessionIdByFilePath.keys(),
    ]
      .map((filePath) => path.dirname(filePath))
      .filter(Boolean);

    return [...new Set([...recentDays, ...trackedDirectories])];
  }

  private async syncRecentFiles(): Promise<void> {
    const roots = this.getLikelyActiveDirectories();
    for (const root of roots) {
      try {
        const entries = await fsp.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !SESSION_FILE_PATTERN.test(entry.name)) {
            continue;
          }

          const filePath = path.join(root, entry.name);
          await this.readAppended(filePath, !this.cursors.has(filePath));
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logger.warn("扫描 session 目录失败", { root, error });
        }
      }
    }
  }

  private async walk(root: string): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.walk(fullPath)));
        continue;
      }
      if (entry.isFile()) {
        files.push(fullPath);
      }
    }

    return files;
  }

  private async readAppended(filePath: string, reset: boolean): Promise<void> {
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    const cursor = reset
      ? { bytesRead: 0, carry: "" }
      : (this.cursors.get(filePath) ?? { bytesRead: 0, carry: "" });
    if (stat.size < cursor.bytesRead) {
      cursor.bytesRead = 0;
      cursor.carry = "";
    }

    if (stat.size === cursor.bytesRead && !reset) {
      return;
    }

    const stream = fs.createReadStream(filePath, {
      start: cursor.bytesRead,
      end: stat.size,
      encoding: "utf8",
    });

    let content = cursor.carry;
    for await (const chunk of stream) {
      content += chunk;
    }

    const lines = content.split("\n");
    cursor.carry = lines.pop() ?? "";
    cursor.bytesRead = stat.size;
    this.cursors.set(filePath, cursor);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith("{")) {
        continue;
      }
      try {
        this.handleLine(filePath, JSON.parse(line) as JsonRecord);
      } catch (error) {
        logger.warn("解析 session 行失败", { filePath, error });
      }
    }
  }

  private handleLine(filePath: string, line: JsonRecord): void {
    const timestamp = asString(line.timestamp) ?? new Date().toISOString();
    const type = asString(line.type) ?? "unknown";
    const payload = asRecord(line.payload);

    if (type === "session_meta") {
      this.handleSessionMeta(filePath, payload, timestamp);
      return;
    }

    if (type === "turn_context") {
      this.handleTurnContext(filePath, payload, timestamp);
      return;
    }

    if (type === "response_item") {
      this.handleResponseItem(filePath, payload, timestamp);
      return;
    }

    if (type === "event_msg") {
      this.handleEventMessage(filePath, payload, timestamp);
    }
  }

  private handleSessionMeta(filePath: string, payload: JsonRecord, timestamp: string): void {
    const sessionId = asString(payload.id) ?? path.basename(filePath, ".jsonl");
    this.sessionIdByFilePath.set(filePath, sessionId);

    const existing = this.sessions.get(sessionId);
    const next = this.mergeSession(sessionId, {
      filePath,
      cwd: asString(payload.cwd) ?? existing?.cwd,
      source: normalizeSessionSource(payload.source) ?? existing?.source,
      createdAt: asString(payload.timestamp) ?? existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    this.emit("sessionUpdated", next);
  }

  private handleTurnContext(filePath: string, payload: JsonRecord, timestamp: string): void {
    const turnId = asString(payload.turn_id);
    if (turnId) {
      this.currentTurnIdByFilePath.set(filePath, turnId);
    }

    const session = this.getOrCreateSessionByFilePath(filePath, timestamp);
    const next = this.mergeSession(session.id, {
      cwd: asString(payload.cwd) ?? session.cwd,
      latestTurnId: turnId ?? session.latestTurnId ?? null,
      updatedAt: timestamp,
    });
    this.emit("sessionUpdated", next);
  }

  private handleResponseItem(filePath: string, payload: JsonRecord, timestamp: string): void {
    const itemType = asString(payload.type);
    if (itemType === "function_call") {
      this.handleFunctionCall(filePath, payload, timestamp);
      return;
    }

    if (itemType === "function_call_output") {
      this.handleFunctionCallOutput(filePath, payload, timestamp);
    }
  }

  private handleFunctionCall(filePath: string, payload: JsonRecord, timestamp: string): void {
    const callId = asString(payload.call_id);
    const name = asString(payload.name);
    const argumentsText = asString(payload.arguments);
    if (!callId || !name || !argumentsText) {
      return;
    }

    const parsedArguments = parseJsonObject(argumentsText);
    if (!parsedArguments) {
      return;
    }

    if (name !== "exec_command" || asString(parsedArguments.sandbox_permissions) !== "require_escalated") {
      return;
    }

    const session = this.getOrCreateSessionByFilePath(filePath, timestamp);
    const existingApproval = this.pendingApprovalByCallId.get(callId);
    if (existingApproval) {
      return;
    }

    const command = asString(parsedArguments.cmd) ?? "";
    const justification = asString(parsedArguments.justification);
    const approval: ApprovalRequest = {
      requestId: callId,
      sessionId: session.id,
      callId,
      turnId:
        this.currentTurnIdByFilePath.get(filePath) ??
        session.latestTurnId ??
        undefined,
      kind: "command",
      title: "命令执行需要确认",
      body: buildApprovalBody(command, justification),
      createdAt: timestamp,
      rawMethod: name,
      command,
      justification: justification ?? null,
      sandboxPermissions: "require_escalated",
      actions: [...APPROVAL_ACTIONS],
      signature: command || callId,
    };

    this.pendingApprovalByCallId.set(callId, approval);
    const pendingApprovals = [...(session.pendingApprovals ?? []), approval];
    const activeApproval =
      session.activeApproval && pendingApprovals.some((item) => item.callId === session.activeApproval?.callId)
        ? session.activeApproval
        : pendingApprovals[0] ?? null;
    const next = this.mergeSession(session.id, {
      pendingApprovals,
      activeApproval,
      latestTurnId: approval.turnId ?? session.latestTurnId ?? null,
      preview: buildApprovalPreview(activeApproval ?? approval),
      runtimeState: "waitingApproval",
      updatedAt: timestamp,
    });

    this.emit("sessionUpdated", next);
    this.emit("approvalUpdated", {
      ...approval,
      status: "pending",
    });
  }

  private handleFunctionCallOutput(filePath: string, payload: JsonRecord, timestamp: string): void {
    const callId = asString(payload.call_id);
    const output = asString(payload.output);
    if (!callId || !output) {
      return;
    }

    const approval = this.pendingApprovalByCallId.get(callId);
    if (!approval) {
      return;
    }

    if (!output.includes("aborted by user")) {
      return;
    }

    this.pendingApprovalByCallId.delete(callId);
    const session = this.getOrCreateSessionByFilePath(filePath, timestamp);
    const pendingApprovals = (session.pendingApprovals ?? []).filter(
      (item) => item.callId !== callId,
    );
    const activeApproval = selectNextActiveApproval(session.activeApproval, pendingApprovals);
    const next = this.mergeSession(session.id, {
      pendingApprovals,
      activeApproval,
      preview:
        activeApproval
          ? buildApprovalPreview(activeApproval)
          : `审批已取消：${approval.command ?? approval.title}`,
      runtimeState: pendingApprovals.length > 0 ? "waitingApproval" : "active",
      updatedAt: timestamp,
    });

    this.emit("sessionUpdated", next);
    this.emit("approvalUpdated", {
      ...approval,
      status: "cancelled",
      resolvedAt: timestamp,
    });
  }

  private handleEventMessage(filePath: string, payload: JsonRecord, timestamp: string): void {
    const eventType = asString(payload.type);
    const session = this.getOrCreateSessionByFilePath(filePath, timestamp);

    if (eventType === "user_message" || eventType === "agent_message") {
      const role = eventType === "user_message" ? "user" : "assistant";
      const text = asString(payload.message) ?? "";
      if (!text.trim()) {
        return;
      }

      const message: SessionMessage = {
        id: `${session.id}:${timestamp}:${role}:${session.recentMessages.length}`,
        sessionId: session.id,
        role,
        text,
        timestamp,
        phase: asString(payload.phase) ?? null,
        source: "session_file",
        kind: "chat",
        turnId: asString(payload.turn_id) ?? session.latestTurnId ?? null,
      };

      const recentMessages = [...session.recentMessages, message].slice(-20);
      const next = this.mergeSession(session.id, {
        latestTurnId: message.turnId ?? session.latestTurnId ?? null,
        preview: buildPreviewText(text),
        recentMessages,
        runtimeState:
          session.pendingApprovals && session.pendingApprovals.length > 0
            ? "waitingApproval"
            : role === "assistant" || role === "user"
              ? "active"
              : session.runtimeState,
        updatedAt: timestamp,
      });

      this.emit("sessionUpdated", next);
      this.emit("sessionMessage", message);
      return;
    }

    if (eventType === "task_started") {
      const next = this.mergeSession(session.id, {
        latestTurnId: asString(payload.turn_id) ?? session.latestTurnId ?? null,
        runtimeState:
          session.pendingApprovals && session.pendingApprovals.length > 0
            ? "waitingApproval"
            : "active",
        updatedAt: timestamp,
      });
      this.emit("sessionUpdated", next);
      return;
    }

    if (eventType === "task_complete") {
      const pendingApprovals = session.pendingApprovals ?? [];
      const next = this.mergeSession(session.id, {
        latestTurnId: asString(payload.turn_id) ?? session.latestTurnId ?? null,
        latestCompletedTurnId:
          asString(payload.turn_id) ?? session.latestCompletedTurnId ?? null,
        preview:
          buildPreviewText(asString(payload.last_agent_message) ?? "") ||
          session.preview,
        runtimeState: pendingApprovals.length > 0 ? "waitingApproval" : "idle",
        updatedAt: timestamp,
      });
      this.emit("sessionUpdated", next);
      return;
    }

    if (eventType === "exec_command_end") {
      this.handleExecCommandEnd(session, payload, timestamp);
    }
  }

  private handleExecCommandEnd(
    session: SessionSnapshot,
    payload: JsonRecord,
    timestamp: string,
  ): void {
    const callId = asString(payload.call_id);
    const output = asString(payload.aggregated_output) ?? "";
    const turnId = asString(payload.turn_id) ?? session.latestTurnId ?? null;
    const commandText = formatCommand(payload.command);
    const exitCode = asNumber(payload.exit_code);

    if (callId) {
      const approval = this.pendingApprovalByCallId.get(callId);
      if (approval) {
        this.pendingApprovalByCallId.delete(callId);
        const pendingApprovals = (session.pendingApprovals ?? []).filter(
          (item) => item.callId !== callId,
        );
        const activeApproval = selectNextActiveApproval(session.activeApproval, pendingApprovals);
        const next = this.mergeSession(session.id, {
          pendingApprovals,
          activeApproval,
          preview:
            (activeApproval ? buildApprovalPreview(activeApproval) : "") ||
            buildPreviewText(output) ||
            buildCommandPreview(commandText) ||
            session.preview,
          runtimeState: pendingApprovals.length > 0 ? "waitingApproval" : "active",
          updatedAt: timestamp,
        });

        this.emit("sessionUpdated", next);
        this.emit("approvalUpdated", {
          ...approval,
          status: "approved",
          resolvedAt: timestamp,
        });
        session = next;
      }
    }

    const toolText = buildToolMessageText(commandText, output, exitCode);
    if (!toolText) {
      return;
    }

    const message: SessionMessage = {
      id: `${session.id}:${timestamp}:tool:${callId ?? "exec"}`,
      sessionId: session.id,
      role: "tool",
      text: toolText,
      timestamp,
      source: "session_file",
      kind: "tool",
      turnId,
      callId: callId ?? null,
      toolName: "exec_command",
    };

    const recentMessages = [...session.recentMessages, message].slice(-20);
    const next = this.mergeSession(session.id, {
      latestTurnId: turnId ?? session.latestTurnId ?? null,
      preview: buildPreviewText(toolText) || buildCommandPreview(commandText) || session.preview,
      recentMessages,
      updatedAt: timestamp,
    });

    this.emit("sessionUpdated", next);
    this.emit("sessionMessage", message);
  }

  private getOrCreateSessionByFilePath(filePath: string, timestamp: string): SessionSnapshot {
    const sessionId =
      this.sessionIdByFilePath.get(filePath) ?? path.basename(filePath, ".jsonl");
    if (!this.sessionIdByFilePath.has(filePath)) {
      this.sessionIdByFilePath.set(filePath, sessionId);
    }

    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const created: SessionSnapshot = {
      id: sessionId,
      filePath,
      createdAt: timestamp,
      updatedAt: timestamp,
      runtimeState: "idle",
      recentMessages: [],
      activeApproval: null,
      pendingApprovals: [],
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private mergeSession(sessionId: string, patch: Partial<SessionSnapshot>): SessionSnapshot {
    const base =
      this.sessions.get(sessionId) ??
      ({
        id: sessionId,
        runtimeState: "idle",
        recentMessages: [],
        activeApproval: null,
        pendingApprovals: [],
      } satisfies SessionSnapshot);
    const next: SessionSnapshot = {
      ...base,
      ...patch,
      recentMessages: patch.recentMessages ?? base.recentMessages,
      pendingApprovals: patch.pendingApprovals ?? base.pendingApprovals,
      activeApproval:
        patch.activeApproval === undefined ? base.activeApproval ?? null : patch.activeApproval,
    };
    this.sessions.set(sessionId, next);
    return next;
  }
}

const asRecord = (value: unknown): JsonRecord => {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : {};
};

const asString = (value: unknown): string | undefined => {
  return typeof value === "string" ? value : undefined;
};

const asNumber = (value: unknown): number | null => {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const parseJsonObject = (value: string): JsonRecord | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as JsonRecord) : null;
  } catch {
    return null;
  }
};

const normalizeSessionSource = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value !== null && "subagent" in value) {
    return "subagent";
  }

  return undefined;
};

const buildApprovalBody = (command: string, justification?: string): string => {
  const lines = [
    "Would you like to run the following command?",
    justification ? `Reason: ${justification}` : "",
    command ? `$ ${command}` : "",
  ].filter(Boolean);
  return lines.join("\n\n");
};

const buildApprovalPreview = (approval: ApprovalRequest): string => {
  return `等待审批：${approval.command ?? approval.title}`;
};

const selectNextActiveApproval = (
  currentActiveApproval: ApprovalRequest | null | undefined,
  pendingApprovals: ApprovalRequest[],
): ApprovalRequest | null => {
  if (pendingApprovals.length === 0) {
    return null;
  }

  if (currentActiveApproval) {
    const stillPending = pendingApprovals.find(
      (approval) => approval.callId === currentActiveApproval.callId,
    );
    if (stillPending) {
      return stillPending;
    }
  }

  return pendingApprovals[0] ?? null;
};

const buildPreviewText = (text: string): string => {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return "";
  }
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
};

const formatCommand = (value: unknown): string => {
  if (!Array.isArray(value)) {
    return "";
  }

  const parts = value.filter((item): item is string => typeof item === "string");
  if (parts.length === 3 && parts[1] === "-lc") {
    return parts[2] ?? "";
  }
  return parts.join(" ");
};

const buildCommandPreview = (command: string): string => {
  if (!command) {
    return "";
  }
  return `已执行：${command}`;
};

const buildToolMessageText = (
  command: string,
  aggregatedOutput: string,
  exitCode: number | null,
): string => {
  const text = aggregatedOutput.trim();
  if (text) {
    return text;
  }

  if (exitCode !== null && exitCode !== 0) {
    return [`命令执行失败：${command || "(unknown)"}`, `exit ${exitCode}`].join("\n");
  }

  return "";
};
