import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false, // tests share one Postgres and truncate between cases
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
