// run 级留痕契约（测量常量面：审计投影的形状与 DSH 线一致，
// 冻结 analyze 脚本据此消费 pi RunRecord）。随模块落地逐步补齐。

import type { Finding } from "./finding.js";
import type { LedgerEntry } from "./ledger.js";
import type { LlmUsage, ToolSchema, WireMessage } from "./llm.js";
import type { PrefetchLayerRecord } from "./prefetch.js";

/** 六阶段名（固定顺序；phaseLog 留痕用） */
export type ReviewPhase =
  | "Change Understanding"
  | "Risk Classification"
  | "Context Decision"
  | "Context Retrieval"
  | "Deep Reasoning"
  | "Evidence Verification";

/** 一个阶段的执行留痕 */
export interface PhaseRecord {
  readonly round: number;
  readonly phase: ReviewPhase;
  readonly requestCount: number;
  readonly note?: string;
}

/** 一次工具调用的留痕（config B 零工具，恒空数组；契约先行） */
export interface ToolCallRecord {
  readonly name: string;
  readonly argumentsJson: string;
  readonly resultSummary: string;
}

/** 候选结论被拦截的留痕（候选拦截链每候选至多一条，首个失败阶段） */
export interface CandidateRejection {
  readonly candidateId: string;
  readonly stage: RejectionStage;
  /** 英文的拦截原因 */
  readonly reason: string;
}

/** 拦截阶段顺序：Schema 校验 → 语言检查 → 证据检查 → 验证裁决 → 重复 id */
export type RejectionStage =
  | "SCHEMA_INVALID"
  | "NON_ENGLISH"
  | "NO_EVIDENCE"
  | "VERIFICATION_FAILED"
  | "DUPLICATE_ID";

/** Cache Break 原因分类（相邻请求字节前缀分歧定位） */
export type CacheBreakReason =
  | "MODEL_CHANGED"
  | "SYSTEM_PROMPT_CHANGED"
  | "TOOL_SCHEMA_CHANGED"
  | "CONTEXT_REORDERED";

/** 分歧落点分区（报告归因口径：model 段 / Zone A 稳定前缀 / Zone B/C 上下文） */
export type CacheBreakZone = "MODEL" | "A" | "B/C";

export interface CacheBreakRecord {
  /** 相邻对中后一请求的序号（1-based） */
  readonly requestIndex: number;
  readonly reason: CacheBreakReason;
  readonly zone: CacheBreakZone;
  /** 规范字节布局（model 段 → messages 段 → tools 段）内的首个分歧偏移 */
  readonly divergeByteOffset: number;
}

/** 一次 review 的请求面（onPayload 序列化点捕获；审计 requests[] 即此形状） */
export interface WireRequest {
  readonly model: string;
  readonly effort: string;
  readonly messages: readonly WireMessage[];
  readonly tools: readonly ToolSchema[];
  /** JSON.stringify(payload) 原文（可原样重放） */
  readonly wireBody: string;
}

/** config C 全仓注入的留痕（预算守卫：截断必留痕） */
export interface FullRepoRecord {
  readonly budgetChars: number;
  readonly contentChars: number;
  readonly truncated: boolean;
  readonly totalFiles: number;
  readonly shownFiles: number;
}

/** 循环运行期的审计累积面（AuditFileContent 与 AuditLight 的共同来源） */
export interface RunAudit {
  readonly requests: readonly WireRequest[];
  readonly toolCallLog: readonly ToolCallRecord[];
  readonly phaseLog: readonly PhaseRecord[];
  readonly rejections: readonly CandidateRejection[];
  readonly cacheBreaks: readonly CacheBreakRecord[];
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  readonly prefetch?: readonly PrefetchLayerRecord[];
  /** config C 全仓注入记账（非 C 配置缺省） */
  readonly fullRepo?: FullRepoRecord;
  /** config E Context Ledger 快照（非 E 配置缺省） */
  readonly ledger?: readonly LedgerEntry[];
}

/** 六阶段循环一次完整运行的结果（审计投影的输入） */
export interface RunResult {
  readonly caseId: string;
  readonly configId: string;
  readonly model: string;
  readonly findings: readonly Finding[];
  readonly usage: LlmUsage;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly audit: RunAudit;
  readonly auditPath?: string;
}
