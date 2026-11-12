/**
 * 工具结果预算层（#6 P3a；#57 排序选择）：超长结果在行边界截断并显式留痕
 * （不静默丢弃）。
 *
 * 纪律（与 zoneb/budget.ts 一致）：截断时在内容末尾追加确定性提示行，
 * 提示行携带预算与截断规模，可见于请求字节与审计 toolCallLog。
 * 预算以字符数为代理（无 tokenizer；字符计数跨平台确定）。
 *
 * 两种选择策略：
 * - applyLineBudget（get_file / get_diff）：保留行前缀（头部）；
 * - applyRankedBudget（检索 / 符号 / 调用链）：超预算时按条目 rank 贪心
 *   选取 top-K，选中条目保持原有顺序输出；未超预算时输出逐字节不变。
 */

/** 单次工具结果的默认字符预算（≈2K tokens @4 chars/token） */
export const DEFAULT_TOOL_RESULT_BUDGET_CHARS = 8_000;

/** 截断规模（两种策略共用的外部可观察计数；提示与 Ledger 同源） */
export interface TruncationCounts {
  readonly truncated: boolean;
  /** 实际送达的结果行数（含工具自带的 header 行；不含提示行） */
  readonly shownLines: number;
  /** 完整结果的结果行数（含 header 行） */
  readonly totalLines: number;
}

export interface LineBudgetResult extends TruncationCounts {
  /** 保留的行（含截断提示行，若发生截断） */
  readonly lines: readonly string[];
}

/**
 * 在预算内保留最长的行前缀（行边界截断，不切断行内部）。
 * 计入预算的是保留行以 "\n" 连接后的总字符数；截断提示行不计入。
 */
export function applyLineBudget(
  lines: readonly string[],
  budgetChars: number,
  buildNotice: (shown: number, total: number) => string,
): LineBudgetResult {
  if (lines.length === 0) {
    return { lines: [], truncated: false, shownLines: 0, totalLines: 0 };
  }
  let shown = 0;
  let used = 0;
  for (const line of lines) {
    const candidate = shown === 0 ? line.length : used + 1 + line.length;
    if (candidate > budgetChars) {
      break;
    }
    used = candidate;
    shown++;
  }
  if (shown === lines.length) {
    return { lines: [...lines], truncated: false, shownLines: shown, totalLines: lines.length };
  }
  const notice = buildNotice(shown, lines.length);
  return {
    lines: [...lines.slice(0, shown), notice],
    truncated: true,
    shownLines: shown,
    totalLines: lines.length,
  };
}

/** 排序选择的一个条目：rank 字典序越小越优先；lines 为条目的完整行块 */
export interface RankedBudgetItem {
  readonly rank: readonly number[];
  /** 可选分组头：同组内任一入选时只输出一次（如 get_symbol 的文件头） */
  readonly group?: RankedBudgetGroup;
  readonly lines: readonly string[];
}

export interface RankedBudgetGroup {
  readonly id: string;
  readonly header: readonly string[];
}

export interface RankedBudgetResult extends TruncationCounts {
  /** 选中条目按原有顺序展开（含分组头；不含提示行） */
  readonly lines: readonly string[];
}

/**
 * 超预算时按 rank 选择 top-K（贪心：高优先条目先占预算，整条入选），
 * 输出保持选中条目的原有顺序；某组有任一条目入选时输出该组头一次。
 * 未超预算时直接返回全部条目（调用方 join 后与既有输出逐字节一致）。
 */
export function applyRankedBudget(
  headerLines: readonly string[],
  items: readonly RankedBudgetItem[],
  budgetChars: number,
  buildNotice: (shown: number, total: number) => string,
): RankedBudgetResult {
  const fullLines = renderRankedLines(headerLines, items, fullSelection(items));
  if (joinedChars(fullLines) <= budgetChars) {
    return {
      lines: fullLines,
      truncated: false,
      shownLines: fullLines.length,
      totalLines: fullLines.length,
    };
  }
  const shownLines = renderRankedLines(
    headerLines,
    items,
    selectRankedItems(headerLines, items, budgetChars),
  );
  return {
    lines: [...shownLines, buildNotice(shownLines.length, fullLines.length)],
    truncated: true,
    shownLines: shownLines.length,
    totalLines: fullLines.length,
  };
}

/** 贪心选取完整条目（rank 升序）；预算放不下的条目跳过，不输出半条目 */
function selectRankedItems(
  headerLines: readonly string[],
  items: readonly RankedBudgetItem[],
  budgetChars: number,
): ReadonlyMap<number, number> {
  const selection = new Map<number, number>();
  for (const index of rankedIndices(items)) {
    const lineCount = items[index]?.lines.length;
    if (lineCount === undefined) {
      continue;
    }
    const tentative = new Map(selection);
    tentative.set(index, lineCount);
    if (joinedChars(renderRankedLines(headerLines, items, tentative)) <= budgetChars) {
      selection.set(index, lineCount);
    }
  }
  return selection;
}

/** 按 rank 字典序排列的条目下标（平局保持原序） */
function rankedIndices(items: readonly RankedBudgetItem[]): readonly number[] {
  return items
    .map((item, index) => ({ index, rank: item.rank }))
    .sort((a, b) => compareRanks(a.rank, b.rank) || a.index - b.index)
    .map((entry) => entry.index);
}

/** 标准截断提示：shown / total / budget / complete 四要素（确定性文案） */
export function standardTruncationNotice(
  shown: number,
  total: number,
  budgetChars: number,
  unitLabel = "result lines",
): string {
  return `Tool result truncated: showing ${shown} of ${total} ${unitLabel} (tool result budget ${budgetChars} chars exceeded; complete=false).`;
}

function fullSelection(items: readonly RankedBudgetItem[]): ReadonlyMap<number, number> {
  return new Map(items.map((item, index) => [index, item.lines.length]));
}

function renderRankedLines(
  headerLines: readonly string[],
  items: readonly RankedBudgetItem[],
  selection: ReadonlyMap<number, number>,
): readonly string[] {
  const lines: string[] = [...headerLines];
  const emittedGroups = new Set<string>();
  for (let index = 0; index < items.length; index++) {
    const count = selection.get(index);
    if (count === undefined || count <= 0) {
      continue;
    }
    const item = items[index];
    if (item === undefined) {
      continue;
    }
    if (item.group !== undefined && !emittedGroups.has(item.group.id)) {
      emittedGroups.add(item.group.id);
      lines.push(...item.group.header);
    }
    lines.push(...item.lines.slice(0, count));
  }
  return lines;
}

/** 行集合按 "\n" 连接后的字符数（预算口径；空集合为 0） */
function joinedChars(lines: readonly string[]): number {
  if (lines.length === 0) {
    return 0;
  }
  return lines.reduce((sum, line) => sum + line.length, 0) + lines.length - 1;
}

/** rank 字典序比较（前缀相同者短者优先） */
function compareRanks(a: readonly number[], b: readonly number[]): number {
  const common = Math.min(a.length, b.length);
  for (let index = 0; index < common; index++) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }
  return a.length - b.length;
}
