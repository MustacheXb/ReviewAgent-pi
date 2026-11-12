/**
 * Context Ledger 契约（#6 P3a 去重面；#56 / ADR-0018 §4 送达感知重写）。
 *
 * 语义界定（与 DSH 线语义等价、pi 线原语从 0 重写）：
 * - Ledger 登记本次 run 已**送达**的上下文单元，四类 kind 对应
 *   loaded_files / loaded_ranges / loaded_symbols / loaded_evidence；
 * - 身份键 = kind + 规范化工具身份（resourceKey）+ 内容哈希 + 请求范围；
 * - 命中规则（核心决策）：只有实际送达范围（deliveredRange）完整覆盖请求
 *   范围（requestedRange）才返回引用——
 *   · 完全重复请求 → 命中；
 *   · 整文件 / 整结果完整送达后请求其子区间 → 命中，并标注覆盖关系；
 *   · 请求范围未被完整覆盖 → 未命中，重新执行并登记新条目；
 *   · 不做「部分命中 + 只补缺口」的拼接，不谎报「已加载」；
 * - 引用文本带请求范围、实际送达范围与 complete 标记；
 * - 状态属 run 私有：每个 run 从空账本开始；
 * - 读取失败不登记（错误不是上下文），重试仍走真实读取路径；
 * - Zone A 不受影响：工具 schema 与 system prompt 字节不依赖 Ledger 状态。
 */

/** 条目种类：映射 loaded_files / loaded_ranges / loaded_symbols / loaded_evidence 四类登记 */
export type LedgerEntryKind = "file" | "range" | "symbol" | "evidence";

/**
 * 1-based 闭区间行范围；endLine = null 表示到文件 / 结果结尾。
 * 范围类工具（get_file）用行区间；整结果工具（diff / 符号 / 检索）的
 * `requestedRange` 为 null，`deliveredRange` 完整送达时为 null、超预算截断
 * 时为已送达的结果行前缀（partial delivery 必须可见，不冒充整结果）。
 * 空送达用 endLine < startLine 表示（formatter 显示 no lines）。
 */
export interface LedgerRange {
  readonly startLine: number;
  readonly endLine: number | null;
}

/** 一次工具读取的账本身份（命中查询的输入） */
export interface LedgerRequest {
  readonly kind: LedgerEntryKind;
  /**
   * 规范化工具身份：工具名 + 决定资源内容的参数（不含请求范围）。
   * 覆盖判定只在同一 resourceKey 的条目之间进行。
   */
  readonly resourceKey: string;
  /** 人类可读请求标识（含工具名与请求范围；引用回显用，有界输出） */
  readonly description: string;
  /** 请求范围；整结果工具为 null */
  readonly requestedRange: LedgerRange | null;
}

/** 一次真实读取的送达结果（未命中路径的执行产物） */
export interface LedgerDelivery {
  /** 工具结果原文（命中时被引用替代；未命中路径逐字节返回） */
  readonly content: string;
  /** 实际送达范围；整结果完整送达为 null，部分送达为已送达行区间 */
  readonly deliveredRange: LedgerRange | null;
  /** 送达是否完整覆盖请求（无截断、无 clamp） */
  readonly complete: boolean;
  /** 资源总行数（范围类工具；用于判定「到结尾」请求越界与子区间折算） */
  readonly totalLines?: number;
}

/**
 * 一条已送达的上下文单元（审计留痕形态）。
 *
 * `id / kind / description` 是历史最小形态（#6 起）；#56 新增的送达字段为
 * 可选——#56 之前落盘的历史记录只有三字段，读取面必须可读（缺席省键，
 * 不回填、不改写）。
 */
export interface LedgerEntry {
  /** 引用标识（ctx#001 起顺序编号；run 内唯一、按登记顺序确定） */
  readonly id: string;
  readonly kind: LedgerEntryKind;
  /** 人类可读请求标识（含工具名与请求范围） */
  readonly description: string;
  /** 身份键：kind + resourceKey + 请求范围 + 内容哈希（#56） */
  readonly key?: string;
  readonly requestedRange?: LedgerRange | null;
  readonly deliveredRange?: LedgerRange | null;
  /** 实际送达是否完整覆盖请求范围（#56） */
  readonly complete?: boolean;
  /** 送达内容哈希（sha256 hex；内容变化即产生新条目） */
  readonly contentHash?: string;
  /** 内容版本（run 内静态快照恒 1；内容哈希变化会产生新条目） */
  readonly contentVersion?: number;
  /** 送达内容字符数（savedCharsEstimate 的估算基数） */
  readonly charCount?: number;
  /** 资源总行数（范围类工具；「到结尾」请求越界判定与子区间折算用） */
  readonly totalLines?: number;
  /** 被引用次数（命中即累加） */
  readonly hitCount?: number;
  /** 最近一次命中的时间（ISO 8601；从未命中则省键） */
  readonly lastHitAt?: string;
}

/** Ledger 命中统计（审计可读；只统计账本查询，不重复请求/尝试计数） */
export interface LedgerStats {
  /** 命中次数（返回引用的查询数） */
  readonly ledgerHits: number;
  /** 未命中次数（真实执行读取的查询数） */
  readonly ledgerMisses: number;
  /** 命中避免的送达字符数估算（按请求/送达行数比例折算） */
  readonly savedCharsEstimate: number;
}

/**
 * 工具结果层送达感知账本（run 私有）。
 * 实现见 src/tools/ledger.ts；ToolRunContext.ledger 持有其一，
 * 各工具在 execute 入口处经 readThroughLedger 接入。
 */
export interface ContextLedger {
  /**
   * 命中查询：已完整覆盖请求返回引用文本（含请求范围、送达范围与
   * complete），未覆盖返回 undefined。命中/未命中均计入 stats。
   */
  referenceIfLoaded(request: LedgerRequest): string | undefined;
  /** 真实读取成功后登记（调用方保证仅在未命中路径调用；失败的工具调用不登记） */
  register(request: LedgerRequest, delivery: LedgerDelivery): void;
  /** 当前快照（防御性拷贝；runReview 审计留痕用） */
  snapshot(): readonly LedgerEntry[];
  /** 命中 / 未命中 / 节省字符估算（审计留痕用） */
  stats(): LedgerStats;
}
