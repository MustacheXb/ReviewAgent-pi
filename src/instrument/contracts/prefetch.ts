/**
 * config B 预取契约（spec #1 工单 #4）——留痕读面：
 * Zone B 静态构造 + 固定管线确定性预取（Diff → Symbol → Reference → Call Chain）。
 *
 * #9 P4b：预取预算（PrefetchOptions / DEFAULT_PREFETCH_BUDGETS /
 * resolvePrefetchBudgets）属 legacy 运行时执行面，已随内核退役；此处仅保留
 * 审计记录面（记录消费与指标消费历史 pi / legacy 记录的 prefetch 留痕）。
 * 预算语义见主文档第 6 章 Budget（Zone B ≈ 4K tokens 等，按 ~4 chars/token 折算）。
 */

/** 预取注入层名（固定管线顺序） */
export type PrefetchLayerName = "zone-b" | "symbol" | "reference" | "call-chain";

/** 一层的注入记录（留痕：截断与否、预算、条目数） */
export interface PrefetchLayerRecord {
  readonly layer: PrefetchLayerName;
  readonly budgetChars: number;
  /** 最终注入内容的字符数（含截断提示行） */
  readonly contentChars: number;
  readonly truncated: boolean;
  /** 条目总数（截断前） */
  readonly totalEntries: number;
  /** 实际注入条目数 */
  readonly shownEntries: number;
}
