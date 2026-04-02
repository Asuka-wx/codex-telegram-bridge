import { InlineKeyboard } from "grammy";

import type { SyncMode } from "../app/state-store.js";

const bi = (zh: string, en: string): string => `${zh} / ${en}`;

export const buildSessionControlKeyboard = (
  sessionId: string,
): InlineKeyboard | undefined => {
  const callbackData = [
    `control:status:${sessionId}`,
    `control:key:${sessionId}:Enter`,
    `control:key:${sessionId}:C-c`,
    `sessionMode:set:${sessionId}:local`,
    `sessionMode:set:${sessionId}:hybrid`,
    `sessionMode:set:${sessionId}:remote`,
  ];

  if (callbackData.some((value) => Buffer.byteLength(value, "utf8") > 64)) {
    return undefined;
  }

  return new InlineKeyboard()
    .text(bi("查看状态", "Status"), callbackData[0] ?? "")
    .row()
    .text(bi("继续", "Continue"), callbackData[1] ?? "")
    .text(bi("中断", "Interrupt"), callbackData[2] ?? "")
    .row()
    .text(bi("本地模式", "Local"), callbackData[3] ?? "")
    .text(bi("提醒模式", "Hybrid"), callbackData[4] ?? "")
    .text(bi("远程模式", "Remote"), callbackData[5] ?? "");
};

export const buildControlKeyboard = (chatId: number): InlineKeyboard => {
  const keyboard = new InlineKeyboard()
    .text(bi("刷新总控", "Refresh"), "control:refresh")
    .text(bi("设置", "Settings"), "control:settings")
    .row()
    .text(bi("本地模式", "Local"), "control:mode:local")
    .text(bi("提醒模式", "Hybrid"), "control:mode:hybrid")
    .text(bi("远程模式", "Remote"), "control:mode:remote");

  if (chatId > 0) {
    keyboard
      .row()
      .text(bi("绑定最新窗口", "Bind Latest"), "control:bindLatest")
      .text(bi("查看当前状态", "Current Status"), "control:currentStatus");
  }

  return keyboard;
};

export const buildSettingsKeyboard = (chatId: number): InlineKeyboard => {
  const keyboard = new InlineKeyboard()
    .text(bi("查看聊天信息", "Chat Info"), "control:chatInfo")
    .text(bi("检查群准备", "Group Ready"), "control:groupReady")
    .row()
    .text(bi("设为总控", "Set Control"), "control:setControl")
    .text(bi("取消总控", "Clear Control"), "control:clearControl")
    .row()
    .text(bi("返回总控", "Back"), "control:back");

  if (chatId > 0) {
    keyboard.row().text(bi("绑定最新窗口", "Bind Latest"), "control:bindLatest");
  }

  return keyboard;
};

export const buildCollapsedToolOutputKeyboard = (
  requestToken: string,
): InlineKeyboard | undefined => {
  const callbackData = `toolOutput:${requestToken}:open`;
  if (Buffer.byteLength(callbackData, "utf8") > 64) {
    return undefined;
  }

  return new InlineKeyboard().text("查看完整原文", callbackData);
};

export const renderModeLabel = (mode: SyncMode): string => {
  if (mode === "local") {
    return "本地模式";
  }
  if (mode === "hybrid") {
    return "提醒模式";
  }
  return "远程模式";
};
