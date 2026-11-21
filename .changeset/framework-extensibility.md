---
"@qq-bot/plugin-sdk": minor
"@qq-bot/plugin-sdk-qq": minor
"@qq-bot/core": minor
"@qq-bot/plugin-testkit": minor
---

Plugin API v2: extensibility pass. Everything is additive; plugins that declare
`apiVersion` 1 (or none) keep working unchanged.

- **Commands**: subcommands, typed arguments (`defineArgs`, `defineCommand`,
  `defineSubcommand`), per-command chat `scopes`, a per-message `logger` on
  `CommandContext`, and a `command.executed` event.
- **Access control**: a pluggable `AccessPolicy` gate and the default
  `StoreAccessPolicy` (per-conversation plugin/command switches, user blocklist).
- **Hooks**: outbound message hooks (`context.outbound`), callback-button routing
  (`context.interactions`, `InteractionEvent.data`) and plugin-emitted events
  (`context.events.emit`, `<plugin>.*` namespace).
- **Host extensibility**: `contextExtensions`, `requires`, and plugin
  `permissions` (`PLUGIN_PERMISSIONS`, `PermissionError`) enforced for active
  delivery, scheduler, middleware, outbound hooks and event emission.
- **Observability**: per-plugin metrics (`context.metrics`) plus per-command and
  per-task metrics, exported through `BotKernel.getMetricsText()`.
- **Scheduling**: `scheduler.cron()` (with persisted catch-up) and `scheduler.at()`.
- **Storage**: `KeyValueStore.set(…, { ttlMs })`, `createCollection()`, and a
  `SettingsCatalog` (`BotKernel.settings`) for generic settings tooling.
- **Testkit**: `ownerIds`, `accessPolicy`, `contextExtensions`, `unload()`,
  `flush()` and `getMetricsText()` on `PluginTestHost`.
