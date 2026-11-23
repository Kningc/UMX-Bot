# UMX-Bot

给自有 QQ 群使用的自托管、插件化机器人框架。核心只负责编排：生命周期、命令
路由、权限、存储和调度；具体功能全部由插件提供。插件只依赖平台无关的
`@umx-bot/plugin-sdk`，本地用 Console 适配器开发，部署时切换到 QQ 官方适配器。

## 特性

**插件运行时**

- 显式插件清单：npm 包、本地路径或子进程（[进程外插件](docs/remote-plugins.md)），
  SemVer 依赖排序、可选依赖、禁用开关；启动配置深层只读，密钥由环境变量注入。
- 资源自动跟踪：命令、事件、中间件、服务、定时任务随插件卸载回收；取消信号、
  初始化失败只回滚该插件。
- 插件权限声明（`messages.active`、`scheduler`、`middleware` 等）与清单授权上限；
  `requires` 能力检查、宿主上下文扩展、类型化 Service Token。

**消息与交互**

- 统一消息模型：文本、Markdown、按钮、图片/视频/语音/文件、引用、撤回、
  输入中状态、流式回复。
- 命令：别名、子命令、类型化参数、引号与转义、冷却、按聊天类型限定、
  `member`/`admin`/`owner` 权限；帮助目录由命令声明自动生成。
- 导航：单独 `@机器人` 唤起主导航，插件声明式注册 QQ 单聊菜单与指令面板，
  启动时幂等同步；无按钮权限时降级为纯 Markdown。
- 出站钩子、回调按钮路由、插件间事件、可排序中间件。

**存储与调度**

- 分层会话配置（默认 → 全局 → 平台 → 聊天类型 → 会话）与自动生成的 `/config`。
- 会话隔离状态、KV（TTL、前缀枚举、集合），SQLite 原子更新与 schema 版本门禁。
- interval / cron / 一次性任务，防重入，cron 可补跑错过的触发。

**QQ 官方适配器**

- WebSocket Gateway：Session Resume、按会话分道并发、只提交连续完成水位、
  心跳检测、指数退避、持久化消息去重。
- OpenAPI：统一 Client、结构化错误、限频与安全重试、Token 自动刷新。
- 主动消息：共享配额账本、持久化 Outbox，结果不确定时禁止自动重发。

**运维**

- `/acl` 按会话启停插件与封禁用户，owner 专属的 `/plugin` 运行时启停/重载，命令审计日志。
- 健康快照、`/healthz`、`/readyz`、Prometheus `/metrics`。
- 不可变 release 部署、发布失败自动回滚代码与数据库；Docker 镜像。

内置插件：`help`（帮助）、`ping`（在线状态）、`minecraft-status`（Minecraft
Java/Bedrock 服务器状态）。AI 群助手插件在独立仓库
[UMX-Qbot-Agent](https://github.com/Kningc/UMX-Qbot-Agent) 开发和发布。

## 快速开始

需要 Node.js 22.13+（内置 `node:sqlite` 从该版本起无需实验开关）。

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm dev
```

默认是 Console 适配器，直接在终端输入：

```text
/help
/ping
/mc set play.example.com java
/mc
```

连接真实 QQ 机器人见[配置参考](docs/configuration.md#连接-qq-官方机器人)。

### Minecraft 服务器状态

管理员或群主为每个群聊/私聊保存默认服务器：

```text
/mc set play.example.com java
/mc set play.example.com:19132 bedrock
```

之后 `/mc` 显示图标、在线状态、版本、MOTD、人数、玩家样本以及可用时的插件/模组
信息。`/mc <地址> [java|bedrock]` 临时查询，`/mc config` 查看、`/mc reset` 清除。
已保存的 Java 服务器优先通过 Server List Ping 直连（支持 SRV，缓存 1 分钟，
拒绝私有地址），失败时回退公共状态服务；临时查询与 Bedrock 使用公共服务。

## 文档

| 文档 | 内容 |
| --- | --- |
| [配置参考](docs/configuration.md) | 全部环境变量、插件清单格式、连接 QQ |
| [插件开发](docs/plugin-development.md) | 从模板起步、全部插件 API、测试与发布 |
| [进程外插件](docs/remote-plugins.md) | 子进程插件的 stdio JSON-RPC 协议（英文） |
| [架构](docs/architecture.md) | 模块边界、运行时保证、依赖方向 |
| [部署](docs/deployment.md) | 用户目录 release 部署、回滚、进程托管、Docker |
| [运维](docs/operations.md) | 健康检查、指标、内置管理命令、Outbox、数据库 |
| [QQ 官方能力报告](docs/qq-official-gap-analysis.md) | 单聊/群聊能力覆盖、生产冒烟记录 |
| [安全策略](SECURITY.md) | 漏洞报告与部署建议 |

## 工作区

```text
apps/bot                       可执行程序：配置、插件加载、内置管理插件、运维端点、远程插件宿主
packages/core                  内核、命令/事件/中间件、插件运行时、调度、存储封装
packages/plugin-sdk            插件与适配器的公共契约（平台无关）
packages/plugin-sdk-qq         QQ 专属的可选插件扩展
packages/plugin-testkit        内存插件测试宿主与适配器一致性测试
packages/adapter-console       本地终端适配器
packages/adapter-qq-official   QQ 官方适配器（openapi/、gateway/、mapping/）
packages/storage-sqlite        SQLite 存储
plugins/                       help、ping、minecraft-status
examples/plugin-starter        可复制、参与回归测试的插件模板
examples/remote-echo           无依赖的进程外插件示例
deploy/                        发布、托管与运维脚本
scripts/                       脚手架、Outbox 工具、数据库快照、菜单同步、发包
```

## 常用命令

```bash
pnpm dev                    # 构建后以开发模式启动
pnpm start                  # 运行已构建产物
pnpm build                  # 构建全部工作区包
pnpm test                   # 构建并运行测试
pnpm test:coverage          # 覆盖率（低于阈值即失败）
pnpm typecheck              # 严格类型检查
pnpm lint                   # Biome 检查；pnpm lint:fix 自动修复
pnpm check                  # 完整门禁：lint、构建、类型检查、覆盖率、菜单校验、发布包验证、依赖审计
pnpm create:plugin <名称>   # 从 starter 生成新插件
pnpm outbox list            # 查看主动消息 Outbox
pnpm deploy:production      # 发布到服务器，见 docs/deployment.md
```

## 版本与发布

四个公共包 `@umx-bot/plugin-sdk`、`@umx-bot/plugin-sdk-qq`、`@umx-bot/core`、
`@umx-bot/plugin-testkit` 发布在 npm，版本由 Changesets 管理，变更记录见各包的
`CHANGELOG.md`。插件 API 版本（`PLUGIN_API_VERSION`，当前为 `2`）独立于包版本。

- 改动公共包时用 `pnpm changeset` 记录。
- CI（`.github/workflows/ci.yml`）在 Node 22.13 和 24 上跑同一套门禁，并在空白
  项目中安装验证发布 tarball。
- 合并到 `main` 后，Release workflow 开版本 PR；版本 PR 合并后重新跑类型检查和
  测试再发布，每发布成功一个包就打上 `<包名>@<版本>` tag。

### npm Trusted Publishing

CI 通过 npm Trusted Publishing（OIDC）发布，仓库里不保存 npm token，provenance
自动附带。`scripts/publish-packages.mjs` 用 `pnpm pack` 打包（替换 `workspace:`
依赖），再用 npm CLI 上传尚未发布的版本。npm 只能给已存在的包配置 Trusted
Publisher，首次启用步骤：

1. 在 npm 上创建 `umx-bot` 组织。
2. 本地 `npm login` 后执行 `pnpm -r --if-present build && node scripts/publish-packages.mjs`，
   手动发布四个包的当前版本（需要 npm 11.5.1+）。
3. 在每个包的 Settings → Trusted Publisher 里选择 GitHub Actions，仓库
   `Kningc/UMX-Bot`，工作流 `release.yml`；随后可把包设为禁止 token 发布。
4. 在 GitHub 仓库 Settings → Secrets and variables → Actions → Variables 新建
   `NPM_PUBLISH_ENABLED=true`。未设置时 Release workflow 只开版本 PR，不发布。

## 当前边界

- 插件是管理员显式安装的可信进程内代码，不提供沙箱；不可信插件请用
  [进程外插件](docs/remote-plugins.md)并放进容器。
- QQ 适配器覆盖单聊与群聊；频道能力尚未实现。图片上传、流式回复等能力的生产
  验证状态见 [QQ 官方能力报告](docs/qq-official-gap-analysis.md)。
- QQ 自定义按钮是平台内邀能力，未开通时自动降级为纯 Markdown 导航。
- 消息去重跨重启生效要求存储支持前缀枚举（内置 SQLite 与内存实现都支持）；
  只实现 get/set/delete/update 的第三方存储会退回进程内去重并告警。

## 许可证

[MIT](./LICENSE)
