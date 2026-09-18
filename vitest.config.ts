import { defineConfig } from "vitest/config";

export default defineConfig({
  // review-llm（workspace 内部包）按 "source" 条件解析到 TS 源而非 dist 产物，
  // 保证测试始终跑当前源码（exports: types/source 指向 src，default 指向 dist 供编译路径运行时用）
  resolve: {
    conditions: ["source"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // 满套件并行（forks 池按核数起 worker）下，重型集成用例——仓库快照扫描 /
    // tree-sitter 建索引 / 全流程 runReview / CLI 子进程——单用例与夹具在磁盘
    // 争用下可远超 vitest 默认 5s/10s（#29 曾按文件放宽到 60s，高负载下仍可超）。
    // 统一放宽到 120s 有界值；真实 API 的 e2e 另见 vitest.config.e2e.ts（30 分钟）。
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // 产品代码覆盖率（src/）：scripts/ 为进程入口壳（experiment / reference /
      // 数据准备），由 e2e 与手工流程触达，不计入常规门
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      // 零网络常规门的最低覆盖线（全局；当前基线 86.9% lines）
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
