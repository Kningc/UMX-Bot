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
      │
      ▼
 BotKernel（状态机、流量接纳、优雅停机）
      │
      ▼
 MiddlewarePipeline
      │
      ├── EventBus
      └── CommandRouter
              │
              ▼
         PluginRuntime
         ├── Scheduler
         ├── ServiceContainer
         ├── ScopedSettings / ScopedState
         └── KeyValueStore
```

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
- 中间件按优先级形成 onion pipeline，可检查、修改状态或短路。
- 事件处理器故障互相隔离，不阻断其他订阅者。
- 中间件或命令故障只影响当前消息，不会终止机器人进程。
- 内核记录收到、完成、失败和命令处理数量。

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
- Gateway 分开记录 received/processed sequence，Dispatch 串行处理并只提交连续成功
  水位；处理失败会断开并从旧水位 Resume，正常重启从 SQLite 恢复 Session。
- 缺少心跳 ACK 时主动重连。
- HTTP、Gateway Ready 和优雅关闭都有超时边界。
- 相同消息事件只在处理成功后进入去重表，同一消息的多次回复自动递增 `msg_seq`。
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
