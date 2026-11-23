# QQ 官方适配器

`@umx-bot/adapter-qq-official` 通过 QQ 开放平台的 WebSocket Gateway 接收事件、
通过 OpenAPI（默认 `https://api.bot.qq.com`）发送消息。覆盖范围是 **QQ 单聊和
QQ 群聊**；频道、子频道、频道私信及其成员/身份组/论坛等能力不在支持范围内，
也不支持 Webhook 接入。

接入步骤和全部 `QQ_*` 变量见[配置参考](configuration.md#qq-官方适配器)。
插件侧的调用方式见[插件开发](plugin-development.md)，本文说明适配器能做什么、
有哪些平台限制。

## 事件

| QQ 事件 | 插件看到的事件 | 前提 |
| --- | --- | --- |
| `C2C_MESSAGE_CREATE` | `message.created`（`scope: "direct"`） | 默认 |
| `GROUP_AT_MESSAGE_CREATE` | `message.created`（`scope: "group"`，`botMentioned: true`） | 默认 |
| `GROUP_MESSAGE_CREATE` | `message.created`（群内全部消息） | `QQ_RECEIVE_ALL_GROUP_MESSAGES=true` 且已获权限 |
| `FRIEND_ADD`、`FRIEND_DEL` | `contact.added`、`contact.removed` | 默认 |
| `GROUP_ADD_ROBOT`、`GROUP_DEL_ROBOT` | `bot.conversation.joined`、`bot.conversation.left` | 默认 |
| `C2C_MSG_RECEIVE`/`REJECT`、`GROUP_MSG_RECEIVE`/`REJECT` | `message.delivery.enabled`、`message.delivery.disabled`（主动消息开关） | 默认 |
| `INTERACTION_CREATE` | `interaction.created`，回调按钮按插件名路由 | `QQ_ENABLE_INTERACTIONS=true` 且已获权限 |
| 其他 | `platform.event`，不会静默丢弃 | — |

完整事件信封（含外层 `event_id`）保留在 `IncomingMessage.raw` 中。引用消息映射到
`message.quote`，`@全体成员` 不算 @ 机器人。

## 发送能力

| 能力 | 单聊 | 群聊 | 说明 |
| --- | --- | --- | --- |
| 文本、Markdown | ✓ | ✓ | |
| 按钮（指令/回调/跳转，样式 0–3） | ✓ | ✓ | 自定义按钮需平台内邀权限，未开通时自动重试为纯 Markdown |
| 按钮模板 | ✓ | ✓ | `qqKeyboardTemplate()`，来自 `@umx-bot/plugin-sdk-qq` |
| 图片、视频、语音、文件 | ✓ | ✓ | 见下文“富媒体” |
| 引用回复 | ✓ | ✓ | `reference` |
| 撤回 | ✓ | ✓ | 只能撤回机器人发出的消息，受平台时限约束 |
| 输入中状态 | ✓ | — | 必须绑定触发消息或事件 |
| 流式回复 | ✓ | — | append / replace / complete / retry / abort |
| 主动消息 | ✓ | ✓ | 需幂等键，见下文 |
| 互动召回（wakeup） | ✓ | ✓ | `qqWakeupDelivery()` |

插件应先用 `context.messages.supports("recall" | "typing" | "stream")` 判断能力。

### 投递类型

- **被动回复**（`passive`）：回复某条消息或事件，命令回复默认使用。适配器自动
  携带 `msg_id`/`event_id` 并为同一消息的多次回复递增 `msg_seq`。
- **主动消息**（`active`）与**互动召回**（`platform` wakeup）：必须提供稳定的
  `idempotencyKey`。相同键重复调用直接返回已保存的回执，不会重复投递。

### 主动消息配额与 Outbox

主动消息经过共享配额账本（按 AppID，原子更新），覆盖：

- 认证类型（`QQ_CERTIFICATION`）对应的 Bot QPS/QPM；
- 单关系 20 QPM、每关系每日 1000 条；
- 依据最近一次用户互动计算的召回周期（当天、1–3 天、3–7 天、7–30 天）；
- 用户/群拒收状态（来自投递偏好事件）。

429 响应会叠加端点级自适应阻断。内容违规、权限不足、用户拒收和配额耗尽不会自动
重试。

每条主动消息在 Outbox 中经历 `pending → sending → sent`。网络中断、发送后落库失败
或部分成功会留在 `uncertain`，**框架不会自动重发**，需要人工裁决，操作见
[运维：主动消息 Outbox](operations.md#主动消息-outbox)。主动流式消息的
`stream_msg_id`、分片 index 和内容状态同样持久化，结果不确定时必须显式
`retry()` 或 `abort()`。

### 富媒体

- 先上传到会话文件接口取得 `file_info`，再以 `msg_type: 7` 发送。
- 软限制：图片 20 MiB、视频 30 MiB、语音 20 MiB、文件 200 MiB；硬限制 200 MiB。
- 较大的数据自动走预上传与分片，`AsyncIterable` 字节流只缓冲当前分片。分片上传
  所需的 QQ 专用摘要用 `qqStreamingChecksums()` 构造。
- `file_info` 按场景、会话和内容摘要缓存并遵守 TTL，不跨单聊/群聊复用。
- 图片可以附带文字；视频、语音、文件附带文字时先发文本再发媒体。

### 导航、菜单与指令面板

适配器在所有插件加载后幂等同步两处入口（`QQ_SYNC_NAVIGATION`，运行中加载或卸载
插件后也会重新同步），同步只修改带 `qq-bot-managed:<scope>` 备注的面板：

- **单聊底部菜单**：来自导航条目（`context.navigation.register()` 中 `surfaces`
  含 `menu` 的条目），点一下发送固定内容。超过平台数量或长度限制时在写入前
  失败，保留线上最后一次有效配置。
- **指令面板**（输入 `/` 弹出的列表）：来自已注册的命令，每个顶层命令一条，选中后
  填进输入框由用户补参数。子命令和用法请用 `/help <命令>` 查看。规则：
  - 不列出 `hidden`、`botOwnerOnly`、`panel: false` 的命令；命令的 `scopes`
    决定出现在单聊还是群聊面板。
  - **每个插件最多 5 条**，按优先级选：`panel: true`、有精选导航入口、有任意
    导航入口、普通命令先于管理命令，其余的只在 `/help` 里出现（日志记一条
    info）。命令很多的插件建议用 `panel` 自己挑出门面命令。
  - 面板顺序：普通命令在前，其中 `panel: true` 和精选的排前面，再按插件的
    导航顺序；要求 `admin`/`owner` 的命令排最后并标 `only_admin`。
  - 总数超过 20 条时，管理命令保留最多 5 个位置，其余从末尾丢弃并记一条告警；
    描述超过 30 个显示宽度时截断。都不会让同步失败。

单条消息最多 5 行 × 5 个按钮；内置导航为照顾手机端每行 2 个、最多 10 个，
Markdown 正文仍列出全部条目。

## 连接与可靠性

- Access Token 缓存、提前刷新、并发刷新合并；401 只安全刷新重试一次，403 不刷新。
- 所有 HTTP 调用经过统一 Client，错误带 HTTP 状态、业务码、TraceID 和 endpoint。
- Session Resume，失败后带抖动指数退避；缺少心跳 ACK 时主动重连。
- Dispatch 按会话分道并发，同一会话内保序；只提交“连续已完成”的序号。
- 处理失败的事件记录日志后视为完成，不会通过 Resume 反复重放。
- 消息去重持久化到存储，进程重启后 Resume 重投的事件不会被重复回复。
- Session 与 Identify 时的 intents 一起保存；intents 变化后自动丢弃旧 Session 重新
  Identify。

实现细节见[架构：QQ 连接](architecture.md#qq-连接)。

## 生产验证状态

自动化测试覆盖以上全部能力（含故障注入）。在真实机器人上验证过的部分：

| 能力 | 状态 |
| --- | --- |
| Gateway 连接、单聊/群聊被动文本回复 | 已验证 |
| Markdown、撤回、单聊输入中状态 | 已验证 |
| 小图片上传 | 未验证 |
| 流式回复 | 未验证 |
| Session 失效后重新 Identify | 未验证（仅单元测试） |

在依赖未验证能力上线前，建议先用下面的冒烟脚本在测试机器人上验证。

## 冒烟测试

`packages/adapter-qq-official/src/smoke.ts` 用真实凭据验证收发链路：

```bash
QQ_SMOKE_CONFIRM=send-and-recall pnpm --filter @umx-bot/adapter-qq-official smoke
```

它读取当前目录 `.env` 中的 `QQ_APP_ID`、`QQ_CLIENT_SECRET`、
`QQ_RECEIVE_ALL_GROUP_MESSAGES`，以及：

| 变量 | 说明 |
| --- | --- |
| `QQ_SMOKE_CONFIRM` | 必须为 `send-and-recall`，确认会发送并撤回真实消息 |
| `QQ_SMOKE_SCOPES` | `direct`、`group` 或两者（默认），逗号分隔 |
| `QQ_SMOKE_IMAGE_URL` | 可选，额外验证小图片上传 |

注意：

- 脚本是**交互式**的：连上 Gateway 后最多等待 5 分钟，由人分别给机器人发一条
  单聊和一条群消息，脚本回复文本与 Markdown 并撤回文本回复。
- 它用同一 AppID 重新 Identify，**必须先停掉正在运行的机器人**，否则会抢占
  Gateway 会话，并回复真实用户发来的第一条消息。请使用专用测试机器人和测试会话。
- `QQ_RECEIVE_ALL_GROUP_MESSAGES` 必须与机器人真实配置一致。开启时群里任何人的
  第一条消息都会触发测试，不需要 @。
