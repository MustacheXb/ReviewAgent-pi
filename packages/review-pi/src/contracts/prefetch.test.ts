import { expect, test } from "vitest";
import {
  DEFAULT_PREFETCH_BUDGETS,
  resolvePrefetchBudgets,
  type PrefetchOptions,
} from "./prefetch.js";

// 预取契约（测量常量面）：字符预算跨平台确定（无 tokenizer 的确定性代理）。
// 默认值：Zone B 16K / Symbol 8K / Reference 6K / Call Chain 6K。

test("默认预算：不传 options 返回冻结默认值", () => {
  expect(resolvePrefetchBudgets(undefined)).toEqual(DEFAULT_PREFETCH_BUDGETS);
  expect(DEFAULT_PREFETCH_BUDGETS).toEqual({
    zoneBBudgetChars: 16_000,
    symbolLayerBudgetChars: 8_000,
    referenceLayerBudgetChars: 6_000,
    callChainLayerBudgetChars: 6_000,
  });
});

test("部分覆盖：只改给定的层，其余保持默认", () => {
  const options: PrefetchOptions = { zoneBBudgetChars: 2_000, callChainLayerBudgetChars: 500 };
  expect(resolvePrefetchBudgets(options)).toEqual({
    zoneBBudgetChars: 2_000,
    symbolLayerBudgetChars: 8_000,
    referenceLayerBudgetChars: 6_000,
    callChainLayerBudgetChars: 500,
  });
});

test("空对象与 undefined 同义（全默认）", () => {
  expect(resolvePrefetchBudgets({})).toEqual(DEFAULT_PREFETCH_BUDGETS);
});
