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
权限可设为 `member`、`admin` 或 `owner`。命令参数支持单双引号和反斜杠转义。

```ts
context.commands.register({
  name: "search",
  aliases: ["搜索"],
  description: "搜索群资料",
  usage: "/search <关键词>",
  permission: "member",
  cooldownMs: 3_000,
  async execute(command) {
    const [keyword] = command.args;
    await command.reply(`正在搜索：${keyword ?? ""}`);
  }
});
```

`hidden: true` 可隐藏内部命令；命令名称和别名不能包含空白或 `/`。

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
  content: "通知内容"
});
```

主动消息需要遵守对应平台的授权和频率限制。回复用户消息时优先使用命令上下文
的 `reply()`。
