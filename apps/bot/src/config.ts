import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");
const booleanFromStringDefaultTrue = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");
const positiveInteger = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const configSchema = z
  .object({
    BOT_ADAPTER: z.enum(["console", "qq-official"]).default("console"),
    BOT_COMMAND_PREFIX: z.string().min(1).default("/"),
    BOT_DATABASE_PATH: z.string().min(1).default("./data/bot.sqlite"),
    BOT_PLUGIN_MANIFEST: z.string().min(1).optional(),
    BOT_HEALTH_FILE: z.string().min(1).optional(),
    BOT_HEALTH_INTERVAL_MS: positiveInteger(30_000),
    BOT_SHUTDOWN_TIMEOUT_MS: positiveInteger(10_000),
    // Node 无法释放已导入的 ESM 模块，每次带缓存破坏的热重载都会残留旧模块。
    // 超过上限后拒绝继续热重载，改为要求重启进程。
    BOT_PLUGIN_MAX_HOT_RELOADS: positiveInteger(20),
    // 以逗号分隔的平台用户 ID；这些人在任何会话都按 owner 处理。
    BOT_OWNER_IDS: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      ),
    // 运维 HTTP 端点默认关闭；设了端口才启动。它没有鉴权，所以默认只绑回环。
    BOT_METRICS_PORT: z.coerce.number().int().min(0).max(65_535).optional(),
    BOT_METRICS_HOST: z.string().min(1).default("127.0.0.1"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    QQ_APP_ID: z.string().optional(),
    QQ_CLIENT_SECRET: z.string().optional(),
    QQ_API_BASE_URL: z.string().url().default("https://api.bot.qq.com"),
    QQ_RECEIVE_ALL_GROUP_MESSAGES: booleanFromString,
    QQ_ENABLE_INTERACTIONS: booleanFromString,
    QQ_SYNC_NAVIGATION: booleanFromStringDefaultTrue,
    QQ_CERTIFICATION: z
      .enum(["enterprise", "personal", "unverified"])
      .default("unverified"),
    QQ_INTENTS: z.coerce.number().int().nonnegative().optional(),
    QQ_REQUEST_TIMEOUT_MS: positiveInteger(10_000),
    QQ_GATEWAY_READY_TIMEOUT_MS: positiveInteger(15_000),
    QQ_RECONNECT_DELAY_MS: positiveInteger(2_000),
    QQ_RECONNECT_MAX_DELAY_MS: positiveInteger(60_000)
  })
  .superRefine((config, context) => {
    if (config.BOT_ADAPTER !== "qq-official") {
      return;
    }
    if (!config.QQ_APP_ID) {
      context.addIssue({
        code: "custom",
        path: ["QQ_APP_ID"],
        message: "QQ_APP_ID is required for qq-official"
      });
    }
    if (!config.QQ_CLIENT_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["QQ_CLIENT_SECRET"],
        message: "QQ_CLIENT_SECRET is required for qq-official"
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env
): AppConfig {
  return configSchema.parse(environment);
}
