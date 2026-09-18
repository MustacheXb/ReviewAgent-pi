import { expect, test } from "vitest";
import { CONFIGS } from "./config.js";

// 实验配置矩阵（测量常量面：configId 语义与 DSH 线 / 判定链一致）。
// P1a 全链走 config B（零工具 + 确定性预取）。

test("config B：零工具、确定性预取、无全仓/稳定前缀/ledger", () => {
  expect(CONFIGS.B).toEqual({
    configId: "B",
    toolsEnabled: false,
    prefetch: true,
    fullRepo: false,
    stablePrefix: false,
    ledger: false,
  });
});

test("配置矩阵 A-E 完整且 configId 与键一致", () => {
  expect(Object.keys(CONFIGS)).toEqual(["A", "B", "C", "D", "E"]);
  for (const [key, config] of Object.entries(CONFIGS)) {
    expect(config.configId, key).toBe(key);
  }
});
