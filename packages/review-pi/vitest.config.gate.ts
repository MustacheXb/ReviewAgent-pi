import { defineConfig } from "vitest/config";

// P2 字节纪律门(#5):独立入口——默认套件(src/**/*.test.ts)不收 *.gate.ts,
// 本档只收 src/bytegate/**/*.gate.ts(对照 DSH 审计真源的重型门)。
// 组成:coverage(覆盖完整性把口)+ control(CI 常开黄金真源正/负对照,
// 不依赖 gitignored 数据)+ t{1..5}(单实验全量对照,真源/快照缺席时
// 该实验注册显式 skip 占位——vitest 对零测试文件判败,静默空转 CI 必红;
// CI 绿不等于重型验收通过,全量以本地实跑为准)。
// 超时档:t 系列预取(每案 ~1 分钟级)+ 六请求重放,单测 15 分钟。
// resolve.conditions ["source"] 与主套件同构(workspace 内按 TS 源解析)。
export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  test: {
    environment: "node",
    include: ["src/bytegate/**/*.gate.ts"],
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
  },
});
