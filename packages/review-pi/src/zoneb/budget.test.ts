import { expect, test } from "vitest";
import { applyBlockBudget } from "./budget.js";

// 预算层（测量常量面：超限截断必须显式留痕——block 边界截断 + 确定性提示行）。

test("空 blocks：空结果、不截断", () => {
  expect(applyBlockBudget([], 100, () => "notice")).toEqual({
    lines: [],
    totalBlocks: 0,
    shownBlocks: 0,
    truncated: false,
  });
});

test("全部 block 在预算内：全保留、无提示行", () => {
  const blocks = [["a", "b"], ["c"], ["d", "e"]];
  const out = applyBlockBudget(blocks, 1000, () => "notice");
  expect(out).toEqual({
    lines: ["a", "b", "c", "d", "e"],
    totalBlocks: 3,
    shownBlocks: 3,
    truncated: false,
  });
});

test("超出预算：在 block 边界截断并追加提示行（计入预算的是空行相连后的总字符数）", () => {
  // block1 = "x".repeat(50)（1 行），block2 = "y".repeat(50)。
  // 连接后 = 50 + 2(\n\n) + 50 = 102 > 100 → 只保留 block1
  const blocks = [["x".repeat(50)], ["y".repeat(50)]];
  const out = applyBlockBudget(blocks, 100, (shown, total) => `t:${shown}/${total}`);
  expect(out).toEqual({
    lines: ["x".repeat(50), "t:1/2"],
    totalBlocks: 2,
    shownBlocks: 1,
    truncated: true,
  });
});

test("恰好等于预算：整 block 计入（边界含）", () => {
  const blocks = [["x".repeat(50)], ["y".repeat(48)]];
  // 50 + 2 + 48 = 100 ≤ 100 → 全保留
  const out = applyBlockBudget(blocks, 100, () => "t");
  expect(out.shownBlocks).toBe(2);
  expect(out.truncated).toBe(false);
});

test("第一个 block 就超预算：0 保留，仅剩提示行", () => {
  const out = applyBlockBudget([["x".repeat(200)], ["y"]], 100, (shown, total) => `t:${shown}/${total}`);
  expect(out).toEqual({
    lines: ["t:0/2"],
    totalBlocks: 2,
    shownBlocks: 0,
    truncated: true,
  });
});
