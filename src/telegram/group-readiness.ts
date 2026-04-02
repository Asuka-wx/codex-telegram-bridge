export interface GroupReadinessAdviceInput {
  chatId: number;
  currentControlChatId: number | null;
  status: string;
  canManageTopics: string;
  isForum: string;
  enableForumTopics: boolean;
}

export interface GroupReadinessAdvice {
  recommendedState: string;
  nextStep: string;
}

export const getGroupReadinessAdvice = ({
  chatId,
  currentControlChatId,
  status,
  canManageTopics,
  isForum,
  enableForumTopics,
}: GroupReadinessAdviceInput): GroupReadinessAdvice => {
  if (currentControlChatId === chatId) {
    return {
      recommendedState: enableForumTopics
        ? "建议目标状态：保持当前总控群可用，Topics 权限和 forum 状态不要被关闭。"
        : "建议目标状态：保持当前总控群可用。",
      nextStep: "当前群已经是总控群。下一步直接发“绑定最新窗口”。",
    };
  }

  if (status !== "administrator" && status !== "creator") {
    return {
      recommendedState: enableForumTopics
        ? "建议目标状态：bot 为 administrator，canManageTopics=true，群已开启 Topics。"
        : "建议目标状态：bot 为 administrator。",
      nextStep: "下一步：先把 bot 提升为管理员。",
    };
  }

  if (enableForumTopics && isForum !== "true") {
    return {
      recommendedState:
        "建议目标状态：bot 为 administrator，canManageTopics=true，群已开启 Topics。",
      nextStep: "下一步：先把群组切换成 forum / Topics 模式，再发“设为总控”。",
    };
  }

  if (enableForumTopics && canManageTopics !== "true") {
    return {
      recommendedState:
        "建议目标状态：bot 为 administrator，canManageTopics=true，群已开启 Topics。",
      nextStep: "下一步：先给 bot 打开 Topics 管理权限，再发“设为总控”。",
    };
  }

  return {
    recommendedState: enableForumTopics
      ? "建议目标状态：bot 为 administrator，canManageTopics=true，群已开启 Topics。"
      : "建议目标状态：bot 为 administrator。",
    nextStep: "下一步：发“设为总控”，然后再发“绑定最新窗口”。",
  };
};
