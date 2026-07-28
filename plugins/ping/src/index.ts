import { definePlugin } from "@qq-bot/plugin-sdk";

export default definePlugin({
  name: "ping",
  version: "0.3.0",
  description: "检查机器人是否在线",
  setup(context) {
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
