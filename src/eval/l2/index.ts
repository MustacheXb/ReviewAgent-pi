/**
 * L2 配对回归门（#41，eval-only）：配对统计 / bootstrap / 四门判定 / 报告装配。
 * #42 增加空对照校准噪声底报告（JSON + 确定性 Markdown）。
 *
 * 零网络、零文件系统：输入是 campaign 的两侧分节分析报告与单元记录，输出
 * `l2-report.json` / `noise-floor.json` 形状的纯数据。campaign runner 与
 * `--report-only` 共用本模块。
 */
export {
  DEFAULT_BOOTSTRAP_OPTIONS,
  bootstrapGeometricMeanCI,
  bootstrapMeanCI,
  type BootstrapOptions,
} from "./bootstrap.js";
export {
  buildNoiseFloorReport,
  renderNoiseFloorMarkdown,
  type BuildNoiseFloorReportArgs,
} from "./calibration.js";
export {
  DEFAULT_L2_GATE_THRESHOLDS,
  L2_REPORT_FILE,
  L2_REPORT_KIND,
  L2_REPORT_SCHEMA_VERSION,
  NOISE_FLOOR_MARKDOWN_FILE,
  NOISE_FLOOR_REPORT_FILE,
  NOISE_FLOOR_REPORT_KIND,
  NOISE_FLOOR_REPORT_SCHEMA_VERSION,
  type L2ArmMetrics,
  type L2BootstrapMetadata,
  type L2CampaignType,
  type L2CostSummary,
  type L2Coverage,
  type L2GateEvaluation,
  type L2GateInput,
  type L2GateResult,
  type L2GateThresholds,
  type L2Gates,
  type L2LoopSummary,
  type L2MetricSet,
  type L2PairedMetrics,
  type L2PairedSet,
  type L2QualitySummary,
  type L2Report,
  type L2ReproSample,
  type L2RunSample,
  type NoiseFloorEnvironment,
  type NoiseFloorReport,
  type PairedDiff,
  type PairedRatio,
  type ThresholdRecommendation,
  type ThresholdReview,
} from "./contracts.js";
export { claimsAllowedOf, evaluateL2Gates } from "./gates.js";
export { buildMetricSet, buildPairedSet } from "./metrics.js";
export {
  buildL2Report,
  resolveCampaignIdentity,
  type BuildL2ReportArgs,
  type CampaignIdentity,
} from "./report.js";
