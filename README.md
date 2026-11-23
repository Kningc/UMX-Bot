# QQ Bot

一个给自有 QQ 群使用的自托管、插件化机器人框架。核心只负责任务编排，
实际功能由插件提供。

当前框架版本：`0.5.0`。

## 当前能力

- 与平台无关的统一消息模型
- QQ 官方 WebSocket 事件接入和文本回复
- 本地 Console 适配器，无 QQ 凭据也能开发插件
- 显式内核状态机、启动失败回滚、消息排空和优雅停机
- 插件依赖校验、取消信号、资源自动清理和类型化服务共享
- 显式插件清单、npm 包/本地路径动态导入、SemVer 依赖排序和禁用开关
- 深层只读启动配置、环境变量密钥映射和可信进程内执行模型
- 可排序消息中间件与类型安全的优先级/一次性事件订阅
- 带引号与转义的命令解析、别名、冷却和 member/admin/owner 权限
- 分层会话配置、群聊/私聊隔离状态和 SQLite 原子持久化
- 统一富媒体回复模型，支持图片、视频、语音、文件及图文混合
- 插件化导航注册、单独 `@机器人` 唤起导航和 QQ 可点击指令按钮
- 插件声明式注册 QQ 单聊菜单与单聊/群聊指令面板，启动时统一幂等同步
- 框架归一化的插件/命令帮助目录，自动适配自定义命令前缀
- QQ Markdown 导航；无自定义按钮权限时自动降级为可复制的文字命令
- 机器人级 owner 名单、命令审计日志和运行时插件启停/重载
- 防重入定时任务、插件级日志和底层存储命名空间
- 带 TTL 和自动清理的持久化消息去重，进程重启后 Resume 不会重复回复
- KeyValueStore 前缀枚举与存储 schema 版本门禁
- 可选的 `/healthz`、`/readyz` 和 Prometheus `/metrics` 运维端点
- QQ 断线恢复、指数退避、心跳检测、请求超时和凭据自动刷新
- 运行健康快照与消息处理指标
- `help`、`ping` 示例插件，以及 Minecraft Java/Bedrock 服务器状态插件
- Biome 统一 lint/格式化、带阈值的覆盖率、GitHub Actions CI 和 Changesets 发布
- 子命令、类型化参数、按聊天适用范围，以及 `/acl`（按会话启停插件、封禁用户）和自动生成的 `/config`
- 出站钩子、回调按钮路由、插件间事件、cron/一次性定时任务、KV TTL 与集合
- 插件权限声明、`requires` 与宿主上下文扩展，插件级 Prometheus 指标
- 可发布的跨平台 SDK、QQ 扩展 SDK、插件测试宿主、适配器一致性测试套件和脚手架

## 快速开始

要求 Node.js 22.13 或更高版本（内置 `node:sqlite` 从该版本起无需实验开关）。

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm dev
```

Console 模式下直接在终端输入：

```text
/help
/ping
/mc set play.example.com java
/mc
```

在 QQ 群中单独 `@机器人` 会显示主导航。点击“在线状态”“服务器状态”等
指令按钮会自动发送对应命令；点击插件名称会进入该插件注册的二级导航页。
也可以随时使用 `/help` 或 `/help <插件名|命令名>` 打开统一的命令帮助。
AI 群助手插件已迁移到独立仓库
[UMX-Qbot-Agent](https://github.com/Kningc/UMX-Qbot-Agent)，单独开发和发布；
它的部署脚本会把插件清单中的 AI 条目指向独立发布目录。

### Minecraft 服务器状态

管理员或群主可以为每个群聊/私聊分别保存一个默认服务器：

```text
/mc set play.example.com java
/mc set play.example.com:19132 bedrock
```

之后发送 `/mc` 即可查看服务器图标、在线状态、版本、服务端、游戏模式、
地图、MOTD、人数、服务器公开的玩家样本，以及可用时的插件或模组信息。
`/mc <地址> [java|bedrock]` 可以临时查询而不修改配置；`/mc config` 查看配置，
`/mc reset` 清除配置。Java 版为默认类型。管理员已保存的 Java 服务器优先通过
Minecraft Server List Ping 协议直连查询，并缓存 1 分钟；支持标准 SRV 记录，
直连失败时自动回退公共状态服务。临时地址与 Bedrock 查询仍使用公共服务。

## 连接 QQ 官方机器人

1. 在 [QQ 开放平台](https://q.qq.com/)创建机器人，获得 AppID 和
   ClientSecret。
2. 复制 `.env.example` 为 `.env`。
3. 设置以下配置：

```dotenv
BOT_ADAPTER=qq-official
QQ_APP_ID=你的AppID
QQ_CLIENT_SECRET=你的ClientSecret
```

使用自定义插件清单时设置：

```dotenv
BOT_PLUGIN_MANIFEST=/absolute/path/plugins.json
```

默认处理 `C2C_MESSAGE_CREATE` 和 `GROUP_AT_MESSAGE_CREATE`。只有在开放平台
已经开启“接收所有消息”权限后，才应设置：

```dotenv
QQ_RECEIVE_ALL_GROUP_MESSAGES=true
```

互动事件需要对应权限并显式开启：

```dotenv
QQ_ENABLE_INTERACTIONS=true
```

OpenAPI 默认使用 `https://api.bot.qq.com`，兼容环境可通过
`QQ_API_BASE_URL` 覆盖。只有确实知道机器人已获 Intent 权限时才使用数值型
`QQ_INTENTS` 覆盖自动组合。

正式环境还需要按照 QQ 开放平台要求配置固定公网 IP 白名单。

## 工作区

```text
apps/bot                       可执行程序和环境配置
packages/core                  事件、命令、插件运行时
packages/plugin-sdk            插件与适配器的公共契约
packages/plugin-sdk-qq         QQ 专属的可选插件扩展
packages/plugin-testkit        内存插件集成测试宿主
packages/adapter-console       本地交互适配器
packages/adapter-qq-official   QQ 官方 API 适配器
    openapi/                   统一 HTTP Client、结构化错误、限频
    gateway/                   WebSocket 连接、Identify/Resume、心跳、分片进度
    mapping/                   QQ 事件 → 跨平台消息与生命周期事件
packages/storage-sqlite        SQLite 持久化实现
plugins/help                   帮助插件
plugins/minecraft-status       Minecraft 服务器状态与会话配置插件
plugins/ping                   在线状态插件
examples/plugin-starter        可复制、可测试的插件起步模板
scripts/create-plugin.mjs      从模板生成新插件
scripts/outbox.mjs             主动消息 Outbox 运维工具
```

## 常用命令

```bash
pnpm dev        # 构建后启动开发模式
pnpm build      # 构建全部工作区包
pnpm check      # lint、构建、严格类型检查、带阈值的覆盖率、发布 tarball 验证
pnpm lint       # Biome 检查（格式 + 规则）
pnpm lint:fix   # 自动修复可修复项
pnpm typecheck  # 严格类型检查
pnpm test       # 构建并运行测试
pnpm test:coverage          # 覆盖率（阈值不达标即失败）
pnpm verify:plugin-packages # 在空白临时项目安装并运行发布包
pnpm create:plugin <名称>   # 从 starter 生成一个新插件
pnpm outbox list            # 查看主动消息 Outbox，排查 uncertain 记录
pnpm start      # 运行已构建产物
```

CI（`.github/workflows/ci.yml`）在 Node 22.13 和 24 上跑同一套门禁，并单独
验证四个公共包的发布 tarball。公共包版本由 Changesets 管理：改动 SDK/core
时用 `pnpm changeset` 记录，合并后由 Release workflow 开版本 PR 并发布。Release
workflow 在发布前会重新跑类型检查和测试，每发布成功一个包就立即打上
`<包名>@<版本>` tag。

### npm 发布（Trusted Publishing）

公共包发布在 npm 的 `@umx-bot` scope 下，CI 通过 npm Trusted Publishing（OIDC）
发布，仓库里不保存任何 npm token，provenance 自动附带。
`scripts/publish-packages.mjs` 用 `pnpm pack` 打包（替换 `workspace:` 依赖），
再用 npm CLI 上传尚未发布的版本。

npm 只能给已存在的包配置 Trusted Publisher，因此首次启用步骤为：

1. 在 npm 上创建 `umx-bot` 组织。
2. 本地 `npm login` 后执行 `pnpm -r --if-present build && node scripts/publish-packages.mjs`，
   手动发布四个包的当前版本（需要 npm 11.5.1+）。
3. 在每个包的 Settings → Trusted Publisher 里选择 GitHub Actions，
   仓库 `Kningc/UMX-Bot`，工作流 `release.yml`；随后可把包设为禁止 token 发布。
4. 在 GitHub 仓库 Settings → Secrets and variables → Actions → Variables
   新建 `NPM_PUBLISH_ENABLED=true`。未设置时 Release workflow 只开版本 PR，不发布。

旧 `@qq-bot/*` 插件说明符仍可在 `plugins.json` 中使用（会自动映射并打印警告），
但请尽快改为 `@umx-bot/*`。

核心架构与运行时保证参见 [docs/architecture.md](docs/architecture.md)。
QQ 单聊/群聊官方能力覆盖、缺口优先级和开发路线参见
[docs/qq-official-gap-analysis.md](docs/qq-official-gap-analysis.md)。

## 运维

机器人自身的健康快照写在 `shared/data/health.json`，每 `BOT_HEALTH_INTERVAL_MS`
刷新一次，由 `deploy/manage.sh health` 读取；快照超过 3 个刷新周期未更新即视为不健康
（默认 90 秒），与 `/readyz` 的判定一致。需要时间序列时可以打开 HTTP 运维端点：

```dotenv
BOT_METRICS_PORT=9095
BOT_METRICS_HOST=127.0.0.1
```

它提供 `/healthz`（进程存活）、`/readyz`（Gateway 与 OpenAPI 业务探针，附
失败原因）和 Prometheus 格式的 `/metrics`，包含消息处理延迟直方图以及适配器
诊断字段。端点**没有鉴权**，默认只绑回环；要对外暴露请自行加反向代理。

主动消息 Outbox 中状态为 `uncertain` 的记录表示发送结果未知，框架一律拒绝
自动重发。它们需要人工裁决：

```bash
~/apps/qq-bot/current/deploy/manage.sh outbox list --status uncertain
```

确认消息是否真的送达后，再 `outbox resolve <幂等键> --as sent|discard
--confirm`。该命令直接读写共享数据库，机器人没运行也能用。流式消息记录不支持
`--as sent`（适配器恢复流时只看流状态、不看 status），工具会拒绝并说明原因。

设置 `BOT_OWNER_IDS`（逗号分隔）后，作者 ID 匹配的人按 `owner` 处理，并会启用
owner 专属的 `/plugin` 命令。注意它匹配的是消息作者的 `author.id`：QQ 单聊取自
`user_openid`、群聊取自 `member_openid`，是不同的字段，取值不一定相同。先让自己在
每种会话里发一条命令，再从命令审计日志的 `authorId` 字段取值，把需要的都列上。

可用子命令：

```text
/plugin list              查看插件加载状态
/plugin disable <名称>    立即停用（重启后按清单恢复）
/plugin enable <名称>     按清单启用
/plugin reload <名称>     重新加载
```

运行时变更只在当前进程生效，插件清单始终是事实来源。清单路径型插件的
`reload` 会重新读取代码，npm 包型插件因 Node 模块缓存只能生效配置改动。
每条命令的执行、拒绝和失败都会写入带 `audit` 字段的结构化日志（不含消息
正文和参数）。

## 当前边界

- QQ 适配器支持群聊和消息列表单聊的文本、Markdown、指令按钮及富媒体消息。
- QQ 自定义按钮目前是平台内邀能力；未开通时框架会自动重试为纯 Markdown
  导航，命令仍可手动发送。
- 频道能力尚未实现；单聊/群聊主动消息具备共享配额账本、拒收状态和持久化
  Outbox，但真实消息、上传和撤回仍需按发布清单执行显式生产冒烟。
- 默认使用 `./data/bot.sqlite` 持久化插件数据，可通过
  `BOT_DATABASE_PATH` 修改位置。
- 插件从管理员显式配置的清单动态导入；它们是可信进程内代码，不提供沙箱隔离。
- `/plugin` 可以在运行中启停和重载插件，但运行时加载的插件不会收到
  `bot.ready`；npm 包型插件的代码改动仍需重启。
- 消息去重跨进程重启生效的前提是存储支持前缀枚举（内置的 SQLite 与内存实现
  都支持）；第三方只实现 get/set/delete/update 的存储会退回进程内去重。

插件开发方式参见 [docs/plugin-development.md](docs/plugin-development.md)。

## 当前服务器部署

生产环境采用用户目录、不可变 release 和原子软链部署，不依赖 root、Docker
或全局 Node：

```text
~/apps/qq-bot/          # 默认 QQ_BOT_ROOT
├── current -> releases/<release>
├── releases/
├── runtime/node/
└── shared/
    ├── .env
    ├── data/bot.sqlite
    └── logs/
```

每个 release 保留标准 pnpm workspace 布局，进程从
`apps/bot/dist/main.js` 启动，以便 Node 按应用工作区解析运行时依赖。

首次部署时复制本地部署配置（该文件已被 Git 忽略）：

```bash
cp deploy/deploy.env.example .deploy.env
```

填写 SSH 主机、密钥和服务器根目录后，执行：

```bash
pnpm deploy:production
```

标准发布流程会：

1. 要求 Git 工作区干净，保证部署内容对应一个确定提交。
2. 运行完整构建、类型检查和测试。
3. 通过 `git archive` 上传源代码，不携带 `.env`、SQLite、日志或本地依赖。
4. 在服务器 staging 目录执行锁文件安装和构建。
5. 原子切换 `current`，重启进程并检查 supervisor、应用 PID 和运行 release。
6. 健康检查失败时自动切回上一 release；成功后保留最近若干 release。

共享的 `.env`、数据库和日志始终位于 `shared/`，不会被 release 覆盖。每个
release 的 `deploy/release.env` 记录提交、发布时间和 release ID。

日常管理命令：

```bash
~/apps/qq-bot/current/deploy/manage.sh status
~/apps/qq-bot/current/deploy/manage.sh health
~/apps/qq-bot/current/deploy/manage.sh restart
~/apps/qq-bot/current/deploy/manage.sh logs 100
```

QQ 正式适配器默认在启动时根据插件的导航声明，统一同步单聊自定义菜单以及
单聊/群聊指令面板。可以通过 `QQ_SYNC_NAVIGATION=false` 紧急关闭自动同步。

需要脱离机器人启动流程手动恢复菜单时，可使用运维兜底命令：

```bash
pnpm deploy:menu
```

兜底内容由 `deploy/qq-menu.json` 声明。自动与手动同步都只操作带有
`qq-bot-managed:<scope>` 备注的本项目面板，不会修改其他面板。

## 许可证

本项目采用 [MIT 许可证](./LICENSE)。
