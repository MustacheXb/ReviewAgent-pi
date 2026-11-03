import { expect, test } from "vitest";
import { CONFIG_E, HISTORICAL_CONFIG_IDS } from "./config.js";

// 配置合同（测量常量面）：#32 / ADR-0014 后值域塌缩为 E 单值（写面），
// 历史值域 A–E 只活在读取面（RunRecord / 处置库回溯锚）。

test("生产值域：ConfigId 塌缩为 E 单值，CONFIG_E 为单源常量", () => {
  expect(CONFIG_E).toBe("E");
});

test("历史值域：A–E 全集在场（读取面校验集，含 E 收尾），无重复", () => {
  expect(HISTORICAL_CONFIG_IDS).toEqual(["A", "B", "C", "D", "E"]);
  expect(new Set(HISTORICAL_CONFIG_IDS).size).toBe(HISTORICAL_CONFIG_IDS.length);
  // 生产值必须是历史值域的成员（写入的记录永远可被读取面接受）
  expect(HISTORICAL_CONFIG_IDS).toContain(CONFIG_E);
});
