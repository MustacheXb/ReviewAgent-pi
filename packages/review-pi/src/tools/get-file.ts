import path from "node:path";
import type { LedgerDelivery, LedgerRange } from "../contracts/ledger.js";
import type { RepoContext } from "../zoneb/repo-context.js";
import { normalizeRepoPath, optionalPositiveIntArg, requireStringArg } from "./args.js";
import { readThroughLedger } from "./ledger.js";
import { applyLineBudget } from "./result-budget.js";
import type { ReviewToolHandler } from "./toolkit-types.js";

/**
 * review.get_file（#6 P3a）：读取仓库快照中的文件（支持行区间读取）。
 *
 * - 路径为仓库相对 POSIX 路径；反斜杠归一化，拒绝绝对路径与 ".." 越界（防路径逃逸）；
 * - 读取经 RepoContext（确定性）；文件缺失/不可读为显式有界错误，
 *   错误信息不泄漏仓库绝对路径（请求字节可跨环境复现）；
 * - 行区间：start 超出文件尾为显式错误；end 超出文件尾截断到文件尾并留痕；
 * - 输出行带行号（证据引用需要行号）；超预算在行边界截断并留痕；
 * - Context Ledger（#56 送达感知）：resourceKey = 路径；请求范围 = 规范化行
 *   区间；送达范围按实际渲染结果登记（超预算截断 / end clamp 均 complete=false）。
 *   整文件完整送达后请求子区间命中；截断送达不得冒充整文件；读取失败不登记。
 */

export const getFileTool: ReviewToolHandler = async (args, context): Promise<string> => {
  const rawPath = requireStringArg("review.get_file", args, "path");
  const startLine = optionalPositiveIntArg("review.get_file", args, "startLine");
  const endLine = optionalPositiveIntArg("review.get_file", args, "endLine");
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    throw new Error(
      `review.get_file: argument "startLine" (${startLine}) must not exceed "endLine" (${endLine})`,
    );
  }

  const posixPath = normalizeRepoPath("review.get_file", rawPath);
  return readThroughLedger(
    context.ledger,
    {
      kind: fileReadLedgerKind(startLine, endLine),
      resourceKey: `review.get_file ${posixPath}`,
      description: fileReadLedgerDescription(posixPath, startLine, endLine),
      requestedRange: { startLine: startLine ?? 1, endLine: endLine ?? null },
    },
    async () => {
      const repo = await context.repo();
      const source = await readSourceSafe(repo, posixPath);
      const lines = splitFileLines(source);
      return renderFileSlice(posixPath, lines, { startLine, endLine }, context.resultBudgetChars);
    },
  );
};

/** Ledger 登记种类：指定任一边界即区间读取（range），否则整读（file） */
function fileReadLedgerKind(
  startLine: number | undefined,
  endLine: number | undefined,
): "range" | "file" {
  return startLine !== undefined || endLine !== undefined ? "range" : "file";
}

/** 规范化请求标识：路径 + 请求区间（缺省边界显式化；键取请求而非实际返回内容） */
function fileReadLedgerDescription(
  posixPath: string,
  startLine: number | undefined,
  endLine: number | undefined,
): string {
  if (startLine === undefined && endLine === undefined) {
    return `review.get_file ${posixPath}`;
  }
  const start = startLine ?? 1;
  const end = endLine ?? "end";
  return `review.get_file ${posixPath}:${start}-${end}`;
}

/** 读取 + 边界守卫：仓库根外或缺失/不可读一律归为有界错误（不泄漏绝对路径） */
async function readSourceSafe(repo: RepoContext, posixPath: string): Promise<string> {
  const absolute = path.resolve(repo.repoPath, ...posixPath.split("/"));
  const root = path.resolve(repo.repoPath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`review.get_file: path "${posixPath}" must stay inside the repository snapshot`);
  }
  try {
    return await repo.readSource(posixPath);
  } catch {
    throw new Error(
      `review.get_file: file "${posixPath}" cannot be read from the repository snapshot (not found or unreadable)`,
    );
  }
}

/** 行拆分（文件尾换行不产生伪行；空文件为 0 行） */
function splitFileLines(source: string): readonly string[] {
  if (source.length === 0) {
    return [];
  }
  const body = source.endsWith("\n") ? source.slice(0, -1) : source;
  return body.split("\n");
}

interface FileSlice {
  readonly startLine: number | undefined;
  readonly endLine: number | undefined;
}

function renderFileSlice(
  posixPath: string,
  lines: readonly string[],
  slice: FileSlice,
  budgetChars: number,
): LedgerDelivery {
  const totalLines = lines.length;
  if (totalLines === 0) {
    return {
      content: [`File: ${posixPath}`, "Lines 0-0 of 0 (empty file)"].join("\n"),
      deliveredRange: { startLine: 1, endLine: null },
      complete: true,
      totalLines,
    };
  }
  const requestedStart = slice.startLine ?? 1;
  if (requestedStart > totalLines) {
    throw new Error(
      `review.get_file: requested start line ${requestedStart} is beyond end of file "${posixPath}" (${totalLines} lines)`,
    );
  }
  const clampedEnd =
    slice.endLine !== undefined && slice.endLine > totalLines ? totalLines : (slice.endLine ?? totalLines);
  const clamped = slice.endLine !== undefined && slice.endLine > totalLines;
  const clampedNote = clamped
    ? ` (requested end line ${slice.endLine} clamped to end of file)`
    : "";

  const selected = lines.slice(requestedStart - 1, clampedEnd);
  const header = [
    `File: ${posixPath}`,
    `Lines ${requestedStart}-${clampedEnd} of ${totalLines}${clampedNote}`,
  ];
  const numbered = numberLines(selected, requestedStart);
  const budget = applyLineBudget(
    [...header, ...numbered],
    budgetChars,
    (shown, total) =>
      `Tool result truncated: showing ${shown} of ${total} result lines (tool result budget ${budgetChars} chars exceeded); request a narrower range with startLine/endLine.`,
  );
  // 送达范围按实际渲染结果折算（头部两行不计入源行号）；截断或 clamp 即不完整。
  // 整读（未给 endLine）完整送达记 endLine=null（到文件尾）；totalLines 供
  // 账本判定「到结尾」请求是否越界与子区间折算。
  const shownContentLines = Math.max(0, budget.shownLines - header.length);
  const complete = !budget.truncated && !clamped;
  const deliveredRange: LedgerRange = complete
    ? { startLine: requestedStart, endLine: slice.endLine === undefined ? null : clampedEnd }
    : { startLine: requestedStart, endLine: requestedStart + shownContentLines - 1 };
  return {
    content: budget.lines.join("\n"),
    deliveredRange,
    complete,
    totalLines,
  };
}

/** 行号右对齐前缀（宽度按展示区间内最大行号） */
function numberLines(lines: readonly string[], firstLineNumber: number): readonly string[] {
  const width = String(firstLineNumber + lines.length - 1).length;
  return lines.map((line, index) => {
    const lineNumber = String(firstLineNumber + index).padStart(width, " ");
    return `${lineNumber} | ${line}`;
  });
}
