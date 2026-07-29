import { definePlugin, PLUGIN_API_VERSION } from "@qq-bot/plugin-sdk";

export default definePlugin({
  name: "ping",
  version: "0.5.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "检查机器人是否在线",
  help: {
    title: "状态检查",
    description: "检查机器人服务是否在线",
    order: -50
  },
  setup(context) {
    context.navigation.register({
      items: [
        {
          id: "ping",
          label: "在线状态",
          command: "ping",
          description: "立即检查机器人是否在线",
          featured: true
        }
      ]
    });
    context.commands.register({
      name: "ping",
      description: "检查机器人是否在线",
      aliases: ["状态"],
      async execute(command) {
        await command.reply("pong");
      }
    });
  }
});
