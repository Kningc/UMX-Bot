import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Runs the real deploy/remote-release.sh against a throwaway app root. The
// package manager and deploy/manage.sh are stubbed; the release logic, the
// lock, the database snapshot and the symlink swap are the real ones.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Stand-in for deploy/manage.sh. `start` records which release runs and, for
// a release containing MIGRATE, bumps the schema like a forward migration.
// `health` passes only for a release containing HEALTHY.
const fakeManage = `#!/bin/sh
set -eu
state="$QQ_BOT_ROOT/shared/fake-running"
echo "manage $1" >>"$QQ_BOT_ROOT/shared/manage.log"
case "$1" in
  stop) rm -f "$state" ;;
  start)
    release="$(readlink -f "$QQ_BOT_ROOT/current")"
    echo "$release" >"$state"
    if [ -f "$release/MIGRATE" ]; then
      node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec("PRAGMA user_version=99");d.close()' "$DB"
    fi
    ;;
  health)
    release="$(readlink -f "$QQ_BOT_ROOT/current")"
    [ -f "$state" ] && [ "$(cat "$state")" = "$release" ] && [ -f "$release/HEALTHY" ]
    ;;
esac
`;

let root: string;
let dbPath: string;

function userVersion(): number {
  const database = new DatabaseSync(dbPath);
  try {
    const row = database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    return row.user_version;
  } finally {
    database.close();
  }
}

function stageRelease(
  id: string,
  opts: { healthy: boolean; migrate?: boolean }
) {
  const dir = join(root, "releases", `.staging-${id}`);
  mkdirSync(join(dir, "deploy"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "apps/bot/dist"), { recursive: true });
  copyFileSync(
    join(repoRoot, "deploy/remote-release.sh"),
    join(dir, "deploy/remote-release.sh")
  );
  copyFileSync(
    join(repoRoot, "scripts/db-snapshot.mjs"),
    join(dir, "scripts/db-snapshot.mjs")
  );
  writeFileSync(join(dir, "deploy/manage.sh"), fakeManage);
  writeFileSync(join(dir, "deploy/supervise.sh"), "#!/bin/sh\n");
  writeFileSync(join(dir, "apps/bot/dist/main.js"), "export {};\n");
  if (opts.healthy) writeFileSync(join(dir, "HEALTHY"), "");
  if (opts.migrate) writeFileSync(join(dir, "MIGRATE"), "");
  return dir;
}

/** Puts a healthy release in place as `current`, as a previous deploy would. */
function installPrevious(id: string) {
  const staging = stageRelease(id, { healthy: true });
  const dir = join(root, "releases", id);
  spawnSync("mv", [staging, dir]);
  chmodSync(join(dir, "deploy/manage.sh"), 0o755);
  symlinkSync(dir, join(root, "current"));
  writeFileSync(join(root, "shared/fake-running"), `${realpathSync(dir)}\n`);
  return dir;
}

function deploy(id: string, env: Record<string, string> = {}) {
  return new Promise<{ status: number | null; output: string }>((resolve) => {
    const child = spawn(
      "sh",
      [
        join(root, "releases", `.staging-${id}`, "deploy/remote-release.sh"),
        root,
        id,
        "abc",
        "8"
      ],
      {
        env: {
          ...process.env,
          DB: dbPath,
          QQ_BOT_HEALTH_ATTEMPTS: "2",
          QQ_BOT_HEALTH_INTERVAL_SECONDS: "0",
          ...env
        }
      }
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", (status) => resolve({ status, output }));
  });
}

const currentTarget = () => realpathSync(join(root, "current"));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "qq-bot-deploy-")));
  dbPath = join(root, "shared/data/bot.sqlite");
  const bin = join(root, "runtime/node/bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, "shared/data"), { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  writeFileSync(join(bin, "corepack"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "corepack"), 0o755);
  writeFileSync(join(root, "shared/.env"), `BOT_DATABASE_PATH=${dbPath}\n`);

  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=1;");
  database.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)");
  database.exec("INSERT INTO kv VALUES ('owner', 'kept')");
  database.close();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("remote-release.sh", () => {
  it("activates a healthy release and snapshots the database first", async () => {
    installPrevious("20260101000000-aaaaaaa");
    stageRelease("20260102000000-bbbbbbb", { healthy: true });

    const result = await deploy("20260102000000-bbbbbbb");

    expect(result.output).toContain("release activated");
    expect(result.status).toBe(0);
    expect(currentTarget()).toBe(join(root, "releases/20260102000000-bbbbbbb"));
    expect(
      existsSync(join(root, "shared/backups/pre-20260102000000-bbbbbbb.sqlite"))
    ).toBe(true);
    // Stopped before the snapshot, started after the switch.
    const calls = readFileSync(join(root, "shared/manage.log"), "utf8");
    expect(calls.indexOf("manage stop")).toBeLessThan(
      calls.indexOf("manage start")
    );
    expect(existsSync(join(root, "shared/deploy.lock"))).toBe(false);
  });

  it("restores the pre-deploy database when a migrating release fails", async () => {
    const previous = installPrevious("20260101000000-aaaaaaa");
    stageRelease("20260102000000-bbbbbbb", { healthy: false, migrate: true });

    const result = await deploy("20260102000000-bbbbbbb");

    expect(result.status).toBe(1);
    expect(result.output).toContain("rolled back to 20260101000000-aaaaaaa");
    expect(currentTarget()).toBe(previous);
    // The failed release's migration (user_version 99) is gone.
    expect(userVersion()).toBe(1);
    const database = new DatabaseSync(dbPath);
    expect(
      database.prepare("SELECT v FROM kv WHERE k = 'owner'").get()
    ).toEqual({
      v: "kept"
    });
    database.close();
    expect(existsSync(join(root, "shared/deploy.lock"))).toBe(false);
  });

  it("says so loudly when the rollback target is unhealthy too", async () => {
    const previous = installPrevious("20260101000000-aaaaaaa");
    rmSync(join(previous, "HEALTHY"));
    stageRelease("20260102000000-bbbbbbb", { healthy: false });

    const result = await deploy("20260102000000-bbbbbbb");

    expect(result.status).toBe(1);
    expect(result.output).toContain("ROLLBACK FAILED");
  });

  it("reclaims a lock left by a dead process", async () => {
    installPrevious("20260101000000-aaaaaaa");
    stageRelease("20260102000000-bbbbbbb", { healthy: true });
    mkdirSync(join(root, "shared/deploy.lock"));
    // PIDs this large are never handed out.
    writeFileSync(join(root, "shared/deploy.lock/pid"), "999999999\n");

    const result = await deploy("20260102000000-bbbbbbb");

    expect(result.output).toContain("removing stale deploy lock");
    expect(result.status).toBe(0);
  });

  it("refuses to run while a live process holds the lock", async () => {
    installPrevious("20260101000000-aaaaaaa");
    stageRelease("20260102000000-bbbbbbb", { healthy: true });
    mkdirSync(join(root, "shared/deploy.lock"));
    writeFileSync(join(root, "shared/deploy.lock/pid"), `${process.pid}\n`);

    const result = await deploy("20260102000000-bbbbbbb");

    expect(result.status).toBe(1);
    expect(result.output).toContain("another deployment is already running");
    expect(readlinkSync(join(root, "current"))).toContain(
      "20260101000000-aaaaaaa"
    );
  });

  it("rejects a relative database path", async () => {
    installPrevious("20260101000000-aaaaaaa");
    stageRelease("20260102000000-bbbbbbb", { healthy: true });
    writeFileSync(
      join(root, "shared/.env"),
      "BOT_DATABASE_PATH=./data/bot.sqlite\n"
    );

    const result = await deploy("20260102000000-bbbbbbb");

    expect(result.status).toBe(1);
    expect(result.output).toContain("BOT_DATABASE_PATH must be absolute");
  });
});
