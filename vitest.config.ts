import { defineConfig } from "vitest/config";

export default defineConfig({
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
        statements: 83,
        branches: 79,
        functions: 91,
        lines: 83
      }
    }
  }
});
