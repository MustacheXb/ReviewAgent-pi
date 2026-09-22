import type { CacheBreakRecord, CacheBreakReason } from "./contracts/run.js";

/**
 * Cache Break 原因分类（spec #1 user story 13）——计数读面：
 * 对审计留痕的 cacheBreaks 记录按原因分类计数，供报告 / dashboard
 * 归因缓存命中率波动。
 *
 * #9 P4b：分类器执行面（classifyCacheBreaks 及其字节前缀分歧检测——
 * model 段 → messages 段 → tools 段布局比对，分歧位置映射 Zone 分区）
 * 属 legacy 运行时，已随内核退役；pi 内核以同形留痕 CacheBreakRecord，
 * 此处保留计数口径与规范列序（零值字段保留，报告列序恒定）。
 *
 * 原因语义（历史口径，读侧对账用）：
 * - MODEL_CHANGED：model 段分歧；
 * - SYSTEM_PROMPT_CHANGED：messages[0]（system，Zone A 头部）分歧；
 * - CONTEXT_REORDERED：messages 中段（非首条 system）分歧（重排 / 中段插入 / 改写）；
 * - TOOL_SCHEMA_CHANGED：消息序列一致而 tools 段分歧（Zone A 工具 schema）。
 */

/** 全部原因分类的规范序（报告 / dashboard 列序） */
export const CACHE_BREAK_REASONS: readonly CacheBreakReason[] = [
  "MODEL_CHANGED",
  "SYSTEM_PROMPT_CHANGED",
  "TOOL_SCHEMA_CHANGED",
  "CONTEXT_REORDERED",
];

/** 按原因分类计数（报告 / dashboard 的统计口径；零值字段保留，列序恒定） */
export function tallyCacheBreakReasons(
  records: readonly CacheBreakRecord[],
): Readonly<Record<CacheBreakReason, number>> {
  const tally: Record<CacheBreakReason, number> = {
    MODEL_CHANGED: 0,
    SYSTEM_PROMPT_CHANGED: 0,
    TOOL_SCHEMA_CHANGED: 0,
    CONTEXT_REORDERED: 0,
  };
  for (const record of records) {
    if (tally[record.reason] !== undefined) {
      tally[record.reason]++;
    }
  }
  return tally;
}
