import { EMPTY_EVIDENCE_GATE_COUNTS, EVIDENCE_GATE_STAGES } from "./contracts.js";
import type {
  AnalysisSummary,
  AnalysisRunInput,
  CostStats,
  EvidenceGateStage,
  L1Report,
  LoopStats,
  PrfMetrics,
  QualityColumn,
  RunAnalysis,
  Stat,
} from "./contracts.js";
import { perCaseStat, statOfValues } from "./stats.js";

/** 跨 run 汇总（成本 / 循环 / 截断）；每指标按 case 等权 */
export function buildSummary(runs: readonly RunAnalysis[]): AnalysisSummary {
  const caseIds = new Set(runs.map((run) => run.caseId));
  return {
    runCount: runs.length,
    caseCount: caseIds.size,
    cost: {
      cachedInputTokens: costStat(runs, (run) => run.cost.cachedInputTokens),
      uncachedInputTokens: costStat(runs, (run) => run.cost.uncachedInputTokens),
      cacheWriteTokens: costStat(runs, (run) => run.cost.cacheWriteTokens),
      outputTokens: costStat(runs, (run) => run.cost.outputTokens),
      totalInputTokens: costStat(runs, (run) => run.cost.totalInputTokens),
      totalTokens: costStat(runs, (run) => run.cost.totalTokens),
      cacheHitRate: costStat(runs, (run) => run.cost.cacheHitRate),
      toolCostTokens: costStat(runs, (run) => run.cost.toolCostTokens),
      retryCostTokens: costStat(runs, (run) => run.cost.retryCostTokens),
      summaryCostTokens: costStat(runs, (run) => run.cost.summaryCostTokens),
      currencyCost: costStat(runs, (run) => run.cost.currencyCost),
      carc: costStat(runs, (run) => run.cost.carc),
    } satisfies CostStats,
    loop: {
      requests: costStat(runs, (run) => run.loop.requests),
      rounds: costStat(runs, (run) => run.loop.rounds),
      attemptedToolCalls: costStat(runs, (run) => run.loop.attemptedToolCalls),
      executedToolCalls: costStat(runs, (run) => run.loop.executedToolCalls),
      skippedToolCalls: costStat(runs, (run) => run.loop.skippedToolCalls),
    } satisfies LoopStats,
    truncation: {
      truncatedRuns: runs.filter((run) => run.loop.truncated).length,
      reasons: countTruncationReasons(runs),
    },
  };
}

/** L1 绝对质量报告（不依赖 C；缺数据 → null） */
export function buildL1(
  runs: readonly RunAnalysis[],
  inputs: readonly AnalysisRunInput[],
  plannedCases: number | undefined,
): L1Report {
  const caseIds = new Set(runs.map((run) => run.caseId));
  const cleanRuns = runs.filter((run) => run.quality.truth === "clean");
  const planned = plannedCases ?? null;
  return {
    runCount: runs.length,
    caseCount: caseIds.size,
    rule: qualityColumn(runs, (run) => run.quality.rule),
    judge: qualityColumn(runs, (run) =>
      run.quality.truth === "clean" ? null : run.quality.judge,
    ),
    zeroFinding: zeroFindingRate(runs),
    negativeControl: negativeControl(cleanRuns),
    evidenceGateRejections: countEvidenceGateRejections(inputs),
    coverage: {
      plannedCases: planned,
      executedCases: caseIds.size,
      ratio: planned !== null && planned > 0 ? caseIds.size / planned : null,
    },
  };
}

function costStat(
  runs: readonly RunAnalysis[],
  selector: (run: RunAnalysis) => number | null,
): Stat | null {
  return perCaseStat(runs.map((run) => ({ caseId: run.caseId, value: selector(run) })));
}

function qualityColumn(
  runs: readonly RunAnalysis[],
  selector: (run: RunAnalysis) => PrfMetrics | null,
): QualityColumn {
  const measured = runs.flatMap((run) => {
    const prf = selector(run);
    return prf === null ? [] : [{ caseId: run.caseId, prf }];
  });
  return {
    runs: measured.length,
    recall: perCaseStat(measured.map(({ caseId, prf }) => ({ caseId, value: prf.recall }))),
    precision: perCaseStat(measured.map(({ caseId, prf }) => ({ caseId, value: prf.precision }))),
    f1: perCaseStat(measured.map(({ caseId, prf }) => ({ caseId, value: prf.f1 }))),
  };
}

function zeroFindingRate(runs: readonly RunAnalysis[]): L1Report["zeroFinding"] {
  const byCase = new Map<string, { total: number; zero: number }>();
  for (const run of runs) {
    const current = byCase.get(run.caseId) ?? { total: 0, zero: 0 };
    byCase.set(run.caseId, {
      total: current.total + 1,
      zero: current.zero + (run.quality.zeroFindings ? 1 : 0),
    });
  }
  const rates = [...byCase.values()].map((entry) => entry.zero / entry.total);
  return {
    runs: runs.length,
    zeroRuns: runs.filter((run) => run.quality.zeroFindings).length,
    rate: statOfValues(rates),
  };
}

function negativeControl(
  cleanRuns: readonly RunAnalysis[],
): L1Report["negativeControl"] {
  const byCase = new Map<string, number[]>();
  for (const run of cleanRuns) {
    byCase.set(run.caseId, [...(byCase.get(run.caseId) ?? []), run.quality.findingCount]);
  }
  const caseMeans = [...byCase.values()].map(
    (values) => values.reduce((sum, value) => sum + value, 0) / values.length,
  );
  return {
    cases: byCase.size,
    runs: cleanRuns.length,
    fpPerCase: statOfValues(caseMeans),
  };
}

function countTruncationReasons(runs: readonly RunAnalysis[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const run of runs) {
    for (const reason of run.loop.truncationReasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function countEvidenceGateRejections(
  inputs: readonly AnalysisRunInput[],
): Readonly<Record<EvidenceGateStage, number>> {
  const counts: Record<EvidenceGateStage, number> = { ...EMPTY_EVIDENCE_GATE_COUNTS };
  for (const input of inputs) {
    for (const rejection of input.record.baseline.audit.rejections) {
      if (!EVIDENCE_GATE_STAGES.includes(rejection.stage)) {
        throw new Error(
          `run record ${input.record.caseId}/${input.record.configId}/rep-${input.record.rep}: ` +
            `unknown evidence gate rejection stage ${JSON.stringify(rejection.stage)}`,
        );
      }
      counts[rejection.stage] += 1;
    }
  }
  return counts;
}
