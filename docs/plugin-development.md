# 插件开发

每个插件是一个独立 workspace 包，并导出 `definePlugin()` 创建的插件对象。

## 最小插件

```ts
import { definePlugin } from "@qq-bot/plugin-sdk";

export default definePlugin({
  name: "hello",
  version: "0.1.0",
  description: "问候插件",

  setup(context) {
    context.commands.register({
      name: "hello",
      description: "向机器人问好",
      aliases: ["你好"],
      async execute(command) {
        await command.reply(`你好，${command.message.author.name ?? "朋友"}`);
      }
    });
  }
});
```

将插件包加入 `apps/bot/package.json`，然后在 `apps/bot/src/main.ts` 中导入并
调用 `bot.load(plugin)`。

## 可用能力

### 命令

`context.commands.register()` 注册命令，返回的清理函数由插件运行时自动跟踪。
权限可设为 `member`、`admin` 或 `owner`。

### 事件

```ts
context.events.on("message.created", async (message) => {
  context.logger.debug({ messageId: message.id }, "message received");
});
```

单个事件处理器抛出异常时，错误会被记录，其他处理器和命令仍会继续执行。

### 存储

```ts
await context.store.set("enabled", true);
const enabled = await context.store.get<boolean>("enabled");
```

键会自动加上插件名称作为命名空间，避免插件间冲突。当前应用使用 SQLite，
接口保持不变即可替换成 PostgreSQL 或测试用内存实现。

### 定时任务

```ts
context.scheduler.every("refresh", 60_000, async () => {
  // 定时刷新
});
```

卸载插件时，事件监听、命令和定时器都会自动清理。任务应该保持幂等，并避免
单次执行时间超过任务间隔。

### 主动发送

```ts
await context.messages.send({
  scope: "group",
  conversationId: "group-openid",
  content: "通知内容"
});
```

主动消息需要遵守对应平台的授权和频率限制。回复用户消息时优先使用命令上下文
的 `reply()`。
