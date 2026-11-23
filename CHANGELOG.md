# Changelog

## Unreleased

### 工程基建

- 新增 GitHub Actions CI：Node 22.13/24 矩阵跑 lint、构建、类型检查、带阈值的
  覆盖率和菜单校验，另有独立 job 验证四个公共包的发布 tarball。此前唯一的门禁
  是人手执行 `pnpm check`。
- 接入 Biome 统一 lint 与格式化（`pnpm lint` / `pnpm lint:fix`）。`noNonNullAssertion`、
  `noDelete`、`noConfusingVoidType` 被显式关闭并写明原因：它们与
  `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 以及插件 API 的
  `Awaitable<void | SentMessage>` 冲突。
- 覆盖率此前在 `vitest.config.ts` 里声明了 reporter 但没装 `@vitest/coverage-v8`，
  `--coverage` 直接报错；现在可用，并设了棘轮式阈值，入口文件和生产冒烟脚本
  排除在统计外。
- Release workflow 在发布前重新跑类型检查和测试；发布脚本每发布一个包就立即打
  tag，中途失败不再漏 tag。各包构建改用排除测试文件的 `tsconfig.build.json`，
  `dist` 与 Docker 镜像不再带测试产物。
- 接入 Changesets 管理四个公共包的版本与发布；`repository.url` 从失效的 gitee
  地址改为真实的 GitHub 仓库，并补上 `homepage` 与 `bugs`。
- `.env.example` 补齐缺失的 `QQ_ENABLE_INTERACTIONS`、`QQ_CERTIFICATION`、
  `QQ_API_BASE_URL`、`QQ_INTENTS` 和 `BOT_HEALTH_*`。
- 新增 `pnpm create:plugin <名称>`，从 starter 生成可直接构建和测试的新插件。

### 可靠性

- **修复**：消息去重表此前只在内存中（上限 1000 条、10 分钟 TTL）。Gateway 只
  提交“连续已完成”的水位，因此进程重启后 Resume 会重投已处理但未提交的事件，
  而此时去重表是空的，消息会被重复处理并重复回复。现在去重键持久化到存储、
  带 TTL 并定期清理，启动时恢复。存储不支持前缀枚举时退回进程内去重，并告警。
- **修复**：`uncertain` 的主动消息 Outbox 记录此前查不出来——`getOutboxStatus`
  要求调用方已经知道幂等键，而 `KeyValueStore` 没有枚举能力。于是“禁止自动
  重发、交由人工裁决”这个设计的最后一环是悬空的。现在 `KeyValueStore` 增加
  可选的 `list(prefix, { limit, after })`，适配器提供 `listOutbox()`，并新增
  `scripts/outbox.mjs`（`manage.sh outbox`）直接读写共享数据库做人工处理。
- SQLite 存储增加 `schema_meta` 版本表和有序迁移；打开版本高于当前构建的数据库
  会直接拒绝，避免发布回滚后旧代码继续写新 schema。旧库自动识别为 v1。
- 内核按固定桶统计端到端消息处理延迟。
- **修复**：关机时 `unloadAll` 会被可选依赖拦住——插件 B 可选依赖 A、A 在运行中
  热加载后，`stop()` 报 “required by” 并停在半路，其余插件的清理都没执行；启动
  失败回滚时还会盖掉原始错误。现在按依赖关系先卸依赖方，可选依赖只影响顺序。
- 命令冷却改为在参数校验通过后才开始计时，参数写错不再占用冷却。
- `deploy/manage.sh health` 的快照时效从写死的 90 秒改为 `BOT_HEALTH_INTERVAL_MS` 的
  3 倍，调大探测间隔后部署健康检查不再必然失败。

### 可观测性

- 新增可选的 HTTP 运维端点（`BOT_METRICS_PORT`）：`/healthz`、`/readyz`
  （附失败原因）和 Prometheus `/metrics`，含处理延迟直方图。适配器诊断字段
  被通用地摊平成 gauge，新增诊断无需改动端点代码。端点无鉴权，默认只绑回环，
  绑到非回环地址时会告警。

### 架构

- QQ 适配器主文件从 1581 行降到 1045 行，并且**不再 import `ws`**：连接层拆到
  `gateway/{client,session-store,intents}`，事件映射拆到
  `mapping/{incoming-message,lifecycle-events}`（纯函数，可直接用事件 JSON 测试）。
  这闭合了 `docs/qq-official-gap-analysis.md` §5 的目标结构和 §8 的第一条禁忌。
  对应的 7 个 Gateway 传输测试也从适配器私有内部迁移到 `gateway/client.test.ts`。
- `plugin-testkit` 新增适配器一致性测试套件 `adapterConformanceChecks()`：
  以可执行断言固化 `BotAdapter` 契约（名称、生命周期幂等、重启、无 `onEvent`
  启动、回执字段、诊断必须可 JSON 序列化）。Console 适配器已接入；套件自身有
  9 个“故意写坏的适配器”测试，确保它不会变成装饰。
- `BotKernel`/`PluginTestHost` 新增 `getNavigation()`，插件作者可以直接断言
  自己注册的导航入口。

### 权限与运行时管理

- **安全修复**：插件存储只是共享存储加 `<插件名>:` 前缀，宿主自己的访问规则
  （`access:`）、Gateway 会话与 Outbox（`adapter:`）、cron 状态（`scheduler:`）也在
  同一存储中，名为 `access` 的插件即使 `permissions: []` 也能改写封禁名单。现在
  `access`、`adapter`、`core`、`host`、`kernel`、`scheduler` 为宿主保留名，内核与
  `pnpm create:plugin` 都会拒绝。

- 新增 `BOT_OWNER_IDS`：名单中的平台用户在任何会话都按 `owner` 处理。平台角色
  只描述单个群，此前自托管者在自己不是管理员的群里无法使用 owner 级命令。
- 命令的通过、拒绝和失败写入带 `audit: "command"` 的结构化日志，记录谁、在哪、
  执行了哪个命令，**不记录**消息正文和参数。
- `BotKernel` 现在允许在 `running` 状态加载和卸载插件，并在变更后重新同步导航
  （同步失败只记录日志）。运行时加载的插件不会收到 `bot.ready`。
- 配置了 owner 后自动启用 owner 专属的 `/plugin list|disable|enable|reload`。
  变更只在当前进程生效，清单仍是事实来源；路径型插件 `reload` 能带上代码改动，
  npm 包型因 Node 模块缓存只能生效配置。

- **修复**：QQ Gateway 原先串行等待每条消息处理完毕，一条慢命令（如 AI 回复）
  会让所有会话无响应，并使心跳 ACK 排队超时而反复重连。Dispatch 现按会话分道
  并发，控制帧即时处理，进度只提交连续完成的水位。
- **修复**：插件处理或回复失败的消息不再通过断线 Resume 无限重放并卡死 Gateway，
  改为记录日志后丢弃并写入去重表。
- **安全**：Minecraft 直连查询先解析 DNS 并拒绝回环、内网和保留地址，只连接校验
  过的公网 IP，防止群管理员借此探测机器人服务器的本机或内网端口。
- **修复**：QQ 媒体 `file_info` 缓存改为有上限的 LRU；Outbox 在配置持久化存储时
  不再把每条主动消息记录常驻内存，长期运行不再无界增长。
- **修复**：定时任务拒绝超过 2^31-1 毫秒的间隔，避免 Node 将其截断为 1 毫秒忙循环。
- QQ 适配器从 2400 多行的单文件拆分为 `protocol`、`keyboard`、`media-uploader`、
  `outbox`、`message-stream`、`gateway-dispatcher` 等模块。
- 移除过时的内置 `ai-agent` 插件，AI 插件改由独立仓库 UMX-Qbot-Agent 维护。
- 根项目与 `storage-sqlite` 要求 Node.js 22.13+（`node:sqlite` 无需实验开关）；
  发布与包验证脚本在缺少 Corepack（Node.js 25+）时回退到固定版本的 pnpm。

- 插件导航入口新增 `message`、`menu`、`panel` 展示面声明；QQ 适配器在全部
  插件加载完成后统一生成并幂等同步单聊菜单及单聊/群聊指令面板。
- QQ 菜单同步增加平台数量/文字长度预检、管理员入口映射、受管面板所有权隔离、
  无变化跳过写入、启动失败回滚和 `QQ_SYNC_NAVIGATION` 紧急关闭开关。
- 生产发布健康检查改为限时轮询，避免 QQ OpenAPI 瞬时限流触发错误回滚。
- `bot.ready` 插件初始化失败现在会使启动失败并回滚全部插件；普通业务事件继续
  隔离处理器错误。
- 插件 API 省略值固定解释为历史 v1，并显式维护支持版本集合。
- 插件依赖范围改用标准 `node-semver`，修正预发布版本错误匹配稳定范围的问题。
- 事件、setup 与清理错误补齐插件归属；启动配置类型改为深层只读。
- 插件测试宿主增加平台事件、富输入字段、自定义存储及适配器能力注入。

## 0.5.0

- 插件由显式 JSON 清单动态导入，支持 npm 包、本地路径、禁用开关、依赖拓扑
  排序，以及缺失和循环的启动前诊断。
- 插件依赖增加 SemVer 范围和可选依赖，插件契约增加显式 API 版本。
- 修复同名插件并发加载覆盖运行时记录并泄漏清理函数的问题。
- 增加深层只读启动配置与环境变量密钥映射；明确插件是可信进程内代码。
- 将 QQ 唤醒投递、键盘模板和分片摘要迁移到 `plugin-sdk-qq` 平台扩展，
  基础 SDK 改用平台无关的投递、按钮样式和 checksum 模型。
- 增加 `plugin-testkit` 内存集成测试宿主和持续参与工作区验证的 starter 插件。
- 补齐 SDK npm 包文件白名单、Node 版本、仓库、公开发布设置和包内 README。
- 发布门禁会实际打包四个公共包，在空白临时项目中安装、严格编译并运行插件。
- 重写插件开发文档，覆盖从模板、安装清单、配置、测试、兼容性到 QQ 扩展。
- 项目及各工作区包统一声明为 MIT 许可证。

## 0.4.0

- 增加插件导航注册中心，插件可声明二级导航页、常用指令、显示范围和权限。
- 群聊中单独 `@机器人` 自动回复 Markdown 主导航，`/help <页面ID>` 可打开
  插件导航页。
- QQ 适配器支持原生指令按钮，点击后自动发送命令；自定义按钮权限不可用时
  自动降级为 Markdown 导航。
- Console 适配器增加 Markdown 与导航按钮的可读降级输出。
- 增加导航注册、页面渲染、单独提及识别、按钮序列化和权限降级测试。
- 增加 Minecraft Java/Bedrock 服务器状态插件，支持会话级地址配置、临时查询、
  服务器图标、MOTD、人数、玩家样本、插件和模组信息。
- 修正 QQ Gateway 在鉴权前发送首个心跳及重连计时器无法保持进程存活的问题。
- Minecraft 状态插件增加已配置 Java 服务器的原生直连回退；图标发送失败时
  自动降级为纯文本状态。
- Minecraft 状态插件对已配置 Java 服务器改为直连优先并缓存 1 分钟，增加
  SRV 解析、并发查询去重和公共 API 自动回退。

## 0.3.0

- 增加统一富媒体消息模型，保持现有纯文本插件完全兼容。
- 支持通过 URL 或二进制数据发送图片、视频、语音和文件。
- QQ 适配器实现媒体预上传、`file_info` 富媒体发送、图文混合及多媒体顺序发送。
- Console 适配器可读地展示媒体类型、文件名、URL 或二进制大小。
- 增加媒体大小限制、URL 协议检查、鉴权刷新和异常响应校验。
- 修正生产启动入口，使部署遵循标准 pnpm workspace 依赖解析。
- 增加按全局、平台、聊天类型和具体会话继承的插件配置。
- 增加群聊/私聊隔离状态、配置版本迁移、原子 KV 更新和配置检查能力。

## 0.2.0

- 增加内核生命周期状态机、启动回滚、消息排空和停机超时。
- 增加插件依赖、取消信号、类型化服务共享和资源自动回收。
- 增加消息中间件、优先级/一次性事件和运行健康快照。
- 增强命令解析、冷却、校验和隐藏命令能力。
- 防止定时任务默认重入，卸载时支持任务取消。
- 扩充消息模型中的附件与提及信息。
- QQ 适配器增加恢复会话、指数退避、心跳检测、请求超时、鉴权刷新、
  消息去重和回复序号管理。
- 增加 SQLite 文件权限保护和进程级异常停机处理。
- 将测试覆盖扩展到生命周期、事件、中间件、服务、调度、鉴权和适配器发送。
