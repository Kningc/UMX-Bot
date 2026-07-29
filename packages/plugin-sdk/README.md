# @qq-bot/plugin-sdk

Platform-neutral TypeScript contracts for qq-bot plugins.

```ts
import { definePlugin, PLUGIN_API_VERSION } from "@qq-bot/plugin-sdk";

export default definePlugin({
  name: "hello",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  setup(context) {
    context.commands.register({
      name: "hello",
      description: "Say hello",
      execute: (command) => command.reply("Hello")
    });
  }
});
```

Plugins execute as trusted in-process Node.js code. Install only plugins whose
source and publisher you trust.

The complete Chinese development guide is maintained in
`docs/plugin-development.md` in the framework repository.
