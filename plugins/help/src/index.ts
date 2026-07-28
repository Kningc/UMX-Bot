import { definePlugin } from "@qq-bot/plugin-sdk";

export default definePlugin({
  name: "help",
  version: "0.1.0",
  description: "显示已注册命令",
  setup(context) {
    context.commands.register({
      name: "help",
      description: "显示所有可用命令",
      aliases: ["帮助"],
      async execute(command) {
        const lines = context.commands
          .list()
          .map(
            (item) =>
              `/${item.name} - ${item.description}${
                item.permission === "member"
                  ? ""
                  : ` [${item.permission}]`
              }`
          );
        await command.reply(`可用命令：\n${lines.join("\n")}`);
      }
    });
  }
});
