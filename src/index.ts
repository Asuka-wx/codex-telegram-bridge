import { config, validateTelegramSecurityConfig } from "./config.js";
import { BridgeService } from "./app/bridge-service.js";
import { logger } from "./utils/logger.js";
import fs from "node:fs/promises";
import path from "node:path";

const MAIN_SCOPE = "main";
const LOCK_FILE = path.join(config.dataDir, "bridge.pid");

const acquireSingletonLock = async (): Promise<void> => {
  await fs.mkdir(path.dirname(LOCK_FILE), { recursive: true });

  try {
    const raw = await fs.readFile(LOCK_FILE, "utf8");
    const existingPid = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(existingPid)) {
      try {
        process.kill(existingPid, 0);
        throw new Error(`bridge 已在运行 (pid=${existingPid})`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          throw error;
        }
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && code !== "ENOENT") {
      throw error;
    }
  }

  await fs.writeFile(LOCK_FILE, String(process.pid), "utf8");
};

const releaseSingletonLock = async (): Promise<void> => {
  try {
    const raw = await fs.readFile(LOCK_FILE, "utf8");
    if (raw.trim() !== String(process.pid)) {
      return;
    }
    await fs.rm(LOCK_FILE, { force: true });
  } catch {
    // ignore cleanup failures
  }
};

async function main(): Promise<void> {
  validateTelegramSecurityConfig();
  await acquireSingletonLock();
  const bridge = new BridgeService();
  await bridge.start();

  const shutdown = async (signal: string) => {
    logger.info(MAIN_SCOPE, `收到 ${signal}，开始关闭服务`);
    await bridge.telegram.stop().catch((error) => logger.warn(MAIN_SCOPE, "停止 Telegram bot 失败", error));
    await releaseSingletonLock();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main().catch((error) => {
  logger.error(MAIN_SCOPE, "启动失败", error);
  void releaseSingletonLock();
  process.exit(1);
});
