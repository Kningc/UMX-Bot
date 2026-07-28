# QQ Bot

一个给自有 QQ 群使用的自托管、插件化机器人框架。核心只负责任务编排，
实际功能由插件提供。

当前框架版本：`0.2.0`。

## 当前能力

- 与平台无关的统一消息模型
- QQ 官方 WebSocket 事件接入和文本回复
- 本地 Console 适配器，无 QQ 凭据也能开发插件
- 显式内核状态机、启动失败回滚、消息排空和优雅停机
- 插件依赖校验、取消信号、资源自动清理和类型化服务共享
- 可排序消息中间件与类型安全的优先级/一次性事件订阅
- 带引号与转义的命令解析、别名、冷却和 member/admin/owner 权限
- 分层会话配置、群聊/私聊隔离状态和 SQLite 原子持久化
- 防重入定时任务、插件级日志和底层存储命名空间
- QQ 断线恢复、指数退避、心跳检测、请求超时和凭据自动刷新
- 运行健康快照与消息处理指标
- `help`、`ping` 示例插件
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
```

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

## 当前边界

- QQ 适配器第一版支持群聊和消息列表单聊的文本消息。
- 频道、图片、语音、Markdown 和主动消息策略尚未实现。
- 默认使用 `./data/bot.sqlite` 持久化插件数据，可通过
  `BOT_DATABASE_PATH` 修改位置。
- 插件在启动时静态加载；后续可以增加目录发现和热重载。

插件开发方式参见 [docs/plugin-development.md](docs/plugin-development.md)。

## 当前服务器部署

阿里云采用用户目录部署，不依赖 root、Docker 或全局 Node：

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

管理命令：

```bash
~/apps/qq-bot/current/deploy/manage.sh status
~/apps/qq-bot/current/deploy/manage.sh restart
~/apps/qq-bot/current/deploy/manage.sh logs 100
```
