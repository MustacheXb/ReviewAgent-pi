import { defineConfig } from "vitest/config";

// 真跑冒烟 e2e（#4）：独立入口——默认套件（src/**/*.test.ts）不收 *.e2e.ts，
// 本档只收 src/e2e/**/*.e2e.ts（真网关真模型，30 分钟档超时）。
// env 守卫（.env.local 的 REVIEWER_URL/REVIEWER_API_KEY + VUL4J 快照）缺失时
// 整档 skip 并 console.info 原因（与根仓 tests/e2e 同约定）。
// resolve.conditions ["source"] 与主套件同构（workspace 内按 TS 源解析）。
export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  test: {
    environment: "node",
    include: ["src/e2e/**/*.e2e.ts"],
    testTimeout: 30 * 60_000,
    hookTimeout: 30 * 60_000,
  },
});
