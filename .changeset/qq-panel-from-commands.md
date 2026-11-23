---
"@umx-bot/plugin-sdk": minor
"@umx-bot/core": minor
---

`BotAdapter.syncNavigation` now receives the registered commands as an
optional second argument, and the kernel passes them. The QQ adapter uses
them to build the command panel from commands (one entry per top-level
command, help and featured commands first, admin ones last and marked
`only_admin`, hidden and bot-owner-only ones left out) instead of from
navigation items. The `panel` navigation surface is deprecated and no longer
affects the QQ panel. Adapters that ignore the new argument keep working.
