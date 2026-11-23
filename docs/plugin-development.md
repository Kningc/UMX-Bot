# 插件开发

插件是独立的 ESM npm 包，并默认导出 `definePlugin()` 创建的插件对象。应用通过
显式清单加载受信任插件：清单中的包会先被导入和校验，再按依赖关系排序，最后
依次进入运行时。

> 安全边界：插件与机器人运行在同一个 Node.js 进程中，拥有相同的文件、网络、
> 环境变量和数据库权限。框架提供生命周期与命名空间隔离，但不提供安全沙箱。
> 只安装你信任其源码和发布者的插件；需要隔离的插件请用[进程外插件](remote-plugins.md)。

本文目录：

- [从模板开始](#从模板开始)、[最小插件](#最小插件)、[安装与插件清单](#安装与插件清单)、[测试插件](#测试插件)
- [可用能力](#可用能力)：命令、导航、事件、中间件、存储、定时任务、服务、主动发送、富媒体、QQ 扩展
- [框架扩展能力（API v2）](#框架扩展能力api-v2)：子命令与参数、访问控制、出站钩子、回调按钮、插件事件、指标、cron、TTL 与集合、权限
- [版本与发布](#版本与发布)、[当前运行边界](#当前运行边界)

## 从模板开始

仓库中的 `examples/plugin-starter` 是完整模板，包含包元数据、严格 TypeScript
配置、启动配置校验和使用真实运行时的 Vitest 测试。它参与主工作区的构建与回归，
所以永远与当前 SDK 对齐。

用脚手架生成，包名、插件名、类型名、测试和 README 会一并改好：

```bash
pnpm create:plugin my-plugin
```

```bash
pnpm install
pnpm --filter @umx-bot/plugin-my-plugin test
```

默认生成到 `plugins/<名称>`，用 `--dir` 可以放到仓库外，`--scope` 可以换 npm
scope。

外部插件的运行时依赖应声明为 peer dependency，避免宿主出现多份 SDK：

```json
{
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "peerDependencies": {
    "@umx-bot/plugin-sdk": "^0.7.0"
  },
  "devDependencies": {
    "@umx-bot/plugin-sdk": "^0.7.0",
    "@umx-bot/plugin-testkit": "^0.7.0"
  }
}
```

## 最小插件

```ts
import { definePlugin, PLUGIN_API_VERSION } from "@umx-bot/plugin-sdk";

export default definePlugin({
  name: "hello",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
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

`name` 必须是稳定的小写标识，`version` 必须是完整 SemVer。`access`、`adapter`、
`core`、`host`、`kernel`、`scheduler` 是宿主保留名，用它们的插件会被拒绝加载。正式插件应显式
声明 `apiVersion`；省略只用于兼容早期 v1 插件。

## 安装与插件清单

先把插件包安装为 `@umx-bot/app` 的依赖，再创建清单：

```bash
corepack pnpm --filter @umx-bot/app add @example/umx-bot-weather
cp deploy/plugins.json.example ./plugins.json
```

```json
{
  "schemaVersion": 1,
  "plugins": [
    { "specifier": "@umx-bot/plugin-help" },
    {
      "specifier": "@example/umx-bot-weather",
      "config": {
        "endpoint": "https://weather.example.com"
      },
      "secrets": {
        "auth.token": "WEATHER_API_TOKEN"
      }
    },
    {
      "specifier": "./local/plugin.js",
      "enabled": false
    }
  ]
}
```

设置 `BOT_PLUGIN_MANIFEST=/absolute/path/plugins.json` 后启动应用（字段一览见
[配置参考](configuration.md#插件清单)）。相对路径以清单
所在目录解析；npm 包名由 Node.js 从应用依赖中解析。`enabled: false` 可停用
条目而无需卸载包。未设置清单时继续加载内置的 help、ping 和
minecraft-status 插件。

`config` 是非敏感 JSON 配置；`secrets` 把配置路径映射到环境变量名称，缺少
变量时应用会在连接平台前拒绝启动。插件通过只读、深层冻结且与宿主隔离的
`context.config` 读取启动配置，其 TypeScript 类型同样是深层只读。通过插件的
`configuration.parse()` 在任何资源注册前完成校验，同时让 `context.config`
获得静态类型；也可直接传入兼容 Zod 的 schema：

```ts
configuration: {
  parse(value) {
    const endpoint = (value as { endpoint?: unknown }).endpoint;
    if (typeof endpoint !== "string") {
      throw new Error("weather config.endpoint is required");
    }
    return { endpoint };
  }
},
setup(context) {
  // context.config.endpoint 是 string。
}
```

管理员可在线调整的会话参数仍应使用 `context.settings`，不要放入启动清单。

## 测试插件

`@umx-bot/plugin-testkit` 使用真实的内核、命令路由、中间件、存储和生命周期，
只把平台适配器换成内存实现：

```ts
import { createPluginTestHost } from "@umx-bot/plugin-testkit";
import { expect, it } from "vitest";
import plugin from "./index.js";

it("replies to hello", async () => {
  const host = createPluginTestHost();
  await host.load(plugin, { config: { greeting: "欢迎" } });
  await host.start();
  const replies = await host.receive("/hello", { authorName: "小明" });
  expect(replies.map((message) => message.content)).toEqual(["欢迎，小明"]);
  await host.emit("contact.added", {
    platform: "test",
    userId: "user-1",
    timestamp: new Date()
  });
  await host.stop();
});
```

`receive()` 还可注入附件、提及、机器人提及状态、时间和原始平台数据。测试宿主
支持传入自定义 `store`、`logger`，以及 recall、typing、stream
`adapterCapabilities`，用于验证持久化、诊断和平台能力降级。

`host.getNavigation()` 返回插件注册的导航页与常用指令，可以直接断言展示面、
可见范围和权限，不必通过适配器侧效果间接验证。

### 测试自己写的适配器

写新适配器时用 `adapterConformanceChecks()` 固化 `BotAdapter` 契约：

```ts
import { adapterConformanceChecks } from "@umx-bot/plugin-testkit";

for (const check of adapterConformanceChecks({
  createAdapter: () => new MyAdapter({ logger })
})) {
  it(check.name, () => check.run());
}
```

它覆盖名称约定、`start`/`stop` 的幂等与重启、缺少 `onEvent` 时仍能启动、发送
回执的字段，以及诊断必须可 JSON 序列化（应用会把它写进健康快照）。适配器在
测试里无法发送时传 `skipSend: true`。

## 可用能力

### 命令

`context.commands.register()` 注册命令，返回的清理函数由插件运行时自动跟踪。
权限可设为 `member`、`admin` 或 `owner`。`owner` 既包括平台群主，也包括
`BOT_OWNER_IDS` 中的机器人主人；影响整个机器人的命令（全局配置、封禁、插件启停）
应再加 `botOwnerOnly: true`，只允许机器人主人（`message.author.botOwner`）执行，
子命令可单独设置并默认继承父命令。命令参数支持单双引号和反斜杠转义。

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
help 插件会自动展示这些信息，不需要插件再实现一套帮助页；只有子命令、没有
`execute` 的命令在没匹配到子命令时，也会回复同一份帮助页。插件自己的“帮助”
入口（例如 `mc help`）可以直接调用帮助服务：

```ts
import { helpService } from "@umx-bot/plugin-sdk";

if (context.services.has(helpService)) {
  await command.reply(
    await context.services.get(helpService).render(command.message, "mc")
  );
}
```

`render(message, query)` 按这条消息的作者和聊天过滤，`query` 与 `/help` 的参数
相同。没装 help 插件时 `has` 返回 false，请准备一个纯文本兜底。`hidden: true`
可隐藏内部命令；命令名称和别名不能包含空白或 `/`。需要在普通回复中生成命令
时，使用 `context.commands.format("search", "帮助")`，不要硬编码 `/`。
`cooldownMs` 按会话和用户分别计时，只有通过权限、访问控制和参数校验的调用才会
开始冷却。

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
`/help <插件名|页面ID|标题|命令名|命令 子命令>` 可直接打开对应帮助，命令名可以
带前缀，也可以用别名；都不匹配时按子串搜索，唯一命中直接打开，多个命中列出
候选。

帮助只展示读者能用的内容。自己做目录时也请用 `context.commands.available(message)`
和 `context.navigation.available(message)`：它们按读者的角色、当前聊天的场景以及
访问控制（`/acl` 的停用、封禁名单）过滤，`list()` 则返回全部注册项。条目支持：

- `featured`：是否进入主导航的常用指令区。
- `permission`：按 `member`、`admin`、`owner` 隐藏无权使用的入口。
- `scopes`：限制在 `group`、`direct` 或 `guild` 场景显示。
- `surfaces`：入口出现的位置，可选 `message`、`menu`，默认仅为 `message`。
  `menu` 会进入 QQ 单聊底部菜单。`panel` 已弃用、不再生效：QQ 指令面板现在
  直接列出已注册的命令（见 [QQ 官方适配](qq-official.md#导航菜单与指令面板)），
  不想出现在面板里的命令请设 `hidden: true`。
- `order`：控制同一导航页中的排序。

插件只声明入口，不直接调用 QQ 的全局覆盖接口。全部插件加载完成后，QQ
适配器会聚合完整快照、检查平台数量和长度限制，再幂等同步。例如：

```ts
context.navigation.register({
  title: "Minecraft",
  items: [
    {
      id: "status",
      label: "服务器状态",
      command: "mc",
      description: "查询已配置服务器的实时状态",
      scopes: ["direct", "group"],
      surfaces: ["message", "menu"]
    },
    {
      id: "config",
      label: "当前配置",
      command: "mc",
      args: "config",
      description: "查看当前服务器配置",
      scopes: ["direct", "group"],
      surfaces: ["message", "menu"]
    }
  ]
});
```

同一页面有多个 `menu` 入口时，页面标题会成为 QQ 一级折叠菜单；只有一个
入口时直接生成一级按钮。如果菜单超过 QQ 限制，同步会在写入前失败并保留线上
最后一次有效配置。

QQ 单条消息最多展示 5 行、每行 5 个按钮。内置导航为保证手机端可读性，每行
展示 2 个并最多展示 10 个；主导航超出时按钮分页（`/help 2`），最后一行留给
上一页和下一页，Markdown 正文仍会列出全部可用条目。超过 10 个字的按钮文字会
截断并以“…”结尾。若机器
人未获自定义按钮权限，QQ 适配器会自动降级为纯 Markdown，用户仍可复制命令。

### 事件

```ts
context.events.on(
  "message.created",
  async (message) => {
    context.logger.debug({ messageId: message.id }, "message received");

    if (message.quote) {
      context.logger.debug(
        {
          quotedText: message.quote.content,
          quotedReferenceId: message.quote.referenceId
        },
        "message quotes another message"
      );
    }
  },
  { priority: 10, once: false }
);
```

`message.quote` 存在即表示当前消息引用（回复）了另一条消息；
`message.quote.content` 是平台提供的引用原文，`attachments` 是引用消息中的附件，
`referenceId` 是可选的平台侧引用标识。若平台只报告了引用关系但省略原文，
`content` 为空字符串。普通消息不包含 `quote` 字段。

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

键会自动加上 `<插件名>:` 前缀作为命名空间，避免插件之间以及插件与宿主数据冲突（宿主保留名见上文）。当前应用使用 SQLite，
接口保持不变即可替换成 PostgreSQL 或测试用内存实现。多个消息会修改同一值时
应使用 `update()`，不要自行拆成 `get()` 和 `set()`。

需要遍历自己写入的键时使用可选的 `list()`：

```ts
import { supportsListing } from "@umx-bot/plugin-sdk";

if (!supportsListing(context.store)) {
  throw new Error("当前存储不支持枚举，无法列出订阅");
}
let after: string | undefined;
for (;;) {
  const page = await context.store.list<Subscription>("subscription:", {
    limit: 100,
    ...(after === undefined ? {} : { after })
  });
  if (page.length === 0) break;
  // 处理 page …
  after = page.at(-1)?.key;
}
```

`list()` 是**可选能力**：内置的 SQLite 与内存实现都支持，第三方存储可以不实现。
缺失时必须当成“无法枚举”，而不是“没有数据”——用 `supportsListing()` 区分，
不要把空结果当成结论。

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
import {
  createServiceToken,
  definePlugin,
  PLUGIN_API_VERSION
} from "@umx-bot/plugin-sdk";

export const counterService = createServiceToken<{
  increment(): number;
}>("counter");

export const provider = definePlugin({
  name: "counter-provider",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
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
  apiVersion: PLUGIN_API_VERSION,
  dependencies: [
    { name: "counter-provider", version: "^1.0.0" }
  ],
  setup(context) {
    const counter = context.services.get(counterService);
    context.logger.info({ value: counter.increment() }, "counter updated");
  }
});
```

清单加载器会自动排序依赖，并在任何插件 setup 前报告缺失、循环或版本不兼容。
版本范围遵循标准 `node-semver` 语义，支持精确版本、`^`、`~`、比较器组合和
其他标准范围，例如 `>=1.2.0 <2.0.0`。未在范围中显式包含预发布版本时，
`1.3.0-beta.1` 不会满足 `^1.2.3`。`optional: true` 可声明可选依赖。卸载插件时，
它提供的服务会自动删除。

### 取消与清理

`context.signal` 在插件开始卸载时触发。网络请求和长任务应该监听它。所有注册
API 返回的清理函数都会由框架跟踪；`setup()` 也可以返回额外的同步或异步清理
函数。

`setup()` 在平台适配器启动前执行，适合校验配置和注册能力，不应在其中发送
消息。需要在平台就绪后执行一次初始化时订阅 `bot.ready`。所有 ready 处理器会
完成本轮执行；其中任意一个失败都会使启动失败、停止适配器并逆序回滚全部插件。
普通业务事件仍会隔离单个处理器错误。正常停机先停止入口并排空消息，再触发取消
信号和逆序清理。同名插件在 setup 期间已经占用名称，并发重复加载不会覆盖清理
记录。

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
          style: "primary",
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

不应把大文件先读成完整 `Uint8Array`。可传入异步字节流和通用 checksum
列表。QQ 分片上传所需的额外摘要由可选扩展包构造；平台无关插件不应依赖它：

```ts
import { qqStreamingChecksums } from "@umx-bot/plugin-sdk-qq";

source: {
  type: "stream",
  stream: createReadStream(filePath),
  size: metadata.size,
  checksums: qqStreamingChecksums({
    md5: metadata.md5,
    sha1: metadata.sha1,
    first10MiBMd5: metadata.first10MiBMd5
  })
}
```

### QQ 可选消息能力

QQ 专属的键盘模板和互动唤醒投递也位于
`@umx-bot/plugin-sdk-qq`：

```ts
import {
  qqKeyboardTemplate,
  qqWakeupDelivery
} from "@umx-bot/plugin-sdk-qq";

await context.messages.send({
  scope: "direct",
  conversationId,
  delivery: qqWakeupDelivery(`interaction:${interactionId}`),
  content: {
    markdown: "## 后续操作",
    keyboard: qqKeyboardTemplate("template-id")
  }
});
```

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

主动流要求稳定幂等键。每个成功分片的 `stream_msg_id`、连续 `index` 和内容状态
都会持久化；结果不确定时状态变为 `uncertain`，不能继续 append/replace。调用方
可显式重试同一分片，或在恢复成功后结束流：

```ts
if (stream.state === "uncertain") {
  await stream.retry();
}
await stream.abort("生成已终止");
```

主动消息需要遵守对应平台的授权和频率限制。回复用户消息时优先使用命令上下文
的 `reply()`。

## 框架扩展能力（API v2）

`PLUGIN_API_VERSION` 当前为 `2`。**演进策略**：同一版本内契约只增不改；可能破坏
现有插件的改动才会升版本号，并且运行时会继续接受 `SUPPORTED_PLUGIN_API_VERSIONS`
里的旧版本。声明 `apiVersion: 1`（或不声明）的插件无需任何改动。

### 子命令、参数与适用范围

```ts
import { defineArgs, defineCommand, defineSubcommand } from "@umx-bot/plugin-sdk";

context.commands.register(
  defineCommand({
    name: "score",
    description: "积分",
    scopes: ["group"], // 在单聊里等同于未注册
    subcommands: [
      defineSubcommand({
        name: "add",
        description: "给成员加分",
        permission: "admin", // 子命令可以有自己的权限、冷却和 scopes
        args: defineArgs({
          user: { type: "string" },
          points: { type: "integer", min: 1, max: 100 },
          reason: { type: "string", rest: true, optional: true }
        }),
        async execute({ parsed, reply, logger }) {
          logger.info({ user: parsed.user }, "score added"); // 已绑定 messageId
          await reply(`+${parsed.points} → ${parsed.user}`);
        }
      })
    ],
    async execute({ reply }) {
      await reply("用法：/score add <user> <points>");
    }
  })
);
```

- 没有 `execute` 而有子命令时，未匹配会自动回复子命令列表。
- 参数校验失败时框架会回复错误原因和用法，不会调用 `execute`。`args` 是任何带
  `parse()` 的对象，抛 `CommandArgumentError` 可自定义提示。
- `command.executed` 事件（含 `completed`/`failed`/`denied`/`rejected`）可用于审计和
  统计；框架本身也据此导出命令指标。

### 访问控制与 `/acl`、`/config`

内核在角色检查之后调用 `AccessPolicy`。默认的 `StoreAccessPolicy` 支持按会话停用
插件或命令、按平台封禁用户（只有机器人主人不受封禁影响）。应用内置两个管理命令：

- `/acl status|disable <插件或命令>|enable …`：管理员开关当前聊天；`/acl block|unblock|blocked`
  仅机器人主人。`help`、`plugin-admin`、`access-admin`、`config-admin` 不可停用。
- `/config list|show|set|reset`：基于 `context.settings.define()` 自动生成，无需插件自己写
  管理命令；修改经过插件自己的 schema 校验，`secret/token/password/apiKey` 字段显示为
  `***`。`set-global`/`reset-global` 仅机器人主人。

完整用法见[运维：内置管理命令](operations.md#内置管理命令)。被 `/acl` 停用或封禁
时命令静默不响应（`command.executed` 记为 `denied`），插件本身无需处理。宿主可以
替换 `AccessPolicy` 接入自己的规则，拒绝时返回 `reason` 会展示给用户。

### 出站钩子

```ts
context.outbound.use(async (message, next) => {
  // 改写、拆分（多次 next）或拦截（不调用 next）
  return next({ ...message, content: redact(message.content) });
}, { priority: 10 });
```

覆盖 `messages.send` 与 `reply`；消息流、撤回和 Outbox 重放不经过它。

### 回调按钮

```ts
const data = context.interactions.encode("refresh", "42"); // "<插件名>:refresh:42"
// 放进 keyboard 的 { action: "callback", data } 按钮
context.interactions.handle("refresh", async ({ payload, reply }) => {
  await reply(`已刷新 ${payload}`);
});
```

QQ 适配器会解析 `INTERACTION_CREATE` 的按钮数据并自动应答（PUT `/interactions/{id}`，失败只记日志）。
需要 `QQ_ENABLE_INTERACTIONS=true`。

### 插件事件

`context.events.emit("my-plugin.something", payload)` 只能发布以自己插件名开头的事件。
用声明合并给 `BotEvents` 增加类型：

```ts
declare module "@umx-bot/plugin-sdk" {
  interface BotEvents { "my-plugin.something": { id: string } }
}
```

### 指标

```ts
const hits = context.metrics.counter("hits_total", "命中次数", { labels: ["kind"] });
hits.inc({ kind: "cache" });
```

导出为 `qq_bot_plugin_<插件名>_hits_total`，随插件卸载一起消失；每个指标最多 1000 个标签组合，
标签值不要用用户或消息 ID。内核另外导出 `qq_bot_command_executions_total`、
`qq_bot_command_duration_seconds` 和 `qq_bot_scheduled_task_*`。

### cron 与一次性任务

```ts
context.scheduler.cron("daily", "0 9 * * *", run, { timezone: "utc", catchUp: true });
context.scheduler.at("remind", new Date(Date.now() + 60_000), run);
```

五段式 cron（分 时 日 月 周，支持 `*`、列表、范围、`/步长`）。`catchUp: true` 会持久化
上次运行，机器人停机期间错过触发时在启动后补跑**一次**；首次出现只记录基线。

### 存储：TTL 与集合

```ts
await context.store.set("session", data, { ttlMs: 60_000 }); // 过期即读不到，list 也会跳过
const scores = createCollection<Score>(context.store, "scores");
await scores.put("alice", { points: 3 });
const top = await scores.find(undefined, { limit: 10, sort: (a, b) => b.value.points - a.value.points });
```

集合基于 KV 前缀枚举，`find`/`count` 是全量扫描，适合千级记录；不支持枚举的存储会直接报错
而不是返回空。TTL 依赖 SQLite schema v2 的 `expires_at` 列，
打开旧库时自动迁移。

### 权限、需求与宿主扩展

```ts
definePlugin({
  name: "digest",
  permissions: ["scheduler", "messages.active"], // 声明即进入受限模型
  requires: ["messages.stream"],                 // 宿主不支持就加载失败
  /* … */
});
```

- 权限：`messages.active`、`events.emit`、`scheduler`、`middleware`、`outbound`。未声明
  `permissions` 且清单也未限制的插件保持旧的不受限行为。
- 清单可以写 `"permissions": [...]`：它既是授权也是上限——插件声明了清单没授予的权限会拒绝加载。
  这只约束框架经手的能力，**不是沙箱**：进程内插件仍能访问网络和文件系统。
- 宿主可通过 `BotKernel` 的 `contextExtensions` 给所有插件加能力（例如数据库句柄）；插件用
  `requires: ["<名字>"]` 声明依赖，类型通过声明合并 `PluginContextExtensions` 提供。

## 版本与发布

- 插件自身的 `version` 使用 SemVer；破坏命令、配置或服务契约时提升主版本。
- `apiVersion` 表示框架插件契约版本，不等同于插件包版本。正式插件必须显式
  使用 `PLUGIN_API_VERSION`。省略值始终按历史 API v1 解释，不会随当前 API
  版本变化。
- `@umx-bot/plugin-sdk` 应放在 `peerDependencies`，开发时再放入
  `devDependencies`，避免多个 SDK 实例破坏 Service Token 身份。
- 平台无关插件不要依赖 `@umx-bot/plugin-sdk-qq`；确实使用 QQ 扩展时，应在包
  说明中明确平台限制。
- 发布包必须包含构建后的 ESM 和 `.d.ts`，建议声明 `"engines": { "node": ">=22.13" }`。

发布前至少执行：

```bash
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
corepack pnpm pack --pack-destination /tmp/plugin-release
```

检查 tarball 中不存在 `.env`、凭据、测试数据库和不必要的源码产物，再在空白
项目中安装 tarball 并运行集成测试。包还应声明自己的许可证、仓库地址和维护者。

## 当前运行边界

- 插件必须是管理员明确安装并加入清单的可信代码，不提供远程市场自动安装。
- 配置了 `BOT_OWNER_IDS` 后，机器人主人可以用 `/plugin disable|enable|reload`
  在运行中切换插件。注意：
  - 运行时加载的插件**不会**收到 `bot.ready`，启动逻辑要放在 `setup()` 里；
  - 变更只在当前进程生效，插件清单仍是事实来源，重启后按清单恢复；
  - `reload` 总会重新读取清单（配置与密钥生效），但只有路径型 specifier 能带上
    代码改动——npm 包型会复用 Node 缓存的模块；
  - Node 无法释放已导入的 ES 模块，每次带代码的热重载都会残留旧版本。为此默认最多
    20 次（`BOT_PLUGIN_MAX_HOT_RELOADS`），超过后拒绝并要求重启进程。热重载是开发期工具，
    生产环境更新代码请重启。
- 被其他已加载插件依赖的插件无法卸载，会报出依赖方名称。
- setup、命令、事件和定时任务错误会附带插件上下文写入日志；向最终用户展示的
  错误信息由命令路由统一降级，插件不应泄露密钥或上游响应正文。

## 进程外插件

不受信任、较重或非 TypeScript 的插件可在子进程中运行，通过 stdio JSON-RPC 与宿主通信，见 [remote-plugins.md](remote-plugins.md)（`plugins.json` 中使用 `remote` 条目）。
