import type { DispositionRecord } from "./record.js";

/**
 * #15 人工接受率 KPI（绝对口径纯函数）。
 *
 * 口径（票面）：直接从处置记录集算出，不依赖锚相对结论——生产 KPI 与
 * 评测判级解耦。acceptance = accepted / total；只有 accept 算接受（reject
 * 与 false-positive 都不是）；total=0 → acceptanceRate = null（N/A ≠ 0，
 * 对齐仓内指标纪律「空集不冒充 0」，同 CONTEXT.md 分口径条目语义）。
 *
 * 读取视图 latest-wins：同一 finding 重复处置 = 追加新记录（store 只追加），
 * 聚合取每个 finding 的最新处置。finding 身份 = 回溯锚全组（source/caseId/
 * configId/rep/model）+ findingId——findingId 仅在 run 内唯一，跨 run 的
 * 同名 id 不互吃（票面「同一 findingId 取最新」按 finding 全身份实现）。
 *
 * notedAt 按时间纪元比较而非字符串序：混合精度 ISO 串的字典序与时间序
 * 不一致（"…00.100Z" 字典序早于 "…00Z"、时间上却更晚）；同刻并列以后到
 * （文件序更晚）为准——追加序即时间意图。纯函数：不改入参、无 IO。
 */

/** 人工接受率 KPI 聚合（绝对口径：accepted/total；total=0 → null） */
export interface AcceptanceKpi {
  readonly accepted: number;
  readonly rejected: number;
  readonly falsePositive: number;
  /** latest-wins 去重后的处置数（= accepted + rejected + falsePositive） */
  readonly total: number;
  /** accepted / total；total=0 → null（N/A ≠ 0，空集不冒充 0） */
  readonly acceptanceRate: number | null;
}

/** finding 全身份（回溯锚 + findingId）——latest-wins 的分组键（JSON 数组序列化：无拼接歧义） */
function findingKey(record: DispositionRecord): string {
  return JSON.stringify([
    record.source,
    record.caseId,
    record.configId,
    record.rep,
    record.model,
    record.findingId,
  ]);
}

/** latest-wins 读取视图：每个 finding 只保留最新处置（同刻后到胜），按首次出现序 */
export function latestDispositions(
  records: readonly DispositionRecord[],
): readonly DispositionRecord[] {
  const latest = new Map<string, { readonly record: DispositionRecord; readonly epoch: number }>();
  for (const record of records) {
    const key = findingKey(record);
    const epoch = Date.parse(record.notedAt);
    const current = latest.get(key);
    // >=：同刻并列也覆盖——后到（文件序更晚）胜，追加序即时间意图
    if (current === undefined || epoch >= current.epoch) {
      latest.set(key, { record, epoch });
    }
  }
  return [...latest.values()].map((entry) => entry.record);
}

/** 绝对口径聚合：输入处置记录集（原始，未去重），输出 KPI */
export function computeAcceptanceKpi(records: readonly DispositionRecord[]): AcceptanceKpi {
  const latest = latestDispositions(records);
  let accepted = 0;
  let rejected = 0;
  let falsePositive = 0;
  for (const record of latest) {
    if (record.disposition === "accept") {
      accepted += 1;
    } else if (record.disposition === "reject") {
      rejected += 1;
    } else {
      falsePositive += 1;
    }
  }
  const total = latest.length;
  return {
    accepted,
    rejected,
    falsePositive,
    total,
    acceptanceRate: total === 0 ? null : accepted / total,
  };
}
