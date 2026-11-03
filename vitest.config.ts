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
    // 统一放宽到 120s 有界值（研究 e2e 档已随评测装置删除，#32；阈值保留——
    // 剩余套件在满载机器上仍可能慢起）。
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // 产品代码覆盖率（src/）：scripts/ 为进程入口壳（migration-gate / demo
      // 装配），由手工流程触达，不计入常规门
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      // 零网络常规门的最低覆盖线（全局；#32 E-only 生产化后基线 ≈ 98% lines
      // ——研究测试树退役后由 gate 面行为测试（pi-kernel / cli-args /
      // migration-gate）承载，instrument/contracts 纯类型模块零可执行语句、
      // 不计入聚合）
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
