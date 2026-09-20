import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["bench/**/*.test.ts"],
    testTimeout: 600_000, // 基准含真实模型/长会话路径
  },
});
