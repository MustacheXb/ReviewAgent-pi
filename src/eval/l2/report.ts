import type { RunAnalysis } from "../analysis/contracts.js";
import {
  ENVIRONMENT_REF,
  type CampaignPlan,
  type CampaignReport,
  type EnvironmentManifest,
  type EvalRunRecord,
} from "../campaign/contracts.js";
import { DEFAULT_BOOTSTRAP_OPTIONS, type BootstrapOptions } from "./bootstrap.js";
import {
  L2_REPORT_KIND,
  L2_REPORT_SCHEMA_VERSION,
  type L2ArmMetrics,
  type L2BootstrapMetadata,
  type L2Coverage,
  type L2GateThresholds,
  type L2ReproSample,
  type L2Report,
} from "./contracts.js";
import { evaluateL2Gates } from "./gates.js";
import { buildMetricSet, buildPairedSet } from "./metrics.js";

/**
 * L2 报告装配（#41）：从 campaign 的两侧分节分析报告 + 单元记录构造
 * `l2-report.json`（附录 B.1）。
 *
 * 冷热分离（§5.3 / §6.3）：rep1 为冷启动单列（cold），rep2+ 为 L2 主口径
 * （warm）；四门只消费 warm 配对统计。有界性检查两臂全部 run（冷热全查），
 * 可复现门消费单元记录的审计引用与 cache break 计数。
 */

export interface BuildL2ReportArgs {
  readonly plan: CampaignPlan;
  /** campaign 报告的两侧分节（`report.json` 的 arms） */
  readonly arms: CampaignReport["arms"];
  readonly environment: EnvironmentManifest;
  /** 成功落盘的单元记录（coverage / 可复现门输入） */
  readonly records: readonly EvalRunRecord[];
  /** 计划单元数（case 数 × reps × 参跑 arm 数） */
  readonly plannedUnits: number;
  readonly failedUnits: number;
  readonly thresholds?: Partial<L2GateThresholds>;
  readonly bootstrap?: Partial<BootstrapOptions>;
}

export function buildL2Report(args: BuildL2ReportArgs): L2Report {
  const baselineRuns = args.arms.baseline?.runs ?? [];
  const candidateRuns = args.arms.candidate?.runs ?? [];
  const bootstrap: BootstrapOptions = {
    ...DEFAULT_BOOTSTRAP_OPTIONS,
    ...args.bootstrap,
  };

  const coverage = buildCoverage(args, countJudgedRuns([...baselineRuns, ...candidateRuns]));
  const warmBaseline = warmRuns(baselineRuns);
  const warmCandidate = warmRuns(candidateRuns);
  const warmPaired = buildPairedSet(warmBaseline, warmCandidate, bootstrap);
  const evaluation = evaluateL2Gates({
    baselineRef: args.plan.baselineRef,
    candidateRef: args.plan.candidateRef,
    baseline: buildMetricSet(warmBaseline),
    candidate: buildMetricSet(warmCandidate),
    paired: warmPaired,
    runs: [...baselineRuns, ...candidateRuns],
    repro: args.records.map(toReproSample),
    coverage,
    negativeControlCases: countNegativeControlCases([...baselineRuns, ...candidateRuns]),
    ...(args.thresholds !== undefined ? { thresholds: args.thresholds } : {}),
  });

  return {
    kind: L2_REPORT_KIND,
    schemaVersion: L2_REPORT_SCHEMA_VERSION,
    campaignId: args.plan.campaignId,
    baseline: { ref: args.plan.baselineRef, model: args.plan.model },
    candidate: { ref: args.plan.candidateRef, model: args.plan.model },
    dataset: {
      cases: args.environment.dataset.caseCount,
      negativeControl: countNegativeControlCases([...baselineRuns, ...candidateRuns]),
      hash: args.environment.dataset.hash,
    },
    environmentRef: ENVIRONMENT_REF,
    coverage,
    metrics: {
      baseline: buildArmMetrics(baselineRuns),
      candidate: buildArmMetrics(candidateRuns),
      paired: {
        warm: warmPaired,
        cold: buildPairedSet(
          coldRuns(baselineRuns),
          coldRuns(candidateRuns),
          bootstrap,
        ),
      },
    },
    gates: evaluation.gates,
    claimsAllowed: evaluation.claimsAllowed,
    bootstrap: bootstrapMetadata(bootstrap),
    thresholds: evaluation.thresholds,
  };
}

/** rep2+ = 热稳定主口径；rep1 = 冷启动单列 */
function warmRuns(runs: readonly RunAnalysis[]): readonly RunAnalysis[] {
  return runs.filter((run) => run.rep >= 2);
}

function coldRuns(runs: readonly RunAnalysis[]): readonly RunAnalysis[] {
  return runs.filter((run) => run.rep === 1);
}

function buildArmMetrics(runs: readonly RunAnalysis[]): L2ArmMetrics {
  return {
    warm: buildMetricSet(warmRuns(runs)),
    cold: buildMetricSet(coldRuns(runs)),
  };
}

function buildCoverage(args: BuildL2ReportArgs, judged: number): L2Coverage {
  const planned = args.plannedUnits;
  return {
    planned,
    executed: args.records.length,
    judged,
    failed: args.failedUnits,
    ratio: planned > 0 ? judged / planned : null,
    note:
      `${args.environment.dataset.caseCount} case × ${args.plan.reps} reps × ` +
      `${args.plan.arms.length} arms`,
  };
}

/** 有 judge 结果的 run 数（L1 质量非劣的有效样本；judge 失败不计入） */
function countJudgedRuns(runs: readonly RunAnalysis[]): number {
  return runs.filter((run) => run.quality.judge !== null).length;
}

/** 数据集内 clean MR 阴性对照 case 数（跨两臂去重） */
function countNegativeControlCases(runs: readonly RunAnalysis[]): number {
  return new Set(
    runs.filter((run) => run.quality.truth === "clean").map((run) => run.caseId),
  ).size;
}

function toReproSample(record: EvalRunRecord): L2ReproSample {
  return {
    caseId: record.caseId,
    arm: record.arm,
    rep: record.rep,
    auditPath: record.baseline.auditPath,
    cacheBreaks: record.baseline.audit.cacheBreaks?.length ?? 0,
  };
}

function bootstrapMetadata(bootstrap: BootstrapOptions): L2BootstrapMetadata {
  return {
    iterations: bootstrap.iterations,
    seed: bootstrap.seed,
    confidence: bootstrap.confidence,
  };
}
