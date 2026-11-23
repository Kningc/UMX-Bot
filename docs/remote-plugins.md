# Out-of-process plugins

A remote plugin runs in its own child process and talks to the bot over
**newline-delimited JSON-RPC 2.0 on stdin/stdout**. It is for plugins that are
untrusted, heavy (an AI client holding large state), crash-prone, or not
written in TypeScript. The host side lives in
[`apps/bot/src/remote-plugin.ts`](../apps/bot/src/remote-plugin.ts) and
presents the child as an ordinary `BotPlugin`, so loading, unloading,
dependencies, permissions and metrics work as for in-process plugins. Plugin
API v2 is unchanged.

Protocol version: **1.1**. A child announces the version it speaks in `hello`;
the host accepts `1` and `1.1` and answers with the announced one. Everything
marked *(1.1)* below is refused with `-32004` for a child that announced `1`;
1.1 is otherwise a strict superset, so existing protocol 1 children keep
working unchanged. A runnable client and plugin are in
[`examples/remote-echo`](../examples/remote-echo).

## Isolation model

- The child gets **no bot secrets**: its environment is, by default, only
  `PATH` plus the manifest's `remote.env`. Host variables must be named
  explicitly in `remote.inheritEnv` (for example `HTTPS_PROXY`, `HOME`, `LANG`,
  `TMPDIR`); later sources win (`env` over `inheritEnv` over `PATH`). Config (including `secrets`) reaches it only through
  `initialize`.
- A remote plugin is **always restricted** (see Permissions). It cannot use
  `services`, context extensions, middleware or outbound hooks; those are not
  in the protocol.
- A child can only **reply to messages the host delivered to it** (command
  invocations and `message.created` events) while they are inside the *reply
  window* (below), and only **recall messages it sent**. It cannot forge a passive reply to a message
  it never saw.
- Media can only be sent **by URL**; inline bytes and streams do not cross the
  protocol.
- Isolation is process-level, not an OS sandbox: a child can still touch the
  filesystem and network as the bot's user. Run it in a container for hostile
  code.

## Transport

- One JSON-RPC 2.0 message per line, UTF-8, `\n` terminated, at most 1 MiB.
  Both sides send requests, responses and notifications.
- **stdout carries protocol lines only.** A stdout line that is not valid
  JSON-RPC is logged as a warning and ignored. **stderr** is free-form: each
  line is logged at `info` as the plugin's output.
- The child **must exit when its stdin closes** (the host is gone), and must
  answer `shutdown` (below).
- Ids are numbers chosen by the sender. Requests can be answered out of order.

Error codes: `-32700/-32600/-32601/-32602/-32603` are the JSON-RPC standard
ones. Additions: `-32001` permission denied (`error.data.permission` names the
power), `-32002` timeout, `-32003` unavailable (not initialised, restarting,
closed), `-32004` unsupported (for example `store.list` on a store that cannot
list, or inline media).

## Lifecycle

```
host                                   child
 | spawn ───────────────────────────────▶ |
 | ◀─────────────── request hello ─────── |   identity, permissions, requires
 | ─ result {protocol, host} ───────────▶ |
 |        (bot.load: checks permissions, requires, dependencies)
 | ─ request initialize ────────────────▶ |   config, grantedPermissions
 | ◀── commands.register / events.subscribe / settings.define … ──|
 | ◀────────────── result ─────────────── |   plugin is now loaded
 |  … command.execute, event …            |
 | ─ request shutdown ──────────────────▶ |   on unload / bot stop
 | ◀────────────── result ─────────────── |   then the child exits
```

### 1. Handshake: `hello` (child → host, request)

The child sends it first, once.

```json
{"jsonrpc":"2.0","id":1,"method":"hello","params":{
  "protocol":1.1,
  "name":"remote-echo",
  "version":"1.0.0",
  "apiVersion":2,
  "description":"optional",
  "help":{"title":"Echo","order":50},
  "permissions":["messages.active"],
  "requires":["messages.recall"]
}}
```

| field | rules |
| --- | --- |
| `protocol` | `1` or `1.1` |
| `name` | `[a-z0-9][a-z0-9._-]*`; becomes the plugin name (command namespace, store prefix, metric prefix); the host-reserved names `access`, `adapter`, `core`, `host`, `kernel` and `scheduler` fail the load |
| `version` | SemVer |
| `apiVersion` | `1` or `2` (default `2`) |
| `permissions` | subset of `messages.active`, `events.emit`, `scheduler` *(1.1 only)*. `middleware` and `outbound` are rejected: the protocol has no calls for them |
| `requires` | host capabilities (`messages.recall`, `messages.typing`, `messages.stream`); checked at load time like an in-process plugin |

The host answers `{"protocol":1.1,"host":"umx-bot"}` or an error (`-32602`) and
then kills the child. `host` is informational (it read `qq-bot` before the
rename); clients should not branch on it. No `hello` within `handshakeTimeoutMs` fails the load.

### 2. `initialize` (host → child, request)

```json
{"protocol":1.1,"pluginName":"remote-echo","config":{…},"grantedPermissions":["messages.active"]}
```

The child registers everything it needs (commands, subscriptions, settings)
**before it replies**; the reply completes the load. Calls before `initialize`
arrives are rejected with `-32003`. An error reply, a timeout
(`initializeTimeoutMs`) or an exit fails the load and kills the child.

### 3. `shutdown` (host → child, request)

Sent when the plugin is unloaded or the bot stops. The child replies, flushes
and exits. If it has not exited `shutdownGraceMs` later the host sends SIGKILL.

## Child → host calls

Error `-32005` (cancelled) is new in 1.1. All calls are requests; all validate their params (`-32602`) and honour
permissions (`-32001`).

### Commands

`commands.register`

```json
{"name":"echo","description":"Echo text","aliases":["say"],"permission":"member",
 "usage":"<text>","examples":[{"args":"hi","description":"…"}],"hidden":false,
 "cooldownMs":1000,"scopes":["group","direct"],"fallback":true,
 "subcommands":[{"name":"upper","description":"…", "aliases":[], "permission":"admin"}]}
```

Fields mirror `CommandDefinition`. `args` *(1.1)* is a declarative
`defineArgs` spec as JSON (positional, in property order):
`{"count":{"type":"integer","min":1},"word":{"type":"string","choices":["a","b"],"optional":true},"text":{"type":"string","rest":true}}`.
Types are `string` (`choices`, `rest`), `number`/`integer` (`min`, `max`) and
`boolean`; all accept `optional` and `description`; names match
`[a-z][A-Za-z0-9]*`. The host validates arguments before the child runs (the
user gets the usual argument error and usage), and passes the result as
`parsed` in `command.execute`. Without `args`, parse `rawArgs` yourself. `fallback: true` makes the parent command itself runnable when a
command has subcommands (a command without subcommands is always runnable).
Access policy, cooldown, scope and permission checks run on the host before the
child is called. Registrations disappear when the child crashes and are
re-created when it restarts.

### Events

- `events.subscribe` `{event}`: subscribe to a built-in event
  (`message.created`, `contact.added`, `interaction.created`, …). Delivery is a
  `event` notification (below). Subscriptions are per process; subscribe again
  after a restart (you do, because `initialize` runs again).
- `events.emit` `{event, payload}`: emit `<name>.…` for other plugins. Needs
  `events.emit`.

### Messages

- `messages.reply` `{messageId, content}`: reply to a message the host
  delivered. `messageId` is `message.id` from `command.execute` or a
  `message.created` event.
- `messages.send` `{message}` where `message` is
  `{conversationId, scope, content, delivery, reference?}`. `delivery` is
  `{"type":"passive","target":{"type":"message","messageId":…}}` (must be a
  message delivered to this child, in the same conversation), or
  `{"type":"active","idempotencyKey":…}` / `{"type":"platform",…}`, which need
  `messages.active`.
- `messages.recall` `{id, message}`: recall a message this plugin sent.

`content` is a string or `{text?, markdown?, keyboard?, media?}` where `media`
entries are `{type, source:{type:"url",url}, filename?, contentType?}`. Calls
return the `SentMessage` as JSON.

### Store

`store.get {key}` (→ value or `null`), `store.set {key, value, ttlMs?}`,
`store.delete {key}` (→ boolean), `store.list {prefix, limit?, after?}`
(→ `[{key,value}]`). The store is private to the plugin. There is no `update`
(a callback cannot run atomically over RPC). Use
`store.compareAndSet {key, expected, value}` *(1.1)* instead: it sets `value`
only if the current value structurally equals `expected` (key order does not
matter) and returns `{swapped, current}`. `null` stands for "absent" in both
`expected` and `value` (a `null` `value` deletes the key), so a stored `null`
cannot be told apart from a missing key. Retry on `swapped: false`; the
example's `count` subcommand shows the loop.

### Scheduler *(1.1, needs the `scheduler` permission)*

- `scheduler.every {name, intervalMs, runImmediately?, overlap?}`
- `scheduler.cron {name, expression, timezone?: "local"|"utc", overlap?, catchUp?}`
- `scheduler.at {name, when}` (`when` is an ISO date; runs once, then the name
  is free again)
- `scheduler.cancel {name}` (→ whether a task was removed)

`overlap` is `"skip"` or `"allow"`. Names are unique per plugin (a duplicate is
`-32602`). The host runs the task through its own scheduler, so the per-task
metrics, overlap handling and cron catch-up apply as for in-process plugins,
and a failing task is counted as failed. Each run is a `task.run` request to
the child (below).

Tasks live and die with the process: when the child crashes the host drops all
of them, and the child re-registers them in `initialize` after a restart.

### Settings

`settings.define {key, defaults}` once per key (repeating is a no-op),
`settings.get {key, target:{platform,scope,conversationId}}`,
`settings.set {key, scope, overrides}`, `settings.reset {key, scope}`, where
`scope` is a `SettingsScope` (`{"level":"global"}`,
`{"level":"conversation","platform":…,"scope":…,"conversationId":…}`, …).
Defined settings show up in the host's settings catalog like any plugin's.

### Metrics

Exported as `qq_bot_plugin_<plugin>_<name>`. The metric is created on first use
from the call's `name`, `help` and optional `labelNames`/`buckets`; at most 64
per plugin, names `[a-z][a-z0-9_]*`, and a name keeps its kind.

`metrics.counter.inc {name, help, labels?, value?}`,
`metrics.gauge.set {…, value}`, `metrics.gauge.add {…, value}`,
`metrics.histogram.observe {…, value}`. Keep label values low-cardinality.

The host also exports `…_up` (gauge) and `…_restarts_total` (counter) for each
remote plugin.

### Logging

`log` notification `{level:"debug"|"info"|"warn"|"error", message, data?}`.

## Host → child calls

### `command.execute` (request)

```json
{"command":"echo","subcommand":"upper","args":["hi"],"rawArgs":"hi",
 "message":{"id":"…","platform":"qq","scope":"group","conversationId":"…",
            "author":{"id":"…","role":"member"},"content":"/echo upper hi",
            "attachments":[],"mentions":[],"timestamp":"2026-01-01T00:00:00.000Z"}}
```

Dates are ISO strings; the adapter's `raw` payload is never sent. The result is
either empty or `{"reply": <content>}`, which the host sends as the reply. The
child may also reply itself with `messages.reply` before returning. The call
times out after `commandTimeoutMs`; the user then sees the generic failure
message, and the child keeps running.

### `command.cancel` and `task.cancel` (notifications) *(1.1)*

`command.execute` carries an `invocationId`. When `commandTimeoutMs` fires the
host sends `command.cancel {invocationId}` and fails the command. Pass the same
`invocationId` in `messages.reply` / `messages.send`: for a cancelled
invocation they are refused with `-32005`, so a slow AI reply does not appear
after the user was told the command failed. Replies without an `invocationId`
are not checked. Likewise `task.cancel {name}` is sent when a task run exceeds
`taskTimeoutMs` (default 60s) or the host aborts it.

### `task.run` (request) *(1.1)*

`{"name":"tick"}`; reply when the run is finished. Overlap and timing are
enforced by the host's scheduler.

### Reply window

Delivered messages are remembered **per conversation**: at most 64 each
(`replyWindow.perConversation`), at most 1024 overall (`replyWindow.total`,
least recently used conversation evicted first), and each for 10 minutes
(`replyWindow.ttlMs`). A busy group therefore cannot push a quiet chat's
message out of the window, and a slow reply still works for ten minutes.

### `event` (notification)

`{"event":"message.created","payload":{…}}`. Fire-and-forget: a slow child never
blocks the bot's event bus.

## Permissions

The model is the existing one (`PLUGIN_PERMISSIONS`), with one difference: a
remote plugin is **always restricted**, even if it declares none, so the
unrestricted legacy mode is never available to a child.

- The effective set is the manifest's `permissions` when present, otherwise what
  the child declared in `hello`.
- A child that declares a power the manifest does not grant **fails to load**
  (and the child is killed).
- A restricted call returns `-32001` with `data.permission`.
- Without `messages.active` a child can only reply passively.

## Crashes, timeouts and restarts

| situation | behaviour |
| --- | --- |
| no `hello` | load fails after `handshakeTimeoutMs` (10s), child killed |
| `initialize` fails / times out | load fails (`initializeTimeoutMs`, 30s), child killed |
| command exceeds `commandTimeoutMs` (30s) | that command fails; child stays |
| child exits while running | its commands/subscriptions are unregistered, in-flight calls fail with `-32003`, restart is scheduled |
| restart | wait `min(maxDelayMs, baseDelayMs·2^(n−1))` (500ms base, 30s cap), spawn, `hello` (must match the original name, version, apiVersion, protocol, permissions and requires; a mismatch is logged as `changed its identity (version: 1.0.0 -> 1.0.1)` naming each field and counts as a failed restart), `initialize` again |
| too many crashes | after `maxRestarts` (5) consecutive failures the plugin stays stopped (`failed`; the kernel still lists it, its commands and tasks are gone); the counter resets after `stableAfterMs` (30s) of uptime. `/plugin reload <name>` spawns a fresh child and recovers it |
| unload / bot stop | `shutdown`, wait `shutdownGraceMs` (3s), then SIGKILL; pending restarts are cancelled |
| oversized line | child is killed (and restarted per policy) |

While a child is restarting its commands behave as unregistered.

## Manifest entry

In `plugins.json` a `remote` object replaces module import. `specifier` is only
an identifier (use `remote:<name>`):

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "specifier": "remote:echo",
      "permissions": [],
      "config": { "greeting": "hi" },
      "secrets": { "apiKey": "ECHO_API_KEY" },
      "remote": {
        "command": "node",
        "args": ["echo/plugin.mjs"],
        "cwd": ".",
        "name": "echo",
        "env": { "LOG_LEVEL": "info" },
        "inheritEnv": ["HTTPS_PROXY", "HOME", "LANG", "TMPDIR"],
        "handshakeTimeoutMs": 10000,
        "initializeTimeoutMs": 30000,
        "commandTimeoutMs": 30000,
        "taskTimeoutMs": 60000,
        "shutdownGraceMs": 3000,
        "replyWindow": { "ttlMs": 600000, "perConversation": 64, "total": 1024 },
        "restart": { "maxRestarts": 5, "baseDelayMs": 500, "maxDelayMs": 30000, "stableAfterMs": 30000 }
      }
    }
  ]
}
```

- `command` is executed without a shell. `cwd` is resolved against the
  manifest's directory (default: that directory); `args` are passed as given.
- `config` and `secrets` work as for module plugins and arrive in `initialize`.
- `name` (optional) is the plugin name the child must announce; any other name
  fails the handshake. With it, `/plugin list`, `enable`, `disable` and `reload`
  use the plugin name, even while the plugin is not running. Without it the
  name is only known once the child runs, so a stopped remote plugin can only
  be enabled by specifier (`remote:echo`).
- `inheritEnv` lists host environment variable names copied into the child;
  unset ones are skipped. Keep it minimal: anything listed is visible to the
  (possibly untrusted) child.
- `enabled: false`, dependency ordering and `plugin-admin` enable/disable/reload
  all work. `reload` starts a fresh child (there is no module cache).
- The child is started when the manifest is resolved and killed again if the
  plugin then fails to load, if dependency sorting fails, or if a later enable
  or reload fails; no child outlives a failed load.

## Writing a child

`examples/remote-echo/client.mjs` is a ~60-line, dependency-free client (request
/ notify / handler registry, automatic `shutdown` handling and exit on stdin
close). Any language works: read lines from stdin, write lines to stdout.
Minimal session:

```
→ {"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":1.1,"name":"hi","version":"1.0.0"}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol":1.1,"host":"umx-bot"}}
← {"jsonrpc":"2.0","id":1,"method":"initialize","params":{…}}
→ {"jsonrpc":"2.0","id":1,"method":"commands.register","params":{"name":"hi","description":"Say hi","fallback":true}}
← {"jsonrpc":"2.0","id":1,"result":null}
→ {"jsonrpc":"2.0","id":1,"result":null}          (answer to initialize)
← {"jsonrpc":"2.0","id":2,"method":"command.execute","params":{…}}
→ {"jsonrpc":"2.0","id":2,"result":{"reply":"hi!"}}
```

(`→` child to host, `←` host to child; ids of the two directions are
independent.)

## Not in protocol v1

Navigation pages, middleware, outbound hooks, services and context extensions,
interaction (callback button) handlers, and message streams/typing. All are
additive for a future protocol minor version.
