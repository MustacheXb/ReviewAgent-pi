import { expect, test } from "vitest";
import {
  computeReusablePrefix,
  estimateReusableTokens,
  longestCommonPrefixLength,
} from "../../src/eval/analysis/reusable-prefix.js";

// 离线 reusable-prefix 预测（#60 / P1-3）：对相邻请求 wireBody 求最长公共
// 前缀，按 chars/4 估算可复用 token，与 usage.cacheRead 对账。纯只读、
// 确定性、零网络；估算口径显式标注，不冒充真实计费。

test("longestCommonPrefixLength：相同 / 前缀 / 无公共前缀 / 空串", () => {
  expect(longestCommonPrefixLength("abc", "abc")).toBe(3);
  expect(longestCommonPrefixLength("abcdef", "abcxyz")).toBe(3);
  expect(longestCommonPrefixLength("abc", "xyz")).toBe(0);
  expect(longestCommonPrefixLength("", "abc")).toBe(0);
  expect(longestCommonPrefixLength("abc", "")).toBe(0);
});

test("estimateReusableTokens：相邻对 LCP chars/4 向下取整后求和", () => {
  const base = "x".repeat(8);
  expect(estimateReusableTokens([base, `${base}tail`])).toBe(2);
  // pair1 LCP=4 → 1；pair2 LCP=5 → 1
  expect(estimateReusableTokens([base, `${base.slice(0, 4)}y`, `${base.slice(0, 4)}y2`])).toBe(2);
  expect(estimateReusableTokens(["abc"])).toBe(0);
  expect(estimateReusableTokens([])).toBe(0);
});

test("computeReusablePrefix：predicted / actual / gap 与估算标注", () => {
  const base = "x".repeat(8);
  expect(computeReusablePrefix([base, `${base}y`], { cacheReadTokens: 5 })).toEqual({
    estimated: true,
    estimateMethod: "chars/4",
    requestCount: 2,
    pairCount: 1,
    predictedReusableTokens: 2,
    actualCacheReadTokens: 5,
    // actual − predicted（正 = 实际命中高于估算）
    gap: 3,
  });
});

test("缺 cacheRead → actual / gap 为 null（N/A，不按 0 冒充）", () => {
  const base = "x".repeat(8);
  expect(computeReusablePrefix([base, `${base}y`], {})).toMatchObject({
    predictedReusableTokens: 2,
    actualCacheReadTokens: null,
    gap: null,
  });
});

test("单请求 / 空输入：单请求预测 0；空输入无字段", () => {
  expect(computeReusablePrefix(["abc"], { cacheReadTokens: 4 })).toEqual({
    estimated: true,
    estimateMethod: "chars/4",
    requestCount: 1,
    pairCount: 0,
    predictedReusableTokens: 0,
    actualCacheReadTokens: 4,
    gap: 4,
  });
  expect(computeReusablePrefix([], { cacheReadTokens: 4 })).toBeUndefined();
});

test("确定性：同一输入两次计算结果相同", () => {
  const bodies = ["a".repeat(40), `${"a".repeat(40)}b`, `${"a".repeat(40)}bc`];
  const first = computeReusablePrefix(bodies, { cacheReadTokens: 12 });
  const second = computeReusablePrefix([...bodies], { cacheReadTokens: 12 });
  expect(second).toEqual(first);
});
