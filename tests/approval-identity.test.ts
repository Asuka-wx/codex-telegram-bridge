import { describe, expect, it } from "vitest";

import {
  approvalsRepresentSamePrompt,
  getApprovalIdentity,
  shouldReplaceApprovalIdentity,
} from "../src/approval/approval-identity.js";

describe("approval identity", () => {
  it("优先使用结构化 callId 作为审批身份", () => {
    expect(
      getApprovalIdentity({
        callId: "call-1",
        signature: "$ mktemp /tmp/a",
        requestId: "fallback-1",
      }),
    ).toBe("call-1");
  });

  it("会把 $ 前缀命令和结构化 command 识别为同一审批", () => {
    expect(
      approvalsRepresentSamePrompt(
        {
          signature: "$ mktemp /tmp/a",
          body: "Would you like to run?\n$ mktemp /tmp/a",
        },
        {
          command: "mktemp /tmp/a",
          signature: "mktemp /tmp/a",
        },
      ),
    ).toBe(true);
  });

  it("结构化审批身份优先级高于 tmux fallback", () => {
    expect(
      shouldReplaceApprovalIdentity(
        {
          rawMethod: "tmux/paneApproval",
          signature: "$ mktemp /tmp/a",
        },
        {
          rawMethod: "exec_command",
          callId: "call-1",
          command: "mktemp /tmp/a",
        },
      ),
    ).toBe(true);
  });

  it("不会让 tmux fallback 反向覆盖已经存在的结构化身份", () => {
    expect(
      shouldReplaceApprovalIdentity(
        {
          rawMethod: "exec_command",
          callId: "call-1",
          command: "mktemp /tmp/a",
        },
        {
          rawMethod: "tmux/paneApproval",
          signature: "$ mktemp /tmp/a",
        },
      ),
    ).toBe(false);
  });
});
