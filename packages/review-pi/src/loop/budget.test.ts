import { describe, expect, test } from "vitest";
import {
  DEFAULT_REVIEW_BUDGET,
  resolveReviewBudget,
  type ReviewBudgetOverride,
} from "./budget.js";

// 内核内部预算（#53 / ADR-0018 §1）：五类独立预算的缺省档与覆盖解析。
// 纯函数缝——预算只经 runReview 内部输入注入，不进入协议 / CLI / 环境变量。

describe("DEFAULT_REVIEW_BUDGET", () => {
  test("五类预算的安全上界与 ADR-0018 对齐", () => {
    expect(DEFAULT_REVIEW_BUDGET).toEqual({
      maxRequests: 24,
      maxRounds: 5,
      maxExecutedToolCalls: 6,
      maxToolAttempts: 12,
      maxOutputTokens: 48_000,
    });
  });
});

describe("resolveReviewBudget", () => {
  test("无覆盖 → 逐字段等于缺省档", () => {
    expect(resolveReviewBudget()).toEqual(DEFAULT_REVIEW_BUDGET);
  });

  test("部分覆盖 → 只替换给出的字段", () => {
    const override: ReviewBudgetOverride = { maxRequests: 16, maxOutputTokens: 32_000 };
    expect(resolveReviewBudget(override)).toEqual({
      maxRequests: 16,
      maxRounds: 5,
      maxExecutedToolCalls: 6,
      maxToolAttempts: 12,
      maxOutputTokens: 32_000,
    });
  });

  test("五类预算均可覆盖", () => {
    const override: ReviewBudgetOverride = {
      maxRequests: 1,
      maxRounds: 2,
      maxExecutedToolCalls: 3,
      maxToolAttempts: 4,
      maxOutputTokens: 5,
    };
    expect(resolveReviewBudget(override)).toEqual(override);
  });

  test.each([
    { field: "maxRequests", value: 0 },
    { field: "maxRounds", value: -1 },
    { field: "maxExecutedToolCalls", value: 1.5 },
    { field: "maxToolAttempts", value: Number.NaN },
    { field: "maxOutputTokens", value: Number.POSITIVE_INFINITY },
  ] as const)("非法覆盖（$field=$value）→ 显式抛 RangeError", ({ field, value }) => {
    expect(() => resolveReviewBudget({ [field]: value })).toThrowError(
      new RegExp(`review budget ${field}.*positive integer`),
    );
  });
});
