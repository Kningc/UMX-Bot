---
"@umx-bot/core": patch
---

Reserve the plugin names `access`, `adapter`, `core`, `host`, `kernel` and
`scheduler`: a plugin's store lives in the host's store under `<name>:`, so a
plugin with one of these names could read and write host records (access rules,
gateway sessions, the Outbox, cron state) regardless of its permissions.

`unloadAll()` now unloads dependents first and no longer stops half-way when a
plugin was hot-loaded after a plugin that optionally depends on it.

A command's cooldown starts only after its arguments parse, so a typo no longer
locks the user out for the whole period.
