# QQ 官方 API 能力缺口与闭环报告

评估日期：2026-07-29
闭环日期：2026-07-29

> 本文第 4 节保留最初缺口基线，便于审计开发动机；当前状态以本节和
> “闭环清单”为准，不应再把基线中的“未实现”理解为现状。

## 1. 范围与结论

本报告只评估 QQ 单聊和 QQ 群聊，明确排除：

- 频道、子频道和频道私信。
- 频道成员、身份组、公告、日程、精华消息。
- 论坛、频道音频和频道表情表态。

二次可靠性审计发现了 Gateway 并发水位倒退、Outbox 发送后落库失败删除记录、
配额治理不完整、流式主动消息未持久化、健康检查仅检查进程以及大文件先完整驻留
内存等问题。当前代码已针对这些问题补齐实现和故障注入测试：统一 OpenAPI Client、
结构化错误、消息回执、完整事件信封、可靠 Gateway 进度、关系事件、显式投递
策略、状态化 Outbox、共享配额账本、可恢复流式回复、完整 Keyboard、流式分片
上传、业务健康快照和 TTL 缓存均已落地。生产凭据验证仍是发布门禁，而不是普通
单元测试的一部分。

不再用单一百分比表达成熟度，代码可靠性与真实生产能力分开验收：

| 范围 | 代码/自动化状态 | 生产状态 |
| --- | --- | --- |
| 自用群机器人 | 已覆盖 | Gateway Ready，待显式消息冒烟 |
| 单聊/群聊基础消息 | 已覆盖 | 待单聊/群聊发送与撤回冒烟 |
| 单聊/群聊官方能力整体封装 | 条件完成 | 未执行 Markdown、上传、流式和撤回全链路前不标记完成 |

这里的目标不是把每个 QQ 字段直接泄露给插件，而是提供稳定的跨平台能力，并在
必要时保留类型化的 QQ 扩展。

### 1.1 闭环清单

| 范围 | 状态 | 证据 |
| --- | --- | --- |
| OpenAPI 基座 | 已完成 | `openapi/client.ts`、`error.ts`、`rate-limiter.ts`；Adapter 除 Token 获取外无直接 `fetch` |
| 鉴权与错误 | 已完成 | 401 仅安全刷新一次，403 不刷新；HTTP 与 HTTP 200 业务错误均结构化 |
| 发送回执与撤回 | 已完成 | `SentMessage` 贯穿 SDK、Kernel、Console 和 QQ；单聊/群聊撤回已路由 |
| 投递类型 | 已完成 | passive message/event、active、wakeup 为联合类型；active/wakeup 强制幂等键 |
| Gateway 可靠进度 | 已完成 | Dispatch 串行队列；只提交连续成功水位；失败断线 Resume；乱序延迟测试覆盖 42/43 |
| GROUP_AND_C2C 事件 | 已完成 | 关系、进退群、接收开关、Interaction 映射；未知事件进入 `platform.event` |
| 主动消息治理 | 已完成 | pending/sending/sent/uncertain Outbox；Bot/关系/每日共享配额；四周期召回账本；429 自适应 |
| 高级消息 | 已完成 | 流式 append/replace/complete/retry/abort；主动流状态和连续 index 持久化 |
| 富媒体 | 已完成 | 200 MiB 限制；`AsyncIterable` 分片源只缓冲当前 part；顺序确认、合并与 TTL 缓存 |
| 可观测性 | 已完成 | 业务健康快照要求 Gateway Ready、OpenAPI 成功记录和新鲜时间戳；失败触发发布回滚 |
| 生产冒烟 | 已提供、待凭据执行 | `pnpm --filter @qq-bot/adapter-qq-official smoke`；需显式确认并由测试者触发单聊/群聊 |

生产冒烟没有在本次本地开发中伪造“通过”。它必须使用真实开发机器人、固定
测试会话和显式 `QQ_SMOKE_CONFIRM=send-and-recall`，验证结果属于部署记录。

## 2. 官方能力基线

本报告以以下官方文档为基线：

- [API 调用指南](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)
- [事件订阅与通知](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)
- [消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)
- [发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)
- [流式发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)
- [发送群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
- [富媒体消息概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)
- [撤回单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages_message_id.delete.html)
- [撤回群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages_message_id.delete.html)

官方当前统一请求地址是 `https://api.bot.qq.com`。事件可通过 WebSocket 或
Webhook 接收；本项目继续以 WebSocket 为主，不把 Webhook 列为近期目标。

## 3. 当前已覆盖能力

### 3.1 鉴权和连接

- Access Token 缓存、提前刷新和并发刷新合并。
- 动态获取 Gateway 地址。
- Identify、Heartbeat、Heartbeat ACK、Resume。
- Gateway Ready 超时和 HTTP 请求超时。
- 带抖动的指数退避重连。
- 收到服务端 Reconnect 和 Invalid Session 后重新建连。

### 3.2 消息接收

- `C2C_MESSAGE_CREATE`。
- `GROUP_AT_MESSAGE_CREATE`。
- 配置开启后的 `GROUP_MESSAGE_CREATE`。
- `msg_id + msg_seq` 去重。
- 文本、附件、提及和基础成员角色归一化。
- 完整事件信封保留到 `IncomingMessage.raw`，包括外层 `event_id`。
- 好友、机器人进退群、消息接收开关、Interaction 和未知事件兜底。
- 业务处理成功后才提交 processed sequence，Session/Sequence 持久化。

### 3.3 消息发送

- 单聊、群聊文本。
- 原生 Markdown。
- 自定义或模板 Keyboard，支持跳转、回调、指令和 0–3 样式；按钮不可用时降级。
- 图片、视频、语音和文件整文件/分片上传，按 TTL 安全缓存 `file_info`。
- 被动消息/事件回复、主动消息、互动召回和引用回复。
- 输入中状态、单聊流式 append/replace/complete。
- 消息回执与单聊/群聊撤回。
- 被动回复 `msg_id` 和自动递增 `msg_seq`；主动消息使用持久化 Outbox。
- 同一条富媒体回复的拆分发送。

### 3.4 框架基础

- 插件生命周期和资源自动清理。
- 权限、冷却、命令解析、统一帮助目录。
- 分层配置、会话状态和 SQLite 持久化。
- QQ Session、投递偏好和主动消息 Outbox 持久化。
- Adapter 诊断指标进入 Kernel health。
- 生产 release、健康检查和自动回滚。

## 4. 缺口矩阵（初始基线，现已闭环）

以下“当前影响/当前状态”记录的是开发开始前的状态。对应实现状态见 1.1。

### P0：先修正底层契约

| 缺口 | 当前影响 | 开发建议 | 验收标准 |
| --- | --- | --- | --- |
| 默认 API 域名仍为 `api.sgroup.qq.com` | 与当前官方统一地址不一致 | 默认切换到 `api.bot.qq.com`，保留环境变量覆盖；生产先做兼容验证 | 单元测试断言新默认值；生产 Gateway 和发消息验证通过 |
| HTTP 调用散落在 Adapter | 新增接口会复制鉴权、超时和错误处理 | 在 QQ Adapter 包内建立 `QqOpenApiClient`，所有 HTTP 接口只能通过 Client 调用 | Adapter 内除 Token 获取外不再直接调用 `fetch` |
| 错误只有拼接字符串 | 无法按 `err_code` 决策，也丢失 TraceID | 增加 `QqApiError`：`httpStatus`、`errCode`、`traceId`、`endpoint`、`retryable`、原始响应摘要 | 401、403、429、5xx 和业务错误都有结构化测试 |
| 403 一律刷新 Token 重试 | 权限不足、接口封禁等 403 重试无意义 | 只对明确鉴权失效错误刷新 Token；权限类错误直接返回 | 权限错误只请求一次，Token 失效最多安全重试一次 |
| 发送接口返回 `void` | 无法撤回、审计或关联后续操作 | `MessageSender.send/reply` 返回 `SentMessage`，包含平台消息 ID、时间和原始扩展 | 文本、Markdown、富媒体发送都返回可用回执 |
| Gateway Payload 没有外层 `id` | 无法使用 `event_id` 回复互动和关系事件 | 完整建模事件信封，保留 `id/op/s/t/d` | 事件映射后仍能取得原始 `event_id` |
| Sequence 在业务处理前推进 | 处理失败时 Resume 可能跨过未完成事件 | 区分 `receivedSequence` 与 `processedSequence`，业务处理成功后再提交进度 | 故障注入测试证明失败事件不会被确认 |
| Sequence 并发完成时倒退 | 后完成的低序号覆盖高序号，重启后重复或跳过事件 | Dispatch 串行 Promise 队列；失败立即断开并从最后连续水位 Resume | 42 阻塞、43 后到时持久化顺序只能是 `[42, 43]` |
| Outbox 发送成功后落库失败 | 删除记录后相同幂等键重试会重复发送 | `pending → sending → sent/uncertain`；发送后存储失败和部分成功保留 `uncertain` | 注入回执后 SQLite 失败，记录仍可查询且拒绝盲目重发 |
| Session/Sequence 只在内存 | 进程重启无法 Resume | 通过专用轻量状态存储持久化 `session_id + processedSequence`，Invalid Session 时清除 | 正常重启可尝试 Resume；无效会话自动回到 Identify |

### P1：补齐单聊/群聊消息能力

| 能力 | 当前状态 | 建议接口 | 验收标准 |
| --- | --- | --- | --- |
| `event_id` 回复 | 未实现 | `replyToEvent(event, content)` 或统一 `ReplyTarget` | `FRIEND_ADD`、`C2C_MSG_RECEIVE`、Interaction 可回复 |
| 引用回复 `message_reference` | 未实现 | `referenceMessageId` | 单聊和群聊均生成正确请求体 |
| 主动消息 | 发送路径可以不带 `msg_id`，但没有策略模型 | 显式 `delivery: "active"`，内置配额/拒收状态检查 | 不会把主动消息误标为被动回复 |
| 互动召回 `is_wakeup` | 未实现 | `delivery: "wakeup"` | 与 `msg_id/event_id` 互斥校验，记录周期配额错误 |
| 输入中状态 `msg_type=6` | 未实现 | `setTyping(conversation, seconds)` | 只允许单聊，最长 60 秒 |
| 单聊流式消息 | 未实现 | `openMessageStream()`，内部管理 `stream_msg_id/index/input_state` | append、replace、完成和中途失败都有测试 |
| 撤回机器人消息 | 未实现 | `recall(sentMessage)` | 单聊/群聊路由正确；超过官方时间限制返回类型化错误 |
| 发送结果 | HTTP 响应被丢弃 | 统一解析 `id/timestamp/ext_info` | 插件可以持久化消息 ID 并后续撤回 |
| Keyboard 完整行为 | 只支持指令按钮，样式仅 0/1 | 支持跳转、回调、指令三类动作和 0–3 样式；能力受权限控制 | 序列化覆盖所有非频道字段，长度限制与官方一致 |
| Keyboard 模板 ID | 未实现 | `keyboard: { templateId }` 与自定义布局联合类型 | 模板和自定义布局在类型层互斥 |
| 富媒体分片上传 | 未实现 | 大文件自动走分片，小文件继续整文件上传 | 中断续传、分片顺序、大小限制和失败清理有测试 |
| `file_info` TTL | 未建模 | 上传结果包含 TTL，缓存键包含会话和媒体摘要 | 不跨单聊/群聊复用，不使用过期 `file_info` |

主动消息和互动召回必须显式建模，不能通过“省略 `replyTo`”隐式触发。官方对
用户拒收、群管理员关闭通知、调用频率和每日额度都有独立约束。

### P1：补齐 GROUP_AND_C2C 事件

当前已经订阅 `GROUP_AND_C2C_EVENT`，但除消息以外的事件会被静默忽略：

- `FRIEND_ADD`、`FRIEND_DEL`。
- `C2C_MSG_RECEIVE`、`C2C_MSG_REJECT`。
- `GROUP_ADD_ROBOT`、`GROUP_DEL_ROBOT`。
- `GROUP_MSG_RECEIVE`、`GROUP_MSG_REJECT`。

建议映射为平台无关事件：

```ts
interface BotEvents {
  "contact.added": ContactEvent;
  "contact.removed": ContactEvent;
  "bot.conversation.joined": BotConversationEvent;
  "bot.conversation.left": BotConversationEvent;
  "message.delivery.enabled": DeliveryPreferenceEvent;
  "message.delivery.disabled": DeliveryPreferenceEvent;
  "interaction.created": InteractionEvent;
}
```

同时提供一个受控的 `platform.event` 兜底事件，携带平台名、事件类型、事件 ID
和只读原始数据。这样新增 QQ 事件不会被静默丢弃，同时业务插件优先依赖稳定的
平台无关事件。

`INTERACTION_CREATE` 属于单独的 `INTERACTION` Intent，应通过显式配置开启。
Intents 不能由 Adapter 写死；配置应基于实际已获权限组装，避免申请不到的
Intent 导致 Gateway 鉴权失败。

### P1：限频与安全重试

官方同时存在 HTTP 状态码、业务 `err_code`、Bot 维度限频、单关系限频和每日
额度。建议：

1. 按 endpoint、AppID、会话和主动/被动消息分别建立限频桶。
2. 解析 `429`、`Retry-After` 和限频业务码。
3. GET 和明确幂等操作可指数退避重试。
4. 发送消息遇到网络中断时结果可能不确定，不得盲目重发。
5. 被动回复依靠 `msg_id + msg_seq` 去重；主动消息需使用 Outbox 状态避免重复。
6. 对内容违规、权限不足、用户拒收和配额耗尽禁止自动重试。

实现使用按 AppID 聚合、由 `KeyValueStore.update()` 原子更新的共享账本。它覆盖
认证类型对应的 Bot QPS/QPM、单关系 20 QPM、每关系每日 1000 条，以及依据最近
一次用户互动计算的当天、1–3 天、3–7 天和 7–30 天召回周期。429 响应仍会叠加
端点级自适应阻断。

### P2：可观测性和运行治理

- 每个 HTTP 请求记录 endpoint、耗时、HTTP 状态、`err_code`、TraceID；
  日志不得包含 Token、Secret、消息全文或 Base64 文件。
- 指标至少包含请求成功率、限频、鉴权刷新、重试、Gateway 重连、Resume 成功率、
  事件积压和消息处理延迟。
- 对“用户拒收”“群通知关闭”“主动消息额度耗尽”建立可查询状态，避免持续失败。
- 未识别事件必须计数并限速告警，不能静默忽略。
- 增加 QQ 沙箱或开发机器人冒烟测试，但不让真实凭据进入普通单元测试。

### P2：规模化连接

当前固定使用 `shard: [0, 1]`。在单实例和当前规模下合理，不应过早复杂化。
当官方 Gateway 返回的推荐分片数大于 1，或事件处理延迟达到阈值后，再增加：

- 获取带分片 WSS 接入点。
- 多 Shard 生命周期管理。
- 每个 Shard 独立 Session/Sequence。
- 跨 Shard 去重和健康状态。

Webhook 暂不列入近期路线；只有在部署环境无法维持 WebSocket，或需要双接入
容灾时再实现签名验证和回调 ACK。

## 5. 推荐目标架构

不建议立即拆出很多 npm 包。先在 `adapter-qq-official` 内形成清晰模块：

```text
packages/adapter-qq-official/src/
├── openapi/
│   ├── client.ts
│   ├── error.ts
│   ├── rate-limiter.ts
│   ├── messages.ts
│   └── media.ts
├── gateway/
│   ├── client.ts
│   ├── session-store.ts
│   ├── intents.ts
│   └── events.ts
├── mapping/
│   ├── incoming-message.ts
│   └── lifecycle-events.ts
├── token-manager.ts
└── index.ts
```

只有当 OpenAPI Client 被独立工具或第二个 Adapter 消费时，再提取为单独包。

插件 SDK 建议增加三个稳定概念：

```ts
interface SentMessage {
  platform: string;
  scope: ChatScope;
  conversationId: string;
  id: string;
  timestamp: Date;
  raw?: unknown;
}

type ReplyTarget =
  | { type: "message"; messageId: string }
  | { type: "event"; eventId: string };

interface MessagingCapabilities {
  send(message: OutgoingMessage): Promise<SentMessage>;
  recall(message: SentMessage): Promise<void>;
  supports(capability: MessagingCapability): boolean;
}
```

流式消息、输入状态和主动召回属于可选能力。插件应通过 `supports()` 或类型化
Capability Service 检查，Console Adapter 可以明确报告不支持，而不是假装成功。

QQ 特有错误和原始字段不应污染通用消息模型；它们可以保存在 `raw` 中，或通过
QQ 专用的类型化诊断接口暴露。

## 6. 已执行的开发顺序

### 里程碑 A：OpenAPI 基座

- 新默认域名和配置迁移。
- `QqOpenApiClient`、`QqApiError`、TraceID。
- 正确区分鉴权、权限、限频、违规和暂时性错误。
- HTTP 契约测试。

完成定义：现有消息和文件上传全部迁移到 Client，行为无回归。

### 里程碑 B：消息回执与可靠事件进度

- `SentMessage`。
- 完整 Gateway Event Envelope。
- `receivedSequence/processedSequence`。
- Session 状态持久化。
- 故障注入和重启 Resume 测试。

完成定义：消息处理失败不会被错误确认，正常进程重启可恢复会话。

### 里程碑 C：完整 GROUP_AND_C2C 事件

- 好友、机器人进退群、主动消息开关事件。
- 平台无关事件映射。
- `platform.event` 兜底。
- Intents 配置和权限失败诊断。

完成定义：已订阅事件没有静默丢弃；未知事件有指标和原始载荷。

### 里程碑 D：消息操作

- `event_id` 回复、引用回复。
- 主动消息、互动召回、输入状态。
- 单聊/群聊撤回。
- 限频和 Outbox。

完成定义：主动与被动消息在类型层可区分，所有官方额度错误可诊断。

### 里程碑 E：高级消息

- 单聊流式消息。
- Keyboard 完整动作。
- 分片上传和 `file_info` TTL。
- 生产指标与开发机器人冒烟测试。

完成定义：流式消息中断可结束或恢复，大文件上传不会一次性占用完整内存。

## 7. 测试建议

### 单元与契约测试

- 官方事件 JSON 固件到 SDK 事件的映射。
- 每个 OpenAPI endpoint 的请求方法、路径、请求体和响应解析。
- `err_code + HTTP status + trace_id` 错误矩阵。
- 401 Token 刷新、403 权限拒绝、429 限频、5xx 和网络中断。
- `msg_seq`、流式 `index`、分片编号和 Session Sequence。

### 故障注入

- 业务事件处理到一半抛错。
- HTTP 已发送但响应连接中断。
- Heartbeat ACK 丢失。
- Resume 被拒绝。
- SQLite 暂时不可写。
- QQ 已返回消息 ID 后 SQLite 写入失败。
- 两个连续 Dispatch 以相反顺序完成。
- 主动流中间分片结果不确定并跨进程恢复。
- 应用在事件处理前后分别退出。

### 生产冒烟

- Gateway Ready。
- 单聊和群聊各一次被动回复。
- Markdown 权限降级。
- 小图片上传。
- 获取回执后撤回测试消息。

生产冒烟必须使用专用会话，并在执行前检查主动消息和内容权限。

## 8. 不建议的做法

- 不要把 Adapter 继续扩成一个包含连接、HTTP、映射和业务策略的单文件。
- 不要对所有 401/403/429/5xx 使用同一种重试策略。
- 不要在不知道发送结果的情况下自动重复主动消息。
- 不要把 QQ 原始事件直接变成插件唯一可用的 API。
- 不要为了“完整”提前实现频道和多 Shard，先完成单聊/群聊正确性。
- 不要用轮询代替官方关系事件和消息开关事件。

## 9. 总体验收标准

本报告 P0、P1 完成后，代码和自动化测试已满足：

1. 单聊/群聊所有已订阅事件都有明确处理或受控兜底。
2. 所有 QQ HTTP 调用经过统一 Client，并保留 TraceID。
3. 插件可取得发送回执并撤回机器人消息。
4. 主动、被动、事件回复和互动召回在类型层互斥。
5. Bot/关系/每日/召回周期配额、拒收、权限不足和内容违规不会被错误重试。
6. Gateway 只提交连续成功水位，进程重启不会跨过未完成事件。
7. 主动消息和流式分片的未知结果保留 `uncertain`，必须显式恢复或终止。
8. 频道能力仍保持明确的“不支持”，不影响单聊/群聊接口稳定性。
9. 生产健康检查必须同时通过进程、release、Gateway、OpenAPI 和快照时效门禁。
10. 异步媒体源上传期间只缓冲当前分片，而不是完整文件。
