import process from "node:process";
import { ConsoleAdapter } from "@qq-bot/adapter-console";
import { QqOfficialAdapter } from "@qq-bot/adapter-qq-official";
import { BotKernel } from "@qq-bot/core";
import helpPlugin from "@qq-bot/plugin-help";
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
        receiveAllGroupMessages: config.QQ_RECEIVE_ALL_GROUP_MESSAGES,
        logger: logger.child({ component: "adapter" })
      })
    : new ConsoleAdapter({
        logger: logger.child({ component: "adapter" })
      });

const bot = new BotKernel({
  adapter,
  logger,
  commandPrefix: config.BOT_COMMAND_PREFIX,
  store
});

await bot.load(helpPlugin);
await bot.load(pingPlugin);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  await bot.stop();
  store.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await bot.start();
