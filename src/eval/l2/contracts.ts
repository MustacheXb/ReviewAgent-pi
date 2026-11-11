import type { RunAnalysis, Stat } from "../analysis/contracts.js";

/**
 * L2 配对回归门契约（#41，评测方案 §6 / 附录 B.1）。
 *
 * 口径纪律：
 * - 分析单位 = case（先 case 内跨 rep 均值，再跨 case / 配对）；rep1（冷）
 *   单列，rep2+（热）为 L2 主口径（§5.3 / §6.3）；
 * - 成本主指标 CARC；uncached / output 为分解；totalTokens / cacheHitRate
 *   必须报告但 totalTokens 不单独设门、cacheHitRate 只作解释变量；
 * - `null` = N/A，不写 0；
 * - 阈值 provisional（ADR-0017 §3/§5），空对照校准后由 #42 补记固化。
 */

/** L2 报告 kind（附录 B.1；与 campaign 报告分文件） */
export const L2_REPORT_KIND = "l2-token-bench";

/** L2 报告 schema 版本（golden / 形状测试锁定；#42 起 2） */
export const L2_REPORT_SCHEMA_VERSION = 2;

/** L2 报告文件名（campaign 输出目录内） */
export const L2_REPORT_FILE = "l2-report.json";

/** campaign 类型：空对照校准 vs 正式配对回归（#42） */
export type L2CampaignType = "calibration" | "formal";

/** 噪声底报告 kind / 文件名（#42；仅空对照校准落盘） */
export const NOISE_FLOOR_REPORT_KIND = "l2-noise-floor";
export const NOISE_FLOOR_REPORT_FILE = "noise-floor.json";
export const NOISE_FLOOR_MARKDOWN_FILE = "NOISE-FLOOR.md";
export const NOISE_FLOOR_REPORT_SCHEMA_VERSION = 1;

/** 配对统计的单个 run 观测（`RunAnalysis` 的结构子集；真值在 quality.truth） */
export type L2RunSample = Pick<RunAnalysis, "caseId" | "rep" | "cost" | "loop" | "quality">;

/** 复现门输入：记录级审计引用与 cache break 计数（不参与指标聚合） */
export interface L2ReproSample {
  readonly caseId: string;
  readonly arm: string;
  readonly rep: number;
  readonly auditPath: string;
  readonly cacheBreaks: number;
}

export interface L2CostSummary {
  readonly cachedInputTokens: Stat | null;
  readonly uncachedInputTokens: Stat | null;
  readonly cacheWriteTokens: Stat | null;
  readonly outputTokens: Stat | null;
  readonly totalInputTokens: Stat | null;
  readonly totalTokens: Stat | null;
  readonly cacheHitRate: Stat | null;
  readonly carc: Stat | null;
}

export interface L2LoopSummary {
  readonly requests: Stat | null;
  readonly rounds: Stat | null;
  readonly attemptedToolCalls: Stat | null;
  readonly executedToolCalls: Stat | null;
}

export interface L2QualitySummary {
  /** judge 列只覆盖有真值的 case（clean MR 单列阴性对照） */
  readonly judgeRecall: Stat | null;
  readonly judgePrecision: Stat | null;
  readonly judgeF1: Stat | null;
  readonly ruleRecall: Stat | null;
  readonly rulePrecision: Stat | null;
  /** 零 finding 率（每 case 内跨 rep 的 run 占比，再跨 case） */
  readonly zeroFindingRate: Stat | null;
  /** clean MR 每案假阳性数（case 内跨 rep 均值，再跨 case） */
  readonly negativeControlFpPerCase: Stat | null;
}

/** 单臂单口径（warm / cold）的指标汇总 */
export interface L2MetricSet {
  readonly runs: number;
  readonly cases: number;
  readonly cost: L2CostSummary;
  readonly loop: L2LoopSummary;
  readonly quality: L2QualitySummary;
}

/** 单臂的双口径：warm = rep2+（L2 主口径），cold = rep1（单列） */
export interface L2ArmMetrics {
  readonly warm: L2MetricSet;
  readonly cold: L2MetricSet;
}

/** 配对差值统计（质量 / 解释变量；均值、中位数、样本标准差、bootstrap 95% CI） */
export interface PairedDiff {
  /** 参与配对的 case 数（N/A 或无配对 → 0） */
  readonly pairs: number;
  readonly mean: number | null;
  readonly median: number | null;
  readonly std: number | null;
  readonly ci95: readonly [number, number] | null;
}

/**
 * 配对比率统计。`mean` 是比率的几何均值（评测方案 §6.3）；`absoluteDiff`
 * 同时给出绝对差（token / 次数），避免只看比例掩盖基数差异。
 */
export interface PairedRatio extends PairedDiff {
  readonly absoluteDiff: PairedDiff | null;
}

/** 配对指标集（warm 进主门；cold 单列） */
export interface L2PairedSet {
  readonly carcRatio: PairedRatio;
  readonly uncachedRatio: PairedRatio;
  readonly outputRatio: PairedRatio;
  readonly totalTokensRatio: PairedRatio;
  readonly cachedInputRatio: PairedRatio;
  readonly attemptsRatio: PairedRatio;
  readonly requestsRatio: PairedRatio;
  /** cacheHitRate 差值（百分点；只作解释变量，不设 ≥85% 硬门） */
  readonly cacheHitRateDiff: PairedDiff;
  readonly judgeRecallDiff: PairedDiff;
  readonly judgePrecisionDiff: PairedDiff;
  readonly zeroFindingRateDiff: PairedDiff;
  readonly negativeControlFpDiff: PairedDiff;
}

export interface L2PairedMetrics {
  readonly warm: L2PairedSet;
  readonly cold: L2PairedSet;
}

export interface L2Coverage {
  /** 计划单元数 = case 数 × reps × 参跑 arm 数 */
  readonly planned: number;
  /** 已落盘单元记录数（内核成功；judge 可能失败） */
  readonly executed: number;
  /** 有 judge 结果的单元数（L1 质量非劣的有效样本；coverage.ratio 的分子） */
  readonly judged: number;
  readonly failed: number;
  /** judged / planned；planned 为 0 → null（N/A） */
  readonly ratio: number | null;
  readonly note: string;
}

/** 门阈值（initial provisional；ADR-0017 §3，校准后由 #42 补记） */
export interface L2GateThresholds {
  /** CARC 比率几何均值上限 */
  readonly maxCarcRatio: number;
  /** CARC 配对 95% CI 上界必须严格小于该值 */
  readonly maxCarcRatioCiUpper: number;
  readonly maxUncachedRatio: number;
  readonly maxOutputRatio: number;
  readonly maxAttemptsRatio: number;
  readonly maxRequestsRatio: number;
  /** judge Recall / Precision 配对 CI 下界的非劣边界（百分点，0.03 = 3pp） */
  readonly qualityNonInferiorityPp: number;
  /** 零 finding 率相对 baseline 允许的最大上升（0.02 = 2pp） */
  readonly maxZeroFindingRateIncreasePp: number;
  /** 阴性对照 FP 相对 baseline 允许的上升倍数（1σ） */
  readonly maxNegativeControlFpSigma: number;
  readonly minCoverage: number;
  /** 有界性：单 run 绝对值上界（设计 §4.1 安全上界） */
  readonly maxAttemptedToolCalls: number;
  readonly maxRequests: number;
  readonly maxOutputTokens: number;
}

/** 初始 provisional 阈值（ADR-0017 §3 / 评测方案 §6.4；#42 校准后更新） */
export const DEFAULT_L2_GATE_THRESHOLDS: L2GateThresholds = {
  maxCarcRatio: 0.9,
  maxCarcRatioCiUpper: 1.0,
  maxUncachedRatio: 1.0,
  maxOutputRatio: 1.05,
  maxAttemptsRatio: 1.0,
  maxRequestsRatio: 1.0,
  qualityNonInferiorityPp: 0.03,
  maxZeroFindingRateIncreasePp: 0.02,
  maxNegativeControlFpSigma: 1,
  minCoverage: 0.95,
  maxAttemptedToolCalls: 12,
  maxRequests: 24,
  maxOutputTokens: 48_000,
};

/** 单个门的判定（pass/fail；detail 说明失败原因 / N/A 口径） */
export interface L2GateResult {
  readonly pass: boolean;
  readonly rule: string;
  readonly detail: string;
}

export interface L2Gates {
  readonly cost: L2GateResult;
  readonly quality: L2GateResult;
  readonly boundedness: L2GateResult;
  readonly reproducibility: L2GateResult;
}

/**
 * 门判定输入：warm（rep2+）的臂内指标与配对统计进主门；boundedness 消费
 * 全部 run 观测（两臂冷热全查）；reproducibility 消费记录级审计引用。
 */
export interface L2GateInput {
  readonly baselineRef: string;
  readonly candidateRef: string;
  readonly baseline: L2MetricSet;
  readonly candidate: L2MetricSet;
  readonly paired: L2PairedSet;
  readonly runs: readonly L2RunSample[];
  readonly repro: readonly L2ReproSample[];
  readonly coverage: L2Coverage;
  /** 数据集内 clean MR 阴性对照 case 数（0 = N/A 可接受；>0 缺数据必须 fail） */
  readonly negativeControlCases: number;
  /** 阈值覆盖（#42 校准时可用；缺省 = DEFAULT_L2_GATE_THRESHOLDS） */
  readonly thresholds?: Partial<L2GateThresholds>;
}

/** 门判定输出（阈值一并返回，供报告留痕） */
export interface L2GateEvaluation {
  readonly gates: L2Gates;
  readonly claimsAllowed: boolean;
  readonly thresholds: L2GateThresholds;
}

/** bootstrap 参数留痕（复算口径） */
export interface L2BootstrapMetadata {
  readonly iterations: number;
  readonly seed: number;
  readonly confidence: number;
}

/** L2 配对回归报告（附录 B.1；campaign 输出目录 `l2-report.json`） */
export interface L2Report {
  readonly kind: typeof L2_REPORT_KIND;
  readonly schemaVersion: typeof L2_REPORT_SCHEMA_VERSION;
  readonly campaignId: string;
  /** 空对照校准（同 ref 双 arm）vs 正式配对回归（#42） */
  readonly campaignType: L2CampaignType;
  /**
   * 引用的空对照校准 campaign id（#42）：校准自身 = campaignId；
   * 正式 campaign = 其引用的校准（可空 = 未校准）。
   */
  readonly calibrationRef: string | null;
  readonly baseline: { readonly ref: string; readonly model: string };
  readonly candidate: { readonly ref: string; readonly model: string };
  readonly dataset: {
    readonly cases: number;
    /** clean MR 阴性对照 case 数（0 = 本数据集无阴性对照，报告注明 N/A） */
    readonly negativeControl: number;
    readonly hash: string;
  };
  readonly environmentRef: "environment.json";
  /** 样本量留痕（#42；校准可复算需能读出 case / reps / arms） */
  readonly sampling: {
    readonly cases: number;
    readonly reps: number;
    readonly arms: number;
    readonly planned: number;
  };
  readonly coverage: L2Coverage;
  /** 两臂全部 run（冷热）的绝对值上界观测（#42 阈值复核输入） */
  readonly bounds: {
    readonly maxAttemptedToolCalls: number | null;
    readonly maxRequests: number | null;
    readonly maxOutputTokens: number | null;
    readonly truncatedRuns: number;
  };
  readonly metrics: {
    readonly baseline: L2ArmMetrics;
    readonly candidate: L2ArmMetrics;
    readonly paired: L2PairedMetrics;
  };
  readonly gates: L2Gates;
  /**
   * L2 内部「可引用该优化通过配对门」的结论位。仅当四门全过 **且**
   * baseline/candidate ref 不同时为 true；空对照校准不得据此宣称收益。
   * 对外宣称仍需 L3 报告 + environment.json + 产品签字（ADR-0017 §4）。
   */
  readonly claimsAllowed: boolean;
  readonly bootstrap: L2BootstrapMetadata;
  readonly thresholds: L2GateThresholds;
}
