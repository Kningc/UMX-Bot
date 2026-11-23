# 配置参考

应用启动时读取进程环境变量；工作目录下有 `.env` 时会先用 `process.loadEnvFile()`
加载它（已存在的环境变量优先）。所有变量都经过 Zod 校验
（[`apps/bot/src/config.ts`](../apps/bot/src/config.ts)），取值非法时进程在连接
平台之前就退出并指出字段。

模板文件：

| 文件 | 用途 |
| --- | --- |
| [`.env.example`](../.env.example) | 本地开发，复制为 `.env` |
| [`deploy/server.env.example`](../deploy/server.env.example) | 生产服务器，复制为 `shared/.env` |
| [`deploy/deploy.env.example`](../deploy/deploy.env.example) | 本机发布脚本，复制为 `.deploy.env`（已被 Git 忽略） |
| [`deploy/plugins.json.example`](../deploy/plugins.json.example) | 插件清单示例 |

## 应用

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BOT_ADAPTER` | `console` | `console`：在终端输入消息，适合本地开发；`qq-official`：连接 QQ 官方机器人 |
| `BOT_COMMAND_PREFIX` | `/` | 命令前缀。帮助、导航和 `context.commands.format()` 都按它生成命令 |
| `BOT_DATABASE_PATH` | `./data/bot.sqlite` | SQLite 数据库。生产环境必须是绝对路径（发布脚本会校验），否则每个 release 会各用一份空库 |
| `BOT_PLUGIN_MANIFEST` | 未设置 | 插件清单路径。未设置时加载内置的 help、ping、minecraft-status |
| `BOT_PLUGIN_MAX_HOT_RELOADS` | `20` | 每个进程允许的代码热重载次数。Node 无法释放已导入的 ES 模块，超出后 `/plugin reload` 要求重启 |
| `BOT_OWNER_IDS` | 空 | 逗号分隔的作者 ID，匹配者按 `owner` 处理；为空时不加载 `/plugin`。取值方法见[运维](operations.md#owner-与权限) |
| `BOT_SHUTDOWN_TIMEOUT_MS` | `10000` | 停机时等待进行中消息的上限 |
| `BOT_HEALTH_FILE` | 数据库同级的 `health.json` | 健康快照路径 |
| `BOT_HEALTH_INTERVAL_MS` | `30000` | 健康快照刷新周期；超过 3 个周期未刷新即视为不健康 |
| `BOT_METRICS_PORT` | 未设置 | 设置后启动 `/healthz`、`/readyz`、`/metrics` 运维端点 |
| `BOT_METRICS_HOST` | `127.0.0.1` | 运维端点绑定地址。端点**没有鉴权** |
| `LOG_LEVEL` | `info` | `fatal`/`error`/`warn`/`info`/`debug`/`trace`，pino JSON 日志 |

## QQ 官方适配器

`BOT_ADAPTER=qq-official` 时生效。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QQ_APP_ID` | — | 必填 |
| `QQ_CLIENT_SECRET` | — | 必填 |
| `QQ_API_BASE_URL` | `https://api.bot.qq.com` | OpenAPI 地址，仅兼容环境需要覆盖 |
| `QQ_RECEIVE_ALL_GROUP_MESSAGES` | `false` | 接收群内所有消息（`GROUP_MESSAGE_CREATE`）。必须先在开放平台获得权限 |
| `QQ_ENABLE_INTERACTIONS` | `false` | 订阅 `INTERACTION` Intent，回调按钮需要它。必须先获得权限 |
| `QQ_CERTIFICATION` | `unverified` | `enterprise`/`personal`/`unverified`，决定主动消息配额与限频档位 |
| `QQ_INTENTS` | 自动组合 | 数值型 Intent 覆盖。仅在确知已获对应权限时使用 |
| `QQ_SYNC_NAVIGATION` | `true` | 启动及插件变更时同步单聊菜单与指令面板；`false` 可紧急关闭 |
| `QQ_REQUEST_TIMEOUT_MS` | `10000` | 单次 HTTP 请求超时 |
| `QQ_GATEWAY_READY_TIMEOUT_MS` | `15000` | 等待 Gateway Ready 的上限 |
| `QQ_RECONNECT_DELAY_MS` | `2000` | 重连退避初始值 |
| `QQ_RECONNECT_MAX_DELAY_MS` | `60000` | 重连退避上限 |

> 修改 `QQ_RECEIVE_ALL_GROUP_MESSAGES`、`QQ_ENABLE_INTERACTIONS` 或 `QQ_INTENTS`
> 后，下次启动会丢弃已保存的 Gateway Session 并重新 Identify（QQ 在整个 Session
> 内沿用最初的 intents），日志里有一条 warn，属预期行为。

### 连接 QQ 官方机器人

1. 在 [QQ 开放平台](https://q.qq.com/)创建机器人，取得 AppID 和 ClientSecret。
2. 设置：

   ```dotenv
   BOT_ADAPTER=qq-official
   QQ_APP_ID=你的AppID
   QQ_CLIENT_SECRET=你的ClientSecret
   ```

3. 默认只处理 `C2C_MESSAGE_CREATE`（单聊）和 `GROUP_AT_MESSAGE_CREATE`（群内 @
   机器人）。全量群消息、互动事件按上表在获得权限后再开启。
4. 正式环境需要在开放平台配置固定公网 IP 白名单。

上线前的真实凭据冒烟（文本、Markdown、撤回、可选图片）见
[QQ 官方能力报告](qq-official-gap-analysis.md#11-闭环清单)中的说明。

## 插件清单

清单是部署边界：只有清单里列出的插件才会执行。格式：

```json
{
  "schemaVersion": 1,
  "plugins": [
    { "specifier": "@umx-bot/plugin-help" },
    {
      "specifier": "@example/umx-bot-weather",
      "config": { "endpoint": "https://weather.example.com" },
      "secrets": { "auth.token": "WEATHER_API_TOKEN" },
      "permissions": ["scheduler"]
    },
    { "specifier": "./local/plugin.js", "enabled": false },
    { "specifier": "remote:echo", "remote": { "command": "node", "args": ["echo/plugin.mjs"] } }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `specifier` | npm 包名（从 `@umx-bot/app` 的依赖解析）或相对清单目录的路径；远程插件只是标识，约定 `remote:<名称>` |
| `enabled` | `false` 时跳过该条目，无需卸载包 |
| `config` | 非敏感启动配置，插件通过深层只读的 `context.config` 读取 |
| `secrets` | 配置路径 → 环境变量名。变量缺失时应用在连接平台前拒绝启动 |
| `permissions` | 授权且是上限：插件声明了清单未授予的权限会拒绝加载。省略时按插件自己的声明 |
| `remote` | 以子进程运行插件，见[进程外插件](remote-plugins.md#manifest-entry) |

旧的 `@qq-bot/*` 包名仍会被自动映射为 `@umx-bot/*` 并打印警告，请尽快改掉。
插件编写、配置校验和权限细节见[插件开发](plugin-development.md)。

## 部署脚本

本机 `.deploy.env`（`pnpm deploy:production` 与 `pnpm deploy:menu` 读取）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QQ_BOT_DEPLOY_HOST` | — | 必填，SSH 目标，如 `deploy@example.com` |
| `QQ_BOT_DEPLOY_IDENTITY` | 未设置 | SSH 私钥路径 |
| `QQ_BOT_ROOT` | 远端 `~/apps/qq-bot` | 服务器上的应用根目录 |
| `QQ_BOT_KEEP_RELEASES` | `8` | 保留的 release 与数据库快照数量，必须大于 1 |
| `QQ_BOT_DEPLOY_CONFIG` | `./.deploy.env` | 换一个配置文件 |

服务器端发布脚本（`deploy/remote-release.sh`）从 SSH 会话环境读取：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QQ_BOT_HEALTH_ATTEMPTS` | `20` | 发布后健康检查次数 |
| `QQ_BOT_HEALTH_INTERVAL_SECONDS` | `3` | 健康检查间隔 |

supervisor（`deploy/supervise.sh`）的调参可以直接写进 `shared/.env`，
`manage.sh` 启动它之前会加载该文件：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QQ_BOT_RESTART_DELAY_SECONDS` | `5` | supervisor 重启退避初始值 |
| `QQ_BOT_RESTART_MAX_DELAY_SECONDS` | `300` | 重启退避上限 |
| `QQ_BOT_STABLE_SECONDS` | `60` | 运行超过此时长视为稳定，退避归零 |
| `QQ_BOT_LOG_MAX_BYTES` | `52428800` | `app.log` 轮转阈值（copytruncate） |
| `QQ_BOT_LOG_KEEP` | `5` | 保留的轮转日志数 |
| `QQ_BOT_LOG_CHECK_SECONDS` | `60` | 轮转检查间隔 |

部署路径和 `QQ_BOT_*` 变量名沿用了项目改名前的 `qq-bot`，以兼容已有服务器。
