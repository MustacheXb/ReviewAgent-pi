import type { AnalysisTruth, MatchCounts } from "./contracts.js";

/**
 * 确定性 rule 粗筛（判定链第一级；分析器内零 LLM 复算）。
 *
 * 匹配口径（与历史评测线默认口径一致）：
 * 1. 文件路径归一后相等（\ → /、折叠重复 /、剥 ./ 与 unified diff 的 a/ b/ 前缀）；
 * 2. finding.line ∈ [lineStart, lineEnd]（默认零容差）；
 * 3. category 与 defectNature trim + 大写后相等。
 * 一对一贪心占用：每个真值位置至多被一条 finding 占用。
 *
 * clean MR 不在本函数处理（调用方只对 truth ≠ null 调用）。
 */
export function screenFindings(
  findings: readonly { readonly file: string; readonly line: number; readonly category: string }[],
  truth: AnalysisTruth,
): MatchCounts {
  const locations = truth.locations.map((location) => ({
    file: normalizeFilePath(location.file),
    lineStart: location.lineStart,
    lineEnd: location.lineEnd,
    defectNature: canonicalNature(location.defectNature),
  }));
  const claimed = locations.map(() => false);
  let tp = 0;
  let fp = 0;
  for (const finding of findings) {
    const matched = locations.findIndex(
      (location, index) =>
        !claimed[index] &&
        location.file === normalizeFilePath(finding.file) &&
        finding.line >= location.lineStart &&
        finding.line <= location.lineEnd &&
        location.defectNature === canonicalNature(finding.category),
    );
    if (matched >= 0) {
      claimed[matched] = true;
      tp += 1;
    } else {
      fp += 1;
    }
  }
  const fn = claimed.filter((value) => !value).length;
  return { tp, fp, fn };
}

/** 文件路径归一：统一分隔符、折叠重复斜杠、剥 ./ 与 a/ b/ 前缀（迭代剥净） */
export function normalizeFilePath(rawPath: string): string {
  let normalized = rawPath.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  let changed = true;
  while (changed) {
    changed = false;
    while (normalized.startsWith("./")) {
      normalized = normalized.slice(2);
      changed = true;
    }
    if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
      normalized = normalized.slice(2);
      changed = true;
    }
  }
  return normalized;
}

/** 缺陷性质归一：trim + 大写（未命中词表也稳定；词表外类别不参与匹配） */
export function canonicalNature(raw: string): string {
  return raw.trim().toUpperCase();
}
