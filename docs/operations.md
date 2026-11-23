# 运维

本文的路径以默认部署根目录 `~/apps/qq-bot` 为例，部署方式见[部署](deployment.md)。

## 进程管理

```bash
~/apps/qq-bot/current/deploy/manage.sh status      # supervisor 与应用进程
~/apps/qq-bot/current/deploy/manage.sh health      # 业务健康检查，失败时非零退出
~/apps/qq-bot/current/deploy/manage.sh restart
~/apps/qq-bot/current/deploy/manage.sh logs 100    # app.log 最后 100 行
~/apps/qq-bot/current/deploy/manage.sh outbox list # 见下文“主动消息 Outbox”
```

还有 `start`、`stop`。`stop` 发送 SIGTERM，最多等待
`QQ_BOT_STOP_TIMEOUT_SECONDS`（默认 30）秒；应用收到信号后先停止接收新消息、
排空进行中的消息（上限 `BOT_SHUTDOWN_TIMEOUT_MS`），再卸载插件。

日志是 pino JSON，位于 `shared/logs/app.log`。

## 健康检查

### 健康快照

应用每 `BOT_HEALTH_INTERVAL_MS` 调用一次适配器业务探针（QQ：Gateway Ready 且
OpenAPI 有成功记录），并原子写入 `shared/data/health.json`：

```json
{"status":"ready","pid":1234,"updatedAt":"…","adapter":"qq-official","diagnostics":{…}}
```

`status` 为 `starting`、`ready`、`unhealthy` 或 `stopping`。`manage.sh health`
同时要求 supervisor 与应用进程存活、正在运行的 release 等于 `current`、快照为
`ready` 且在 3 个刷新周期内更新过（默认 90 秒）。发布脚本用同一检查决定是否回滚。

### HTTP 运维端点

默认关闭，设置端口后开启：

```dotenv
BOT_METRICS_PORT=9095
BOT_METRICS_HOST=127.0.0.1
```

| 端点 | 含义 |
| --- | --- |
| `/healthz` | 进程存活 |
| `/readyz` | 业务就绪：与健康快照同一判定（3 个周期内为 `ready`），失败时附原因 |
| `/metrics` | Prometheus 文本格式 |

端点**没有鉴权**，默认只绑回环；需要对外暴露请加反向代理。端口被占用时只记
错误日志，不影响机器人运行。停机时端点先于内核关闭，编排系统会先把实例摘除。

### 指标

指标名沿用 `qq_bot_` 前缀，以保持已有仪表盘可用：

| 指标 | 说明 |
| --- | --- |
| `qq_bot_up`、`qq_bot_uptime_seconds` | 进程状态 |
| `qq_bot_messages_in_flight`、`qq_bot_plugins_loaded` | 当前负载 |
| `qq_bot_messages_{received,processed,failed}_total`、`qq_bot_commands_handled_total` | 消息计数 |
| `qq_bot_message_processing_duration_seconds` | 端到端处理延迟直方图，固定桶 |
| `qq_bot_command_executions_total`、`qq_bot_command_duration_seconds` | 按命令与结果（`completed`/`failed`/`denied`/`rejected`） |
| `qq_bot_scheduled_task_runs_total`、`qq_bot_scheduled_task_duration_seconds` | 定时任务 |
| `qq_bot_adapter_*` | 适配器数值型诊断字段（限频、重试、Outbox、未识别事件等），同样写进健康快照的 `diagnostics` |
| `qq_bot_plugin_<插件名>_*` | 插件自定义指标；远程插件另有 `…_up` 与 `…_restarts_total` |

## Owner 与权限

角色从低到高为 `member`、`admin`、`owner`。群聊 `admin`/`owner` 来自平台；
`BOT_OWNER_IDS` 中列出的作者在任何检查之前被提升为 `owner`，命令、导航和插件
看到的角色一致。

`BOT_OWNER_IDS` 匹配的是消息作者的 `author.id`：QQ 单聊取自 `user_openid`、
群聊取自 `member_openid`，是不同字段，取值不一定相同。先在每种会话里各发一条
命令，再从命令审计日志（`audit: "command"`）的 `authorId` 字段取值，全部列上。

## 内置管理命令

应用除清单插件外总会加载 `access-admin`、`config-admin`；配置了
`BOT_OWNER_IDS` 时再加载 `plugin-admin`。`help` 与这三个插件不能被 `/acl`
停用，管理员不会把自己锁在外面。

### `/acl`：按会话启停与封禁

```text
/acl status                     查看当前聊天停用了什么
/acl disable <插件或命令>        在当前聊天停用（管理员）
/acl enable <插件或命令>         重新启用（管理员）
/acl block <用户ID>              封禁用户，其命令一律不响应（owner）
/acl unblock <用户ID>            解除封禁（owner）
/acl blocked                    查看封禁名单（owner）
```

规则持久化在数据库中，重启后仍然有效。owner 不受封禁影响。

### `/config`：插件会话设置

由插件的 `context.settings.define()` 自动生成，插件不需要自己写管理命令：

```text
/config list                         列出可配置的插件
/config show <插件>                  当前聊天生效的设置及每项来源层
/config set <插件> <路径> <值>        修改当前聊天（值可以是 JSON），如 /config set mc timeoutMs 5000
/config reset <插件> [路径]          重置当前聊天
/config set-global …                 修改全局设置（owner）
/config reset-global …               重置全局设置（owner）
```

写入经过插件自己的 schema 校验；名称含 `secret`、`token`、`password`、
`apiKey` 的字段显示为 `***`。

### `/plugin`：运行时插件管理（owner）

```text
/plugin list              查看插件加载状态
/plugin disable <名称>    立即停用
/plugin enable <名称>     按清单启用
/plugin reload <名称>     重新加载
```

- 变更只在当前进程生效，插件清单始终是事实来源，重启后按清单恢复。
- `reload` 总会重新读取清单（配置与密钥生效）；只有路径型插件会重新加载代码，
  npm 包型插件因 Node 模块缓存只能生效配置改动。代码热重载每进程最多
  `BOT_PLUGIN_MAX_HOT_RELOADS` 次。生产环境更新代码请走发布流程。
- 运行时加载的插件不会收到 `bot.ready`。
- 被其他已加载插件依赖的插件无法停用，会报出依赖方。
- 远程插件 `reload` 会启动新的子进程，也可用于从 `failed` 状态恢复。

### 审计日志

每条命令的执行、拒绝和失败都写入带 `audit: "command"` 的结构化日志，记录谁、
在哪、执行了哪个命令及结果，不含消息正文和参数。

## 主动消息 Outbox

QQ 主动消息经过持久化 Outbox：`pending → sending → sent`。发送结果未知
（网络中断、发送后落库失败、部分成功）的记录标为 `uncertain`，框架**一律拒绝
自动重发**，必须人工裁决：

```bash
~/apps/qq-bot/current/deploy/manage.sh outbox list --status uncertain
~/apps/qq-bot/current/deploy/manage.sh outbox show <幂等键>
```

确认用户是否真的收到后：

```bash
~/apps/qq-bot/current/deploy/manage.sh outbox resolve <幂等键> --as sent --confirm
```

- `--as sent`：标记为已送达。
- `--as discard`：删除记录，之后允许同一幂等键重发。
- 不带 `--confirm` 时只预览，不做修改。
- 流式消息记录不支持 `--as sent`（恢复流时只看流状态），工具会拒绝并说明原因。

工具直接读写共享数据库，机器人没运行也能用。其他选项：`--app-id`、`--limit`、
`--json`；本地开发可用 `pnpm outbox …`。

## 数据库

- 默认 `shared/data/bot.sqlite`，带 `schema_meta` 版本表和有序迁移；打开版本
  高于当前构建的数据库会直接拒绝。
- 每次发布前自动快照到 `shared/backups/pre-<id>.sqlite`，数量与 release 保留数一致。
  手动备份/恢复：

  ```bash
  node scripts/db-snapshot.mjs backup <数据库> <快照>
  node scripts/db-snapshot.mjs restore <快照> <数据库>
  ```

  备份基于 `VACUUM INTO`。恢复前必须先停止机器人，在运行中的进程下恢复会破坏
  它对数据库的视图。
