import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const auditDirectory = await mkdtemp(
  join(tmpdir(), "qq-bot-package-audit-")
);
const consumerDirectory = join(auditDirectory, "consumer");

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: workspace,
    stdio: "inherit",
    ...options
  });
}

function pack(packageDirectory) {
  run("corepack", [
    "pnpm",
    "--dir",
    packageDirectory,
    "pack",
    "--pack-destination",
    auditDirectory
  ]);
}

function install(tarballs) {
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toLowerCase().startsWith("npm_config_")
    )
  );
  run(
    "npm",
    [
      "install",
      "--prefix",
      consumerDirectory,
      ...tarballs,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline"
    ],
    {
      env: {
        ...cleanEnvironment,
        npm_config_cache: join(auditDirectory, "npm-cache")
      }
    }
  );
}

try {
  for (const packageDirectory of [
    "packages/plugin-sdk",
    "packages/core",
    "packages/plugin-sdk-qq",
    "packages/plugin-testkit"
  ]) {
    pack(packageDirectory);
  }

  const tarballs = (await readdir(auditDirectory))
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(auditDirectory, file));
  const findTarball = (pattern) => {
    const tarball = tarballs.find((file) => pattern.test(file));
    if (!tarball) {
      throw new Error(`package audit did not produce ${String(pattern)}`);
    }
    return tarball;
  };

  await mkdir(consumerDirectory, { recursive: true });
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "qq-bot-package-audit",
        private: true,
        type: "module"
      },
      null,
      2
    )}\n`
  );

  install([findTarball(/qq-bot-plugin-sdk-(?!qq-)\d/u)]);
  install([
    findTarball(/qq-bot-core-\d/u),
    findTarball(/qq-bot-plugin-sdk-qq-\d/u)
  ]);
  install([findTarball(/qq-bot-plugin-testkit-\d/u)]);

  for (const packageName of [
    "@qq-bot/plugin-sdk",
    "@qq-bot/core",
    "@qq-bot/plugin-sdk-qq",
    "@qq-bot/plugin-testkit"
  ]) {
    const packageDirectory = join(
      consumerDirectory,
      "node_modules",
      ...packageName.split("/")
    );
    const manifest = JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8")
    );
    if (manifest.license !== "MIT") {
      throw new Error(`${packageName} tarball does not declare the MIT license`);
    }
    const license = await readFile(join(packageDirectory, "LICENSE"), "utf8");
    if (!license.startsWith("MIT License")) {
      throw new Error(`${packageName} tarball does not include the MIT license`);
    }
  }

  const source = `
import { definePlugin, PLUGIN_API_VERSION } from "@qq-bot/plugin-sdk";
import { createPluginTestHost } from "@qq-bot/plugin-testkit";
import { qqWakeupDelivery } from "@qq-bot/plugin-sdk-qq";

const plugin = definePlugin({
  name: "package-audit",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  configuration: {
    parse(value) {
      if (typeof value !== "object" || value === null) {
        throw new Error("config object required");
      }
      const greeting = Reflect.get(value, "greeting");
      if (typeof greeting !== "string") throw new Error("greeting required");
      return { greeting };
    }
  },
  setup(context) {
    context.commands.register({
      name: "audit",
      description: "audit packaged SDKs",
      execute: (command) => command.reply(context.config.greeting)
    });
  }
});

const host = createPluginTestHost();
await host.load(plugin, { config: { greeting: "package-ok" } });
await host.start();
const replies = await host.receive("/audit");
await host.stop();
if (replies[0]?.content !== "package-ok") {
  throw new Error("packaged plugin runtime returned an unexpected reply");
}
if (qqWakeupDelivery("audit").type !== "platform") {
  throw new Error("packaged QQ extension returned an unexpected delivery");
}
`;
  await writeFile(join(consumerDirectory, "audit.ts"), source);
  await writeFile(join(consumerDirectory, "audit.mjs"), source);
  await writeFile(
    join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false
        },
        include: ["audit.ts"]
      },
      null,
      2
    )}\n`
  );

  run("corepack", [
    "pnpm",
    "exec",
    "tsc",
    "-p",
    join(consumerDirectory, "tsconfig.json")
  ]);
  run(process.execPath, [join(consumerDirectory, "audit.mjs")]);
  console.info("plugin package audit passed");
} finally {
  await rm(auditDirectory, { recursive: true, force: true });
}
