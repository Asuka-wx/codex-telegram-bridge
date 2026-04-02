import { rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LAUNCH_AGENT_LABEL = "local.codex.telegram-bridge";
const PLIST_TARGET = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCH_AGENT_LABEL}.plist`,
);

const main = async (): Promise<void> => {
  await execFileAsync("launchctl", ["unload", PLIST_TARGET]).catch(() => {
    // ignore when not loaded
  });
  await rm(PLIST_TARGET, { force: true });
  console.log(`已卸载 LaunchAgent：${PLIST_TARGET}`);
};

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
