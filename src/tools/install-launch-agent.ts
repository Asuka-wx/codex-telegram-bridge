import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  buildLaunchAgentPlist,
  mergePathEntries,
  resolveProjectRoot,
} from "../utils/launch-agent.js";

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = resolveProjectRoot(
  path.dirname(fileURLToPath(import.meta.url)),
);
const RUN_SCRIPT = path.join(PROJECT_ROOT, "scripts", "run-bridge.sh");
const BOOTSTRAP_SCRIPT = path.join(PROJECT_ROOT, "scripts", "bootstrap-tmux.sh");
const DATA_DIR = path.join(PROJECT_ROOT, ".data");
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const LAUNCH_AGENT_LABEL = "local.codex.telegram-bridge";
const PLIST_TARGET = path.join(
  LAUNCH_AGENTS_DIR,
  `${LAUNCH_AGENT_LABEL}.plist`,
);

const ensureExists = async (targetPath: string): Promise<void> => {
  try {
    await access(targetPath);
  } catch {
    throw new Error(
      `未找到 ${targetPath}。请从仓库根目录执行 pnpm launchd:install。`,
    );
  }
};

const main = async (): Promise<void> => {
  await ensureExists(path.join(PROJECT_ROOT, "package.json"));
  await ensureExists(RUN_SCRIPT);
  await ensureExists(BOOTSTRAP_SCRIPT);

  await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await chmod(RUN_SCRIPT, 0o755);
  await chmod(BOOTSTRAP_SCRIPT, 0o755);
  await writeFile(
    PLIST_TARGET,
    buildLaunchAgentPlist({
      label: LAUNCH_AGENT_LABEL,
      runScript: RUN_SCRIPT,
      workingDirectory: PROJECT_ROOT,
      stdoutPath: path.join(DATA_DIR, "launchd.out.log"),
      stderrPath: path.join(DATA_DIR, "launchd.err.log"),
      pathValue: mergePathEntries(
        path.dirname(process.execPath),
        process.env.PATH ?? "",
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ),
      homeDir: os.homedir(),
    }),
    "utf8",
  );

  await execFileAsync("launchctl", ["unload", PLIST_TARGET]).catch(() => {
    // ignore unload failure when service does not yet exist
  });
  await execFileAsync("launchctl", ["load", PLIST_TARGET]);

  console.log(`已安装并加载 LaunchAgent：${PLIST_TARGET}`);
};

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
