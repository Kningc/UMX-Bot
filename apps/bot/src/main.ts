import process from "node:process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConsoleAdapter } from "@qq-bot/adapter-console";
import { QqOfficialAdapter } from "@qq-bot/adapter-qq-official";
import { BotKernel } from "@qq-bot/core";
import type { BotAdapter, Logger } from "@qq-bot/plugin-sdk";
import { SQLiteStore } from "@qq-bot/storage-sqlite";
import pino from "pino";
import { loadConfig } from "./config.js";
import { loadConfiguredPlugins } from "./plugin-loader.js";

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

process.umask(0o077);

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL }) as unknown as Logger;
const store = new SQLiteStore(config.BOT_DATABASE_PATH);

const adapter: BotAdapter =
  config.BOT_ADAPTER === "qq-official"
    ? new QqOfficialAdapter({
        appId: config.QQ_APP_ID!,
        clientSecret: config.QQ_CLIENT_SECRET!,
        apiBaseUrl: config.QQ_API_BASE_URL,
        receiveAllGroupMessages: config.QQ_RECEIVE_ALL_GROUP_MESSAGES,
        enableInteractions: config.QQ_ENABLE_INTERACTIONS,
        certification: config.QQ_CERTIFICATION,
        gatewayStateStore: store,
        ...(config.QQ_INTENTS !== undefined
          ? { intents: config.QQ_INTENTS }
          : {}),
        requestTimeoutMs: config.QQ_REQUEST_TIMEOUT_MS,
        gatewayReadyTimeoutMs: config.QQ_GATEWAY_READY_TIMEOUT_MS,
        reconnectDelayMs: config.QQ_RECONNECT_DELAY_MS,
        reconnectMaxDelayMs: config.QQ_RECONNECT_MAX_DELAY_MS,
        logger: logger.child({ component: "adapter" })
      })
    : new ConsoleAdapter({
        commandPrefix: config.BOT_COMMAND_PREFIX,
        logger: logger.child({ component: "adapter" })
      });

const bot = new BotKernel({
  adapter,
  logger,
  commandPrefix: config.BOT_COMMAND_PREFIX,
  shutdownTimeoutMs: config.BOT_SHUTDOWN_TIMEOUT_MS,
  store
});
const healthFile =
  config.BOT_HEALTH_FILE ??
  join(dirname(config.BOT_DATABASE_PATH), "health.json");
let healthWrite = Promise.resolve();
const writeHealth = (
  status: "starting" | "ready" | "unhealthy" | "stopping"
) => {
  healthWrite = healthWrite
    .catch(() => undefined)
    .then(async () => {
      const temporary = `${healthFile}.${process.pid}.tmp`;
      await mkdir(dirname(healthFile), { recursive: true });
      await writeFile(
        temporary,
        `${JSON.stringify({
          status,
          pid: process.pid,
          updatedAt: new Date().toISOString(),
          adapter: adapter.name,
          diagnostics: adapter.getDiagnostics?.() ?? {}
        })}\n`,
        { mode: 0o600 }
      );
      await rename(temporary, healthFile);
    })
    .catch((error: unknown) => {
      logger.error({ error, healthFile }, "health snapshot write failed");
    });
  return healthWrite;
};
const refreshHealth = async () => {
  try {
    await adapter.checkHealth?.();
    await writeHealth("ready");
  } catch (error) {
    logger.error({ error }, "business health probe failed");
    await writeHealth("unhealthy");
  }
};
await writeHealth("starting");

try {
  await loadConfiguredPlugins(bot, {
    ...(config.BOT_PLUGIN_MANIFEST
      ? { manifestPath: config.BOT_PLUGIN_MANIFEST }
      : {}),
    logger
  });
} catch (error) {
  try {
    await bot.stop();
  } finally {
    store.close();
  }
  throw error;
}

let shuttingDown = false;
let healthTimer: NodeJS.Timeout | undefined;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (healthTimer) {
    clearInterval(healthTimer);
  }
  await writeHealth("stopping");
  logger.info({ signal }, "shutting down");
  try {
    await bot.stop();
  } catch (error) {
    exitCode = 1;
    logger.error({ error }, "graceful shutdown failed");
  } finally {
    store.close();
    process.exitCode = exitCode;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("uncaughtException", (error) => {
  logger.error({ error }, "uncaught exception");
  void shutdown("uncaughtException", 1);
});
process.once("unhandledRejection", (error) => {
  logger.error({ error }, "unhandled rejection");
  void shutdown("unhandledRejection", 1);
});

try {
  await bot.start();
  await refreshHealth();
  healthTimer = setInterval(
    () => void refreshHealth(),
    config.BOT_HEALTH_INTERVAL_MS
  );
} catch (error) {
  store.close();
  throw error;
}
