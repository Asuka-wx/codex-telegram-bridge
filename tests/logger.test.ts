import { describe, expect, it } from "vitest";

import { sanitizeLogValue } from "../src/utils/logger.js";

describe("sanitizeLogValue", () => {
  it("会对敏感字段和值做脱敏", () => {
    const result = sanitizeLogValue({
      token: "12345678:abcdefghijklmnopqrstuvwxyz",
      nested: {
        authorization: "Bearer super-secret-token",
        note: "OpenAI key sk-abcdefghijklmnopqrstuvwxyz123456",
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
    const result = sanitizeLogValue(
      new Error("request failed for 12345678:abcdefghijklmnopqrstuvwxyz"),
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
