import { describe, expect, it } from "vitest";
import type { CacheBreakRecord } from "../../src/instrument/contracts/run.js";
import { CACHE_BREAK_REASONS, tallyCacheBreakReasons } from "../../src/instrument/cache-break.js";

/**
 * Cache Break 原因分类的计数读面（spec #1 user story 13，#9 P4b 收口）：
 * 分类器执行面（classifyCacheBreaks 前缀分歧检测）属 legacy 运行时、已随内核
 * 退役；pi 内核以同形留痕 CacheBreakRecord，此处钉住计数口径与规范列序
 * （报告 / dashboard 的统计面——零值字段保留，列序恒定）。
 */

/** 同形留痕记录（计数面只消费 reason——其余字段取合法占位） */
function record(reason: CacheBreakRecord["reason"], count = 1): readonly CacheBreakRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    requestIndex: index + 1,
    reason,
    zone: "A" as const,
    divergeByteOffset: 0,
  }));
}

describe("CACHE_BREAK_REASONS — 规范列序", () => {
  it("四类原因恒定有序（报告列序契约）", () => {
    expect(CACHE_BREAK_REASONS).toEqual([
      "MODEL_CHANGED",
      "SYSTEM_PROMPT_CHANGED",
      "TOOL_SCHEMA_CHANGED",
      "CONTEXT_REORDERED",
    ]);
  });
});

describe("tallyCacheBreakReasons — 计数口径", () => {
  it("按原因分类计数；空输入 → 全零且四键齐全（零值列保留）", () => {
    expect(tallyCacheBreakReasons([])).toEqual({
      MODEL_CHANGED: 0,
      SYSTEM_PROMPT_CHANGED: 0,
      TOOL_SCHEMA_CHANGED: 0,
      CONTEXT_REORDERED: 0,
    });
    const tally = tallyCacheBreakReasons([
      ...record("MODEL_CHANGED", 2),
      ...record("CONTEXT_REORDERED", 3),
    ]);
    expect(tally).toEqual({
      MODEL_CHANGED: 2,
      SYSTEM_PROMPT_CHANGED: 0,
      TOOL_SCHEMA_CHANGED: 0,
      CONTEXT_REORDERED: 3,
    });
  });

  it("记录顺序不影响计数（纯函数，无聚合状态）", () => {
    const reversed = [...record("MODEL_CHANGED", 2), ...record("CONTEXT_REORDERED", 3)].reverse();
    expect(tallyCacheBreakReasons(reversed)).toEqual(tallyCacheBreakReasons([
      ...record("MODEL_CHANGED", 2),
      ...record("CONTEXT_REORDERED", 3),
    ]));
  });
});
