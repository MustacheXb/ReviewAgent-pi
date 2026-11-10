import type { Stat } from "./contracts.js";

/** 一个 case 上的单个指标观测（跨 case 等权聚合的输入形状） */
export interface CaseValue {
  readonly caseId: string;
  readonly value: number | null;
}

/** 算术均值 */
export function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 样本标准差（n − 1；n ≤ 1 时 0） */
export function sampleStd(values: readonly number[]): number {
  if (values.length <= 1) {
    return 0;
  }
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) * (value - average), 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

/** 一组数值的 Stat；空数组 → null（N/A） */
export function statOfValues(values: readonly number[]): Stat | null {
  if (values.length === 0) {
    return null;
  }
  return { count: values.length, mean: mean(values), std: sampleStd(values) };
}

/** 跨 case 等权：先每 case 内取有效值的均值，再跨 case 求 Stat */
export function perCaseStat(entries: readonly CaseValue[]): Stat | null {
  const byCase = new Map<string, number[]>();
  for (const entry of entries) {
    if (entry.value === null || !Number.isFinite(entry.value)) {
      continue;
    }
    byCase.set(entry.caseId, [...(byCase.get(entry.caseId) ?? []), entry.value]);
  }
  const caseMeans = [...byCase.values()].map((values) => mean(values));
  return statOfValues(caseMeans);
}
