# 参与开发

欢迎提交 Issue 和 Pull Request。本文面向想修改框架本身的人；只是写插件的话，
看[插件开发](docs/plugin-development.md)就够了。安全问题请按
[安全策略](SECURITY.md)私下报告，不要开公开 Issue。

## 开发环境

- Node.js 22.13+（`.nvmrc` 为 24，CI 在 22.13 和 24 上都跑）
- pnpm，版本由 `package.json` 的 `packageManager` 固定，用 Corepack 启用

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm dev          # Console 适配器，无需 QQ 凭据
```

## 仓库结构

```text
apps/bot                       可执行程序：配置、插件加载、内置管理插件、运维端点、远程插件宿主
packages/plugin-sdk            插件与适配器的公共契约（平台无关，零依赖）
packages/plugin-sdk-qq         QQ 专属的可选插件扩展
packages/core                  内核、命令/事件/中间件、插件运行时、调度、存储封装
packages/plugin-testkit        内存插件测试宿主与适配器一致性测试
packages/adapter-console       本地终端适配器
packages/adapter-qq-official   QQ 官方适配器（openapi/、gateway/、mapping/）
packages/storage-sqlite        SQLite 存储
plugins/                       内置插件 help、ping、minecraft-status
examples/plugin-starter        插件模板，参与构建与回归测试
examples/remote-echo           无依赖的进程外插件示例
deploy/                        发布、托管与运维脚本（POSIX sh）
scripts/                       脚手架、Outbox 工具、数据库快照、菜单同步、发包
```

模块边界、运行时保证和依赖方向见[架构](docs/architecture.md)。几条硬约束：

- `plugin-sdk` 不依赖任何工作区包；业务插件只依赖 `plugin-sdk`（QQ 专属能力用
  `plugin-sdk-qq`），不得导入 `core` 内部实现。
- QQ 适配器内所有 HTTP 调用必须经过 `openapi/` Client；`mapping/` 保持纯函数。
- 插件 API 在同一 `PLUGIN_API_VERSION` 内只增不改，破坏性改动必须升版本并继续
  接受 `SUPPORTED_PLUGIN_API_VERSIONS` 中的旧版本。

## 常用命令

```bash
pnpm build                  # 构建全部工作区包
pnpm test                   # 构建并运行测试
pnpm test:watch             # Vitest watch
pnpm test:coverage          # 覆盖率（低于阈值即失败）
pnpm typecheck              # 严格类型检查
pnpm lint                   # Biome 检查；pnpm lint:fix 自动修复，pnpm format 只格式化
pnpm check                  # 完整门禁，提交 PR 前必须通过
pnpm verify:plugin-packages # 在空白临时项目中安装并运行公共包 tarball
pnpm validate:menu          # 校验 deploy/qq-menu.json
```

`pnpm check` 依次执行 lint、构建、类型检查、带阈值的覆盖率、菜单校验、发布包
验证和 `pnpm audit --prod --audit-level=high`，与 CI 一致。

## 代码约定

- **TypeScript**：ESM（`NodeNext`），开启 `strict`、`noUncheckedIndexedAccess`、
  `exactOptionalPropertyTypes`、`verbatimModuleSyntax`。可选字段请用条件展开
  （`...(x === undefined ? {} : { x })`）而不是赋 `undefined`。
- **格式与 lint**：Biome（`biome.jsonc`）。少数被关闭的规则在配置里写明了原因。
- **测试**：Vitest，测试与源码同目录（`*.test.ts`）。覆盖率阈值见
  `vitest.config.ts`，只能上调。可靠性相关改动（Gateway、Outbox、存储、部署脚本）
  请附故障注入测试，例如中途抛错、落库失败、并发完成顺序颠倒。
- **构建**：各包用 `tsconfig.build.json` 排除测试文件，`dist` 不带测试产物。
- **文档**：面向用户的文档使用中文，`docs/remote-plugins.md` 与公共包 README 使用
  英文。改动行为、配置项或命令时同步更新对应文档；新增环境变量要同时写进
  `.env.example`、`deploy/server.env.example`（如适用）和
  [配置参考](docs/configuration.md)。

## 提交与 Pull Request

- 提交信息使用英文 [Conventional Commits](https://www.conventionalcommits.org/)，
  如 `fix(qq): …`、`feat(core): …`、`docs: …`、`ci(release): …`。
- 改动以下四个公共包时，用 `pnpm changeset` 添加变更记录：
  `@umx-bot/plugin-sdk`、`@umx-bot/plugin-sdk-qq`、`@umx-bot/core`、
  `@umx-bot/plugin-testkit`。它们版本号固定同步；其他工作区包不单独发版。
- PR 描述写清改了什么、为什么，以及跑了哪些验证；没验证到的地方（例如真实 QQ
  环境）也写上。涉及部署脚本或数据库 schema 时说明回滚路径：SQLite schema 只能
  前进，旧版本会拒绝打开新库。
- 涉及 QQ 真实收发的改动，可以用[冒烟测试](docs/qq-official.md#冒烟测试)在自己的
  测试机器人上验证。

## 发布流程

由维护者和 CI 完成，贡献者只需要在 PR 里附上 changeset：

1. PR 合并到 `main` 后，Release workflow 汇总 changeset，开一个“version packages”PR。
2. 版本 PR 合并后，workflow 重新构建、类型检查和测试，再通过 npm Trusted
   Publishing 发布尚未发布的版本，并为每个包打 `<包名>@<版本>` tag。
