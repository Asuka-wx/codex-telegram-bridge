import { describe, expect, it } from "vitest";

import { sanitizeLogValue } from "../src/utils/logger.js";

describe("sanitizeLogValue", () => {
  it("会对敏感字段和值做脱敏", () => {
    const fakeTelegramToken = ["12345678", "abcdefghijklmnopqrstuvwxyz"].join(":");
    const fakeBearer = ["Bearer", "super-secret-token"].join(" ");
    const fakeOpenAiKey = ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-");

    const result = sanitizeLogValue({
      token: fakeTelegramToken,
      nested: {
        authorization: fakeBearer,
        note: `OpenAI key ${fakeOpenAiKey}`,
      },
    });

    expect(result).toEqual({
      token: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        note: "OpenAI key [REDACTED_API_KEY]",
      },
    });
  });

  it("会把 Error 对象压缩成安全摘要", () => {
    const fakeTelegramToken = ["12345678", "abcdefghijklmnopqrstuvwxyz"].join(":");
    const result = sanitizeLogValue(
      new Error(`request failed for ${fakeTelegramToken}`),
    );

    expect(result).toEqual({
      name: "Error",
      message: "request failed for [REDACTED_TELEGRAM_TOKEN]",
      code: undefined,
      status: undefined,
      description: undefined,
    });
  });
});
