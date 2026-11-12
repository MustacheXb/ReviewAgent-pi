import type { Finding } from "../../../instrument/contracts/finding.js";
import type { MRCase } from "../../../instrument/contracts/mr-case.js";

/**
 * Claude Code 外部参照契约（#44，eval-only）：跨模型外部参照单列报告。
 *
 * 定位（ADR-0017 §4）：Claude Code 只作 L3 定位 / 宣称的跨模型参照，单列
 * 报告，不进 S/A/B 主判定；token 语义跨模型不作等价，成本以 USD 记录。
 *
 * 硬上界（设计 §7.2）：`--max-turns 5`；只允许 `Read / Grep / Glob`；CLI
 * 以 stdin 注入提示词、`--output-format json`；记录 CLI 版本、实际模型、
 * usage、cost、turns、permission denials；非法 / 截断 / 重复项留痕。
 */

export const CLAUDE_CODE_MAX_TURNS = 5;

export const CLAUDE_CODE_ALLOWED_TOOLS = ["Read", "Grep", "Glob"] as const;

export const CLAUDE_CODE_REFERENCE_KIND = "claude-code-reference";

export const CLAUDE_CODE_REFERENCE_SCHEMA_VERSION = 1;

/** Claude Code 的 token usage（字段缺失记 null，不写 0） */
export interface ClaudeCodeUsage {
  readonly inputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly outputTokens: number | null;
}

/** 一次 Claude Code 外部参照运行请求（同仓、同 diff、同 issue） */
export interface ClaudeCodeRequest {
  readonly caseId: string;
  readonly mrCase: MRCase;
  /** 每个 case 的重复序（1 起；冒烟可为 1） */
  readonly rep: number;
}

/** 一次 Claude Code 外部参照运行结果（eval-only） */
export interface ClaudeCodeOutcome {
  readonly findings: readonly Finding[];
  /** 非法 / 截断 / 重复条目等有界失败留痕（空数组 = 无异常） */
  readonly anomalies: readonly string[];
  readonly cliVersion: string | null;
  readonly requestedModel: string | null;
  readonly actualModels: readonly string[] | null;
  readonly numTurns: number | null;
  readonly totalCostUsd: number | null;
  readonly usage: ClaudeCodeUsage | null;
  /** modelUsage 的逐模型累计（CLI 顶层 usage 在部分版本可能只含末轮） */
  readonly modelUsage: Readonly<Record<string, ClaudeCodeUsage>> | null;
  readonly permissionDenials: number | null;
  readonly durationMs: number | null;
  /** CLI 报告错误时的文本 / subtype（正常为 null） */
  readonly error: string | null;
  /** max-turns 等截断（正常为 false） */
  readonly truncated: boolean;
  /** CLI 最终文本（`result` 字段；原样留痕，便于复算归一化） */
  readonly resultText: string;
}

/** Claude Code client 边界（真实 CLI / fake 同缝） */
export interface ClaudeCodeClient {
  run(request: ClaudeCodeRequest): Promise<ClaudeCodeOutcome>;
}

/** 单列记录（评测侧；不进入生产 RunRecord / RunAudit / ConfigId） */
export interface ClaudeCodeReferenceRecord {
  readonly kind: typeof CLAUDE_CODE_REFERENCE_KIND;
  readonly schemaVersion: typeof CLAUDE_CODE_REFERENCE_SCHEMA_VERSION;
  readonly evalOnly: true;
  readonly caseId: string;
  readonly rep: number;
  readonly maxTurns: typeof CLAUDE_CODE_MAX_TURNS;
  readonly allowedTools: typeof CLAUDE_CODE_ALLOWED_TOOLS;
  readonly cliVersion: string | null;
  readonly requestedModel: string | null;
  readonly actualModels: readonly string[] | null;
  readonly numTurns: number | null;
  readonly totalCostUsd: number | null;
  readonly usage: ClaudeCodeUsage | null;
  readonly modelUsage: Readonly<Record<string, ClaudeCodeUsage>> | null;
  readonly permissionDenials: number | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly truncated: boolean;
  readonly findings: readonly Finding[];
  readonly anomalies: readonly string[];
  readonly resultText: string;
}

/** CLI 输出不可用（非法 JSON / is_error / 截断）；调用方记为参照运行失败 */
export class ClaudeCodeOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeOutputError";
  }
}
