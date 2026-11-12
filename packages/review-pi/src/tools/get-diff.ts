import { readThroughLedger, wholeResultDelivery, wholeResultRequest } from "./ledger.js";
import { applyLineBudget, standardTruncationNotice } from "./result-budget.js";
import type { ReviewToolHandler } from "./toolkit-types.js";

/**
 * review.get_diff（#6 P3a）：返回本次 MR 的 unified diff（检视对象本体）。
 *
 * 输出确定性：同一 MR → 同一字节；超预算在行边界截断并留痕。
 * Context Ledger（#56 送达感知）：diff 登记为 evidence（Evidence Policy：
 * diff 即首要证据源）；只有整结果完整送达时重复读取才命中引用；截断送达
 * 不冒充整结果已加载。
 * 截断提示（#57）：列出未完全展开的文件并建议 review.get_file(path)。
 */

/** Ledger 登记标识（无入参，请求本身即标识） */
const GET_DIFF_LEDGER_DESCRIPTION = "review.get_diff";

/** 结果头行数（"MR unified diff:"）——折算已送达的 diff 行号时扣除 */
const DIFF_SUMMARY_HEADER_LINES = 1;

/** 未完全展开文件提示一次最多列出的文件数（其余以 +N more 概括，提示有界） */
const MAX_UNEXPANDED_FILES_LISTED = 5;

const GIT_FILE_HEADER = /^diff --git a\/.+ b\/(.+)$/;
const PLUS_FILE_HEADER = /^\+\+\+ b\/(.+)$/;

export const getDiffTool: ReviewToolHandler = async (_args, context): Promise<string> =>
  readThroughLedger(
    context.ledger,
    wholeResultRequest("evidence", GET_DIFF_LEDGER_DESCRIPTION),
    async () => {
      const diffLines = context.diff.split("\n");
      const lines = ["MR unified diff:", ...diffLines];
      const budget = applyLineBudget(
        lines,
        context.resultBudgetChars,
        (shown, total) =>
          `${standardTruncationNotice(shown, total, context.resultBudgetChars, "diff lines")}${diffContinuationHint(diffLines, Math.max(0, shown - DIFF_SUMMARY_HEADER_LINES))}`,
      );
      return wholeResultDelivery(budget.lines.join("\n"), budget);
    },
  );

/**
 * 截断后的可行动提示（#57）：列出未完全展开的文件并建议 get_file(path)。
 * 「未完全展开」= 该文件块还有行未送达（含截断边界所在的文件），
 * 避免只露出文件头就冒充已展开。文件边界取 `diff --git` 的 b 侧路径
 * （无 git 头时回退 `+++ b/`）。
 */
function diffContinuationHint(diffLines: readonly string[], shownDiffLines: number): string {
  const starts = diffFileStarts(diffLines);
  const notFullyExpanded = starts.filter((_start, index) => {
    const nextStart = starts[index + 1]?.index ?? diffLines.length + 1;
    return nextStart - 1 > shownDiffLines;
  });
  if (notFullyExpanded.length === 0) {
    return "";
  }
  const listed = notFullyExpanded
    .slice(0, MAX_UNEXPANDED_FILES_LISTED)
    .map((start) => start.path);
  const omitted = notFullyExpanded.length - listed.length;
  const suffix = omitted > 0 ? ` (+${omitted} more)` : "";
  return ` Not fully expanded files: ${listed.join(", ")}${suffix}; continue with review.get_file(path=${JSON.stringify(listed[0])}).`;
}

/** 每个文件块在 diff 行集中的 1-based 起始行 */
function diffFileStarts(diffLines: readonly string[]): readonly { path: string; index: number }[] {
  const fromGit = fileStartsMatching(diffLines, GIT_FILE_HEADER);
  return fromGit.length > 0 ? fromGit : fileStartsMatching(diffLines, PLUS_FILE_HEADER);
}

function fileStartsMatching(
  diffLines: readonly string[],
  pattern: RegExp,
): readonly { path: string; index: number }[] {
  const starts: { path: string; index: number }[] = [];
  for (const [offset, line] of diffLines.entries()) {
    const match = pattern.exec(line);
    if (match?.[1] !== undefined) {
      starts.push({ path: match[1], index: offset + 1 });
    }
  }
  return starts;
}
