import type { RunAnalysis } from "../analysis/contracts.js";
import { portableRepoPath } from "../campaign/paths.js";
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
  type L2CampaignType,
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
 *
 * 空对照校准（#42）：同 ref 双 arm = calibration，`calibrationRef` 自指
 * campaignId；正式 campaign 记录其引用的校准 id（可空）。校准只测噪声底，
 * 不得宣称收益。
 */

export interface CampaignIdentity {
  readonly campaignType: L2CampaignType;
  readonly calibrationRef: string | null;
}

/** 只需 calibrationRef 的 provenance 子集（environment input / manifest 共用） */
export interface CalibrationProvenance {
  readonly evaluation: { readonly calibrationRef: string | null };
}

/**
 * 判定 campaign 类型并解析 `calibrationRef`（#42）。同 ref 双 arm 即空对照
 * 校准（物理定义）；此时 `calibrationRef` 必须自指 campaignId（缺省自动补齐，
 * 显式给别的 id 视为错配 fail fast）。同 ref 单 arm 是单边冒烟，不作校准。
 */
export function resolveCampaignIdentity(
  plan: CampaignPlan,
  environment: CalibrationProvenance,
): CampaignIdentity {
  const sameCode = plan.baselineRef === plan.candidateRef;
  const dualArm =
    plan.arms.includes("baseline") && plan.arms.includes("candidate");
  const provided = environment.evaluation.calibrationRef;
  if (!sameCode || !dualArm) {
    return { campaignType: "formal", calibrationRef: provided };
  }
  if (provided !== null && provided !== plan.campaignId) {
    throw new Error(
      `campaign: empty-control calibration must record its own campaign id as ` +
        `calibrationRef (got ${JSON.stringify(provided)}, expected ${JSON.stringify(plan.campaignId)})`,
    );
  }
  return { campaignType: "calibration", calibrationRef: plan.campaignId };
}

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
  const allRuns = [...baselineRuns, ...candidateRuns];
  const identity = resolveCampaignIdentity(args.plan, args.environment);
  const bootstrap: BootstrapOptions = {
    ...DEFAULT_BOOTSTRAP_OPTIONS,
    ...args.bootstrap,
  };

  const coverage = buildCoverage(args, countJudgedRuns(allRuns));
  const warmBaseline = warmRuns(baselineRuns);
  const warmCandidate = warmRuns(candidateRuns);
  const warmPaired = buildPairedSet(warmBaseline, warmCandidate, bootstrap);
  const evaluation = evaluateL2Gates({
    baselineRef: args.plan.baselineRef,
    candidateRef: args.plan.candidateRef,
    baseline: buildMetricSet(warmBaseline),
    candidate: buildMetricSet(warmCandidate),
    paired: warmPaired,
    runs: allRuns,
    repro: args.records.map(toReproSample),
    coverage,
    negativeControlCases: countNegativeControlCases(allRuns),
    ...(args.thresholds !== undefined ? { thresholds: args.thresholds } : {}),
  });

  return {
    kind: L2_REPORT_KIND,
    schemaVersion: L2_REPORT_SCHEMA_VERSION,
    campaignId: args.plan.campaignId,
    campaignType: identity.campaignType,
    calibrationRef: identity.calibrationRef,
    outputDir: portableRepoPath(args.plan.outputDir),
    baseline: { ref: args.plan.baselineRef, model: args.plan.model },
    candidate: { ref: args.plan.candidateRef, model: args.plan.model },
    dataset: {
      cases: args.environment.dataset.caseCount,
      negativeControl: countNegativeControlCases(allRuns),
      hash: args.environment.dataset.hash,
    },
    environmentRef: ENVIRONMENT_REF,
    sampling: {
      cases: args.environment.dataset.caseCount,
      reps: args.plan.reps,
      arms: args.plan.arms.length,
      planned: args.plannedUnits,
    },
    coverage,
    bounds: computeBounds(allRuns),
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

/** 两臂全部 run 的绝对值观测（有界性阈值复核输入；无 run → null） */
function computeBounds(runs: readonly RunAnalysis[]): L2Report["bounds"] {
  return {
    maxAttemptedToolCalls: maxOrNull(runs.map((run) => run.loop.attemptedToolCalls)),
    maxRequests: maxOrNull(runs.map((run) => run.loop.requests)),
    maxOutputTokens: maxOrNull(runs.map((run) => run.cost.outputTokens)),
    truncatedRuns: runs.filter((run) => run.loop.truncated).length,
  };
}

function maxOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
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
