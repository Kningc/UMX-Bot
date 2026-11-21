#!/usr/bin/env node
// SQLite snapshot tool used by deploy/remote-release.sh.
//
// A release may migrate the schema forward on start. Older builds refuse to
// open a newer schema, so rolling back the code alone leaves the bot unable to
// start. The deploy takes a snapshot before activating a release and restores
// it when that release fails its health check.
//
//   node scripts/db-snapshot.mjs backup <database> <snapshot>
//   node scripts/db-snapshot.mjs restore <snapshot> <database>
//
// Exit codes: 0 ok, 1 failure, 2 usage, 3 backup source does not exist.
// Both commands expect the bot to be stopped: backup is still consistent while
// it runs (VACUUM INTO reads one transaction), but writes made afterwards would
// be lost on restore, and restoring under a live process corrupts its view.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync
} from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const EXIT_NO_SOURCE = 3;

function fail(message, code = 1) {
  console.error(`db-snapshot: ${message}`);
  process.exit(code);
}

function checkIntegrity(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA integrity_check").get();
    if (row?.integrity_check !== "ok") {
      throw new Error(`integrity check failed for ${path}`);
    }
  } finally {
    database.close();
  }
}

function backup(source, target) {
  if (!existsSync(source)) {
    fail(`database does not exist: ${source}`, EXIT_NO_SOURCE);
  }
  mkdirSync(dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  rmSync(partial, { force: true });

  const database = new DatabaseSync(source);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    // Produces a compact, self-contained copy that includes WAL contents.
    database.prepare("VACUUM INTO ?").run(partial);
  } finally {
    database.close();
  }
  checkIntegrity(partial);
  renameSync(partial, target);
  console.log(`db-snapshot: backed up ${source} -> ${target}`);
}

function restore(snapshot, target) {
  if (!existsSync(snapshot)) {
    fail(`snapshot does not exist: ${snapshot}`);
  }
  checkIntegrity(snapshot);
  mkdirSync(dirname(target), { recursive: true });
  const staged = `${target}.restoring`;
  copyFileSync(snapshot, staged);
  // Stale WAL/SHM files from the newer schema would be replayed over the
  // restored main file, so they must go before it is swapped in.
  rmSync(`${target}-wal`, { force: true });
  rmSync(`${target}-shm`, { force: true });
  renameSync(staged, target);
  console.log(`db-snapshot: restored ${snapshot} -> ${target}`);
}

const [command, from, to] = process.argv.slice(2);
if (!from || !to || (command !== "backup" && command !== "restore")) {
  console.error(
    "usage: db-snapshot.mjs backup <database> <snapshot> | restore <snapshot> <database>"
  );
  process.exit(2);
}

try {
  if (command === "backup") {
    backup(from, to);
  } else {
    restore(from, to);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
