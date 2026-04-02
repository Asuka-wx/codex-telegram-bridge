import { describe, expect, it } from "vitest";

import {
  drainTelegramUpdateQueue,
  getNextTelegramUpdateOffset,
} from "../src/tools/telegram-discover.js";

describe("telegram discover offset", () => {
  it("会跳过已有历史更新，避免拿到旧 chat 信息", () => {
    expect(
      getNextTelegramUpdateOffset([
        { update_id: 101 },
        { update_id: 104 },
      ]),
    ).toBe(105);
  });

  it("会在已有 offset 基础上继续推进", () => {
    expect(
      getNextTelegramUpdateOffset(
        [{ update_id: 109 }],
        120,
      ),
    ).toBe(120);
  });

  it("会持续排空多页历史更新，而不是只跳过第一页", async () => {
    const batches = [
      [{ update_id: 10 }, { update_id: 11 }],
      [{ update_id: 120 }, { update_id: 121 }],
      [],
    ];
    let readCount = 0;

    const offset = await drainTelegramUpdateQueue(async () => {
      const next = batches[readCount] ?? [];
      readCount += 1;
      return next as Array<{ update_id: number }>;
    });

    expect(offset).toBe(122);
    expect(readCount).toBe(3);
  });
});
