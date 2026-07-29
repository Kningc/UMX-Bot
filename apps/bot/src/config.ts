import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
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
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    QQ_APP_ID: z.string().optional(),
    QQ_CLIENT_SECRET: z.string().optional(),
    QQ_API_BASE_URL: z
      .string()
      .url()
      .default("https://api.bot.qq.com"),
    QQ_RECEIVE_ALL_GROUP_MESSAGES: booleanFromString,
    QQ_ENABLE_INTERACTIONS: booleanFromString,
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
