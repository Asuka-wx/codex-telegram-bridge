import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { StateStore } from "../src/app/state-store.js";

describe("StateStore", () => {
  const writableConfig = config as unknown as {
    dataDir: string;
  };

  const originalDataDir = writableConfig.dataDir;
  let tempDataDir = "";

  afterEach(async () => {
    writableConfig.dataDir = originalDataDir;
    if (tempDataDir) {
      await fs.rm(tempDataDir, { recursive: true, force: true });
      tempDataDir = "";
    }
  });

  it("state 文件损坏时会备份原文件并回退到默认状态", async () => {
    tempDataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "codex-telegram-bridge-state-"),
    );
    writableConfig.dataDir = tempDataDir;

    await fs.writeFile(
      path.join(tempDataDir, "state.json"),
      "{invalid json",
      "utf8",
    );

    const store = new StateStore();
    await store.load();

    expect(store.listSelectedSessions()).toEqual([]);

    const files = await fs.readdir(tempDataDir);
    expect(files.some((file) => file.startsWith("state.json.corrupt-"))).toBe(true);
  });
});
