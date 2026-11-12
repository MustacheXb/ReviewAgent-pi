import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * C_ref 全仓注入（#43，eval-only）：把仓库快照的全部 Java 源文件按排序路径序
 * 装填进评审上下文，用于 L3 的「同模型信息给满」参照。
 *
 * 纪律（评测基准方案 §7.1 / ADR-0016）：
 * - 确定性：文件清单排序、读取字节稳定；同仓同预算 → 字节相同；
 * - 预算守卫：默认 80k chars；整文件优先，装不下整文件时行级截断并显式标记，
 *   末尾追加截断总提示（未注入文件清单有界列出），杜绝静默丢弃；
 * - 零网络 / 零 LLM：只读仓库文件；输出 `FullRepoRecord` 供评测侧 sidecar，
 *   不写生产 `RunAudit.fullRepo`；
 * - eval-only：本模块只存在于 `src/eval/ref`，生产入口不得 import。
 */

/** 默认字符预算（≈20K tokens @4 chars/token） */
export const DEFAULT_FULL_REPO_BUDGET_CHARS = 80_000;

/** 截断提示中最多列出的未注入文件路径数 */
const MAX_LISTED_OMITTED_FILES = 20;

/** 构建 / VCS / 依赖目录不进入全仓参照（确定性排除） */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  ".gradle",
  ".idea",
  "build",
  "node_modules",
  "out",
  "target",
]);

const INTRO_LINES: readonly string[] = [
  "Full repository context (C_ref, eval-only). Deterministically injected from the repository snapshot",
  "(zero-build, no LLM). Java source files are listed in sorted path order; budget truncation is explicit.",
];

/**
 * 全仓注入记账（评测侧 sidecar；不写生产 RunAudit.fullRepo）。
 * `budgetChars` 是装填预算；截断总提示有固定开销，`contentChars` 可略超预算。
 */
export interface CRefFullRepoRecord {
  readonly budgetChars: number;
  readonly contentChars: number;
  readonly truncated: boolean;
  readonly totalFiles: number;
  readonly shownFiles: number;
  /** 完全未注入的文件（排序路径序；可比 shownFiles 大很多） */
  readonly omittedFiles: readonly string[];
  /** 被行级截断的尾部文件（整文件装入时为 null） */
  readonly partialFile: string | null;
}

/** 仓库快照读取面（可注入 fake 供测试；真实实现走 fs） */
export interface RepoSnapshot {
  /** 绝对仓库根 */
  readonly root: string;
  /** 全部 Java 文件（排序、仓库相对 POSIX 路径） */
  readonly javaFiles: readonly string[];
  readSource(file: string): Promise<string>;
}

export interface FullRepoInjection {
  readonly message: { readonly role: "user"; readonly content: string };
  readonly record: CRefFullRepoRecord;
}

export interface BuildFullRepoInjectionInput {
  readonly repo: RepoSnapshot;
  readonly budgetChars: number;
}

/** 读取仓库快照：递归列出 `.java`（排序 POSIX 路径），排除构建 / VCS / 依赖目录 */
export async function loadRepoSnapshot(root: string): Promise<RepoSnapshot> {
  const resolvedRoot = path.resolve(root);
  const javaFiles = await listJavaFiles(resolvedRoot, "");
  return {
    root: resolvedRoot,
    javaFiles,
    // CRLF 归一：跨平台 checkout 不改变注入字节（确定性 golden bytes）
    readSource: async (file: string) =>
      (await readFile(absoluteFile(resolvedRoot, file), "utf8")).replaceAll("\r\n", "\n"),
  };
}

export async function buildFullRepoInjection(
  input: BuildFullRepoInjectionInput,
): Promise<FullRepoInjection> {
  const budget = input.budgetChars;
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new Error(`full-repo injection: budgetChars must be a positive integer (got ${budget})`);
  }
  if (input.repo.javaFiles.length === 0) {
    const content = [...INTRO_LINES, "No Java files found in the repository snapshot."].join("\n");
    return {
      message: { role: "user", content },
      record: {
        budgetChars: budget,
        contentChars: content.length,
        truncated: false,
        totalFiles: 0,
        shownFiles: 0,
        omittedFiles: [],
        partialFile: null,
      },
    };
  }

  const fill = await fillFilesInBudget(input.repo, budget);
  const parts = [INTRO_LINES.join("\n"), ...fill.blocks];
  const truncated = fill.shownFiles < input.repo.javaFiles.length || fill.lastFilePartial;
  if (truncated) {
    parts.push(buildTruncationNotice(input.repo.javaFiles, fill, budget));
  }

  const content = parts.join("\n\n");
  return {
    message: { role: "user", content },
    record: {
      budgetChars: budget,
      contentChars: content.length,
      truncated,
      totalFiles: input.repo.javaFiles.length,
      shownFiles: fill.shownFiles,
      omittedFiles: input.repo.javaFiles.slice(fill.stopIndex),
      partialFile: fill.lastFilePartial
        ? (input.repo.javaFiles[fill.stopIndex - 1] ?? null)
        : null,
    },
  };
}

interface BudgetFillResult {
  /** 已装入的文件块（整文件或行级截断尾块） */
  readonly blocks: readonly string[];
  readonly shownFiles: number;
  /** 最后一个装入的文件是否被行级截断 */
  readonly lastFilePartial: boolean;
  /** 第一个未装入文件的索引（= 文件总数表示全部装入） */
  readonly stopIndex: number;
}

/**
 * 前锋装填：按排序路径序逐个装整文件；装不下整文件时行级截断装尾块，然后停止
 * （保持注入文件为排序清单的连续前缀，截断规模最小化且有界）。
 */
async function fillFilesInBudget(
  repo: RepoSnapshot,
  budgetChars: number,
): Promise<BudgetFillResult> {
  const blocks: string[] = [];
  let used = INTRO_LINES.join("\n").length;
  let shownFiles = 0;
  let lastFilePartial = false;

  for (let index = 0; index < repo.javaFiles.length; index += 1) {
    const file = repo.javaFiles[index];
    if (file === undefined) {
      break;
    }
    const source = await repo.readSource(file);
    const lines = splitFileLines(source);
    const header = `## File: ${file} (${lines.length} lines)`;
    const blockText = [header, ...lines].join("\n");
    if (used + 2 + blockText.length <= budgetChars) {
      blocks.push(blockText);
      used += 2 + blockText.length;
      shownFiles += 1;
      continue;
    }
    const partial = buildPartialBlock(header, lines, budgetChars - used - 2);
    if (partial !== undefined) {
      blocks.push(partial);
      shownFiles += 1;
      lastFilePartial = true;
      return { blocks, shownFiles, lastFilePartial, stopIndex: index + 1 };
    }
    return { blocks, shownFiles, lastFilePartial, stopIndex: index };
  }
  return { blocks, shownFiles, lastFilePartial, stopIndex: repo.javaFiles.length };
}

function buildTruncationNotice(
  javaFiles: readonly string[],
  fill: BudgetFillResult,
  budgetChars: number,
): string {
  const partialNote = fill.lastFilePartial
    ? " The last included file is line-truncated (full-repo budget exceeded)."
    : "";
  const omitted = listOmitted(javaFiles.slice(fill.stopIndex));
  return `Full repository context truncated: showing ${fill.shownFiles} of ${javaFiles.length} files (budget ${budgetChars} chars exceeded).${partialNote} Files not included: ${omitted}`;
}

/** 行级截断的尾块（装不下整文件时，保留头部 + 能装下的行数 + 留痕行） */
function buildPartialBlock(
  header: string,
  lines: readonly string[],
  remainingChars: number,
): string | undefined {
  const notice = "(file truncated; full-repo budget exceeded)";
  const fixed = header.length + 1 + notice.length;
  if (remainingChars < fixed) {
    return undefined;
  }
  let shown = 0;
  let used = fixed;
  for (const line of lines) {
    if (used + 1 + line.length > remainingChars) {
      break;
    }
    used += 1 + line.length;
    shown += 1;
  }
  if (shown === 0) {
    return undefined;
  }
  return [header, ...lines.slice(0, shown), notice].join("\n");
}

function listOmitted(files: readonly string[]): string {
  const listed = files.slice(0, MAX_LISTED_OMITTED_FILES);
  const rest = files.length - listed.length;
  const names = listed.length > 0 ? listed.join(", ") : "(none)";
  return rest > 0 ? `${names} (+${rest} more)` : names;
}

function splitFileLines(source: string): readonly string[] {
  if (source.length === 0) {
    return [];
  }
  const body = source.endsWith("\n") ? source.slice(0, -1) : source;
  return body.split("\n");
}

async function listJavaFiles(root: string, relativeDir: string): Promise<readonly string[]> {
  const directory = relativeDir === "" ? root : path.join(root, ...relativeDir.split("/"));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `full-repo injection: failed to read directory "${directory}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      files.push(...(await listJavaFiles(root, relative)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".java")) {
      files.push(relative);
    }
  }
  // readdir 顺序不保证跨平台稳定——排序后才符合「排序路径前缀」纪律
  return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function absoluteFile(root: string, file: string): string {
  return path.join(root, ...file.split("/"));
}
