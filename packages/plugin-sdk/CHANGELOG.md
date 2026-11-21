# @qq-bot/plugin-sdk

## 0.6.0

### Minor Changes

- [#2](https://github.com/Kningc/UMX-Bot/pull/2) [`b8d0abf`](https://github.com/Kningc/UMX-Bot/commit/b8d0abfc1f7e54fd95757d24dd57bcae19c77fa9) Thanks [@Kningc](https://github.com/Kningc)! - 四个公共包同版本发布（`fixed` 分组），本次的公开 API 变化：
  
  **plugin-sdk**
  - `KeyValueStore` 新增可选的 `list(prefix, { limit, after })`，并导出
    `ListableKeyValueStore`、`KeyValueEntry`、`KeyValueListOptions` 和类型守卫
    `supportsListing()`。可选是因为不是所有存储都能枚举键；缺失必须当成“无法枚举”，
    不能当成“没有数据”。
  
  **core**
  - `BotKernel.load()` 现在允许在 `running` 状态调用，新增 `unload(name)` 和
    `getNavigation()`。运行中加载的插件不会收到 `bot.ready`；变更后会重新同步导航。
  - `BotKernelOptions.ownerIds`：名单里的用户在任何会话都按 `owner` 处理。
  - `BotKernelHealth.metrics` 新增必填的 `processingLatency` 直方图。只读取健康
    快照的代码不受影响，但手工构造这个对象的测试需要补上该字段。
  - `MemoryStore` 实现 `list()`；插件的 `context.store` 与 `context.state` 会在底层
    存储支持时转发 `list()`，键相对插件自己的命名空间。
  - 命令的通过/拒绝/失败写入 `audit: "command"` 日志，不含消息正文和参数。
  
  **plugin-testkit**
  - `PluginTestHost.getNavigation()`。
  - `adapterConformanceChecks()`：把 `BotAdapter` 契约固化成可执行检查。
