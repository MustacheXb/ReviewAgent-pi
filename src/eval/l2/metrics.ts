import type { Stat } from "../analysis/contracts.js";
import { mean, perCaseStat, sampleStd, statOfValues } from "../analysis/stats.js";
import {
  DEFAULT_BOOTSTRAP_OPTIONS,
  bootstrapGeometricMeanCI,
  bootstrapMeanCI,
  type BootstrapOptions,
} from "./bootstrap.js";
import type {
  L2CostSummary,
  L2LoopSummary,
  L2MetricSet,
  L2PairedSet,
  L2QualitySummary,
  L2RunSample,
  PairedDiff,
  PairedRatio,
} from "./contracts.js";

/**
 * L2 配对统计（#41）：纯函数，输入 run 级观测（`RunAnalysis` 结构子集），
 * 输出按 case 等权的臂内汇总与候选 − 基线配对统计。
 *
 * 配对纪律（评测方案 §6.3）：先 case 内跨 rep 均值，再配对——不把 rep 当
 * 独立样本（伪重复）。比率用几何均值（正数域），差值用算术均值；两者都
 * 给固定种子 bootstrap 95% CI。N/A 值不参与配对，`pairs` 如实计数。
 */

type Selector = (run: L2RunSample) => number | null;

/** 臂内指标汇总（warm / cold 由调用侧先过滤 rep） */
export function buildMetricSet(runs: readonly L2RunSample[]): L2MetricSet {
  const cases = new Set(runs.map((run) => run.caseId));
  return {
    runs: runs.length,
    cases: cases.size,
    cost: buildCostSummary(runs),
    loop: buildLoopSummary(runs),
    quality: buildQualitySummary(runs),
  };
}

/** 配对指标集（candidate − baseline；warm / cold 由调用侧先过滤 rep） */
export function buildPairedSet(
  baseline: readonly L2RunSample[],
  candidate: readonly L2RunSample[],
  options: BootstrapOptions = DEFAULT_BOOTSTRAP_OPTIONS,
): L2PairedSet {
  return {
    carcRatio: ratioPair(baseline, candidate, (run) => run.cost.carc, options),
    uncachedRatio: ratioPair(baseline, candidate, (run) => run.cost.uncachedInputTokens, options),
    outputRatio: ratioPair(baseline, candidate, (run) => run.cost.outputTokens, options),
    totalTokensRatio: ratioPair(baseline, candidate, (run) => run.cost.totalTokens, options),
    cachedInputRatio: ratioPair(baseline, candidate, (run) => run.cost.cachedInputTokens, options),
    attemptsRatio: ratioPair(baseline, candidate, (run) => run.loop.attemptedToolCalls, options),
    requestsRatio: ratioPair(baseline, candidate, (run) => run.loop.requests, options),
    cacheHitRateDiff: diffPair(baseline, candidate, (run) => run.cost.cacheHitRate, options),
    judgeRecallDiff: diffPair(baseline, candidate, judgeSelector("recall"), options),
    judgePrecisionDiff: diffPair(baseline, candidate, judgeSelector("precision"), options),
    zeroFindingRateDiff: diffPair(
      baseline,
      candidate,
      (run) => (run.quality.zeroFindings ? 1 : 0),
      options,
    ),
    negativeControlFpDiff: diffPair(
      baseline,
      candidate,
      (run) => (run.quality.truth === "clean" ? run.quality.findingCount : null),
      options,
    ),
  };
}

function buildCostSummary(runs: readonly L2RunSample[]): L2CostSummary {
  return {
    cachedInputTokens: runStat(runs, (run) => run.cost.cachedInputTokens),
    uncachedInputTokens: runStat(runs, (run) => run.cost.uncachedInputTokens),
    cacheWriteTokens: runStat(runs, (run) => run.cost.cacheWriteTokens),
    outputTokens: runStat(runs, (run) => run.cost.outputTokens),
    totalInputTokens: runStat(runs, (run) => run.cost.totalInputTokens),
    totalTokens: runStat(runs, (run) => run.cost.totalTokens),
    cacheHitRate: runStat(runs, (run) => run.cost.cacheHitRate),
    carc: runStat(runs, (run) => run.cost.carc),
  };
}

function buildLoopSummary(runs: readonly L2RunSample[]): L2LoopSummary {
  return {
    requests: runStat(runs, (run) => run.loop.requests),
    rounds: runStat(runs, (run) => run.loop.rounds),
    attemptedToolCalls: runStat(runs, (run) => run.loop.attemptedToolCalls),
    executedToolCalls: runStat(runs, (run) => run.loop.executedToolCalls),
  };
}

function buildQualitySummary(runs: readonly L2RunSample[]): L2QualitySummary {
  return {
    // judge 列只覆盖有真值的正例 case；clean MR 进阴性对照，不混入 judge 均值
    judgeRecall: runStat(runs, judgeSelector("recall")),
    judgePrecision: runStat(runs, judgeSelector("precision")),
    judgeF1: runStat(runs, judgeSelector("f1")),
    ruleRecall: runStat(runs, (run) => run.quality.rule?.recall ?? null),
    rulePrecision: runStat(runs, (run) => run.quality.rule?.precision ?? null),
    zeroFindingRate: statOfCaseMeans(
      caseMeans(runs, (run) => (run.quality.zeroFindings ? 1 : 0)),
    ),
    negativeControlFpPerCase: statOfCaseMeans(
      caseMeans(runs, (run) => (run.quality.truth === "clean" ? run.quality.findingCount : null)),
    ),
  };
}

function judgeSelector(field: "recall" | "precision" | "f1"): Selector {
  return (run) =>
    run.quality.truth === "provided" ? (run.quality.judge?.[field] ?? null) : null;
}

/** case 内跨 rep 均值（无有效值 → null；case 集合以输入为准） */
function caseMeans(runs: readonly L2RunSample[], selector: Selector): Map<string, number | null> {
  const valuesByCase = new Map<string, number[]>();
  const caseIds = new Set<string>();
  for (const run of runs) {
    caseIds.add(run.caseId);
    const value = selector(run);
    if (value === null || !Number.isFinite(value)) {
      continue;
    }
    valuesByCase.set(run.caseId, [...(valuesByCase.get(run.caseId) ?? []), value]);
  }
  const means = new Map<string, number | null>();
  for (const caseId of [...caseIds].sort()) {
    const values = valuesByCase.get(caseId) ?? [];
    means.set(caseId, values.length === 0 ? null : mean(values));
  }
  return means;
}

/** 先 case 内跨 rep 平均、再跨 case 的 Stat；仅 case 均值全为 null → null */
function statOfCaseMeans(means: ReadonlyMap<string, number | null>): Stat | null {
  const values: number[] = [];
  for (const value of means.values()) {
    if (value !== null && Number.isFinite(value)) {
      values.push(value);
    }
  }
  return statOfValues(values);
}

/** run 级观测 → 先 case 内均值、再跨 case 的 Stat（N/A 值被剔除） */
function runStat(runs: readonly L2RunSample[], selector: Selector): Stat | null {
  return perCaseStat(runs.map((run) => ({ caseId: run.caseId, value: selector(run) })));
}

interface PairedValues {
  readonly baseline: readonly number[];
  readonly candidate: readonly number[];
}

/** 按 caseId 确定性排序取两侧都有的配对值（N/A 剔除） */
function pairedValues(
  baseline: readonly L2RunSample[],
  candidate: readonly L2RunSample[],
  selector: Selector,
): PairedValues {
  const baselineMeans = caseMeans(baseline, selector);
  const candidateMeans = caseMeans(candidate, selector);
  const baselineValues: number[] = [];
  const candidateValues: number[] = [];
  for (const caseId of [...baselineMeans.keys()].sort()) {
    const baselineValue = baselineMeans.get(caseId) ?? null;
    const candidateValue = candidateMeans.get(caseId) ?? null;
    if (baselineValue === null || candidateValue === null) {
      continue;
    }
    baselineValues.push(baselineValue);
    candidateValues.push(candidateValue);
  }
  return { baseline: baselineValues, candidate: candidateValues };
}

/** 配对比率（candidate / baseline；仅正数域，0 基线 / 0 候选视为无配对） */
function ratioPair(
  baseline: readonly L2RunSample[],
  candidate: readonly L2RunSample[],
  selector: Selector,
  options: BootstrapOptions,
): PairedRatio {
  const values = pairedValues(baseline, candidate, selector);
  const ratios: number[] = [];
  const differences: number[] = [];
  for (let index = 0; index < values.baseline.length; index += 1) {
    const base = values.baseline[index] as number;
    const cand = values.candidate[index] as number;
    if (!(base > 0) || !(cand > 0)) {
      continue;
    }
    ratios.push(cand / base);
    differences.push(cand - base);
  }
  if (ratios.length === 0) {
    return {
      pairs: 0,
      mean: null,
      median: null,
      std: null,
      ci95: null,
      absoluteDiff: null,
    };
  }
  return {
    pairs: ratios.length,
    mean: geometricMeanOf(ratios),
    median: median(ratios),
    std: sampleStd(ratios),
    ci95: bootstrapGeometricMeanCI(ratios, options),
    absoluteDiff: diffOf(differences, options),
  };
}

/** 配对差值（candidate − baseline） */
function diffPair(
  baseline: readonly L2RunSample[],
  candidate: readonly L2RunSample[],
  selector: Selector,
  options: BootstrapOptions,
): PairedDiff {
  const values = pairedValues(baseline, candidate, selector);
  const differences = values.candidate.map(
    (value, index) => value - (values.baseline[index] as number),
  );
  return diffOf(differences, options);
}

function diffOf(differences: readonly number[], options: BootstrapOptions): PairedDiff {
  if (differences.length === 0) {
    return { pairs: 0, mean: null, median: null, std: null, ci95: null };
  }
  return {
    pairs: differences.length,
    mean: mean(differences),
    median: median(differences),
    std: sampleStd(differences),
    ci95: bootstrapMeanCI(differences, options),
  };
}

function geometricMeanOf(values: readonly number[]): number {
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}
