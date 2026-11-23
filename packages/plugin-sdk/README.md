# @umx-bot/plugin-sdk

Platform-neutral TypeScript contracts for UMX-Bot plugins.

```ts
import { definePlugin, PLUGIN_API_VERSION } from "@umx-bot/plugin-sdk";

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

Incoming messages expose replies through the optional `message.quote` field.
Its presence means the message quotes another message; `quote.content` contains
the original text supplied by the platform.

The complete development guide (Chinese) is
[docs/plugin-development.md](https://github.com/Kningc/UMX-Bot/blob/main/docs/plugin-development.md).
Plugins that need process isolation can instead speak the stdio JSON-RPC
protocol in
[docs/remote-plugins.md](https://github.com/Kningc/UMX-Bot/blob/main/docs/remote-plugins.md).
