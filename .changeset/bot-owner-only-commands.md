---
"@umx-bot/plugin-sdk": minor
"@umx-bot/core": minor
---

Separate group owners from bot owners. `MessageAuthor` gains an optional `botOwner` flag that the kernel sets only for `ownerIds` (`BOT_OWNER_IDS`) and strips when an adapter supplies it. Commands and subcommands gain `botOwnerOnly`, enforced by the command router and reported in command summaries. `StoreAccessPolicy` now exempts only bot owners from the blocklist, so a platform group owner can be blocked. The bundled `/plugin`, `/config set-global`/`reset-global` and `/acl block`/`unblock`/`blocked` commands now require a bot owner instead of any `owner`, so a QQ group owner can no longer change bot-wide state.
