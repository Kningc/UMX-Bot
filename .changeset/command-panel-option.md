---
"@umx-bot/plugin-sdk": minor
"@umx-bot/core": minor
---

Add `panel` to command definitions (and `CommandSummary`): `false` keeps a
command out of platform command lists such as the QQ command panel while
`/help` still shows it, and `true` asks for it ahead of the plugin's other
commands. The QQ panel now takes at most five commands per plugin (preferring
`panel: true`, then featured, then other navigated commands), keeps up to five
slots for admin commands when it overflows, and logs a plugin's own overflow
at info level instead of warning.
