/**
 * P5b（issue #11）pi↔DSH 对照复算的纯函数内核。
 *
 * 职责：对照报告（docs/report/《Phase 2 pi 内核全量对照报告》）全部数字面的
 * 可测计算——跨 rep σ（#36 口径移植自 analyze-phase2.ts，与 DSH 线逐字同款）、
 * 跨侧极差（全侧在场才算，任一侧缺失 → null——避免缺侧极差被误读为全侧极差）、
 * 判定形态（零 finding 率）、九维度行提取（judge 口径，对齐 DSH 报告 §5.1）。
 * 加载与表拼装在 scripts/analyze-p5b.ts（离线重放范式，对齐兄弟仓）。
 *
 * 口径纪律：本模块零新指标定义，全部为既有口径的均值/计数/求和；
 * 跨 rep σ 与跨侧极差分开呈现（issue #11 AC——前者是 rep 间稳定性，后者是侧间差异）。
 */
import type { ConfigId } from "../instrument/contracts/config.js";
import type { MetricsField } from "../metrics/types.js";
import type { JudgeRunResult } from "../judge/orchestrate.js";
import type { JudgeStageReport } from "./report.js";

/** 展示顺序（本地呈现约定；契约 CONFIGS 为无序键控表；与 analyze-phase2.ts 同款） */
export const P5B_CONFIG_IDS: readonly ConfigId[] = ["A", "B", "C", "D", "E"];

/** 判定链 σ 面（与 #36 误差棒同口径）的指标集（rule 口径）——报告 T4 与单测共享 */
export const SIGMA_METRICS = ["lineRecall", "linePrecision", "totalTokens", "cacheHitRate"] as const;
type SigmaMetric = (typeof SIGMA_METRICS)[number];

/** 九维度（对齐 DSH 线报告 §5.1 主表九列，judge 口径） */
export const NINE_DIMS = [
  "lineRecall", "linePrecision", "lineF1", "totalTokens", "cacheHitRate",
  "rie", "carc", "toolCalls", "rounds",
] as const satisfies readonly MetricsField[];
export type NineDim = (typeof NINE_DIMS)[number];
export type NineDims = Readonly<Record<NineDim, number | null>>;

// ── 样本标准差（n-1 分母；ADR-0007 σ 算术测试纪律：n=2 std = 偏差 × √2）──
export function sampleStd(values: ReadonlyArray<number>): number {
  const n = values.length;
  if (n < 2) return Number.NaN;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (n - 1);
  return Math.sqrt(variance);
}

// ── 跨 rep σ（#36 误差棒口径）：按 (caseId, configId) 分组 3-rep 样本 σ，
//    null 剔除、≥2 有效 rep 才计、对全部案取均值。移植自 analyze-phase2.ts（逐字同款）。──
const SIGMA_EXTRACTORS: Record<SigmaMetric, (row: JudgeRunResult) => number | null> = {
  lineRecall: (row) => row.rulePrf?.recall ?? null,
  linePrecision: (row) => row.rulePrf?.precision ?? null,
  totalTokens: (row) => row.tokens?.totalTokens ?? null,
  cacheHitRate: (row) => row.tokens?.cacheHitRate ?? null,
};
export function repSigma(results: ReadonlyArray<JudgeRunResult>): Map<string, number> {
  const perCell = new Map<string, Record<SigmaMetric, number[]>>();
  for (const row of results) {
    const key = `${row.caseId}|${row.configId}`;
    let cell = perCell.get(key);
    if (cell === undefined) {
      cell = { lineRecall: [], linePrecision: [], totalTokens: [], cacheHitRate: [] };
      perCell.set(key, cell);
    }
    for (const metric of SIGMA_METRICS) {
      const value = SIGMA_EXTRACTORS[metric](row);
      if (value !== null) cell[metric].push(value);
    }
  }
  const out = new Map<string, number>();
  for (const configId of P5B_CONFIG_IDS) {
    const cellSigmas = new Map<SigmaMetric, number[]>(SIGMA_METRICS.map((m) => [m, [] as number[]]));
    for (const [key, cell] of perCell) {
      if (!key.endsWith(`|${configId}`)) continue;
      for (const metric of SIGMA_METRICS) {
        if (cell[metric].length >= 2) cellSigmas.get(metric)?.push(sampleStd(cell[metric]));
      }
    }
    for (const metric of SIGMA_METRICS) {
      const sigmas = cellSigmas.get(metric) ?? [];
      out.set(`${configId}/${metric}`, sigmas.length === 0 ? Number.NaN : sigmas.reduce((a, b) => a + b, 0) / sigmas.length);
    }
  }
  return out;
}

// ── 跨侧极差：全部侧在场才算（max − min），任一侧缺失 → null。
//    与 DSH 线 T3b「recalls.length === 3 才算」同纪律，泛化为 n 侧。──
export function crossSideRange(values: ReadonlyArray<number | null>): number | null {
  if (values.length === 0 || values.some((v) => v === null)) return null;
  const nums = values as ReadonlyArray<number>;
  return Math.max(...nums) - Math.min(...nums);
}

// ── 判定形态：零 finding 率（skipped-no-findings / 全部单元）──
export interface ZeroFindingStats {
  readonly runCount: number;
  readonly skippedNoFindings: number;
  /** runCount = 0 → null（分母护栏） */
  readonly rate: number | null;
}
export function zeroFindingRate(judge: JudgeStageReport): ZeroFindingStats {
  return {
    runCount: judge.runCount,
    skippedNoFindings: judge.skippedNoFindingsCount,
    rate: judge.runCount === 0 ? null : judge.skippedNoFindingsCount / judge.runCount,
  };
}

// ── 九维度行提取（judge 口径；Stat 缺失 → null）──
export function judgeNineDims(entry: JudgeStageReport["perConfig"][number]): NineDims {
  const dims = {} as Record<NineDim, number | null>;
  for (const dim of NINE_DIMS) {
    const stat = entry.judge.values[dim];
    dims[dim] = stat === null || stat === undefined ? null : stat.mean;
  }
  return dims;
}
