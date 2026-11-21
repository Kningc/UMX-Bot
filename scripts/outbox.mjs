#!/usr/bin/env node
import process from "node:process";
// 主动消息 Outbox 运维工具。
//
// 适配器对 `uncertain` 记录一律拒绝自动重发：消息可能已经送达，重发会打扰用户。
// 这些记录必须由人判断，所以需要一个不依赖机器人进程、直接读写 SQLite 的入口。
import { DatabaseSync } from "node:sqlite";

const STATUSES = new Set(["pending", "sending", "sent", "uncertain"]);
const DEFAULT_LIMIT = 50;

function usage() {
  console.log(`用法:
  node scripts/outbox.mjs list [options]
  node scripts/outbox.mjs show <idempotency-key> [options]
  node scripts/outbox.mjs resolve <idempotency-key> --as <sent|discard> --confirm [options]

选项:
  --db <path>       SQLite 路径，默认取 BOT_DATABASE_PATH 或 ./data/bot.sqlite
  --app-id <id>     只看某个 AppID，默认取 QQ_APP_ID；都没有则列出全部
  --status <s>      过滤状态: ${[...STATUSES].join(" | ")}
  --limit <n>       最多输出条数，默认 ${DEFAULT_LIMIT}
  --json            输出 JSON 而不是表格

resolve 会修改生产数据，必须显式带 --confirm：
  --as sent         标记为已送达（确认用户确实收到了）
  --as discard      删除记录（确认没有送达，之后允许同一幂等键重发）`);
}

function parseArgs(argv) {
  const options = {
    db: process.env.BOT_DATABASE_PATH ?? "./data/bot.sqlite",
    appId: process.env.QQ_APP_ID,
    limit: DEFAULT_LIMIT,
    json: false,
    confirm: false
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${argument} 需要一个值`);
      }
      index += 1;
      return value;
    };
    switch (argument) {
      case "--db":
        options.db = next();
        break;
      case "--app-id":
        options.appId = next();
        break;
      case "--status": {
        const status = next();
        if (!STATUSES.has(status)) {
          throw new Error(`未知状态 "${status}"`);
        }
        options.status = status;
        break;
      }
      case "--limit": {
        const limit = Number.parseInt(next(), 10);
        if (!Number.isSafeInteger(limit) || limit <= 0) {
          throw new Error("--limit 必须是正整数");
        }
        options.limit = limit;
        break;
      }
      case "--as":
        options.as = next();
        break;
      case "--json":
        options.json = true;
        break;
      case "--confirm":
        options.confirm = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        if (argument.startsWith("-")) {
          throw new Error(`未知选项 "${argument}"`);
        }
        positional.push(argument);
    }
  }
  return { options, positional };
}

function openDatabase(path, readOnly) {
  const database = new DatabaseSync(path, { readOnly });
  // 机器人进程可能正持有 WAL 写锁，等一会儿而不是立刻失败。
  database.exec("PRAGMA busy_timeout = 5000;");
  return database;
}

function outboxPrefix(appId) {
  return appId
    ? `adapter:qq-official:${appId}:outbox:`
    : "adapter:qq-official:";
}

function decodeKey(key) {
  const encoded = key.slice(key.lastIndexOf(":outbox:") + ":outbox:".length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function readEntries(database, options) {
  const prefix = outboxPrefix(options.appId);
  const rows = database
    .prepare(`
      SELECT key, value, updated_at FROM plugin_kv
      WHERE key >= :prefix AND substr(key, 1, :length) = :prefix
      ORDER BY key
    `)
    .all({ prefix, length: prefix.length });
  const entries = [];
  for (const row of rows) {
    if (!String(row.key).includes(":outbox:")) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(String(row.value));
    } catch {
      entries.push({
        key: String(row.key),
        idempotencyKey: decodeKey(String(row.key)),
        status: "corrupt",
        updatedAt: String(row.updated_at),
        raw: String(row.value)
      });
      continue;
    }
    if (options.status && record.status !== options.status) {
      continue;
    }
    entries.push({
      key: String(row.key),
      idempotencyKey: decodeKey(String(row.key)),
      status: record.status,
      updatedAt: record.updatedAt ?? String(row.updated_at),
      sentCount: record.sentCount,
      error: record.error,
      receiptId: record.receipt?.id,
      stream: record.stream ? { nextIndex: record.stream.nextIndex } : undefined
    });
  }
  return entries;
}

function printTable(entries) {
  if (entries.length === 0) {
    console.log("没有符合条件的 Outbox 记录。");
    return;
  }
  for (const entry of entries) {
    const parts = [
      `${entry.status.padEnd(9)} ${entry.updatedAt}`,
      `  key       ${entry.idempotencyKey}`
    ];
    if (entry.receiptId) parts.push(`  receipt   ${entry.receiptId}`);
    if (entry.sentCount !== undefined) {
      parts.push(`  sentCount ${entry.sentCount}`);
    }
    if (entry.stream) {
      parts.push(`  stream    nextIndex=${entry.stream.nextIndex}`);
    }
    if (entry.error) parts.push(`  error     ${entry.error}`);
    console.log(parts.join("\n"));
    console.log("");
  }
  const uncertain = entries.filter(
    (entry) => entry.status === "uncertain"
  ).length;
  console.log(`共 ${entries.length} 条，其中 uncertain ${uncertain} 条。`);
  if (uncertain > 0) {
    console.log(
      "uncertain 表示发送结果未知。先到 QQ 会话里确认消息是否真的送达，" +
        "再用 resolve 标记 sent 或 discard。"
    );
  }
}

function main(argv) {
  const { options, positional } = parseArgs(argv);
  const [command, target] = positional;
  if (options.help || !command) {
    usage();
    return 0;
  }

  if (command === "list" || command === "show") {
    const database = openDatabase(options.db, true);
    try {
      let entries = readEntries(database, options);
      if (command === "show") {
        if (!target) {
          throw new Error("show 需要一个幂等键");
        }
        entries = entries.filter((entry) => entry.idempotencyKey === target);
      }
      entries = entries.slice(0, options.limit);
      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
      } else {
        printTable(entries);
      }
      return entries.some((entry) => entry.status === "uncertain") ? 2 : 0;
    } finally {
      database.close();
    }
  }

  if (command === "resolve") {
    if (!target) {
      throw new Error("resolve 需要一个幂等键");
    }
    if (options.as !== "sent" && options.as !== "discard") {
      throw new Error("resolve 需要 --as sent 或 --as discard");
    }
    const database = openDatabase(options.db, true);
    let entry;
    try {
      entry = readEntries(database, { ...options, status: undefined }).find(
        (candidate) => candidate.idempotencyKey === target
      );
    } finally {
      database.close();
    }
    if (!entry) {
      console.error(`找不到幂等键 "${target}" 对应的记录。`);
      return 1;
    }
    if (entry.stream && options.as === "sent") {
      console.error(
        "这是一条流式消息记录。适配器恢复流时只读取 stream 状态、不看 status，" +
          "所以标记 sent 不会改变它的行为。\n" +
          "请通过适配器的流式 retry/abort 接口处理；如果确认整条流都没有送达、" +
          "可以接受重开一条新流，再用 --as discard。"
      );
      return 1;
    }
    console.log(`将要处理: ${entry.status} ${entry.idempotencyKey}`);
    console.log(
      options.as === "sent"
        ? "标记为 sent：之后同一幂等键会被当成已发送而拒绝重发。"
        : "删除记录：之后同一幂等键可以重新发送，可能造成重复消息。"
    );
    if (!options.confirm) {
      console.error("未加 --confirm，没有做任何修改。");
      return 1;
    }
    const writable = openDatabase(options.db, false);
    try {
      if (options.as === "discard") {
        writable.prepare("DELETE FROM plugin_kv WHERE key = ?").run(entry.key);
        console.log("已删除。");
      } else {
        const row = writable
          .prepare("SELECT value FROM plugin_kv WHERE key = ?")
          .get(entry.key);
        const record = JSON.parse(String(row.value));
        record.status = "sent";
        record.updatedAt = new Date().toISOString();
        record.resolvedBy = "scripts/outbox.mjs";
        writable
          .prepare(
            "UPDATE plugin_kv SET value = ?, updated_at = ? WHERE key = ?"
          )
          .run(JSON.stringify(record), new Date().toISOString(), entry.key);
        console.log("已标记为 sent。");
      }
    } finally {
      writable.close();
    }
    return 0;
  }

  console.error(`未知命令 "${command}"`);
  usage();
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
