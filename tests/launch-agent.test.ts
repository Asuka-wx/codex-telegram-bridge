import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildLaunchAgentPlist,
  mergePathEntries,
  resolveProjectRoot,
} from "../src/utils/launch-agent.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("resolveProjectRoot", () => {
  it("能从嵌套目录向上找到 package.json 所在根目录", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-launch-agent-"));
    tempDirs.push(repoRoot);
    const nestedDir = path.join(repoRoot, "dist", "src", "tools");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "package.json"), "{}");

    expect(resolveProjectRoot(nestedDir)).toBe(repoRoot);
  });
});

describe("mergePathEntries", () => {
  it("会去重并保留顺序", () => {
    expect(
      mergePathEntries(
        "/usr/bin:/bin",
        "/bin:/opt/homebrew/bin",
        "",
      ),
    ).toBe("/usr/bin:/bin:/opt/homebrew/bin");
  });
});

describe("buildLaunchAgentPlist", () => {
  it("会写入当前机器路径并做 XML 转义", () => {
    const plist = buildLaunchAgentPlist({
      label: "com.example.bridge",
      runScript: "/Users/tester/Dev/bridge/scripts/run & bridge.sh",
      workingDirectory: "/Users/tester/Dev/bridge",
      stdoutPath: "/tmp/bridge.out.log",
      stderrPath: "/tmp/bridge.err.log",
      pathValue: "/opt/homebrew/bin:/usr/bin",
      homeDir: "/Users/tester",
    });

    expect(plist).toContain("com.example.bridge");
    expect(plist).toContain("/Users/tester/Dev/bridge");
    expect(plist).toContain("run &amp; bridge.sh");
    expect(plist).toContain("/tmp/bridge.out.log");
    expect(plist).toContain("/Users/tester");
  });
});
