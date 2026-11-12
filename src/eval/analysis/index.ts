/**
 * 只读 RunRecord 分析器（#37，P0）：main 侧评测消费面。
 *
 * 纯读、零网络、零 LLM、零文件系统；不执行配置、不读网关。
 * 报告 schema 由 golden 测试锁定（tests/eval/testdata/analysis-report.golden.json）。
 *
 * 用法（外部 JSON 记录）：
 * ```ts
 * const parsed: unknown = JSON.parse(text);
 * validateAnalysisInput(parsed);
 * const report = analyzeRuns(parsed);
 * ```
 * N/A 纪律：缺缓存计量字段记 null（不记 0）；缺真值 / judge 结果时对应质量列为 null。
 */
export {
  ANALYSIS_REPORT_KIND,
  ANALYSIS_REPORT_SCHEMA_VERSION,
  DEFAULT_TOOL_COST_PRICING,
  EMPTY_EVIDENCE_GATE_COUNTS,
  EVIDENCE_GATE_STAGES,
  type AnalysisInput,
  type AnalysisPriceTable,
  type AnalysisReport,
  type AnalysisRunInput,
  type AnalysisSummary,
  type AnalysisTruth,
  type AnalysisTruthLocation,
  type CostStats,
  type CoverageReport,
  type EvidenceGateStage,
  type L1Report,
  type LoopStats,
  type MatchCounts,
  type NegativeControlReport,
  type PrfMetrics,
  type QualityColumn,
  type RunAnalysis,
  type RunCostMetrics,
  type RunLoopMetrics,
  type RunQualityMetrics,
  type Stat,
  type ToolCostPricing,
  type TruncationSummary,
  type TruthKind,
  type ZeroFindingRate,
} from "./contracts.js";
export { analyzeRuns } from "./analyze.js";
export { renderAnalysisMarkdown } from "./markdown.js";
export { validateAnalysisInput } from "./validate.js";
