# 部署

提供两种方式：

- **用户目录部署**（推荐）：不可变 release + 原子软链，不需要 root、
  Docker 或全局 Node，发布失败自动回滚代码和数据库。
- **Docker 镜像**：仓库根目录的 `Dockerfile`，适合已有容器平台的环境。

环境变量含义见[配置参考](configuration.md)，上线后的日常操作见[运维](operations.md)。

## 用户目录部署

### 目录结构

```text
~/apps/qq-bot/                 # QQ_BOT_ROOT，默认值
├── current -> releases/<id>   # 当前运行的 release
├── releases/<id>/             # 每次发布一个目录，id 形如 20261121073824-27a2e86
├── runtime/node/              # 私有 Node.js（需自带 corepack）
└── shared/                    # 跨 release 共享，发布不会覆盖
    ├── .env                   # 机器人配置，权限应为 600
    ├── plugins.json           # 可选的插件清单
    ├── data/bot.sqlite        # 数据库
    ├── data/health.json       # 健康快照
    ├── backups/pre-<id>.sqlite
    └── logs/                  # app.log、supervisor.log、deploy-<id>.log
```

每个 release 保留标准 pnpm workspace 布局，进程从 `apps/bot/dist/main.js`
启动，Node 按应用工作区解析运行时依赖。release 内的 `deploy/release.env`
记录提交、发布时间和 release ID。

### 首次准备

服务器上：

1. 把 Node.js 22.13+ 解压到 `~/apps/qq-bot/runtime/node/`，确认
   `runtime/node/bin/node` 与 `runtime/node/bin/corepack` 存在（Node 25+ 不再
   自带 corepack，需要另行安装）。
2. 以 [`deploy/server.env.example`](../deploy/server.env.example) 为模板创建
   `shared/.env`，`chmod 600`。`BOT_DATABASE_PATH` 必须是绝对路径。
3. 需要自定义插件时按 [`deploy/plugins.json.example`](../deploy/plugins.json.example)
   创建 `shared/plugins.json`，并在 `.env` 中设置 `BOT_PLUGIN_MANIFEST`。
4. 开机自启：按 [`deploy/qq-bot.cron`](../deploy/qq-bot.cron) 用 `crontab -e`
   添加 `@reboot` 条目。

本机上：

```bash
cp deploy/deploy.env.example .deploy.env
```

填写 `QQ_BOT_DEPLOY_HOST`、`QQ_BOT_DEPLOY_IDENTITY`，必要时设置 `QQ_BOT_ROOT`。

### 发布

```bash
pnpm deploy:production
```

[`deploy/release.sh`](../deploy/release.sh) 在本机：

1. 要求 Git 工作区干净，保证部署内容对应一个确定提交。
2. 运行完整门禁 `pnpm check`（lint、构建、类型检查、覆盖率、菜单校验、发布包验证、依赖审计）。
3. 用 `git archive` 打包并上传，不携带 `.env`、数据库、日志或 `node_modules`。

随后 [`deploy/remote-release.sh`](../deploy/remote-release.sh) 在服务器上
**脱离 SSH 会话**运行（日志 `shared/logs/deploy-<id>.log`，本机只跟随输出），
连接中断也会走完发布或回滚：

1. 获取发布锁（记录持有者 PID，持有者已死亡时自动回收）。
2. 在 staging 目录执行 `pnpm install --frozen-lockfile` 和构建。
3. 停止旧版本，用 `VACUUM INTO` 做数据库快照 `shared/backups/pre-<id>.sqlite`。
4. 原子切换 `current`，启动新版本，按 `QQ_BOT_HEALTH_ATTEMPTS` ×
   `QQ_BOT_HEALTH_INTERVAL_SECONDS` 轮询健康检查。
5. 健康检查失败：停止新版本 → 恢复快照 → 切回上一个 release → 再次检查健康。
6. 成功后按 `QQ_BOT_KEEP_RELEASES` 清理旧 release、快照和发布日志。

> 回滚只恢复到发布前那一刻：新版本运行期间写入的数据会随之丢弃。数据库快照
> 必须随代码一起恢复，因为 SQLite schema 升级后旧版本会拒绝打开新库。

### 进程托管

`manage.sh start` 启动 [`deploy/supervise.sh`](../deploy/supervise.sh)，由它
拉起并守护应用：

- 崩溃后重启；启动后 `QQ_BOT_STABLE_SECONDS` 内再次崩溃则退避时间翻倍，
  上限 `QQ_BOT_RESTART_MAX_DELAY_SECONDS`，配置错误时不会每 5 秒狂重启。
- `app.log` 超过 `QQ_BOT_LOG_MAX_BYTES` 时按 copytruncate 轮转，保留
  `QQ_BOT_LOG_KEEP` 份。
- 用 `flock` 保证同一根目录只有一个 supervisor。

`manage.sh` 和 `supervise.sh` 在未设置 `QQ_BOT_ROOT` 时会根据脚本所在位置推导
根目录，因此从 `current/deploy/` 或 `releases/<id>/deploy/` 调用都可以。

### QQ 菜单兜底同步

QQ 适配器默认在启动时根据插件导航同步单聊菜单、根据已注册命令同步指令面板
（`QQ_SYNC_NAVIGATION`）。需要脱离机器人手动恢复时：

```bash
pnpm deploy:menu
```

内容来自 [`deploy/qq-menu.json`](../deploy/qq-menu.json)（CI 会用
`pnpm validate:menu` 校验它）。自动与手动同步都只操作带
`qq-bot-managed:<scope>` 备注的面板，不会修改其他面板。

## Docker

```bash
docker build -t umx-bot .
docker run -d --name umx-bot \
  --env-file .env \
  -v umx-bot-data:/data \
  umx-bot
```

镜像要点：

- 多阶段构建，运行阶段基于 `node:24-alpine`，以 `node` 用户运行，只含
  `pnpm deploy --prod` 产出的应用与生产依赖。
- 数据库与健康快照位于卷 `/data`（`BOT_DATABASE_PATH=/data/bot.sqlite`）。
- 默认开启运维端点 `127.0.0.1:9095`，`HEALTHCHECK` 通过回环访问 `/healthz`。
  端点没有鉴权，不要把 `BOT_METRICS_HOST` 改成 `0.0.0.0` 后直接映射端口。
- 使用自定义清单时，把清单和插件挂载进容器并设置 `BOT_PLUGIN_MANIFEST`；
  npm 包型插件需要在构建镜像前加入 `@umx-bot/app` 的依赖。

Docker 部署没有上面的自动快照与回滚，升级前请自行备份 `/data`。
