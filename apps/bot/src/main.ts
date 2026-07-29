import process from "node:process";
import { ConsoleAdapter } from "@qq-bot/adapter-console";
import { QqOfficialAdapter } from "@qq-bot/adapter-qq-official";
import { BotKernel } from "@qq-bot/core";
import helpPlugin from "@qq-bot/plugin-help";
import minecraftStatusPlugin from "@qq-bot/plugin-minecraft-status";
import pingPlugin from "@qq-bot/plugin-ping";
import type { BotAdapter, Logger } from "@qq-bot/plugin-sdk";
import { SQLiteStore } from "@qq-bot/storage-sqlite";
import pino from "pino";
import { loadConfig } from "./config.js";

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

await bot.load(helpPlugin);
await bot.load(pingPlugin);
await bot.load(minecraftStatusPlugin);

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
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
} catch (error) {
  store.close();
  throw error;
}
