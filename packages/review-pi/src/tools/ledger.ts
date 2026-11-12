import { createHash } from "node:crypto";
import type {
  ContextLedger,
  LedgerDelivery,
  LedgerEntry,
  LedgerRange,
  LedgerRequest,
  LedgerStats,
} from "../contracts/ledger.js";
import { boundedEcho } from "./args.js";
import type { TruncationCounts } from "./result-budget.js";

/**
 * Context Ledger 实现（#6 P3a；#56 / ADR-0018 §4 送达感知）。
 *
 * - createContextLedger()：run 私有功能态——真实读取成功后登记送达结果；
 *   命中只发生在「实际送达范围完整覆盖请求范围」时（整文件送达后可命中
 *   子区间；截断送达不得冒充整文件；不做部分命中拼接）；
 * - 引用格式集中在此（工具不各自拼装，保证字节一致）：
 *   Already loaded: ctx#001 (review.get_file src/…/Foo.java:100-180;
 *   delivered lines 1-end of requested lines 100-180; complete=true)
 * - 命中统计（ledgerHits / ledgerMisses / savedCharsEstimate）随快照进审计。
 */

/** 引用文本中 description 的回显上限（与检索工具的 query 回显上限一致） */
export const LEDGER_REFERENCE_ECHO_MAX_CHARS = 120;

/** 时钟注入缝（测试确定性；缺省系统时钟 ISO 8601） */
export interface ContextLedgerOptions {
  readonly now?: () => string;
}

/**
 * 内部登记形态：新条目恒有全部送达字段。
 * 历史记录只有 id/kind/description 三字段——那种形态只出现在 AuditLight
 * 读取面，不进入功能态账本。
 */
interface StoredLedgerEntry extends LedgerEntry {
  readonly key: string;
  readonly requestedRange: LedgerRange | null;
  readonly deliveredRange: LedgerRange | null;
  readonly complete: boolean;
  readonly contentHash: string;
  readonly contentVersion: number;
  readonly charCount: number;
  readonly hitCount: number;
}

/** 命中键：kind + resourceKey + 请求范围 + 内容哈希（ADR-0018 §4） */
function entryKey(
  request: LedgerRequest,
  contentHash: string,
): string {
  return `${request.kind} ${request.resourceKey} ${rangeKey(request.requestedRange)} ${contentHash}`;
}

function rangeKey(range: LedgerRange | null): string {
  return range === null ? "whole" : `${range.startLine}-${range.endLine ?? "end"}`;
}

/** 引用文本：id + 有界回显的当前请求 + 请求/送达范围 + complete（确定性） */
function formatReference(entry: StoredLedgerEntry, request: LedgerRequest): string {
  const echo = boundedEcho(request.description, LEDGER_REFERENCE_ECHO_MAX_CHARS);
  return `Already loaded: ${entry.id} (${echo}; delivered ${rangeText(entry.deliveredRange)} of requested ${rangeText(request.requestedRange)}; complete=${String(entry.complete)})`;
}

function rangeText(range: LedgerRange | null): string {
  if (range === null) {
    return "whole result";
  }
  if (range.endLine !== null && range.endLine < range.startLine) {
    return "no lines";
  }
  return `lines ${range.startLine}-${range.endLine ?? "end"}`;
}

/**
 * 覆盖判定：送达范围完整覆盖请求范围。
 * - 整结果请求（null）只被整结果完整送达（null）覆盖；
 * - 整文件送达（endLine = null 表示到文件尾）覆盖有限子区间，但请求起点
 *   必须落在资源内（totalLines 已知时校验）；
 * - 请求了具体终点时，终点不得超过资源总行数（越界 clamp 不算覆盖）；
 * - 其余按行区间比较；「no lines」送达（endLine < startLine）不覆盖任何请求。
 */
function covers(entry: StoredLedgerEntry, requested: LedgerRange | null): boolean {
  const delivered = entry.deliveredRange;
  if (requested === null) {
    // 整结果请求只被「完整送达」覆盖；截断（含排序选择）不得冒充整结果
    return delivered === null && entry.complete === true;
  }
  if (delivered === null) {
    return false;
  }
  if (delivered.endLine !== null && delivered.endLine < delivered.startLine) {
    return false;
  }
  if (delivered.startLine > requested.startLine) {
    return false;
  }
  if (
    entry.totalLines !== undefined &&
    ((requested.endLine !== null && requested.endLine > entry.totalLines) ||
      (requested.endLine === null && requested.startLine > entry.totalLines))
  ) {
    return false;
  }
  if (requested.endLine === null) {
    // 「到结尾」请求：只有确实送达至结尾才算覆盖
    return delivered.endLine === null;
  }
  return endRank(delivered.endLine) >= requested.endLine;
}

function endRank(endLine: number | null): number {
  return endLine === null ? Number.POSITIVE_INFINITY : endLine;
}

/** 节省字符估算：精确重复按原文长度；子区间按行数比例折算（上界 clamp） */
function estimateSavedChars(entry: StoredLedgerEntry, requested: LedgerRange | null): number {
  if (requested === null || entry.deliveredRange === null) {
    return entry.charCount;
  }
  const requestedLines = lineSpan(requested, entry.totalLines);
  const deliveredLines = lineSpan(entry.deliveredRange, entry.totalLines);
  if (requestedLines === null || deliveredLines === null) {
    return entry.charCount;
  }
  if (requestedLines <= 0 || deliveredLines <= 0) {
    return 0;
  }
  return Math.min(entry.charCount, Math.round((entry.charCount * requestedLines) / deliveredLines));
}

/**
 * 区间行数；endLine = null（到结尾）用资源总行数折算，总行数未知时返回
 * null（调用方回退为整条字符数——整结果工具没有行区间语义）。
 */
function lineSpan(range: LedgerRange, totalLines: number | undefined): number | null {
  const end = range.endLine ?? totalLines;
  if (end === undefined) {
    return null;
  }
  return Math.max(0, end - range.startLine + 1);
}

/** 送达内容哈希（sha256 hex） */
function contentHashOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * 功能态账本：内部累积登记，对外只暴露防御性快照与统计。
 * 账本天然是有状态累积器（登记 / 命中计数），内部数组与索引按 run 顺序
 * 单写；对入参范围对象做防御性拷贝，登记后不与调用方共享引用。
 */
export function createContextLedger(options: ContextLedgerOptions = {}): ContextLedger {
  const now = options.now ?? ((): string => new Date().toISOString());
  const entries: StoredLedgerEntry[] = [];
  const indicesByResource = new Map<string, number[]>();
  let ledgerHits = 0;
  let ledgerMisses = 0;
  let savedCharsEstimate = 0;

  // 命中桶按 resourceKey（工具名 + 资源参数）分桶：整读（file）与子区间读
  // （range）必须落在同一桶才能做覆盖判定；kind 只进条目身份键与审计。
  const bucketKey = (request: LedgerRequest): string => request.resourceKey;

  return {
    referenceIfLoaded: (request): string | undefined => {
      for (const index of indicesByResource.get(bucketKey(request)) ?? []) {
        const entry = entries[index];
        if (entry === undefined || !covers(entry, request.requestedRange)) {
          continue;
        }
        const hit: StoredLedgerEntry = {
          ...entry,
          hitCount: entry.hitCount + 1,
          lastHitAt: now(),
        };
        entries[index] = hit;
        ledgerHits += 1;
        savedCharsEstimate += estimateSavedChars(hit, request.requestedRange);
        return formatReference(hit, request);
      }
      ledgerMisses += 1;
      return undefined;
    },
    register: (request, delivery): void => {
      const contentHash = contentHashOf(delivery.content);
      const entry: StoredLedgerEntry = {
        id: `ctx#${String(entries.length + 1).padStart(3, "0")}`,
        kind: request.kind,
        description: request.description,
        key: entryKey(request, contentHash),
        requestedRange: copyRange(request.requestedRange),
        deliveredRange: copyRange(delivery.deliveredRange),
        complete: delivery.complete,
        contentHash,
        contentVersion: 1,
        charCount: delivery.content.length,
        ...(delivery.totalLines !== undefined ? { totalLines: delivery.totalLines } : {}),
        ...(delivery.shownResultLines !== undefined
          ? { shownResultLines: delivery.shownResultLines }
          : {}),
        ...(delivery.totalResultLines !== undefined
          ? { totalResultLines: delivery.totalResultLines }
          : {}),
        hitCount: 0,
      };
      entries.push(entry);
      const key = bucketKey(request);
      const siblingIndices = indicesByResource.get(key);
      if (siblingIndices !== undefined) {
        siblingIndices.push(entries.length - 1);
      } else {
        indicesByResource.set(key, [entries.length - 1]);
      }
    },
    snapshot: (): readonly LedgerEntry[] => entries.map(copyEntry),
    stats: (): LedgerStats => ({ ledgerHits, ledgerMisses, savedCharsEstimate }),
  };
}

function copyRange(range: LedgerRange | null): LedgerRange | null {
  return range === null ? null : { ...range };
}

function copyEntry(entry: StoredLedgerEntry): StoredLedgerEntry {
  return {
    ...entry,
    requestedRange: copyRange(entry.requestedRange),
    deliveredRange: copyRange(entry.deliveredRange),
  };
}

/**
 * 整结果工具（无范围参数：diff / 符号 / 检索）的请求构造单点：
 * resourceKey 即请求标识，requestedRange 恒 null。
 */
export function wholeResultRequest(
  kind: LedgerEntry["kind"],
  resourceKey: string,
): LedgerRequest {
  return { kind, resourceKey, description: resourceKey, requestedRange: null };
}

/**
 * 整结果工具（无范围参数：diff / 符号 / 检索）的送达投影：
 * 未截断 = 整结果完整送达（deliveredRange null）；截断 = 非完整送达，
 * 排序选择可能非连续，故以 shownResultLines / totalResultLines 如实登记
 * （complete=false，不冒充整结果已送达）。
 */
export function wholeResultDelivery(content: string, budget: TruncationCounts): LedgerDelivery {
  if (!budget.truncated) {
    return { content, deliveredRange: null, complete: true };
  }
  return {
    content,
    deliveredRange: null,
    complete: false,
    shownResultLines: budget.shownLines,
    totalResultLines: budget.totalLines,
  };
}

/** 未截断的整结果送达（零命中 / 空语料等提前返回路径） */
export function completeWholeResultDelivery(content: string): LedgerDelivery {
  return { content, deliveredRange: null, complete: true };
}

/**
 * 工具入口的统一接入模式：命中直接返回引用（不触碰数据源）；
 * 未命中执行真实读取，成功后登记送达结果并返回原文（read 抛错则不登记，
 * 错误原样上抛——失败不是上下文，重试仍走真实读取路径）。
 */
export async function readThroughLedger(
  ledger: ContextLedger,
  request: LedgerRequest,
  read: () => Promise<LedgerDelivery>,
): Promise<string> {
  const cached = ledger.referenceIfLoaded(request);
  if (cached !== undefined) {
    return cached;
  }
  const delivery = await read();
  ledger.register(request, delivery);
  return delivery.content;
}
