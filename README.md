# UMX-Bot

面向 QQ 官方机器人的插件化框架。用它搭建并部署你自己的 QQ 机器人，服务单聊和群聊：连接、命
令、权限、存储、调度和运维这些通用部分由框架负责，具体功能全部由插件实现。

插件只依赖平台无关的 `@umx-bot/plugin-sdk`，可以作为 npm 包独立发布，安装到任何
UMX-Bot 实例上；本地用 Console 适配器开发调试，不需要 QQ 凭据。

## 特性

**插件**

- 显式插件清单：npm 包、本地路径或独立子进程（[进程外插件](docs/remote-plugins.md)），
  SemVer 依赖排序、可选依赖、禁用开关；启动配置深层只读，密钥由环境变量注入。
- 命令（别名、子命令、类型化参数、冷却、`member`/`admin`/`owner` 权限）、事件、
  中间件、出站钩子、回调按钮、插件间服务与事件。
- 分层会话配置（默认 → 全局 → 平台 → 聊天类型 → 会话）并自动生成 `/config`；
  会话隔离状态、带 TTL 与枚举的 KV、集合。
- interval / cron / 一次性定时任务，防重入，可补跑停机期间错过的触发。
- 插件注册的资源随卸载自动回收；权限声明与清单授权上限；插件级 Prometheus 指标。
- 测试宿主 `@umx-bot/plugin-testkit` 用真实运行时跑插件集成测试。

**消息**

- 统一消息模型：文本、Markdown、按钮、图片/视频/语音/文件、引用、撤回、
  输入中状态、流式回复。
- 帮助目录由命令声明自动生成；单独 `@机器人` 唤起导航，插件声明式注册 QQ
  单聊菜单与指令面板。

**QQ 官方适配器**

- 单聊与群聊：Session Resume、按会话并发且保序、持久化消息去重、断线退避、
  Token 自动刷新、结构化错误与限频。
- 主动消息共享配额账本与持久化 Outbox，结果不确定时绝不自动重发。

**运维**

- `/acl` 按会话启停插件与封禁用户，机器人主人专属 `/plugin` 运行时启停/重载，命令审计日志。
- 健康快照、`/healthz`、`/readyz`、Prometheus `/metrics`。
- 不可变 release 部署，发布失败自动回滚代码与数据库；也提供 Docker 镜像。

内置插件：`help`（帮助）、`ping`（在线状态）、`minecraft-status`（Minecraft
Java/Bedrock 服务器状态）。AI 群助手插件在独立仓库
[UMX-Qbot-Agent](https://github.com/Kningc/UMX-Qbot-Agent)。

## 快速开始

需要 Node.js 22.13+。

```bash
git clone https://github.com/Kningc/UMX-Bot.git
cd UMX-Bot
corepack enable
pnpm install
cp .env.example .env
pnpm dev
```

默认使用 Console 适配器，不需要 QQ 凭据，直接在终端输入：

```text
/help
/ping
/mc set play.example.com java
/mc
```

接下来：

- 连接真实 QQ 机器人：[配置参考 › 连接 QQ 官方机器人](docs/configuration.md#连接-qq-官方机器人)
- 写第一个插件：`pnpm create:plugin my-plugin`，然后看[插件开发](docs/plugin-development.md)
- 上线：[部署](docs/deployment.md)

## 文档

**运行机器人**

| 文档 | 内容 |
| --- | --- |
| [配置参考](docs/configuration.md) | 全部环境变量、插件清单格式、连接 QQ |
| [QQ 官方适配器](docs/qq-official.md) | 支持的事件与消息能力、配额、平台限制、冒烟测试 |
| [部署](docs/deployment.md) | 用户目录 release 部署与回滚、进程托管、Docker |
| [运维](docs/operations.md) | 健康检查、指标、`/acl` `/config` `/plugin`、Outbox、数据库 |
| [内置插件](#内置插件) | help、ping、minecraft-status 的用法 |

**开发插件**

| 文档 | 内容 |
| --- | --- |
| [插件开发](docs/plugin-development.md) | 模板、全部插件 API、测试、打包发布 |
| [进程外插件](docs/remote-plugins.md) | 以子进程运行插件的 stdio JSON-RPC 协议（英文） |

**参与框架开发**

| 文档 | 内容 |
| --- | --- |
| [参与开发](CONTRIBUTING.md) | 开发环境、仓库结构、代码约定、PR 与发布流程 |
| [架构](docs/architecture.md) | 模块边界、运行时保证、依赖方向 |
| [安全策略](SECURITY.md) | 漏洞报告与部署建议 |

## npm 包

| 包 | 用途 |
| --- | --- |
| [`@umx-bot/plugin-sdk`](packages/plugin-sdk) | 插件与适配器契约，插件唯一必需的依赖 |
| [`@umx-bot/plugin-sdk-qq`](packages/plugin-sdk-qq) | QQ 专属的可选扩展（按钮模板、互动召回、分片摘要） |
| [`@umx-bot/plugin-testkit`](packages/plugin-testkit) | 插件集成测试宿主、适配器一致性测试 |
| [`@umx-bot/core`](packages/core) | 内核与插件运行时，供宿主与测试宿主使用 |

四个包版本同步，变更记录见各包 `CHANGELOG.md`。插件 API 版本
（`PLUGIN_API_VERSION`，当前为 `2`）独立于包版本；同一 API 版本内契约只增不改。

## 内置插件

**help**：`/help` 打开命令目录，`/help <插件名|命令名>` 查看详细用法；用法与示例
来自各插件的命令声明，自动适配命令前缀。

**ping**：`/ping` 检查机器人是否在线。

**minecraft-status**：管理员或群主为每个群聊/私聊保存默认服务器：

```text
/mc set play.example.com java
/mc set play.example.com:19132 bedrock
```

之后 `/mc` 显示图标、在线状态、版本、MOTD、人数、玩家样本以及可用时的插件/模组
信息。`/mc <地址> [java|bedrock]` 临时查询，`/mc config` 查看、`/mc reset` 清除。
已保存的 Java 服务器优先通过 Server List Ping 直连（支持 SRV，缓存 1 分钟，
拒绝私有地址），失败时回退公共状态服务；临时查询与 Bedrock 使用公共服务。

## 已知限制

- 进程内插件是可信代码，不提供沙箱；不可信插件请用进程外插件并放进容器。
- 只支持 QQ 单聊和群聊，不支持频道和 Webhook。部分能力尚未在真实环境验证，
  见 [QQ 官方适配器 › 生产验证状态](docs/qq-official.md#生产验证状态)。
- QQ 自定义按钮是平台内邀能力，未开通时自动降级为纯 Markdown 导航。
- 消息去重跨重启生效要求存储支持前缀枚举（内置 SQLite 与内存实现都支持）。

## 许可证

[MIT](./LICENSE)
