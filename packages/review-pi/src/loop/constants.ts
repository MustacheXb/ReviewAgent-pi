// 循环常量（测量常量面）：预算数值自 #53 / ADR-0018 §1 起迁出本文件，统一由
// `DEFAULT_REVIEW_BUDGET`（loop/budget.ts）持有；此处只保留截断留痕文案与
// 预算耗尽应答字节（这些文案与应答字节仍是 DSH 线审计的字节真源）。

/** 轮次上限截断原因（审计 truncationReasons 留痕文案） */
export const TRUNCATION_MAX_ROUNDS = "MAX_ROUNDS_REACHED";

/** 工具预算耗尽截断原因（审计 truncationReasons 留痕文案；不翻转 truncated） */
export const TRUNCATION_TOOL_BUDGET = "TOOL_BUDGET_EXHAUSTED";

/**
 * 预算耗尽时的工具应答内容（= 审计 resultSummary = wire tool 消息 content）。
 * 字节真源：t-series C/D/E 审计 toolCallLog（"Error: tool call budget exhausted"）；
 * 根仓现行源码的 "SKIPPED: " 前缀是 t-series 之后的演进，不采纳。
 */
export const TOOL_BUDGET_EXHAUSTED_SUMMARY = "Error: tool call budget exhausted";
