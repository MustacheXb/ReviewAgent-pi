/**
 * L3 三列定位报告 / 宣称门（#45，eval-only）：纯函数，零网络、零文件系统、
 * 无时钟。三列不进 S/A/B；C_ref totalTokens 仅参考分母；无报告 + 完整
 * environment + 产品签字时 claimsAllowed=false。
 */
export {
  DEFAULT_L3_GATE_THRESHOLDS,
  L3_REPORT_KIND,
  L3_REPORT_SCHEMA_VERSION,
  type L3Column,
  type L3ColumnKey,
  type L3Columns,
  type L3Cost,
  type L3Coverage,
  type L3EnvironmentStatus,
  type L3GateResult,
  type L3GateThresholds,
  type L3Gates,
  type L3Harness,
  type L3Quality,
  type L3ReferenceDenominator,
  type L3Report,
  type L3ReportInput,
  type L3SignOff,
} from "./contracts.js";
export { buildL3Report, checkEnvironment, renderL3ReportMarkdown } from "./report.js";
