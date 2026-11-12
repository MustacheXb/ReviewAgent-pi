import type { RunRecord } from "review-pi";
import type { RunCostMetrics, ToolCostPricing } from "./contracts.js";

/** 记录里的 usage 形状（RunRecord.baseline.usage 的结构投影） */
type LlmUsage = RunRecord["baseline"]["usage"];

/**
 * 工具成本（token 口径）：fixedCostPerCall × 调用次数 + costPerResultChar ×
 * 结果总字符数。调用次数与结果长度均取自 audit.toolCallLog；默认计价全 0。
 */
export function computeToolCostTokens(
  toolCallLog: readonly { readonly resultSummary: string }[],
  pricing: ToolCostPricing,
): number {
  const resultChars = toolCallLog.reduce((sum, call) => sum + call.resultSummary.length, 0);
  return pricing.fixedCostPerCall * toolCallLog.length + pricing.costPerResultChar * resultChars;
}

/**
 * Token 记账（纯函数）：
 * - uncachedInputTokens = usage.inputTokens（prompt_cache_miss_tokens）
 * - cachedInputTokens   = usage.cacheReadTokens（prompt_cache_hit_tokens）
 * - cacheWriteTokens    = usage.cacheWriteTokens（DeepSeek 通常不上报）
 * - totalInputTokens    = uncached + cached + cacheWrite；cached 缺失 → null（N/A）
 * - totalTokens         = totalInputTokens + outputTokens；totalInput 缺失 → null（N/A）
 * - cacheHitRate        = cached / totalInput（分母 0 → null）
 * - CARC                = uncached + cacheWrite + output + toolCost（ADR-0017 口径）
 *                         retry / summary 为独立成本字段，不计入 CARC——机制未落地
 *                         时它们是 null（N/A），把它们当 0 计入等于把未计量成本按 0
 *                         计，也会改变 L2 主指标定义。
 *
 * 缺失缓存字段 → 对应指标 null（N/A，不记 0）；此时 CARC 按全部输入计，
 * 是保守上界（真命中率越高，真实成本只会更低）。totalInput / totalTokens
 * 在 cached 缺失时也为 null：未知缓存量下，把它们写成 uncached + output
 * 等于把缺失缓存按 0 计。
 */
export function computeRunCost(
  usage: LlmUsage,
  toolCostTokens: number,
  retryCostTokens: number | null,
  summaryCostTokens: number | null,
): RunCostMetrics {
  const uncachedInputTokens = usage.inputTokens;
  const cachedInputTokens = usage.cacheReadTokens ?? null;
  const cacheWriteTokens = usage.cacheWriteTokens ?? null;
  const outputTokens = usage.outputTokens;
  const totalInputTokens =
    cachedInputTokens === null
      ? null
      : uncachedInputTokens + cachedInputTokens + (cacheWriteTokens ?? 0);
  const totalTokens = totalInputTokens === null ? null : totalInputTokens + outputTokens;
  const cacheHitRate =
    cachedInputTokens === null || totalInputTokens === null || totalInputTokens === 0
      ? null
      : cachedInputTokens / totalInputTokens;
  const carc = uncachedInputTokens + (cacheWriteTokens ?? 0) + outputTokens + toolCostTokens;
  return {
    cachedInputTokens,
    uncachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    totalInputTokens,
    totalTokens,
    cacheHitRate,
    toolCostTokens,
    retryCostTokens,
    summaryCostTokens,
    carc,
  };
}
