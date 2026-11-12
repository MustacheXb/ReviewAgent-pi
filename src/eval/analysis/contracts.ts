import type { RunRecord } from "review-pi";

/**
 * 只读分析器契约（#37，P0）：输入历史 A–D / 当前 E 的 RunRecord，输出标准化
 * 报告 JSON。纯读、零网络、零 LLM、零文件系统——本目录只做记录换算。
 *
 * N/A 纪律（ADR-0017 / 评测方案附录 A）：
 * - `null` 表示 N/A，不写 0；
 * - 缺失缓存计量字段（cacheReadTokens / cacheWriteTokens）记 null，不记 0；
 * - 缺失真值 / judge 结果时，对应质量列记 null。
 */

/** 报告 kind（机读标识；schema 变更时同步版本号） */
export const ANALYSIS_REPORT_KIND = "run-record-analysis";

/**
 * 报告 schema 版本（golden 测试锁定；v2 = #51 增加 currency / priceValidFrom / retry / summary / skipped）。
 *
 * 与 #49「新字段可选、缺省省键」的差异：#51 验收明确要求缺 retry / summary
 * 成本时字段为 null、缺价目时 currency 为 null，故这些新字段是 present-null
 * 而非省键；v2 标记读取方需要容忍这些键。
 */
export const ANALYSIS_REPORT_SCHEMA_VERSION = 2;

/** 分析输入：一条 run 记录 + 可选真值 / judge 结果 */
export interface AnalysisRunInput {
  readonly record: RunRecord;
  /** 真值；undefined = 未提供（N/A），null = clean MR 阴性对照 */
  readonly truth?: AnalysisTruth | null;
  /** judge 行级计数；undefined = 未判（N/A） */
  readonly judgeCounts?: MatchCounts;
  /** 重试成本（token 口径）；undefined / null = 尚无重试机制或未计量（N/A） */
  readonly retryCostTokens?: number | null;
  /** 摘要 / compaction 成本（token 口径）；undefined / null = 无摘要机制（N/A） */
  readonly summaryCostTokens?: number | null;
}

/** 价目表（静态 JSON；缺失时 currency / priceValidFrom 记 null，不按固定折扣假设） */
export interface AnalysisPriceTable {
  readonly currency: string;
  readonly priceValidFrom: string;
  /** 三种价格在批 1 只校验并随 CLI 读取；货币口径成本在批 4（缓存合同）接线 */
  readonly cacheHitPrice: number;
  readonly cacheMissPrice: number;
  readonly cacheWritePrice?: number;
  readonly outputPrice: number;
}

/** 工具成本计价（token 口径；默认 0 = 不计价，与历史记录口径一致） */
export interface ToolCostPricing {
  /** 每次工具调用固定计价（token 数） */
  readonly fixedCostPerCall: number;
  /** 工具结果每字符计价（token 数） */
  readonly costPerResultChar: number;
}

export const DEFAULT_TOOL_COST_PRICING: ToolCostPricing = {
  fixedCostPerCall: 0,
  costPerResultChar: 0,
};

/** 分析输入面 */
export interface AnalysisInput {
  readonly runs: readonly AnalysisRunInput[];
  /** 计划 case 数（coverage 分母）；缺省 → coverage 为 N/A */
  readonly plannedCases?: number;
  /** 工具成本计价；缺省全 0（历史记录口径） */
  readonly toolCost?: ToolCostPricing;
  /** 价目表；缺省 → currency / priceValidFrom 记 null（N/A） */
  readonly priceTable?: AnalysisPriceTable;
}

/** 真值位置（与 MRCase.truth.locations 形状对齐） */
export interface AnalysisTruthLocation {
  readonly file: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly defectNature: string;
}

/** 真值（只取分析所需的位置集） */
export interface AnalysisTruth {
  readonly locations: readonly AnalysisTruthLocation[];
}

/** TP / FP / FN 计数 */
export interface MatchCounts {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
}

/** 单次 run 的四行 token 记账 + 辅助 token 指标 */
export interface RunCostMetrics {
  /** 命中缓存的输入 token；无缓存计量字段 → null（N/A，不记 0） */
  readonly cachedInputTokens: number | null;
  /** 未命中缓存的输入 token */
  readonly uncachedInputTokens: number;
  /** 缓存写入 token；字段缺失 → null（N/A，不记 0） */
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number;
  /** 总输入 = uncached + cached + cacheWrite；无缓存计量（cached = null）→ null（N/A） */
  readonly totalInputTokens: number | null;
  /** 总 token = 总输入 + 输出；无缓存计量（totalInput = null）→ null（N/A） */
  readonly totalTokens: number | null;
  /** cachedInputTokens / totalInputTokens；无缓存计量或分母 0 → null */
  readonly cacheHitRate: number | null;
  /** 工具成本（token 口径；默认计价 0） */
  readonly toolCostTokens: number;
  /** 重试成本；null = 无重试机制 / 未计量（N/A，不记 0；独立报告，不计入 CARC） */
  readonly retryCostTokens: number | null;
  /** 摘要 / compaction 成本；null = 无摘要机制（N/A，不记 0；独立报告，不计入 CARC） */
  readonly summaryCostTokens: number | null;
  /** CARC = uncachedInput + cacheWrite + output + toolCost（ADR-0017 口径） */
  readonly carc: number;
}

/** 单次 run 的循环 / 工具 / 截断指标（L2 有界性与「模型收敛 vs 预算截断」口径） */
export interface RunLoopMetrics {
  /** wire 请求数 = phaseLog.requestCount 之和 */
  readonly requests: number;
  readonly rounds: number;
  /** 票面 attempts：模型发起的工具调用数（含预算拒绝；= toolCallLog 条目数） */
  readonly attemptedToolCalls: number;
  /** 实际执行的工具调用数（内核 RunSnapshot.toolCalls） */
  readonly executedToolCalls: number;
  /** 超预算 / 未进入执行的工具调用数 = max(0, attempted − executed)；当前日志可区分即预算拒绝 */
  readonly skippedToolCalls: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
}

/** Recall / Precision / F1；null = 分母为零（未定义），不记 0 */
export interface PrfMetrics {
  readonly recall: number | null;
  readonly precision: number | null;
  readonly f1: number | null;
}

/** 真值可得性：provided = 有真值；clean = clean MR；unknown = 调用方未提供 */
export type TruthKind = "provided" | "clean" | "unknown";

/** 单次 run 的 L1 质量指标（rule / judge 双列） */
export interface RunQualityMetrics {
  readonly findingCount: number;
  readonly zeroFindings: boolean;
  readonly truth: TruthKind;
  /** 确定性 rule 列；无真值（unknown / clean）→ null */
  readonly rule: PrfMetrics | null;
  /** judge 列（消费预计算计数）；未提供 judge 结果 → null */
  readonly judge: PrfMetrics | null;
}

/** 单次 run 的只读分析结果 */
export interface RunAnalysis {
  readonly source: RunRecord["source"];
  readonly caseId: string;
  readonly configId: RunRecord["configId"];
  readonly rep: number;
  readonly model: string;
  readonly completedAt: string;
  readonly cost: RunCostMetrics;
  readonly loop: RunLoopMetrics;
  readonly quality: RunQualityMetrics;
}

/** 均值 ± 样本标准差（n ≤ 1 时 std = 0）；null = 无有效样本 */
export interface Stat {
  readonly count: number;
  readonly mean: number;
  readonly std: number;
}

/** 跨 case 等权汇总的成本指标（每指标先 case 内均值、再跨 case 均值 ± 样本标准差） */
export interface CostStats {
  readonly cachedInputTokens: Stat | null;
  readonly uncachedInputTokens: Stat | null;
  readonly cacheWriteTokens: Stat | null;
  readonly outputTokens: Stat | null;
  readonly totalInputTokens: Stat | null;
  readonly totalTokens: Stat | null;
  readonly cacheHitRate: Stat | null;
  readonly toolCostTokens: Stat | null;
  readonly retryCostTokens: Stat | null;
  readonly summaryCostTokens: Stat | null;
  readonly carc: Stat | null;
}

/** 跨 case 等权汇总的循环 / 工具指标 */
export interface LoopStats {
  readonly requests: Stat | null;
  readonly rounds: Stat | null;
  readonly attemptedToolCalls: Stat | null;
  readonly executedToolCalls: Stat | null;
  readonly skippedToolCalls: Stat | null;
}

/** 截断汇总：截断 run 数与原因计数（键按字典序） */
export interface TruncationSummary {
  readonly truncatedRuns: number;
  readonly reasons: Readonly<Record<string, number>>;
}

/** 跨 run 汇总（成本 + 循环 + 截断） */
export interface AnalysisSummary {
  readonly runCount: number;
  readonly caseCount: number;
  readonly cost: CostStats;
  readonly loop: LoopStats;
  readonly truncation: TruncationSummary;
}

/** 证据闸拦截阶段计数（固定键序，零值保留）——阶段词表单源 */
export const EMPTY_EVIDENCE_GATE_COUNTS = {
  SCHEMA_INVALID: 0,
  NON_ENGLISH: 0,
  NO_EVIDENCE: 0,
  VERIFICATION_FAILED: 0,
  DUPLICATE_ID: 0,
} as const;

/** 证据闸拦截阶段（与 RunAudit.rejections[].stage 同值域；由计数表派生） */
export type EvidenceGateStage = keyof typeof EMPTY_EVIDENCE_GATE_COUNTS;

/** 证据闸阶段列表（校验 / 报告共用的单源词表） */
export const EVIDENCE_GATE_STAGES = Object.keys(
  EMPTY_EVIDENCE_GATE_COUNTS,
) as readonly EvidenceGateStage[];

/** L1 质量列（rule 或 judge）：按 case 等权聚合的 P/R/F1 */
export interface QualityColumn {
  /** 该列有有效数据的 run 数 */
  readonly runs: number;
  readonly recall: Stat | null;
  readonly precision: Stat | null;
  readonly f1: Stat | null;
}

/** 零 finding 率（按 case 等权） */
export interface ZeroFindingRate {
  readonly runs: number;
  readonly zeroRuns: number;
  readonly rate: Stat | null;
}

/** 阴性对照：clean MR 每案假阳性数（case 内跨 rep 均值，再跨 case） */
export interface NegativeControlReport {
  readonly cases: number;
  readonly runs: number;
  readonly fpPerCase: Stat | null;
}

/** 覆盖：成功评测的 case / 计划 case；无计划数据 → N/A */
export interface CoverageReport {
  readonly plannedCases: number | null;
  readonly executedCases: number;
  readonly ratio: number | null;
}

/** L1 绝对质量报告（不依赖 C；缺数据时对应字段为 null） */
export interface L1Report {
  readonly runCount: number;
  readonly caseCount: number;
  readonly rule: QualityColumn;
  readonly judge: QualityColumn;
  readonly zeroFinding: ZeroFindingRate;
  readonly negativeControl: NegativeControlReport;
  /** 证据闸拒绝阶段分布（固定键序，零值保留） */
  readonly evidenceGateRejections: Readonly<Record<EvidenceGateStage, number>>;
  readonly coverage: CoverageReport;
}

/** 标准化报告（机读；golden 测试锁定形状与 key 序） */
export interface AnalysisReport {
  readonly kind: typeof ANALYSIS_REPORT_KIND;
  readonly schemaVersion: typeof ANALYSIS_REPORT_SCHEMA_VERSION;
  /** 价目币种；无价目表 → null（N/A，不冒充真实账单） */
  readonly currency: string | null;
  /** 价目生效时间；无价目表 → null（N/A） */
  readonly priceValidFrom: string | null;
  readonly runs: readonly RunAnalysis[];
  readonly summary: AnalysisSummary;
  readonly l1: L1Report;
}
