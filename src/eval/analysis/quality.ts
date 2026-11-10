import type { MatchCounts, PrfMetrics } from "./contracts.js";

/**
 * Recall / Precision / F1（分母为零显式记 null）：
 * - tp + fn = 0（无真值位置，clean MR）→ recall = null
 * - tp + fp = 0（零 finding）→ precision = null
 * - 任一成分 null → f1 = null；P 与 R 均为 0 → f1 = 0（ML 惯例）
 */
export function computePrf(counts: MatchCounts): PrfMetrics {
  const recall = ratio(counts.tp, counts.tp + counts.fn);
  const precision = ratio(counts.tp, counts.tp + counts.fp);
  return { recall, precision, f1: computeF1(recall, precision) };
}

export function computeF1(recall: number | null, precision: number | null): number | null {
  if (recall === null || precision === null) {
    return null;
  }
  if (recall + precision === 0) {
    return 0;
  }
  return (2 * recall * precision) / (recall + precision);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}
