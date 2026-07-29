# 插件开发

每个插件是一个独立 workspace 包，并导出 `definePlugin()` 创建的插件对象。

## 最小插件

```ts
import { definePlugin } from "@qq-bot/plugin-sdk";

export default definePlugin({
  name: "hello",
  version: "0.1.0",
  description: "问候插件",
  help: {
    title: "问候",
    description: "向机器人发送问候"
  },

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
权限可设为 `member`、`admin` 或 `owner`。命令参数支持单双引号和反斜杠转义。

```ts
context.commands.register({
  name: "search",
  aliases: ["搜索"],
  description: "搜索群资料",
  usage: "<关键词>",
  examples: [
    { args: "帮助", description: "搜索“帮助”" },
    { args: "config", description: "搜索“config”" }
  ],
  permission: "member",
  cooldownMs: 3_000,
  async execute(command) {
    const [keyword] = command.args;
    await command.reply(`正在搜索：${keyword ?? ""}`);
  }
});
```

`description`、`usage` 和 `examples` 是所有插件统一的帮助信息来源。`usage`
和示例的 `args` 只填写参数部分，框架会根据实际配置的命令前缀生成完整命令。
help 插件会自动展示这些信息，不需要插件再实现一套帮助页。`hidden: true`
可隐藏内部命令；命令名称和别名不能包含空白或 `/`。需要在普通回复中生成命令
时，使用 `context.commands.format("search", "帮助")`，不要硬编码 `/`。

### 导航页与常用指令

插件可以通过 `context.navigation.register()` 为命令补充导航页标题、精选入口
和快捷操作。导航不是命令帮助的第二份副本：完整用法应写在命令注册的
`description`、`usage`、`examples` 中。`featured: true` 的条目会同时出现在
单独 `@机器人` 唤起的主导航中；点击按钮后，QQ 客户端会自动发送 `command`：

```ts
context.navigation.register({
  items: [
    {
      id: "search",
      label: "搜索资料",
      command: "search",
      args: "帮助",
      description: "查看资料搜索用法",
      featured: true
    },
    {
      id: "admin",
      label: "管理设置",
      command: "search",
      args: "config",
      permission: "admin",
      scopes: ["group"]
    }
  ]
});
```

导航页标题、描述和排序默认来自插件顶层的 `help`：

```ts
help: {
  title: "资料查询",
  description: "查询群内常用资料",
  order: 10,
  listed: true
}
```

`listed: false` 可让基础设施插件不进入帮助目录，help 插件自身即采用此方式，
不依赖插件名称特判。默认导航页 ID 是插件名称，也可以在页面定义中显式设置
`id`。未注册导航页的插件命令仍会自动出现在帮助中。使用
`/help <插件名|页面ID|命令名>` 可直接打开对应帮助。条目支持：

- `featured`：是否进入主导航的常用指令区。
- `permission`：按 `member`、`admin`、`owner` 隐藏无权使用的入口。
- `scopes`：限制在 `group`、`direct` 或 `guild` 场景显示。
- `order`：控制同一导航页中的排序。

QQ 单条消息最多展示 5 行、每行 5 个按钮。内置导航为保证手机端可读性，每行
展示 2 个并最多展示 10 个；Markdown 正文仍会列出该页的全部可用条目。若机器
人未获自定义按钮权限，QQ 适配器会自动降级为纯 Markdown，用户仍可复制命令。

### 事件

```ts
context.events.on(
  "message.created",
  async (message) => {
    context.logger.debug({ messageId: message.id }, "message received");
  },
  { priority: 10, once: false }
);
```

单个事件处理器抛出异常时，错误会被记录，其他处理器和命令仍会继续执行。
同一优先级按注册顺序启动。

### 消息中间件

中间件适合鉴权、限流、审计和上下文注入。高优先级先进入、后退出；不调用
`next()` 即可短路当前消息。

```ts
context.middleware.use(
  async (message, next) => {
    const startedAt = performance.now();
    await next();
    context.logger.debug(
      { elapsedMs: performance.now() - startedAt, handled: message.handled },
      "message completed"
    );
  },
  { priority: 100 }
);
```

### 存储

#### 会话配置

需要让不同群聊或私聊使用不同参数时，优先使用 `context.settings`。配置按以下
顺序继承，越靠后优先级越高：

```text
插件默认值 → 全局 → 平台 → 聊天类型(group/direct/guild) → 具体会话
```

```ts
const settings = context.settings.define({
  key: "main",
  version: 1,
  defaults: {
    enabled: true,
    limits: {
      daily: 20,
      burst: 3
    }
  },
  // 可直接传入 Zod schema；这里只展示无依赖写法。
  schema: {
    parse(value) {
      const candidate = value as {
        enabled?: unknown;
        limits?: { daily?: unknown; burst?: unknown };
      };
      if (
        typeof candidate.enabled !== "boolean" ||
        typeof candidate.limits?.daily !== "number" ||
        typeof candidate.limits.burst !== "number"
      ) {
        throw new Error("配置格式错误");
      }
      return candidate as {
        enabled: boolean;
        limits: { daily: number; burst: number };
      };
    }
  }
});

context.commands.register({
  name: "limit",
  description: "查看或设置当前会话限制",
  permission: "admin",
  async execute(command) {
    const scope = {
      level: "conversation" as const,
      platform: command.message.platform,
      scope: command.message.scope,
      conversationId: command.message.conversationId
    };

    const nextDaily = Number(command.args[0]);
    if (Number.isFinite(nextDaily)) {
      await settings.update(scope, (current) => ({
        ...current,
        limits: {
          ...current.limits,
          daily: nextDaily
        }
      }));
    }

    const effective = await settings.get(command.message);
    await command.reply(`当前每日限制：${effective.limits.daily}`);
  }
});
```

`set()` 替换某一层的覆盖值，`update()` 原子地读改写该层，`reset()` 删除该层
并恢复继承。`inspect()` 同时返回最终值与各层来源，适合实现管理面板或配置诊断
命令。对象会深层合并，数组整体替换。

升级配置结构时增加 `version` 并提供迁移函数：

```ts
const settings = context.settings.define({
  version: 2,
  defaults: { intervalSeconds: 60 },
  migrate(stored, fromVersion) {
    if (fromVersion === 1) {
      const old = stored as { intervalMs?: number };
      return { intervalSeconds: (old.intervalMs ?? 60_000) / 1_000 };
    }
    throw new Error(`不支持从版本 ${fromVersion} 迁移`);
  }
});
```

#### 会话状态

计数、签到记录、游戏进度等运行时数据使用 `context.state`。以下计数器在每个
群聊或私聊中独立：

```ts
const state = context.state.forConversation(command.message);
const count = await state.update<number>(
  "count",
  (current) => (current ?? 0) + 1
);
await command.reply(`本会话已调用 ${count} 次`);
```

`update()` 的更新器必须同步，返回 `undefined` 表示删除。SQLite 实现使用事务，
并发消息不会因普通的“先读再写”竞争而丢失计数。需要平台级或全局状态时可使用
`context.state.forScope(...)`。

#### 底层 KV

不需要作用域和配置继承的插件内部数据仍可直接使用：

```ts
await context.store.set("enabled", true);
const enabled = await context.store.get<boolean>("enabled");
```

键会自动加上插件名称作为命名空间，避免插件间冲突。当前应用使用 SQLite，
接口保持不变即可替换成 PostgreSQL 或测试用内存实现。多个消息会修改同一值时
应使用 `update()`，不要自行拆成 `get()` 和 `set()`。

### 定时任务

```ts
context.scheduler.every(
  "refresh",
  60_000,
  async (signal) => {
    if (signal.aborted) return;
    // 定时刷新
  },
  { runImmediately: true, overlap: "skip" }
);
```

默认禁止同一任务重入；上次任务未完成时，本轮会跳过。卸载插件会终止后续
调度并触发任务的 `AbortSignal`。

### 插件依赖与服务

插件通过 Service Token 共享类型化能力：

```ts
import { createServiceToken, definePlugin } from "@qq-bot/plugin-sdk";

export const counterService = createServiceToken<{
  increment(): number;
}>("counter");

export const provider = definePlugin({
  name: "counter-provider",
  version: "1.0.0",
  setup(context) {
    let value = 0;
    context.services.provide(counterService, {
      increment: () => ++value
    });
  }
});

export const consumer = definePlugin({
  name: "counter-consumer",
  version: "1.0.0",
  dependencies: ["counter-provider"],
  setup(context) {
    const counter = context.services.get(counterService);
    context.logger.info({ value: counter.increment() }, "counter updated");
  }
});
```

依赖必须先加载。卸载插件时，它提供的服务会自动删除。

### 取消与清理

`context.signal` 在插件开始卸载时触发。网络请求和长任务应该监听它。所有注册
API 返回的清理函数都会由框架跟踪；`setup()` 也可以返回额外的同步或异步清理
函数。

### 主动发送

```ts
await context.messages.send({
  scope: "group",
  conversationId: "group-openid",
  delivery: {
    type: "active",
    idempotencyKey: "daily-notice:2026-07-29"
  },
  content: "通知内容"
});
```

主动消息和互动召回必须显式声明投递方式并提供稳定的幂等键；重复使用同一个键会
直接返回已保存的发送回执，不会再次投递。普通命令回复由框架自动使用
`delivery: { type: "passive" }`。`send()` 和 `reply()` 返回 `SentMessage`，
其中包含平台消息 ID，可用于审计或撤回：

```ts
const sent = await command.reply("这条消息稍后撤回");
if (context.messages.supports("recall")) {
  await context.messages.recall(sent);
}
```

### 富媒体回复

`reply()` 和 `context.messages.send()` 都接受统一的富媒体内容。原有字符串写法
保持不变：

```ts
await command.reply("普通文本");
```

发送 Markdown 与点击后自动发送命令的按钮：

```ts
await command.reply({
  markdown: "# 操作导航\n请选择一个操作",
  keyboard: {
    rows: [
      [
        {
          label: "立即查询",
          action: "command",
          data: "/search 热门",
          style: 1,
          enter: true
        }
      ]
    ]
  }
});
```

发送 URL 图片并附带文字：

```ts
await command.reply({
  text: "今日图片",
  media: [
    {
      type: "image",
      source: {
        type: "url",
        url: "https://example.com/today.png"
      }
    }
  ]
});
```

发送内存中的图片或文件：

```ts
import { readFile } from "node:fs/promises";

const data = await readFile("/safe/path/report.png");
await command.reply({
  media: [
    {
      type: "image",
      filename: "report.png",
      contentType: "image/png",
      source: { type: "data", data }
    }
  ]
});
```

媒体类型支持 `image`、`video`、`audio` 和 `file`。一个内容对象可以包含多个
媒体，适配器会保持顺序发送。QQ 图片支持附带文字；视频、语音和文件附带文字
时，适配器会先发送文本，再发送媒体。URL 只允许 HTTP/HTTPS，二进制数据会在
适配器内转换为 QQ 文件上传格式。

QQ 图片、视频和语音的软限制分别为 20、30、20 MiB，文件软限制为 200 MiB；
统一硬限制为 200 MiB。较大的本地数据自动使用预上传和分片流程，小文件继续
整文件上传。`file_info` 按会话和内容摘要缓存，不会跨单聊/群聊复用或使用过期值。

### QQ 可选消息能力

插件应先用 `context.messages.supports()` 检查 `recall`、`typing` 或 `stream`。
输入中状态只支持 QQ 单聊，并且必须绑定触发消息或事件：

```ts
if (
  command.message.scope === "direct" &&
  context.messages.supports("typing")
) {
  await context.messages.setTyping(
    command.message,
    10,
    { type: "message", messageId: command.message.id }
  );
}
```

单聊流式消息支持 append、replace 和显式结束：

```ts
if (
  command.message.scope === "direct" &&
  context.messages.supports("stream")
) {
  const stream = await context.messages.openStream({
    conversation: command.message,
    delivery: {
      type: "passive",
      target: { type: "message", messageId: command.message.id }
    },
    contentType: "markdown",
    inputMode: "replace",
    initialContent: "正在生成…"
  });
  await stream.replace("正在生成…已完成一半");
  await stream.complete("## 完成\n最终结果");
}
```

主动消息需要遵守对应平台的授权和频率限制。回复用户消息时优先使用命令上下文
的 `reply()`。
