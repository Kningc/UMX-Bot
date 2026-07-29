# @qq-bot/plugin-testkit

In-memory integration host for testing qq-bot plugins with their real command,
event, middleware, storage and lifecycle runtime.

```ts
const host = createPluginTestHost();
await host.load(plugin, { config: { endpoint: "https://example.com" } });
await host.start();
const replies = await host.receive("/hello");
await host.stop();
```
