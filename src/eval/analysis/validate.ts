import type { AnalysisInput } from "./contracts.js";
import { EVIDENCE_GATE_STAGES } from "./contracts.js";
import { truthKindOf } from "./truth-kind.js";

/**
 * 历史配置值域（读面兼容 A–D；与 review-pi HistoricalConfigId 同值）。
 * 本地重声明是隔离纪律的代价：分析器只允许 type-only import review-pi
 * （零运行期依赖），不能复用其运行期常量 HISTORICAL_CONFIG_IDS。
 */
export const ANALYSIS_CONFIG_IDS = ["A", "B", "C", "D", "E"] as const;

const EVIDENCE_GATE_STAGE_SET = new Set<string>(EVIDENCE_GATE_STAGES);

/**
 * 分析输入校验（外部 JSON 数据 fail fast；asserts 使调用方无需强转）。
 *
 * 只校验分析器实际消费的字段；可选缓存字段允许缺席（记 N/A，不记 0），
 * 但必填 usage / 审计字段缺失即报错。错误消息带 run 单元定位，便于从
 * 历史目录批量喂数据时定位坏记录。
 */
export function validateAnalysisInput(input: unknown): asserts input is AnalysisInput {
  if (!isRecord(input)) {
    throw new Error("analysis input must be an object");
  }
  if (!Array.isArray(input.runs) || input.runs.length === 0) {
    throw new Error("analysis input.runs must be a non-empty array");
  }
  if (input.plannedCases !== undefined) {
    requireNonNegativeInt(input.plannedCases, "plannedCases", "analysis input");
  }
  if (input.toolCost !== undefined) {
    validateToolCost(input.toolCost);
  }
  const seen = new Set<string>();
  const truthKindByCase = new Map<string, string>();
  for (const run of input.runs) {
    if (!isRecord(run)) {
      throw new Error("analysis input.runs[] entries must be objects");
    }
    const record = run.record;
    if (!isRecord(record)) {
      throw new Error("analysis input.runs[].record must be a RunRecord object");
    }
    const where = `run record ${String(record.caseId)}/${String(record.configId)}/rep-${String(record.rep)}`;
    validateRecord(record, where);
    const caseId = String(record.caseId);
    const key = `${record.source}|${caseId}|${record.configId}|${record.rep}`;
    if (seen.has(key)) {
      throw new Error(`duplicate run record ${where}: same source/caseId/configId/rep appears twice`);
    }
    seen.add(key);
    const kind = truthKindOf(run.truth);
    const existingKind = truthKindByCase.get(caseId);
    if (existingKind !== undefined && existingKind !== kind) {
      throw new Error(
        `${where}: mixed truth kinds for case ${JSON.stringify(caseId)} ` +
          `(${existingKind} vs ${kind}); provide truth consistently across reps`,
      );
    }
    truthKindByCase.set(caseId, kind);
    validateTruth(run.truth, where);
    validateJudge(run.judgeCounts, where);
  }
}

function validateRecord(record: Record<string, unknown>, where: string): void {
  validateIdentity(record, where);
  const baseline = requireRecord(record.baseline, "baseline", where);
  validateUsage(baseline.usage, where);
  requireNonNegativeInt(baseline.rounds, "baseline.rounds", where);
  requireNonNegativeInt(baseline.toolCalls, "baseline.toolCalls", where);
  validateFindings(baseline.findings, where);
  validateAudit(baseline.audit, where);
}

function validateIdentity(record: Record<string, unknown>, where: string): void {
  requireNonEmptyString(record.source, "source", where);
  requireNonEmptyString(record.caseId, "caseId", where);
  if (
    typeof record.configId !== "string" ||
    !(ANALYSIS_CONFIG_IDS as readonly string[]).includes(record.configId)
  ) {
    throw new Error(`${where}: field "configId" must be one of A, B, C, D, E`);
  }
  requirePositiveInt(record.rep, "rep", where);
  requireNonEmptyString(record.model, "model", where);
  requireNonEmptyString(record.completedAt, "completedAt", where);
}

function validateUsage(usage: unknown, where: string): void {
  const value = requireRecord(usage, "baseline.usage", where);
  requireNonNegativeInt(value.inputTokens, "baseline.usage.inputTokens", where);
  requireNonNegativeInt(value.outputTokens, "baseline.usage.outputTokens", where);
  for (const field of ["cacheReadTokens", "cacheWriteTokens"] as const) {
    if (value[field] !== undefined) {
      requireNonNegativeInt(value[field], `baseline.usage.${field}`, where);
    }
  }
}

function validateFindings(findings: unknown, where: string): void {
  if (!Array.isArray(findings)) {
    throw new Error(`${where}: field "baseline.findings" must be an array`);
  }
  for (const [index, finding] of findings.entries()) {
    const value = requireRecord(finding, `baseline.findings[${index}]`, where);
    requireNonEmptyString(value.file, `baseline.findings[${index}].file`, where);
    requireNonNegativeInt(value.line, `baseline.findings[${index}].line`, where);
    requireNonEmptyString(value.category, `baseline.findings[${index}].category`, where);
  }
}

function validateAudit(audit: unknown, where: string): void {
  const value = requireRecord(audit, "baseline.audit", where);
  if (!Array.isArray(value.toolCallLog)) {
    throw new Error(`${where}: field "baseline.audit.toolCallLog" must be an array`);
  }
  for (const [index, call] of value.toolCallLog.entries()) {
    const entry = requireRecord(call, `baseline.audit.toolCallLog[${index}]`, where);
    requireNonEmptyString(entry.name, `baseline.audit.toolCallLog[${index}].name`, where);
    requireString(entry.argumentsJson, `baseline.audit.toolCallLog[${index}].argumentsJson`, where);
    requireString(entry.resultSummary, `baseline.audit.toolCallLog[${index}].resultSummary`, where);
  }
  if (!Array.isArray(value.phaseLog)) {
    throw new Error(`${where}: field "baseline.audit.phaseLog" must be an array`);
  }
  for (const [index, phase] of value.phaseLog.entries()) {
    const entry = requireRecord(phase, `baseline.audit.phaseLog[${index}]`, where);
    requireNonNegativeInt(entry.requestCount, `baseline.audit.phaseLog[${index}].requestCount`, where);
  }
  if (!Array.isArray(value.rejections)) {
    throw new Error(`${where}: field "baseline.audit.rejections" must be an array`);
  }
  for (const [index, rejection] of value.rejections.entries()) {
    if (!isRecord(rejection) || !EVIDENCE_GATE_STAGE_SET.has(rejection.stage as string)) {
      throw new Error(
        `${where}: field "baseline.audit.rejections[${index}].stage" must be one of ` +
          EVIDENCE_GATE_STAGES.join(", "),
      );
    }
  }
  if (typeof value.truncated !== "boolean") {
    throw new Error(`${where}: field "baseline.audit.truncated" must be a boolean`);
  }
  if (
    !Array.isArray(value.truncationReasons) ||
    value.truncationReasons.some((reason) => typeof reason !== "string")
  ) {
    throw new Error(`${where}: field "baseline.audit.truncationReasons" must be an array of strings`);
  }
}

function validateTruth(truth: unknown, where: string): void {
  if (truth === undefined || truth === null) {
    return;
  }
  if (!isRecord(truth) || !Array.isArray(truth.locations)) {
    throw new Error(`${where}: field "truth" must be null or an object with a locations array`);
  }
  for (const [index, location] of truth.locations.entries()) {
    const value = requireRecord(location, `truth.locations[${index}]`, where);
    requireNonEmptyString(value.file, `truth.locations[${index}].file`, where);
    const lineStart = requireNonNegativeInt(
      value.lineStart,
      `truth.locations[${index}].lineStart`,
      where,
    );
    const lineEnd = requireNonNegativeInt(value.lineEnd, `truth.locations[${index}].lineEnd`, where);
    if (lineStart > lineEnd) {
      throw new Error(`${where}: field "truth.locations[${index}]" has lineStart > lineEnd`);
    }
    requireNonEmptyString(value.defectNature, `truth.locations[${index}].defectNature`, where);
  }
}

function validateJudge(judgeCounts: unknown, where: string): void {
  if (judgeCounts === undefined) {
    return;
  }
  const value = requireRecord(judgeCounts, "judgeCounts", where);
  for (const field of ["tp", "fp", "fn"] as const) {
    requireNonNegativeInt(value[field], `judgeCounts.${field}`, where);
  }
}

function validateToolCost(toolCost: unknown): void {
  if (!isRecord(toolCost)) {
    throw new Error('analysis input: field "toolCost" must be a ToolCostPricing object');
  }
  requireNonNegativeNumber(toolCost.fixedCostPerCall, "toolCost.fixedCostPerCall");
  requireNonNegativeNumber(toolCost.costPerResultChar, "toolCost.costPerResultChar");
}

function requireRecord(value: unknown, field: string, where: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${where}: field "${field}" must be an object`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, field: string, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${where}: field "${field}" must be a non-empty string`);
  }
  return value;
}

function requireString(value: unknown, field: string, where: string): string {
  if (typeof value !== "string") {
    throw new Error(`${where}: field "${field}" must be a string`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`analysis input: field "${field}" must be a non-negative finite number`);
  }
  return value;
}

function requireNonNegativeInt(value: unknown, field: string, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${where}: field "${field}" must be a non-negative integer`);
  }
  return value;
}

function requirePositiveInt(value: unknown, field: string, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${where}: field "${field}" must be an integer >= 1`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
