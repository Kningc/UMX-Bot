# Plugin starter

新插件的起点。推荐用脚手架生成，包名、插件名、类型名、测试和 README 会一并改好：

```bash
pnpm create:plugin my-plugin            # 生成到 plugins/my-plugin
pnpm create:plugin weather --dir ../my-plugins/weather --scope @me
```

也可以手动复制此目录，再修改包名、插件名、命令和测试。模板参与主工作区的构建、
严格类型检查和 Vitest 回归，因此始终与当前 SDK 保持同步。

完整 API 见 [插件开发](../../docs/plugin-development.md)。
