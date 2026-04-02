import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { config } from "../config.js";
import type { SessionIndex } from "../codex/session-index.js";
import type {
  ApprovalAction,
  ApprovalActionKey,
  ApprovalRequest,
  CodexFooterStatus,
  SessionMessage,
  SessionSnapshot,
} from "../types/domain.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);
const TMUX_POLL_INTERVAL_MS = 300;
const TMUX_CAPTURE_LINES = 80;
const TMUX_FIELD_SEPARATOR = "__CODEX_BRIDGE_FIELD__";

interface TmuxPaneMeta {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  paneId: string;
  cwd: string;
  currentCommand: string;
  panePid: number;
  paneActive: boolean;
  windowActive: boolean;
  paneInMode: boolean;
}

type TmuxEvents = {
  paneChanged: [SessionSnapshot];
  paneOpened: [SessionSnapshot];
  paneClosed: [SessionSnapshot];
  approvalRequested: [ApprovalRequest];
  paneOutput: [SessionMessage];
};

export class TmuxService extends EventEmitter<TmuxEvents> {
  private readonly panes = new Map<string, SessionSnapshot>();

  private readonly persistentSessionHints = new Set<string>();

  private readonly persistentTmuxSessionNames = new Set(config.tmux.stableSessionNames);

  private readonly activeApprovalSignatures = new Map<string, string>();

  private readonly outputBuffers = new Map<
    string,
    { text: string; timer: NodeJS.Timeout | null }
  >();

  private readonly lastDeliveredOutput = new Map<string, string>();

  private pollTimer: NodeJS.Timeout | null = null;

  private hasCompletedInitialScan = false;

  constructor(private readonly sessionIndex: SessionIndex) {
    super();
  }

  async start(): Promise<void> {
    await this.refresh();
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, TMUX_POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  async refreshNow(): Promise<SessionSnapshot[]> {
    await this.refresh();
    return this.listSessions();
  }

  refreshSessionFacts(linkedSessionId?: string): SessionSnapshot[] {
    for (const [paneId, pane] of this.panes.entries()) {
      if (linkedSessionId && pane.linkedSessionId !== linkedSessionId) {
        continue;
      }

      this.panes.set(paneId, this.hydratePaneSnapshot(pane));
    }

    return this.listSessions();
  }

  setPersistentSessionHints(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      const normalized = sessionId.trim();
      if (!normalized) {
        continue;
      }

      this.persistentSessionHints.add(normalized);
      const sessionName = extractTmuxSessionName(normalized);
      if (sessionName) {
        this.persistentTmuxSessionNames.add(sessionName);
      }
    }
  }

  listSessions(): SessionSnapshot[] {
    return [...this.panes.values()].sort((left, right) =>
      (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
    );
  }

  getSession(sessionId: string): SessionSnapshot | null {
    return this.panes.get(sessionId) ?? null;
  }

  resolveSessionId(reference: string): string | null {
    if (this.panes.has(reference)) {
      return reference;
    }

    const matched = [...this.panes.values()].find(
      (pane) =>
        pane.linkedSessionId === reference ||
        pane.tmuxSessionName === reference ||
        pane.name === reference,
    );

    return matched?.id ?? null;
  }

  hasMappedSession(sessionId: string): boolean {
    return (
      this.panes.has(sessionId) ||
      [...this.panes.values()].some((pane) => pane.linkedSessionId === sessionId)
    );
  }

  getSessionsByLinkedSessionId(sessionId: string): SessionSnapshot[] {
    return [...this.panes.values()].filter((pane) => pane.linkedSessionId === sessionId);
  }

  async sendUserInput(sessionId: string, text: string): Promise<void> {
    const pane = this.mustGetPane(sessionId);
    if (pane.codexAttached === false) {
      throw new Error("当前窗口槽位存在，但 Codex 还没有运行，无法直接发送消息。");
    }
    await this.ensurePaneReadyForInput(pane.rawPaneId ?? "");
    await this.pasteInput(pane.rawPaneId ?? "", text);
    // Codex TUI 在粘贴大段文本后需要一个很短的稳定窗口，否则回车可能只落在输入框编辑态里。
    await delay(80);
    await this.tmux(["send-keys", "-t", pane.rawPaneId ?? "", "Enter"]);

    if (!shouldVerifyPromptSubmission(text)) {
      return;
    }

    await delay(220);
    const capture = await this.capturePane(pane.rawPaneId ?? "");
    if (promptStillContainsInput(capture, text)) {
      await this.tmux(["send-keys", "-t", pane.rawPaneId ?? "", "Enter"]);
    }
  }

  async interruptSession(sessionId: string): Promise<boolean> {
    const pane = this.getSession(sessionId);
    if (!pane?.rawPaneId || pane.codexAttached === false) {
      return false;
    }

    await this.tmux(["send-keys", "-t", pane.rawPaneId, "C-c"]);
    return true;
  }

  async sendControl(
    sessionId: string,
    key: "Enter" | "y" | "p" | "Escape" | "n" | "C-c",
  ): Promise<boolean> {
    const pane = this.getSession(sessionId);
    if (!pane?.rawPaneId || pane.codexAttached === false) {
      return false;
    }

    await this.ensurePaneReadyForInput(pane.rawPaneId);
    if (key === "y" || key === "p") {
      const beforeApprovalSignature = extractApprovalSignature(
        await this.capturePane(pane.rawPaneId),
      );
      if (!beforeApprovalSignature) {
        return false;
      }

      await this.tmux(["send-keys", "-t", pane.rawPaneId, key]);
      await delay(50);

      const afterApprovalSignature = extractApprovalSignature(
        await this.capturePane(pane.rawPaneId),
      );
      if (
        shouldConfirmApprovalShortcut(
          key,
          beforeApprovalSignature,
          afterApprovalSignature,
        )
      ) {
        await this.tmux(["send-keys", "-t", pane.rawPaneId, "Enter"]);
      }
      return true;
    }

    for (const controlKey of buildControlSequence(key)) {
      await this.tmux(["send-keys", "-t", pane.rawPaneId, controlKey]);
    }
    return true;
  }

  private async refresh(): Promise<void> {
    try {
      const panes = await this.listCodexPanes();
      const next = new Map<string, SessionSnapshot>();
      const previousPanes = new Map(this.panes);

      for (const pane of panes) {
        next.set(pane.id, pane);
      }

      this.panes.clear();
      for (const [key, value] of next.entries()) {
        this.panes.set(key, value);
      }

      for (const pane of panes) {
        const previous = previousPanes.get(pane.id);
        if (!previous && this.hasCompletedInitialScan) {
          this.emit("paneOpened", pane);
        } else if (previous && JSON.stringify(previous) !== JSON.stringify(pane)) {
          this.emit("paneChanged", pane);
          if (!pane.tmuxPaneInMode && this.shouldUseTmuxFallback(pane)) {
            this.queueOutput(pane, previous);
          }
        }
        if (this.shouldUseTmuxFallback(pane)) {
          this.maybeEmitApproval(pane);
        }
      }

      for (const [sessionId, previous] of previousPanes.entries()) {
        if (next.has(sessionId)) {
          continue;
        }
        if (this.hasCompletedInitialScan) {
          this.emit("paneClosed", {
            ...previous,
            lifecycleState: "closed",
            updatedAt: new Date().toISOString(),
          });
        }
      }
      this.hasCompletedInitialScan = true;
    } catch (error) {
      logger.warn("刷新 tmux pane 列表失败", error);
    }
  }

  private async listCodexPanes(): Promise<SessionSnapshot[]> {
    const metas = await this.listPaneMeta();
    const paneMetaPairs: Array<{ meta: TmuxPaneMeta; capture: string }> = [];

    for (const meta of metas) {
      const capture = await this.capturePane(meta.paneId);
      paneMetaPairs.push({ meta, capture });
    }

    const paneCountBySession = new Map<string, number>();
    for (const { meta } of paneMetaPairs) {
      paneCountBySession.set(
        meta.sessionName,
        (paneCountBySession.get(meta.sessionName) ?? 0) + 1,
      );
    }

    const sessionCandidatesByCwd = new Map<string, SessionSnapshot[]>();
    for (const { meta } of paneMetaPairs) {
      if (!sessionCandidatesByCwd.has(meta.cwd)) {
        sessionCandidatesByCwd.set(meta.cwd, this.sessionIndex.findSessionsByCwd(meta.cwd));
      }
    }

    const linkedSessionIds = assignLinkedSessionIds(
      paneMetaPairs.map(({ meta }) => {
        const paneKey = buildPaneKey(meta, paneCountBySession.get(meta.sessionName) ?? 1);
        return {
          paneKey,
          cwd: meta.cwd,
          previousLinkedSessionId: this.panes.get(paneKey)?.linkedSessionId ?? null,
          preferStableSlot: this.persistentTmuxSessionNames.has(meta.sessionName),
        };
      }),
      sessionCandidatesByCwd,
    );

    const snapshots: SessionSnapshot[] = [];

    for (const { meta, capture } of paneMetaPairs) {
      const paneKey = buildPaneKey(meta, paneCountBySession.get(meta.sessionName) ?? 1);
      const codexAttached = looksLikeCodexPane(capture);
      if (!codexAttached && !this.shouldKeepDetachedPane(meta, paneKey)) {
        continue;
      }

      const previous = this.panes.get(paneKey);
      const matchedSessionId = linkedSessionIds.get(paneKey) ?? null;
      const matchedSession = matchedSessionId ? this.sessionIndex.getSession(matchedSessionId) : undefined;
      const sessionId = paneKey;
      const codexFooterStatus = codexAttached
        ? extractCodexFooterStatus(capture)
        : previous?.codexFooterStatus ?? null;
      const screenPreview = codexAttached
        ? extractPreview(capture)
        : previous?.preview ?? "Codex 未运行，等待在该槽位重新启动";
      const baseSnapshot: SessionSnapshot = {
        id: sessionId,
        paneKey,
        cwd: meta.cwd,
        source: "tmux",
        name: buildDisplayName(meta, paneCountBySession.get(meta.sessionName) ?? 1),
        preview: screenPreview,
        updatedAt:
          matchedSession?.updatedAt ??
          previous?.updatedAt ??
          new Date().toISOString(),
        runtimeState: codexAttached ? inferRuntimeState(capture) : "idle",
        recentMessages: matchedSession?.recentMessages ?? previous?.recentMessages ?? [],
        pendingApprovals: matchedSession?.pendingApprovals ?? previous?.pendingApprovals ?? [],
        activeApproval: matchedSession?.activeApproval ?? previous?.activeApproval ?? null,
        rawPaneId: meta.paneId,
        tmuxSessionName: meta.sessionName,
        tmuxWindowIndex: meta.windowIndex,
        tmuxPaneIndex: meta.paneIndex,
        tmuxPaneInMode: meta.paneInMode,
        screenPreview: capture,
        linkedSessionId: matchedSessionId,
        codexAttached,
        codexFooterStatus,
        lifecycleState: "open",
      };

      snapshots.push(this.hydratePaneSnapshot(baseSnapshot));
    }

    return snapshots;
  }

  private hydratePaneSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
    const linkedSession = snapshot.linkedSessionId
      ? this.sessionIndex.getSession(snapshot.linkedSessionId)
      : undefined;
    if (!linkedSession) {
      return snapshot;
    }

    const visibleApproval = matchVisibleApproval(
      snapshot.screenPreview ?? "",
      linkedSession.pendingApprovals ?? [],
    );
    const fallbackApproval =
      (linkedSession.pendingApprovals?.length ?? 0) <= 1
        ? linkedSession.activeApproval ?? null
        : null;
    const runtimeState =
      linkedSession.pendingApprovals?.length
        ? "waitingApproval"
        : linkedSession.runtimeState;

    return {
      ...snapshot,
      cwd: linkedSession.cwd ?? snapshot.cwd,
      updatedAt: linkedSession.updatedAt ?? snapshot.updatedAt,
      preview: extractStructuredPreview(linkedSession) ?? snapshot.preview,
      runtimeState: runtimeState ?? snapshot.runtimeState,
      recentMessages: linkedSession.recentMessages,
      pendingApprovals: linkedSession.pendingApprovals ?? [],
      activeApproval: visibleApproval ?? fallbackApproval,
      visibleApproval,
      latestTurnId: linkedSession.latestTurnId ?? snapshot.latestTurnId,
      latestCompletedTurnId:
        linkedSession.latestCompletedTurnId ?? snapshot.latestCompletedTurnId,
    };
  }

  private async listPaneMeta(): Promise<TmuxPaneMeta[]> {
    const format = [
      "#{session_name}",
      "#{window_index}",
      "#{pane_index}",
      "#{pane_id}",
      "#{pane_current_path}",
      "#{pane_current_command}",
      "#{pane_pid}",
      "#{pane_active}",
      "#{window_active}",
      "#{pane_in_mode}",
    ].join(TMUX_FIELD_SEPARATOR);

    const output = await this.tmux(["list-panes", "-a", "-F", format]);
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = splitTmuxFormatLine(line);
        const [
          sessionName,
          windowIndex,
          paneIndex,
          paneId,
          cwd,
          currentCommand,
          panePid,
          paneActive,
          windowActive,
          paneInMode,
        ] = parts;
        return {
          sessionName: sessionName ?? "",
          windowIndex: Number.parseInt(windowIndex ?? "0", 10),
          paneIndex: Number.parseInt(paneIndex ?? "0", 10),
          paneId: paneId ?? "",
          cwd: cwd ?? "",
          currentCommand: currentCommand ?? "",
          panePid: Number.parseInt(panePid ?? "0", 10),
          paneActive: paneActive === "1",
          windowActive: windowActive === "1",
          paneInMode: paneInMode === "1",
        } satisfies TmuxPaneMeta;
      });
  }

  private async capturePane(paneId: string): Promise<string> {
    const output = await this.tmux([
      "capture-pane",
      "-p",
      "-t",
      paneId,
      "-S",
      `-${TMUX_CAPTURE_LINES}`,
      "-J",
    ]);
    return output.trimEnd();
  }

  private async tmux(args: string[]): Promise<string> {
    const result = await execFileAsync("tmux", args, {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024 * 8,
    });
    return String(result.stdout);
  }

  private async pasteInput(paneId: string, text: string): Promise<void> {
    const tempFilePath = path.join(
      os.tmpdir(),
      `codex-telegram-bridge-${process.pid}-${Date.now()}.txt`,
    );
    const bufferName = `codex-telegram-bridge-${process.pid}-${Date.now()}`;

    await fs.writeFile(tempFilePath, text, "utf8");
    try {
      await this.tmux(["load-buffer", "-b", bufferName, tempFilePath]);
      await this.tmux(["paste-buffer", "-dr", "-b", bufferName, "-t", paneId]);
    } finally {
      await fs.rm(tempFilePath, { force: true }).catch(() => undefined);
    }
  }

  private async ensurePaneReadyForInput(paneId: string): Promise<void> {
    const inMode = await this.isPaneInMode(paneId);
    if (!inMode) {
      return;
    }

    await this.tmux(["copy-mode", "-q", "-t", paneId]);
    await delay(40);
  }

  private async isPaneInMode(paneId: string): Promise<boolean> {
    const output = await this.tmux(["display-message", "-p", "-t", paneId, "#{pane_in_mode}"]);
    return output.trim() === "1";
  }

  private mustGetPane(sessionId: string): SessionSnapshot {
    const pane = this.getSession(sessionId);
    if (!pane?.rawPaneId) {
      throw new Error(`找不到 session 对应的 tmux pane: ${sessionId}`);
    }
    return pane;
  }

  private maybeEmitApproval(current: SessionSnapshot): void {
    if (!this.shouldUseTmuxFallback(current)) {
      this.activeApprovalSignatures.delete(current.id);
      return;
    }

    if (current.codexAttached === false) {
      this.activeApprovalSignatures.delete(current.id);
      return;
    }

    if (current.runtimeState !== "waitingApproval") {
      this.activeApprovalSignatures.delete(current.id);
      return;
    }

    const signature = extractApprovalSignature(current.screenPreview ?? "");
    if (!signature) {
      return;
    }

    const previousSignature = this.activeApprovalSignatures.get(current.id);
    if (previousSignature === signature) {
      return;
    }
    this.activeApprovalSignatures.set(current.id, signature);
    const actions = extractApprovalActions(current.screenPreview ?? "");
    const body = extractApprovalBody(current.screenPreview ?? "");

    void fs.writeFile(
      path.join(config.dataDir, "last-approval.json"),
      JSON.stringify({
        sessionId: current.id,
        signature,
        actions,
        body,
        capture: current.screenPreview ?? "",
        recordedAt: new Date().toISOString(),
      }, null, 2),
      "utf8",
    ).catch(() => undefined);

    this.emit("approvalRequested", {
      requestId: `${current.id}:${Date.now()}`,
      sessionId: current.id,
      kind: "command",
      title: "窗口等待确认",
      body,
      createdAt: new Date().toISOString(),
      rawMethod: "tmux/paneApproval",
      actions,
      signature,
    });
  }

  private queueOutput(current: SessionSnapshot, previous: SessionSnapshot): void {
    if (!this.shouldUseTmuxFallback(current) || !this.shouldUseTmuxFallback(previous)) {
      return;
    }

    if (current.codexAttached === false || previous.codexAttached === false) {
      return;
    }
    if (
      current.runtimeState === "waitingApproval" ||
      previous.runtimeState === "waitingApproval"
    ) {
      this.clearPendingOutputBuffer(current.id);
      return;
    }

    const delta = computeCaptureDelta(
      previous.screenPreview ?? "",
      current.screenPreview ?? "",
    );
    if (!delta.trim()) {
      return;
    }

    const buffer = this.outputBuffers.get(current.id) ?? {
      text: "",
      timer: null,
    };
    buffer.text += delta;

    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }

    buffer.timer = setTimeout(() => {
      const text = buffer.text.trim();
      buffer.text = "";
      buffer.timer = null;
      if (!text) {
        return;
      }
      const previousDelivered = this.lastDeliveredOutput.get(current.id);
      if (previousDelivered === text) {
        return;
      }
      this.lastDeliveredOutput.set(current.id, text);
      this.emit("paneOutput", {
        id: `${current.id}:${Date.now()}`,
        sessionId: current.id,
        role: "assistant",
        text,
        timestamp: new Date().toISOString(),
        source: "tmux",
        kind: "fallback",
      });
    }, 700);
    buffer.timer.unref();

    this.outputBuffers.set(current.id, buffer);
  }

  private clearPendingOutputBuffer(sessionId: string): void {
    const buffer = this.outputBuffers.get(sessionId);
    if (!buffer) {
      return;
    }

    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }

    this.outputBuffers.delete(sessionId);
  }

  private shouldKeepDetachedPane(meta: TmuxPaneMeta, paneKey: string): boolean {
    return (
      this.persistentSessionHints.has(paneKey) ||
      this.persistentTmuxSessionNames.has(meta.sessionName) ||
      this.panes.has(paneKey)
    );
  }

  private shouldUseTmuxFallback(pane: SessionSnapshot): boolean {
    return !pane.linkedSessionId;
  }

}

export interface LinkedSessionAssignmentInput {
  paneKey: string;
  cwd: string;
  previousLinkedSessionId: string | null;
  preferStableSlot?: boolean;
}

export function assignLinkedSessionIds(
  panes: LinkedSessionAssignmentInput[],
  sessionsByCwd: Map<string, SessionSnapshot[]>,
): Map<string, string | null> {
  const assignedSessionIds = new Set<string>();
  const selected = new Map<string, string | null>();
  const assignmentOrder = [...panes].sort((left, right) => {
    if (Boolean(left.preferStableSlot) === Boolean(right.preferStableSlot)) {
      return 0;
    }
    return left.preferStableSlot ? -1 : 1;
  });

  for (const pane of panes) {
    if (!pane.previousLinkedSessionId) {
      continue;
    }

    const candidates = sessionsByCwd.get(pane.cwd) ?? [];
    if (
      candidates.some((session) => session.id === pane.previousLinkedSessionId) &&
      !assignedSessionIds.has(pane.previousLinkedSessionId)
    ) {
      selected.set(pane.paneKey, pane.previousLinkedSessionId);
      assignedSessionIds.add(pane.previousLinkedSessionId);
    }
  }

  for (const pane of assignmentOrder) {
    if (selected.has(pane.paneKey)) {
      continue;
    }

    const candidates = sessionsByCwd.get(pane.cwd) ?? [];
    const matched = candidates.find((session) => !assignedSessionIds.has(session.id));
    if (matched) {
      selected.set(pane.paneKey, matched.id);
      assignedSessionIds.add(matched.id);
      continue;
    }

    if (pane.previousLinkedSessionId && !assignedSessionIds.has(pane.previousLinkedSessionId)) {
      selected.set(pane.paneKey, pane.previousLinkedSessionId);
      assignedSessionIds.add(pane.previousLinkedSessionId);
      continue;
    }

    selected.set(pane.paneKey, null);
  }

  return selected;
}

const looksLikeCodexPane = (capture: string): boolean => {
  return (
    capture.includes("OpenAI Codex") ||
    capture.includes("gpt-5.4") ||
    capture.includes("Conversation interrupted") ||
    capture.includes("background terminal")
  );
};

export const extractCodexFooterStatus = (capture: string): CodexFooterStatus | null => {
  const lines = capture
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line || !isFooterStatusLine(line)) {
      continue;
    }

    const segments = line.split("·").map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0) {
      return null;
    }

    const [modelLabel, contextLeft, cwdLabel, scopeLabel] = segments;
    return {
      modelLabel: modelLabel ?? null,
      contextLeft: contextLeft ?? null,
      cwdLabel: cwdLabel ?? null,
      scopeLabel: scopeLabel ?? null,
    };
  }

  return null;
};

const extractPreview = (capture: string): string => {
  const lines = capture
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.startsWith("› ")) {
      return line.slice(2).trim();
    }
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.startsWith("• ")) {
      return line.slice(2).trim();
    }
  }

  return lines.at(-1) ?? "";
};

const extractStructuredPreview = (session: SessionSnapshot): string | null => {
  const latestMessage = [...session.recentMessages]
    .reverse()
    .find((message) => message.role !== "user" && message.text.trim());
  if (!latestMessage) {
    return session.preview ?? null;
  }

  const firstLine = latestMessage.text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ?? session.preview ?? null;
};

const inferRuntimeState = (capture: string): SessionSnapshot["runtimeState"] => {
  if (capture.includes("Working (")) {
    return "active";
  }
  if (capture.includes("background terminal running")) {
    return "active";
  }
  if (findActiveApprovalRange(capture.split("\n")) !== null) {
    return "waitingApproval";
  }
  return "idle";
};

const buildPaneKey = (meta: TmuxPaneMeta, paneCountInSession: number): string => {
  if (paneCountInSession <= 1) {
    return `tmux:${meta.sessionName}`;
  }
  return `tmux:${meta.sessionName}:${meta.windowIndex}.${meta.paneIndex}`;
};

const buildDisplayName = (meta: TmuxPaneMeta, paneCountInSession: number): string => {
  if (paneCountInSession <= 1) {
    return meta.sessionName;
  }
  return `${meta.sessionName}:${meta.windowIndex}.${meta.paneIndex}`;
};

function matchVisibleApproval(
  capture: string,
  pendingApprovals: ApprovalRequest[],
): ApprovalRequest | null {
  if (pendingApprovals.length === 0) {
    return null;
  }

  const signature = extractApprovalSignature(capture);
  if (!signature) {
    return null;
  }

  const normalizedSignature = normalizeApprovalMatchText(signature);
  return (
    pendingApprovals.find((approval) => approval.signature === signature) ??
    pendingApprovals.find((approval) => approval.command === signature) ??
    pendingApprovals.find((approval) =>
      fuzzyApprovalTextMatch(approval.signature ?? "", normalizedSignature),
    ) ??
    pendingApprovals.find((approval) =>
      fuzzyApprovalTextMatch(approval.command ?? "", normalizedSignature),
    ) ??
    null
  );
}

const extractTmuxSessionName = (sessionId: string): string | null => {
  if (!sessionId.startsWith("tmux:")) {
    return null;
  }

  const remainder = sessionId.slice("tmux:".length);
  const firstPart = remainder.split(":")[0]?.trim();
  return firstPart || null;
};

const extractApprovalBody = (capture: string): string => {
  const lines = capture.split("\n").map((line) => line.trimEnd());
  const range = findActiveApprovalRange(lines);
  if (!range) {
    return "";
  }

  return lines
    .slice(range.start, range.end + 1)
    .map((line) => normalizeApprovalOptionLine(line))
    .filter((line) => line.trim())
    .join("\n");
};

export const extractApprovalSignature = (capture: string): string => {
  const lines = capture.split("\n").map((line) => line.trimEnd());
  const range = findActiveApprovalRange(lines);
  if (!range) {
    return "";
  }

  const approvalLines = lines
    .slice(range.start, range.end + 1)
    .map((line) => line.trim())
    .filter(Boolean);
  const title = approvalLines.find((line) => line.startsWith("Would you like to run")) ?? "";
  const command = extractApprovalCommand(approvalLines);
  const reason = extractApprovalReason(approvalLines);

  return command || title || reason || extractApprovalBody(capture);
};

export const hasVisibleApprovalPrompt = (capture: string): boolean => {
  return findActiveApprovalRange(capture.split("\n")) !== null;
};

export const extractApprovalActions = (capture: string): ApprovalAction[] => {
  const fullLines = capture.split("\n").map((line) => line.trimEnd());
  const range = findActiveApprovalRange(fullLines);
  if (!range) {
    return [];
  }

  const lines = fullLines
    .slice(range.start, range.end + 1)
    .filter((line) => line.trim());
  const actions: ApprovalAction[] = [];
  const seenKeys = new Set<ApprovalActionKey>();
  const optionBlocks: string[] = [];
  let currentOption = "";

  for (const rawLine of lines) {
    const line = normalizeApprovalOptionLine(rawLine).trim();
    if (/^\d+\.\s+/.test(line)) {
      if (currentOption) {
        optionBlocks.push(currentOption);
      }
      currentOption = line;
      continue;
    }

    if (!currentOption) {
      continue;
    }

    if (line.startsWith("Press enter to confirm") || line.startsWith("$ ")) {
      optionBlocks.push(currentOption);
      currentOption = "";
      continue;
    }

    currentOption += ` ${line}`;
  }

  if (currentOption) {
    optionBlocks.push(currentOption);
  }

  for (const option of optionBlocks) {
    const match = option.match(/^\d+\.\s+(.+?)\s+\(([^()]+)\)$/);
    if (!match) {
      continue;
    }

    const key = normalizeApprovalActionKey(match[2] ?? "");
    if (!key) {
      continue;
    }

    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);

    actions.push({
      key,
      label: renderApprovalActionLabel(key, match[1] ?? ""),
    });
  }

  if (actions.length > 0) {
    return actions;
  }

  if (capture.includes("Press enter to confirm or esc to cancel")) {
    return [
      { key: "Enter", label: "允许一次" },
      { key: "Escape", label: "拒绝" },
    ];
  }

  return [];
};

const stripActiveApprovalBlock = (capture: string): string => {
  const lines = capture.split("\n");
  const range = findActiveApprovalRange(lines);
  if (!range) {
    return capture;
  }

  const result = [...lines];
  result.splice(range.start, range.end - range.start + 1);
  return result.join("\n");
};

const findActiveApprovalRange = (
  lines: string[],
): { start: number; end: number } | null => {
  const footerIndex = findFooterLineIndex(lines);
  let searchEnd = footerIndex === -1 ? lines.length - 1 : footerIndex - 1;
  while (searchEnd >= 0 && lines[searchEnd]?.trim() === "") {
    searchEnd -= 1;
  }

  if (searchEnd < 0) {
    return null;
  }

  const searchStart = 0;
  let start = -1;
  for (let index = searchEnd; index >= searchStart; index -= 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (
      trimmed.startsWith("Would you like to run") ||
      trimmed.startsWith("Do you want me")
    ) {
      start = index;
      break;
    }
  }

  if (start === -1) {
    const searchWindow = lines.slice(searchStart, searchEnd + 1);
    const optionIndexInWindow = searchWindow.findIndex((line) =>
      isApprovalOptionLikeLine(line),
    );
    const hasConfirmationHintInWindow = searchWindow.some((line) =>
      line.trim().startsWith("Press enter to confirm"),
    );

    if (optionIndexInWindow === -1 || !hasConfirmationHintInWindow) {
      return null;
    }

    start = searchStart + optionIndexInWindow;
    for (let index = start - 1; index >= searchStart; index -= 1) {
      const trimmed = lines[index]?.trim() ?? "";
      if (!trimmed) {
        break;
      }
      start = index;
    }
  }

  const candidate = lines
    .slice(start, searchEnd + 1)
    .map((line) => line.trim())
    .filter(Boolean);

  const hasCommand = candidate.some((line) => line.startsWith("$ "));
  const hasOption = candidate.some((line) => isApprovalOptionLikeLine(line));
  const hasConfirmationHint = candidate.some((line) =>
    line.startsWith("Press enter to confirm"),
  );
  const hasNormalPromptAfterApproval = candidate.some((line) => {
    if (!line.startsWith("› ")) {
      return false;
    }
    const payload = line.slice(2).trim();
    return !/^\d+\.\s+/.test(payload) && !/^(Yes|No)\b/.test(payload);
  });

  const hasApprovalMenu = hasOption && hasConfirmationHint;

  if ((!hasCommand && !hasApprovalMenu) || hasNormalPromptAfterApproval) {
    return null;
  }

  let end = footerIndex === -1 ? lines.length - 1 : footerIndex - 1;
  while (end >= start && lines[end]?.trim() === "") {
    end -= 1;
  }

  return end >= start
    ? {
        start,
        end,
      }
    : null;
};

const normalizeApprovalOptionLine = (line: string): string => {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("› ")) {
    return line.trimEnd();
  }

  const payload = trimmed.slice(2).trim();
  if (/^\d+\.\s+/.test(payload) || /^(Yes|No)\b/.test(payload)) {
    return payload;
  }

  return line.trimEnd();
};

const isApprovalOptionLikeLine = (line: string): boolean => {
  const trimmed = line.trim();
  return (
    /^\d+\.\s+/.test(trimmed) ||
    /^›\s*\d+\.\s+/.test(trimmed) ||
    /^›\s*(Yes|No)\b/.test(trimmed) ||
    /^(Yes|No)\b/.test(trimmed)
  );
};

const extractApprovalReason = (lines: string[]): string => {
  const reasonIndex = lines.findIndex((line) => line.startsWith("Reason:"));
  if (reasonIndex === -1) {
    return "";
  }

  const parts: string[] = [];
  for (let index = reasonIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("$ ") || /^\d+\.\s+/.test(line)) {
      break;
    }
    parts.push(line);
  }

  return parts.join(" ").trim();
};

const extractApprovalCommand = (lines: string[]): string => {
  const commandIndex = lines.findIndex((line) => line.startsWith("$ "));
  if (commandIndex === -1) {
    return "";
  }

  const parts = [lines[commandIndex]?.slice(2).trim() ?? ""].filter(Boolean);
  for (let index = commandIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (
      !line ||
      line.startsWith("Reason:") ||
      line.startsWith("Press enter to confirm") ||
      isApprovalOptionLikeLine(line) ||
      line.startsWith("$ ")
    ) {
      break;
    }
    parts.push(line.trim());
  }

  return parts.length > 0 ? `$ ${parts.join(" ").replace(/\s+/g, " ").trim()}` : "";
};

const normalizeApprovalMatchText = (value: string): string => {
  return value
    .replace(/^\$\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
};

const fuzzyApprovalTextMatch = (
  candidate: string,
  normalizedSignature: string,
): boolean => {
  if (!candidate || !normalizedSignature) {
    return false;
  }

  const normalizedCandidate = normalizeApprovalMatchText(candidate);
  return (
    normalizedCandidate === normalizedSignature ||
    normalizedCandidate.startsWith(normalizedSignature) ||
    normalizedSignature.startsWith(normalizedCandidate)
  );
};

const normalizeApprovalActionKey = (raw: string): ApprovalActionKey | null => {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "enter") {
    return "Enter";
  }
  if (normalized === "y") {
    return "y";
  }
  if (normalized === "p") {
    return "p";
  }
  if (normalized === "n") {
    return "n";
  }
  if (normalized === "esc" || normalized === "escape") {
    return "Escape";
  }
  if (normalized === "c-c" || normalized === "^c" || normalized === "ctrl-c") {
    return "C-c";
  }
  return null;
};

const renderApprovalActionLabel = (key: ApprovalActionKey, fallback: string): string => {
  if (key === "y" || key === "Enter") {
    return "允许一次";
  }
  if (key === "p") {
    return "允许并记住";
  }
  if (key === "Escape" || key === "n") {
    return "拒绝";
  }
  if (key === "C-c") {
    return "取消本轮";
  }
  return fallback.trim() || key;
};

export const buildControlSequence = (
  key: "Enter" | "y" | "p" | "Escape" | "n" | "C-c",
): string[] => {
  return [key];
};

export const shouldConfirmApprovalShortcut = (
  key: "Enter" | "y" | "p" | "Escape" | "n" | "C-c",
  beforeApprovalSignature: string,
  afterApprovalSignature: string,
): boolean => {
  if (key !== "y" && key !== "p") {
    return false;
  }

  if (!beforeApprovalSignature) {
    return false;
  }

  return beforeApprovalSignature === afterApprovalSignature;
};

export const computeCaptureDelta = (previous: string, current: string): string => {
  const previousNormalized = normalizeCaptureForOutput(previous);
  const currentNormalized = normalizeCaptureForOutput(current);

  if (!previousNormalized) {
    return currentNormalized;
  }
  if (currentNormalized === previousNormalized) {
    return "";
  }
  if (currentNormalized.startsWith(previousNormalized)) {
    return currentNormalized.slice(previousNormalized.length);
  }

  const previousLines = previousNormalized.split("\n");
  const currentLines = currentNormalized.split("\n");
  let sharedPrefix = 0;
  while (
    sharedPrefix < previousLines.length &&
    sharedPrefix < currentLines.length &&
    previousLines[sharedPrefix] === currentLines[sharedPrefix]
  ) {
    sharedPrefix += 1;
  }

  if (sharedPrefix > 0) {
    return currentLines.slice(sharedPrefix).join("\n");
  }

  const maxOverlap = Math.min(previousNormalized.length, currentNormalized.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (
      previousNormalized.slice(-size) === currentNormalized.slice(0, size)
    ) {
      return currentNormalized.slice(size);
    }
  }

  // 到这里说明本次变化不具备可靠的“追加输出”特征。
  // 为了避免把旧正文或输入框重绘误发到 Telegram，这里宁可丢弃，也不整段重发。
  return "";
};

export const normalizeCaptureForOutput = (capture: string): string => {
  const rawLines = stripPromptRegionFromFooter(stripActiveApprovalBlock(capture))
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
  const lines: string[] = [];
  let skippingPromptContinuation = false;

  for (const line of rawLines) {
    if (isPromptInputLine(line)) {
      skippingPromptContinuation = true;
      continue;
    }

    if (skippingPromptContinuation) {
      if (line.trim() === "") {
        skippingPromptContinuation = false;
        continue;
      }

      if (looksLikePromptContinuation(line)) {
        continue;
      }

      skippingPromptContinuation = false;
    }

    if (isEphemeralUiLine(line)) {
      continue;
    }

    lines.push(line);
  }

  while (lines.length > 0 && lines.at(-1)?.trim() === "") {
    lines.pop();
  }

  return lines.join("\n").trim();
};

export const splitTmuxFormatLine = (line: string): string[] => {
  if (line.includes(TMUX_FIELD_SEPARATOR)) {
    return line.split(TMUX_FIELD_SEPARATOR);
  }
  return line.includes("\t") ? line.split("\t") : line.split("\\t");
};

const stripPromptRegionFromFooter = (capture: string): string => {
  const lines = capture.split("\n");
  const promptRange = findPromptBlockRange(lines);
  if (!promptRange) {
    return capture;
  }

  const result = [...lines];
  result.splice(promptRange.start, promptRange.end - promptRange.start + 1);
  return result.join("\n");
};

const findPromptBlockRange = (
  lines: string[],
): { start: number; end: number } | null => {
  const footerIndex = findFooterLineIndex(lines);
  if (footerIndex === -1) {
    return null;
  }

  let cursor = footerIndex - 1;
  while (cursor >= 0 && lines[cursor]?.trim() === "") {
    cursor -= 1;
  }

  if (cursor < 0) {
    return null;
  }

  const blockEnd = cursor;
  let promptStart = -1;
  for (let index = blockEnd; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (isPromptInputLine(line)) {
      promptStart = index;
      break;
    }
    if (line.trim() === "") {
      break;
    }
  }

  let blockStart = promptStart;
  if (blockStart === -1) {
    let search = blockEnd;
    while (search >= 0 && lines[search]?.trim() !== "") {
      search -= 1;
    }
    blockStart = search + 1;
  }

  const candidate = lines.slice(blockStart, blockEnd + 1);
  if (blockStart < 0 || !looksLikePromptBlock(candidate)) {
    return null;
  }

  return {
    start: blockStart,
    end: blockEnd,
  };
};

const findFooterLineIndex = (lines: string[]): number => {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (isFooterStatusLine(trimmed)) {
      return index;
    }
  }
  return -1;
};

const looksLikePromptBlock = (lines: string[]): boolean => {
  if (lines.length === 0) {
    return false;
  }

  if (
    lines.some((line) => isApprovalOptionLikeLine(line)) ||
    lines.some((line) => line.trim().startsWith("Press enter to confirm")) ||
    lines.some((line) => {
      const trimmed = line.trim();
      return (
        trimmed.startsWith("Would you like to run") ||
        trimmed.startsWith("Do you want me")
      );
    })
  ) {
    return false;
  }

  if (lines.some((line) => isPromptInputLine(line))) {
    return true;
  }

  if (lines.length <= 6 && lines.every((line) => looksLikePromptContinuation(line))) {
    return true;
  }

  return false;
};

const shouldVerifyPromptSubmission = (text: string): boolean => {
  return text.includes("\n") || text.length >= 80;
};

const promptStillContainsInput = (capture: string, text: string): boolean => {
  const lines = capture.split("\n");
  const range = findPromptBlockRange(lines);
  if (!range) {
    return false;
  }

  const promptBlock = lines.slice(range.start, range.end + 1).join("\n");
  const needle = buildPromptNeedle(text);
  if (!needle) {
    return false;
  }

  return promptBlock.includes(needle);
};

const buildPromptNeedle = (text: string): string => {
  const firstMeaningfulLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstMeaningfulLine) {
    return "";
  }

  return firstMeaningfulLine.slice(0, 24);
};

const isEphemeralUiLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  if (isPromptInputLine(line)) {
    return true;
  }

  if (isFooterStatusLine(trimmed)) {
    return true;
  }

  if (/^\d{1,2}:\d{2}:\d{2}$/.test(trimmed)) {
    return true;
  }

  if (/^\d+\s+background terminal running/.test(trimmed)) {
    return true;
  }

  if (
    trimmed.startsWith("Working (") ||
    trimmed.startsWith("• Working (") ||
    (trimmed.includes("Working (") && trimmed.includes("/stop to close"))
  ) {
    return true;
  }

  if (trimmed === "Write tests for @filename") {
    return true;
  }

  return false;
};

const isPromptInputLine = (line: string): boolean => {
  return line.trimStart().startsWith("› ");
};

const looksLikePromptContinuation = (line: string): boolean => {
  if (!line.startsWith(" ")) {
    return false;
  }

  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith("• ") || trimmed.startsWith("└ ") || trimmed.startsWith("├ ")) {
    return false;
  }

  if (trimmed.startsWith("╭") || trimmed.startsWith("│") || trimmed.startsWith("╰")) {
    return false;
  }

  if (isFooterStatusLine(trimmed)) {
    return false;
  }

  return true;
};

const isFooterStatusLine = (line: string): boolean => {
  if (!line.startsWith("gpt-")) {
    return false;
  }

  return /\bleft\b/.test(line);
};
