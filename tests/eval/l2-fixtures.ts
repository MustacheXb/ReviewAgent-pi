import type {
  RunCostMetrics,
  RunLoopMetrics,
  RunQualityMetrics,
  TruthKind,
} from "../../src/eval/analysis/contracts.js";
import type { L2RunSample } from "../../src/eval/l2/contracts.js";

/** L2 配对 / 门判定测试共享夹具（#41）：可覆盖各指标的 run 级样本。 */

export interface L2SampleOverrides {
  readonly caseId: string;
  readonly rep: number;
  readonly carc?: number;
  readonly uncached?: number;
  readonly output?: number;
  readonly total?: number | null;
  readonly cacheHit?: number | null;
  readonly attempts?: number;
  readonly requests?: number;
  readonly judgeRecall?: number | null;
  readonly judgePrecision?: number | null;
  readonly truth?: TruthKind;
  readonly findingCount?: number;
  readonly zeroFindings?: boolean;
  readonly truncated?: boolean;
  readonly truncationReasons?: readonly string[];
}

export function l2Sample(overrides: L2SampleOverrides): L2RunSample {
  const truth = overrides.truth ?? "provided";
  const cost: RunCostMetrics = {
    cachedInputTokens: overrides.total === null ? null : 0,
    uncachedInputTokens: overrides.uncached ?? 0,
    cacheWriteTokens: 0,
    outputTokens: overrides.output ?? 0,
    totalInputTokens: overrides.total ?? null,
    totalTokens: overrides.total === undefined ? null : overrides.total,
    cacheHitRate: overrides.cacheHit ?? null,
    toolCostTokens: 0,
    carc: overrides.carc ?? 0,
  };
  const loop: RunLoopMetrics = {
    requests: overrides.requests ?? 1,
    rounds: 1,
    attemptedToolCalls: overrides.attempts ?? 1,
    executedToolCalls: 1,
    truncated: overrides.truncated ?? false,
    truncationReasons: overrides.truncationReasons ?? [],
  };
  const recall = overrides.judgeRecall ?? null;
  const precision = overrides.judgePrecision ?? null;
  const quality: RunQualityMetrics = {
    findingCount: overrides.findingCount ?? 0,
    zeroFindings: overrides.zeroFindings ?? (overrides.findingCount ?? 0) === 0,
    truth,
    rule: null,
    judge:
      recall === null || precision === null
        ? null
        : {
            recall,
            precision,
            f1:
              recall + precision === 0
                ? 0
                : (2 * recall * precision) / (recall + precision),
          },
  };
  return { caseId: overrides.caseId, rep: overrides.rep, cost, loop, quality };
}
