---
"@umx-bot/plugin-sdk": minor
"@umx-bot/core": minor
---

Add `commands.available(message)` and `navigation.available(message)`, which
list only what the message's author can use in its chat: they drop hidden
entries, other chats' scopes, roles above the author's and anything the access
policy blocks there (per-chat switches, the blocklist). `list()` is unchanged.

Add the `helpService` token and `HelpService` interface so plugins can render
the shared help page. When a command that has only subcommands gets none that
match, the kernel now replies with that help page if a plugin provides it, and
the built-in fallback list leaves out subcommands the author cannot run.
