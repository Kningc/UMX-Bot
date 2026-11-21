# 架构

## 设计目标

框架采用模块化单体：部署简单，但核心、平台适配器、存储和插件之间保持明确
边界。业务插件只依赖 `@qq-bot/plugin-sdk`，不直接依赖 QQ API。
显式插件清单是部署边界：只有管理员加入清单并安装到应用依赖中的可信 ESM 包
才会执行。插件是进程内扩展而非安全沙箱。

```text
QQ / Console
      │
      ▼
 BotAdapter（平台归一化、去重、重连）
   ├── gateway/   连接、Identify/Resume、心跳、分道进度
   ├── mapping/   平台事件 → 跨平台消息与生命周期事件
   └── openapi/   统一 HTTP Client、结构化错误、限频
      │
      ▼
 BotKernel（状态机、流量接纳、owner 名单、优雅停机）
      │
      ▼
 MiddlewarePipeline
      │
      ├── EventBus
      └── CommandRouter（权限、冷却、审计）
              │
              ▼
         PluginRuntime
         ├── Scheduler
         ├── ServiceContainer
         ├── ScopedSettings / ScopedState
         └── KeyValueStore
```

QQ 适配器按职责分层：`gateway/` 只负责传输契约，不解释事件含义；`mapping/`
是纯函数，可以直接拿抓包的事件 JSON 测试；`openapi/` 是所有 HTTP 调用的唯一
出口。适配器主体只剩组合与消息发送策略。

## 运行时保证

### 内核生命周期

内核只允许以下单向生命周期：

```text
created → starting → running → stopping → stopped
                   ↘ failed
```

- 只能在 `created` 状态加载插件。
- 适配器启动失败时，已经加载的插件会按逆序卸载。
- 停机先停止入口流量，再等待进行中的消息，最后卸载插件。
- 超过停机期限的任务会被记录，插件取消信号随后触发。
- `start()` 和 `stop()` 都是并发幂等的。

### 插件生命周期

- 插件必须使用稳定的小写名称并声明版本。
- 插件可以在 `created` 或 `running` 状态加载。运行中加载的插件**不会**收到
  `bot.ready`：该事件表示“机器人已启动”，重放会让其他插件重跑启动逻辑；
  运行中加载或卸载后会重新同步导航，同步失败只记录日志而不影响进程。
- `BotKernel.unload(name)` 在有其他已加载插件依赖它时拒绝卸载。
- 插件清单先完成导入、API 版本、SemVer 依赖、缺失和循环校验，再拓扑加载。
- 可选依赖允许缺失；已安装但版本不兼容时仍拒绝启动。
- 被依赖插件不能先卸载。
- 插件注册的命令、事件、中间件、服务和定时器都会被自动跟踪。
- 卸载先触发 `context.signal`，再逆序释放资源。
- 插件初始化失败时，只回滚该插件已经注册的资源。
- 同名插件加载期间即占用名称，并发重复加载不会覆盖清理函数。
- 启动配置由宿主克隆并深层冻结；敏感值由清单映射环境变量注入。

### 消息处理

- 适配器将平台事件归一化为 `IncomingMessage`。
- 配置的 `ownerIds` 在任何检查之前把作者角色提升为 `owner`，因此命令、导航
  和插件看到的角色一致。
- 命令的通过、拒绝和失败都写入带 `audit: "command"` 的结构化日志，只记录
  谁、在哪、执行了哪个命令，不记录消息正文和参数。
- 内核按固定桶统计端到端处理延迟，`/metrics` 以 Prometheus 直方图导出。
- 中间件按优先级形成 onion pipeline，可检查、修改状态或短路。
- 事件处理器故障互相隔离，不阻断其他订阅者。
- 中间件或命令故障只影响当前消息，不会终止机器人进程。
- 内核记录收到、完成、失败和命令处理数量。

### 存储

- `KeyValueStore` 的 `list(prefix, { limit, after })` 是可选能力：按键升序
  返回、可分页。不实现它的存储必须被当成“无法枚举”，而不是“没有数据”，
  `supportsListing()` 用于区分这两种情况。
- SQLite 实现带 `schema_meta` 版本表和有序迁移。打开版本**高于**当前构建的
  数据库会直接拒绝：发布脚本在健康检查失败时会回滚到上一个 release，旧代码
  不能继续写它不认识的 schema。
- 没有版本行但已有 `plugin_kv` 的旧库会被识别为 v1 并补上版本号。

### 主动消息运维

`uncertain` 的 Outbox 记录必须由人裁决，所以它们必须查得到。`QqOutbox.list()`
和 `QqOfficialAdapter.listOutbox()` 按前缀枚举记录；存储不支持枚举时抛错而
不是返回空列表，避免把“看不了”误当成“没有”。进程内未能落库的记录会以
`unpersisted` 标出，并计入诊断。`scripts/outbox.mjs` 直接读写共享数据库，
机器人没运行也能查和处理。

### 插件配置与状态

插件持久化数据分为两类：

- `context.settings` 保存管理员可调整的参数。框架按默认值、全局、平台、
  聊天类型、具体会话依次深层合并，数组由更具体的一层整体替换。
- `context.state` 保存运行中产生的数据。作用域会自动编码进键名，群聊和私聊
  之间不会互相污染。

配置定义可携带兼容 Zod 的 `parse()` 校验器、版本号和迁移函数。读取旧版本时
在原子更新中完成迁移；配置写入先校验最终结果，失败不会污染已有值。
`KeyValueStore.update()` 的更新器必须是同步函数，内存实现依赖单次事件循环
操作，SQLite 实现使用 `BEGIN IMMEDIATE` 事务，因此读改写不会丢失并发更新。

### QQ 连接

- Access Token 并发刷新会自动合并。
- 鉴权失败会失效旧 Token 并安全重试一次。
- 所有 OpenAPI 调用统一经过 Client，错误保留 HTTP 状态、业务码、TraceID、
  endpoint、重试属性和有限响应摘要；403 权限错误不会刷新 Token。
- WebSocket 支持 Session Resume，失败后使用带抖动的指数退避。
- Gateway 分开记录 received/processed sequence。Dispatch 按会话分道并发：同一会话内
  严格按到达顺序处理，不同会话互不阻塞，心跳 ACK 等控制帧不会排在慢命令之后。
- 只提交“连续已完成”的水位，Resume 不会跨过仍在处理的事件；连接替换后旧事件
  继续执行但不再提交进度，重放由消息去重吸收。
- 插件处理失败的事件记录日志后视为完成，不会通过断线 Resume 反复重放（避免单条
  “毒消息”卡死整个 Gateway）；适配器停机时尚未开始的事件保持未提交，重启后重投。
- 正常重启从 SQLite 恢复 Session。
- 缺少心跳 ACK 时主动重连。
- HTTP、Gateway Ready 和优雅关闭都有超时边界。
- 消息去重表同时在内存和存储中维护：内存是快路径，存储让去重跨进程重启生效。
  Gateway 只提交“连续已完成”的水位，因此重启后 Resume 可能重投一条已处理但
  未提交的事件；没有持久化去重时它会被重复处理并重复回复。去重键带 TTL 并
  定期清理，所以表不会无界增长。持久化要求存储支持前缀枚举；不支持时退回
  进程内去重，并在启动时告警说明风险。
- 同一消息的多次回复自动递增 `msg_seq`。
- 富媒体先上传到会话文件接口取得 `file_info`，再发送 `msg_type: 7` 消息。
- 大文件可使用带摘要的异步字节流，上传时只缓冲当前分片；`file_info` 缓存按
  场景、会话和内容隔离并遵守 TTL。
- 主动消息使用 pending/sending/sent/uncertain Outbox；发送后落库失败、网络
  中断或部分成功都保留 uncertain，并禁止自动重发。
- 主动消息配额由共享状态原子管理，覆盖 Bot、单关系、每日和互动召回周期。
- 好友、进退群、消息接收开关和 Interaction 被映射为跨平台事件，未知事件进入
  `platform.event`，不会静默丢弃。
- 插件只使用统一的媒体来源模型，QQ 鉴权、Base64 转换和图文拆分由适配器处理。

## 依赖方向

```text
plugins ───────────────► plugin-sdk
adapter-* ─────────────► plugin-sdk
storage-* ─────────────► plugin-sdk
core ──────────────────► plugin-sdk
apps/bot ──────────────► core + adapters + storage + plugins
```

`plugin-sdk` 不依赖其他工作区包。平台无关插件只使用基础 SDK；明确依赖 QQ
能力的插件可额外使用 `plugin-sdk-qq` 构造平台扩展。插件之间共享能力时使用
类型化 Service Token，避免导入核心内部实现或使用全局变量。
