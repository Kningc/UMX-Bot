import { definePlugin, PLUGIN_API_VERSION } from "@qq-bot/plugin-sdk";

interface StarterConfig {
  greeting: string;
}

function readConfig(value: unknown): StarterConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("starter plugin config must be an object");
  }
  const greeting = (value as Record<string, unknown>).greeting ?? "你好";
  if (typeof greeting !== "string" || greeting.trim().length === 0) {
    throw new Error("starter plugin config.greeting must be a non-empty string");
  }
  return { greeting };
}

export default definePlugin({
  name: "starter",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "可复制的插件起步模板",
  help: {
    title: "起步示例",
    description: "演示配置、命令、测试和生命周期"
  },
  configuration: {
    parse: readConfig
  },
  setup(context) {
    context.commands.register({
      name: "hello",
      description: "向当前用户问好",
      execute(command) {
        const name = command.message.author.name ?? "朋友";
        return command.reply(`${context.config.greeting}，${name}`);
      }
    });
  }
});
