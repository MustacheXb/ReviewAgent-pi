import { defineConfig } from "vitest/config";

// 与根 vitest.config.ts 同构：resolve.conditions ["source"] 保证 workspace 内
// （含 vendored pi 包）按 TS 源解析，规避 dist 陈旧问题。
export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
