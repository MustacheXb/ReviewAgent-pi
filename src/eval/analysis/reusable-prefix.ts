import type { ReusablePrefixMetrics } from "./contracts.js";

/**
 * 离线 reusable-prefix 预测（#60 / P1-3）：对相邻请求 wireBody 求最长公共
 * 前缀，按 chars/4 估算可复用 token，并与 usage.cacheRead 对账。
 *
 * - 纯只读、确定性、零网络、零密钥；只消费调用方传入的 wireBody 原文；
 * - `estimated: true` / `estimateMethod: "chars/4"` 显式标注估算口径，
 *   不冒充真实计费；
 * - `gap = actualCacheReadTokens − predictedReusableTokens`（正 = 实际命中
 *   高于估算；负 = 估算高估）；actual 缺失时 gap 记 null（N/A）。
 */

/** 估算口径标识（报告显式标注） */
export const TOKEN_ESTIMATE_METHOD: ReusablePrefixMetrics["estimateMethod"] = "chars/4";
/** token 估算除数（chars/4） */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/** 最长公共前缀长度（UTF-16 code unit 计数；跨平台确定） */
export function longestCommonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) {
    index += 1;
  }
  return index;
}

/** 相邻对可复用 token 估算之和（每对 floor(LCP chars / 4)） */
export function estimateReusableTokens(wireBodies: readonly string[]): number {
  let total = 0;
  for (let index = 1; index < wireBodies.length; index++) {
    const previous = wireBodies[index - 1];
    const current = wireBodies[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    total += Math.floor(longestCommonPrefixLength(previous, current) / CHARS_PER_TOKEN_ESTIMATE);
  }
  return total;
}

/** 单 run 的预测 / 实际 / gap；无 wireBody 输入 → undefined（报告省键） */
export function computeReusablePrefix(
  wireBodies: readonly string[],
  usage: { readonly cacheReadTokens?: number },
): ReusablePrefixMetrics | undefined {
  if (wireBodies.length === 0) {
    return undefined;
  }
  const predictedReusableTokens = estimateReusableTokens(wireBodies);
  const actualCacheReadTokens = usage.cacheReadTokens ?? null;
  return {
    estimated: true,
    estimateMethod: TOKEN_ESTIMATE_METHOD,
    requestCount: wireBodies.length,
    pairCount: Math.max(0, wireBodies.length - 1),
    predictedReusableTokens,
    actualCacheReadTokens,
    gap: actualCacheReadTokens === null ? null : actualCacheReadTokens - predictedReusableTokens,
  };
}
