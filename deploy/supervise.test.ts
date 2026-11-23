import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Runs the real deploy/supervise.sh against a throwaway app root. The "node"
// runtime is a shell stub whose behaviour each test scripts; flock is shimmed
// because macOS has none.

const supervisor = fileURLToPath(new URL("./supervise.sh", import.meta.url));

let root: string;
let child: ChildProcess | undefined;

function writeExecutable(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** The stub reads a run counter so a test can vary behaviour per attempt. */
function fakeNode(body: string) {
  writeExecutable(
    join(root, "runtime/node/bin/node"),
    `n=$(cat "${root}/runs" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"${root}/runs"\n${body}`
  );
}

function startSupervisor(env: Record<string, string> = {}) {
  child = spawn("sh", [supervisor], {
    env: {
      ...process.env,
      PATH: `${join(root, "shim")}:${process.env.PATH}`,
      QQ_BOT_ROOT: root,
      QQ_BOT_RESTART_DELAY_SECONDS: "1",
      QQ_BOT_RESTART_MAX_DELAY_SECONDS: "4",
      QQ_BOT_STABLE_SECONDS: "60",
      QQ_BOT_LOG_CHECK_SECONDS: "1",
      ...env
    },
    stdio: "ignore"
  });
  return child;
}

function stop(process: ChildProcess) {
  return new Promise<number>((resolve) => {
    const startedAt = Date.now();
    process.once("exit", () => resolve(Date.now() - startedAt));
    process.kill("SIGTERM");
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const supervisorLog = () =>
  readFileSync(join(root, "shared/logs/supervisor.log"), "utf8");
const delays = () =>
  [...supervisorLog().matchAll(/restarting in (\d+)s/g)].map((m) =>
    Number(m[1])
  );

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "umx-bot-supervise-")));
  mkdirSync(join(root, "runtime/node/bin"), { recursive: true });
  mkdirSync(join(root, "releases/r1/apps/bot/dist"), { recursive: true });
  mkdirSync(join(root, "shared"), { recursive: true });
  mkdirSync(join(root, "shim"));
  writeExecutable(join(root, "shim/flock"), "exit 0");
  symlinkSync(join(root, "releases/r1"), join(root, "current"));
  writeFileSync(join(root, "shared/.env"), "BOT_ADAPTER=console\n");
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    await stop(child);
  }
  child = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("supervise.sh", () => {
  it("doubles the restart delay on repeated crashes, up to the maximum", async () => {
    fakeNode("exit 1");
    startSupervisor();

    // Crash delays: 1 + 2 + 4 = 7s, then capped at 4.
    await sleep(7_800);

    expect(delays().slice(0, 4)).toEqual([1, 2, 4, 4]);
  }, 15_000);

  it("resets the delay after a run that stayed up", async () => {
    // Runs 1-2 crash at once, run 3 stays up past STABLE_SECONDS, run 4 crashes.
    fakeNode('if [ "$n" -eq 3 ]; then sleep 2; fi\nexit 1');
    startSupervisor({ QQ_BOT_STABLE_SECONDS: "2" });

    await sleep(6_800);

    expect(delays().slice(0, 3)).toEqual([1, 2, 1]);
  }, 15_000);

  it("stops promptly while waiting out a long backoff", async () => {
    fakeNode("exit 1");
    startSupervisor({
      QQ_BOT_RESTART_DELAY_SECONDS: "120",
      QQ_BOT_RESTART_MAX_DELAY_SECONDS: "120"
    });
    await sleep(800);
    expect(delays()).toEqual([120]);

    const took = await stop(child as ChildProcess);

    expect(took).toBeLessThan(3_000);
    expect(existsSync(join(root, "shared/supervisor.pid"))).toBe(false);
  }, 10_000);

  it("rotates app.log once it grows past the size limit", async () => {
    fakeNode('head -c 5000 /dev/zero | tr "\\0" x\nexec sleep 30');
    startSupervisor({ QQ_BOT_LOG_MAX_BYTES: "1000", QQ_BOT_LOG_KEEP: "2" });

    await sleep(2_500);

    const logs = join(root, "shared/logs");
    expect(statSync(join(logs, "app.log.1")).size).toBeGreaterThanOrEqual(5000);
    expect(statSync(join(logs, "app.log")).size).toBeLessThan(1000);
  }, 10_000);

  it("keeps the lock (fd 9) out of every child process", async () => {
    // A child holding fd 9 past the supervisor's exit keeps the flock, and the
    // next supervisor then exits silently: a deploy and its rollback both
    // failed that way. Each stub records whether it inherited the descriptor.
    const realSleep = execFileSync("sh", ["-c", "command -v sleep"], {
      encoding: "utf8"
    }).trim();
    const probe = (who: string) =>
      `if { : >&9; } 2>/dev/null; then echo ${who} >>"${root}/leaks"; fi`;
    writeExecutable(
      join(root, "shim/sleep"),
      `${probe("sleep")}\nexec ${realSleep} "$@"`
    );
    // Appends rather than rewriting a counter: stopping the supervisor can
    // kill this stub mid-write, and a truncated counter would read as 0.
    writeExecutable(
      join(root, "runtime/node/bin/node"),
      `${probe("node")}\necho probed >>"${root}/probed"\nexit 1`
    );
    const process = startSupervisor();
    await sleep(2_500);
    await stop(process);

    expect(readFileSync(join(root, "probed"), "utf8")).toContain("probed");
    expect(existsSync(join(root, "leaks"))).toBe(false);
  });

  it("rejects a non-numeric setting", async () => {
    fakeNode("exit 1");
    const process = startSupervisor({ QQ_BOT_LOG_KEEP: "lots" });
    const code = await new Promise((resolve) => process.once("exit", resolve));
    expect(code).toBe(2);
  });
});
