import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const configSchema = z
  .object({
    BOT_ADAPTER: z.enum(["console", "qq-official"]).default("console"),
    BOT_COMMAND_PREFIX: z.string().min(1).default("/"),
    BOT_DATABASE_PATH: z.string().min(1).default("./data/bot.sqlite"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    QQ_APP_ID: z.string().optional(),
    QQ_CLIENT_SECRET: z.string().optional(),
    QQ_RECEIVE_ALL_GROUP_MESSAGES: booleanFromString
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
