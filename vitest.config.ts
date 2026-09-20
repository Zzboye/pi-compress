import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 只跑单元/集成用例；bench/*.test.ts 是基准脚本（会写 e2e/reports），用 npm run test:bench 单独跑
    include: ["tests/**/*.test.ts"],
  },
});
