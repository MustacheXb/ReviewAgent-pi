import type { EnvironmentManifest } from "../campaign/contracts.js";

/**
 * L3 三列定位报告 / 宣称门契约（#45，eval-only）。
 *
 * 定位（ADR-0017 §4）：E + C_ref + Claude Code 三列，单列报告，不进 S/A/B；
 * C_ref 的 `totalTokens` 只作 L3 参考分母，不进任何门；跨模型 token 语义不作
 * 等价。对外宣称必须同时具备 L3 报告 + 完整 environment + 产品签字，否则
 * `claimsAllowed = false`。
 */

export const L3_REPORT_KIND = "l3-three-column-report";
export const L3_REPORT_SCHEMA_VERSION = 1;

export type L3ColumnKey = "e" | "c-ref" | "claude-code";

export interface L3Coverage {
  readonly planned: number;
  readonly executed: number;
  readonly judged: number;
  readonly failed: number;
  /** judged / planned；planned 0 → null */
  readonly ratio: number | null;
}

export interface L3Quality {
  readonly recall: number | null;
  readonly precision: number | null;
  readonly f1: number | null;
}

export interface L3Cost {
  /** CARC 均值（token 口径；跨模型不作等价） */
  readonly carcMean: number | null;
  /** totalTokens 均值（仅报告；C_ref 只作参考分母） */
  readonly totalTokensMean: number | null;
  readonly cacheHitRateMean: number | null;
  /** 计费 USD（L3 对外成本主口径；N/A = null） */
  readonly billedCostUsd: number | null;
}

export interface L3Harness {
  readonly turnsMean: number | null;
  readonly durationMsMean: number | null;
  readonly permissionDenials: number | null;
}

export interface L3Column {
  readonly key: L3ColumnKey;
  readonly label: string;
  /** 本列实际模型；null = N/A */
  readonly model: string | null;
  readonly cases: number;
  readonly runs: number;
  readonly coverage: L3Coverage;
  readonly quality: L3Quality;
  readonly cost: L3Cost;
  /** 列专属 harness 指标（Claude Code 用；E/C_ref 可为 null） */
  readonly harness: L3Harness | null;
  /** harness 预算口径：bounded（固定轮次） / ceiling（无轮次上界） */
  readonly budget: "bounded" | "ceiling";
  /** 有界失败留痕（judge / 超时 / 截断等），逐项列出 */
  readonly failures: readonly string[];
}

export interface L3Columns {
  readonly e: L3Column;
  readonly cRef: L3Column;
  readonly claudeCode: L3Column;
}

/** 产品签字（L3 对外宣称前置） */
export interface L3SignOff {
  readonly signedBy: string;
  readonly signedAt: string;
  /** 只允许 L3 对外宣称 scope */
  readonly scope: "external-claim";
  /** 可选过期日（ISO；与 generatedAt 比较） */
  readonly expiresAt?: string | null;
}

/** L3 目标线（ADR-0017 §4；provisional，可覆盖） */
export interface L3GateThresholds {
  /** E judge Recall ≥ Claude × 该比例 */
  readonly recallVsClaude: number;
  /** E judge Precision ≥ Claude × 该比例 */
  readonly precisionVsClaude: number;
  /** E 计费成本 ≤ Claude × 该比例（USD；同模型可退回 totalTokens 代理） */
  readonly costVsClaude: number;
  /** E cacheHitRate 绝对下限 */
  readonly minCacheHitRate: number;
  /** 每列 coverage 下限 */
  readonly minCoverage: number;
  /** 三列最少 case 数（L3 对外宣称样本量） */
  readonly minCases: number;
  /** 每案最少 reps（L3 对外宣称至少 3 reps） */
  readonly minReps: number;
}

export const DEFAULT_L3_GATE_THRESHOLDS: L3GateThresholds = {
  recallVsClaude: 0.9,
  precisionVsClaude: 1.0,
  costVsClaude: 0.3,
  minCacheHitRate: 0.85,
  minCoverage: 0.9,
  minCases: 30,
  minReps: 3,
};

export interface L3ReportInput {
  readonly campaignId: string;
  /** 报告生成时间（ISO；UTC）；由调用方提供，保持纯函数 */
  readonly generatedAt: string;
  readonly environment: EnvironmentManifest;
  readonly columns: L3Columns;
  /** 产品签字；null = 未签字 → claimsAllowed false */
  readonly signOff: L3SignOff | null;
}

export interface L3GateResult {
  readonly pass: boolean;
  readonly rule: string;
  readonly detail: string;
}

export interface L3Gates {
  /** 三列样本量 / reps / harness 预算口径是否可比 */
  readonly comparability: L3GateResult;
  readonly quality: L3GateResult;
  readonly cost: L3GateResult;
  readonly cache: L3GateResult;
  readonly coverage: L3GateResult;
  readonly environment: L3GateResult;
  readonly signOff: L3GateResult;
}

export interface L3EnvironmentStatus {
  readonly complete: boolean;
  /** 缺失字段的机读路径（完整 environment 才允许宣称） */
  readonly missing: readonly string[];
}

/** C_ref totalTokens 仅参考分母（不进任何门） */
export interface L3ReferenceDenominator {
  readonly eOverCRefTotalTokens: number | null;
  readonly note: string;
}

export interface L3Report {
  readonly kind: typeof L3_REPORT_KIND;
  readonly schemaVersion: typeof L3_REPORT_SCHEMA_VERSION;
  readonly campaignId: string;
  readonly generatedAt: string;
  readonly columns: L3Columns;
  readonly environment: L3EnvironmentStatus;
  readonly manifest: EnvironmentManifest;
  readonly referenceDenominator: L3ReferenceDenominator;
  readonly gates: L3Gates;
  readonly claimsAllowed: boolean;
  readonly allowedClaim: string | null;
  readonly limitations: readonly string[];
  readonly thresholds: L3GateThresholds;
}
