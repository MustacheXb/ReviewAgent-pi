// 循环常量（测量常量面）：预算数值自 #53 / ADR-0018 §1 起迁出本文件，统一由
// `DEFAULT_REVIEW_BUDGET`（loop/budget.ts）持有；此处只保留截断留痕文案与
// 预算耗尽应答字节（这些文案与应答字节仍是 DSH 线审计的字节真源）。

import type { StopReason } from "../contracts/run.js";

/** 轮次上限截断原因（审计 truncationReasons 留痕文案） */
export const TRUNCATION_MAX_ROUNDS: StopReason = "MAX_ROUNDS_REACHED";

/** 工具预算耗尽截断原因（审计 truncationReasons 留痕文案；不翻转 truncated） */
export const TRUNCATION_TOOL_BUDGET = "TOOL_BUDGET_EXHAUSTED";

/**
 * 尝试预算耗尽截断原因（#54 / ADR-0018 §2.1；与 StopReason 同名，但只作
 * 事件留痕——阶段正常完成时 truncated 不翻转）。
 */
export const TRUNCATION_TOOL_ATTEMPTS: StopReason = "TOOL_ATTEMPTS_EXHAUSTED";

/**
 * 请求预算阶段跳过事件（#55 / ADR-0018 §2.2）：剩余请求不足以按常规序推进
 * 到裁决时，尚未完成的前四阶段被跳过。只作事件留痕（被跳过的阶段另有
 * phaseLog 条目）；run 以模型 complete 收尾时 truncated 不翻转。
 */
export const TRUNCATION_REQUEST_BUDGET_SKIPPED = "REQUEST_BUDGET_PHASES_SKIPPED";

/**
 * 请求预算耗尽截断原因（#55 / ADR-0018 §2.2；与 StopReason 同名事件留痕，
 * run 被预算切断时 truncated 翻转）。
 */
export const TRUNCATION_MAX_REQUESTS: StopReason = "MAX_REQUESTS_REACHED";

/**
 * 输出预算耗尽截断原因（#55 / ADR-0018 §2.3；只在阶段边界事后判定，wire
 * 不新增 max_tokens）。
 */
export const TRUNCATION_OUTPUT_BUDGET: StopReason = "OUTPUT_BUDGET_EXHAUSTED";

/**
 * 跳过阶段时 phaseLog 的留痕文案（被跳过阶段 requestCount = 0）：
 * - reserved：剩余请求仍够候选/裁决保底，前四阶段让位；
 * - exhausted：连保底都不足，run 直接终止。
 */
export const PHASE_SKIPPED_REQUEST_BUDGET_NOTE =
  "skipped: request budget reserved for Deep Reasoning / Evidence Verification";

export const PHASE_SKIPPED_REQUEST_BUDGET_EXHAUSTED_NOTE =
  "skipped: request budget exhausted before the candidate/verification floor";

/**
 * 预算耗尽时的工具应答内容（= 审计 resultSummary = wire tool 消息 content）。
 * 字节真源：t-series C/D/E 审计 toolCallLog（"Error: tool call budget exhausted"）；
 * 根仓现行源码的 "SKIPPED: " 前缀是 t-series 之后的演进，不采纳。
 */
export const TOOL_BUDGET_EXHAUSTED_SUMMARY = "Error: tool call budget exhausted";

/** 尝试预算耗尽时的工具应答内容（#54；超过 Attempt Budget 的调用不再执行） */
export const TOOL_ATTEMPTS_EXHAUSTED_SUMMARY = "Error: tool attempt budget exhausted";

/**
 * 强制阶段收尾指令（#54 / ADR-0018 §2.1）：attempts 耗尽后 append-only 注入，
 * 要求模型直接输出本阶段 JSON。每阶段至多注入
 * `MAX_FORCED_FINALIZATIONS_PER_PHASE` 次。
 */
export const FORCED_FINALIZATION_INSTRUCTION =
  "Tool attempt budget exhausted. Do not call any more tools. Reply directly with the single JSON object required by this phase.";

/** 每阶段强制收尾注入上限（ADR-0018 §2.1：至多 2 次） */
export const MAX_FORCED_FINALIZATIONS_PER_PHASE = 2;
