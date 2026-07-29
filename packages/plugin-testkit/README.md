# @qq-bot/plugin-testkit

In-memory integration host for testing qq-bot plugins with their real command,
event, middleware, storage and lifecycle runtime.

```ts
const host = createPluginTestHost();
await host.load(plugin, { config: { endpoint: "https://example.com" } });
await host.start();
const replies = await host.receive("/hello");
await host.emit("contact.added", {
  platform: "test",
  userId: "user-1",
  timestamp: new Date()
});
await host.stop();
```

`receive()` can inject attachments, mentions, bot mention state, timestamps and
raw platform data. `createPluginTestHost()` also accepts a custom `store` and
`logger` for persistence and diagnostics tests. Use `adapterCapabilities` to
stub recall, typing and streaming support.
