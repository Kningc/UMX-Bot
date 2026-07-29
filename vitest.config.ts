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
      reporter: ["text", "html"]
    }
  }
});
