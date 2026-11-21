import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Workspace packages resolve to their sources, so tests (and coverage) always
// exercise the code being edited instead of a possibly stale `dist` build.
const workspacePackages: Record<string, string> = {
  "@qq-bot/adapter-console": "packages/adapter-console",
  "@qq-bot/adapter-qq-official": "packages/adapter-qq-official",
  "@qq-bot/core": "packages/core",
  "@qq-bot/plugin-sdk": "packages/plugin-sdk",
  "@qq-bot/plugin-sdk-qq": "packages/plugin-sdk-qq",
  "@qq-bot/plugin-testkit": "packages/plugin-testkit",
  "@qq-bot/storage-sqlite": "packages/storage-sqlite",
  "@qq-bot/plugin-help": "plugins/help",
  "@qq-bot/plugin-ping": "plugins/ping",
  "@qq-bot/plugin-minecraft-status": "plugins/minecraft-status"
};

export default defineConfig({
  resolve: {
    alias: Object.entries(workspacePackages).map(([name, directory]) => ({
      find: new RegExp(`^${name}$`),
      replacement: fileURLToPath(
        new URL(`${directory}/src/index.ts`, import.meta.url)
      )
    }))
  },
  test: {
    include: [
      "apps/**/*.test.ts",
      "examples/**/*.test.ts",
      "packages/**/*.test.ts",
      "plugins/**/*.test.ts"
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: [
        "apps/*/src/**/*.ts",
        "packages/*/src/**/*.ts",
        "plugins/*/src/**/*.ts"
      ],
      exclude: [
        // 进程入口：只做装配，由部署冒烟覆盖。
        "apps/bot/src/main.ts",
        // 需要真实 QQ 凭据的手动生产冒烟脚本。
        "packages/adapter-qq-official/src/smoke.ts"
      ],
      // 棘轮阈值：取当前实际覆盖率向下取整，只允许往上走。
      thresholds: {
        statements: 87,
        branches: 83,
        functions: 95,
        lines: 87
      }
    }
  }
});
