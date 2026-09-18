// Finding Schema 运行时校验（测量常量面：10 字段形状校验，零依赖手写，
// 不引入 schema 引擎）。evidence 的非空性不在此判定——空 evidence 是领域
// 问题，由候选拦截链以 NO_EVIDENCE 拦截（No Evidence, No Finding）。
import type { Finding } from "../contracts/finding.js";

const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

/** 校验候选对象是否符合 Finding 形状；返回英文错误列表，空数组 = 合法 */
export function validateFinding(candidate: unknown): readonly string[] {
  if (typeof candidate !== "object" || candidate === null) {
    return ["candidate must be a JSON object"];
  }
  const record = candidate as Record<string, unknown>;
  const errors: string[] = [
    ...checkString(record.id, "id"),
    ...checkSeverity(record.severity),
    ...checkString(record.category, "category"),
    ...checkString(record.file, "file"),
    ...checkLine(record.line),
    ...checkString(record.title, "title"),
    ...checkString(record.description, "description"),
    ...checkEvidence(record.evidence),
    ...checkString(record.rule, "rule"),
    ...checkConfidence(record.confidence),
  ];
  return errors;
}

/** 类型收窄辅助：验证通过即视为 Finding */
export function isFinding(candidate: unknown): candidate is Finding {
  return validateFinding(candidate).length === 0;
}

function checkString(value: unknown, field: string): readonly string[] {
  if (typeof value !== "string" || value.length === 0) {
    return [`field "${field}" must be a non-empty string`];
  }
  return [];
}

function checkSeverity(value: unknown): readonly string[] {
  if (typeof value !== "string" || !SEVERITIES.has(value)) {
    return ['field "severity" must be one of "P0", "P1", "P2", "P3"'];
  }
  return [];
}

function checkLine(value: unknown): readonly string[] {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return ['field "line" must be an integer >= 1'];
  }
  return [];
}

function checkEvidence(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return ['field "evidence" must be an array of strings'];
  }
  if (value.some((entry) => typeof entry !== "string")) {
    return ['field "evidence" must contain only strings'];
  }
  return [];
}

function checkConfidence(value: unknown): readonly string[] {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return ['field "confidence" must be a number between 0 and 1'];
  }
  return [];
}
