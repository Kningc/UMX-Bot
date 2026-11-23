#!/usr/bin/env node
// 从 examples/plugin-starter 生成一个新插件目录。
//
// 模板随主工作区一起构建、类型检查和测试，所以它永远跟当前 SDK 对齐；
// 手工复制再改名容易漏掉 package.json、tsconfig 或测试里的标识符。
import {
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const templateDirectory = join(repositoryRoot, "examples", "plugin-starter");

function usage() {
  console.log(`用法:
  node scripts/create-plugin.mjs <插件名> [options]

插件名必须是小写字母、数字和连字符，例如 group-welcome。

选项:
  --dir <path>     目标目录，默认 plugins/<插件名>
  --scope <scope>  npm scope，默认 @umx-bot
  --force          目标目录已存在时仍然写入

示例:
  node scripts/create-plugin.mjs group-welcome
  node scripts/create-plugin.mjs weather --dir ../my-plugins/weather`);
}

function parseArgs(argv) {
  const options = { scope: "@umx-bot", force: false };
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
      case "--dir":
        options.dir = next();
        break;
      case "--scope":
        options.scope = next();
        break;
      case "--force":
        options.force = true;
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

function assertPluginName(name) {
  if (!/^[a-z][a-z0-9-]*$/u.test(name)) {
    throw new Error(
      `插件名 "${name}" 无效：只能用小写字母、数字和连字符，且以字母开头`
    );
  }
  // Keep in step with RESERVED_PLUGIN_NAMES in packages/core.
  if (
    ["access", "adapter", "core", "host", "kernel", "scheduler"].includes(name)
  ) {
    throw new Error(`插件名 "${name}" 是宿主保留名，请换一个`);
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// `node_modules` is a symlink farm and `dist` is build output; copying either
// would produce a broken, stale package.
const skippedEntries = new Set(["node_modules", "dist", "coverage"]);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (skippedEntries.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function titleCase(name) {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function main(argv) {
  const { options, positional } = parseArgs(argv);
  const [name] = positional;
  if (options.help || !name) {
    usage();
    return name ? 0 : 1;
  }
  assertPluginName(name);

  const target = resolve(
    options.dir ? options.dir : join(repositoryRoot, "plugins", name)
  );
  if ((await exists(target)) && !options.force) {
    console.error(`目标目录已存在：${target}\n加 --force 才会覆盖。`);
    return 1;
  }

  await mkdir(target, { recursive: true });
  await cp(templateDirectory, target, {
    recursive: true,
    force: true,
    filter: (source) => !skippedEntries.has(basename(source))
  });

  const packageName = `${options.scope}/plugin-${name}`;
  const title = titleCase(name);

  for (const file of await listFiles(target)) {
    const original = await readFile(file, "utf8");
    const rewritten = original
      .replaceAll("@umx-bot/example-plugin-starter", packageName)
      .replaceAll('name: "starter"', `name: "${name}"`)
      .replaceAll("starter plugin", `${name} plugin`)
      .replaceAll("StarterConfig", `${title.replaceAll(" ", "")}Config`)
      .replaceAll("可复制的插件起步模板", `${title} 插件`)
      .replaceAll("起步示例", title)
      .replaceAll('version: "1.0.0"', 'version: "0.1.0"')
      .replaceAll("# Plugin starter", `# ${title}`)
      .replaceAll(
        "复制此目录作为新插件起点，然后修改包名、插件名、命令和测试。模板参与主工作区\n的构建、严格类型检查和 Vitest 回归，因此始终与当前 SDK 保持同步。",
        `由 \`pnpm create:plugin ${name}\` 生成。改掉 \`src/index.ts\` 里的命令和配置，\n` +
          "再把 `src/index.test.ts` 改成真正的断言。插件开发细节见\n" +
          "[docs/plugin-development.md](../../docs/plugin-development.md)。"
      );
    if (rewritten !== original) {
      await writeFile(file, rewritten);
    }
  }

  // The template is private so it never gets published by accident; a real
  // plugin usually should be publishable.
  const manifestPath = join(target, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = packageName;
  manifest.version = "0.1.0";
  delete manifest.private;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const shown = relative(process.cwd(), target) || basename(target);
  console.log(`已创建 ${packageName} → ${shown}

接下来：
  1. pnpm install                       # 让 workspace 认识新包
  2. pnpm --filter ${packageName} test
  3. 在插件清单里加上 { "specifier": "${packageName}" }

模板已经带命令、配置校验和一个通过的测试，可以直接改。`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
