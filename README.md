# QQ Bot

一个给自有 QQ 群使用的自托管、插件化机器人框架。核心只负责任务编排，
实际功能由插件提供。

当前框架版本：`0.4.0`。

## 当前能力

- 与平台无关的统一消息模型
- QQ 官方 WebSocket 事件接入和文本回复
- 本地 Console 适配器，无 QQ 凭据也能开发插件
- 显式内核状态机、启动失败回滚、消息排空和优雅停机
- 插件依赖校验、取消信号、资源自动清理和类型化服务共享
- 可排序消息中间件与类型安全的优先级/一次性事件订阅
- 带引号与转义的命令解析、别名、冷却和 member/admin/owner 权限
- 分层会话配置、群聊/私聊隔离状态和 SQLite 原子持久化
- 统一富媒体回复模型，支持图片、视频、语音、文件及图文混合
- 插件化导航注册、单独 `@机器人` 唤起导航和 QQ 可点击指令按钮
- 框架归一化的插件/命令帮助目录，自动适配自定义命令前缀
- QQ Markdown 导航；无自定义按钮权限时自动降级为可复制的文字命令
- 防重入定时任务、插件级日志和底层存储命名空间
- QQ 断线恢复、指数退避、心跳检测、请求超时和凭据自动刷新
- 运行健康快照与消息处理指标
- `help`、`ping` 示例插件，以及 Minecraft Java/Bedrock 服务器状态插件
- TypeScript 类型检查和 Vitest 测试

## 快速开始

要求 Node.js 22 或更高版本。

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
packages/adapter-console       本地交互适配器
packages/adapter-qq-official   QQ 官方 API 适配器
packages/storage-sqlite        SQLite 持久化实现
plugins/help                   帮助插件
plugins/minecraft-status       Minecraft 服务器状态与会话配置插件
plugins/ping                   在线状态插件
```

## 常用命令

```bash
pnpm dev        # 构建后启动开发模式
pnpm build      # 构建全部工作区包
pnpm typecheck  # 严格类型检查
pnpm test       # 构建并运行测试
pnpm start      # 运行已构建产物
```

核心架构与运行时保证参见 [docs/architecture.md](docs/architecture.md)。
QQ 单聊/群聊官方能力覆盖、缺口优先级和开发路线参见
[docs/qq-official-gap-analysis.md](docs/qq-official-gap-analysis.md)。

## 当前边界

- QQ 适配器支持群聊和消息列表单聊的文本、Markdown、指令按钮及富媒体消息。
- QQ 自定义按钮目前是平台内邀能力；未开通时框架会自动重试为纯 Markdown
  导航，命令仍可手动发送。
- 频道能力尚未实现；单聊/群聊主动消息具备共享配额账本、拒收状态和持久化
  Outbox，但真实消息、上传和撤回仍需按发布清单执行显式生产冒烟。
- 默认使用 `./data/bot.sqlite` 持久化插件数据，可通过
  `BOT_DATABASE_PATH` 修改位置。
- 插件在启动时静态加载；后续可以增加目录发现和热重载。

插件开发方式参见 [docs/plugin-development.md](docs/plugin-development.md)。

## 当前服务器部署

生产环境采用用户目录、不可变 release 和原子软链部署，不依赖 root、Docker
或全局 Node：

```text
/home/kningc/apps/qq-bot/
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
