import { describe, expect, it } from "vitest";

import { chunkText } from "../src/utils/chunk-text.js";

describe("chunkText", () => {
  it("在长度足够时保持原文", () => {
    expect(chunkText("hello", 10)).toEqual(["hello"]);
  });

  it("会按限制切块且不丢内容", () => {
    const input = "alpha beta gamma delta epsilon";
    const output = chunkText(input, 12);
    expect(output.join(" ")).toContain("alpha");
    expect(output.join(" ")).toContain("epsilon");
    expect(output.every((item) => item.length <= 12)).toBe(true);
  });
});
