import { readThroughLedger, wholeResultDelivery, wholeResultRequest } from "./ledger.js";
import { applyLineBudget } from "./result-budget.js";
import type { ReviewToolHandler } from "./toolkit-types.js";

/**
 * review.get_diff（#6 P3a）：返回本次 MR 的 unified diff（检视对象本体）。
 *
 * 输出确定性：同一 MR → 同一字节；超预算在行边界截断并留痕。
 * Context Ledger（#56 送达感知）：diff 登记为 evidence（Evidence Policy：
 * diff 即首要证据源）；只有整结果完整送达时重复读取才命中引用；截断送达
 * 不冒充整结果已加载。
 */

/** Ledger 登记标识（无入参，请求本身即标识） */
const GET_DIFF_LEDGER_DESCRIPTION = "review.get_diff";

export const getDiffTool: ReviewToolHandler = async (args, context): Promise<string> =>
  readThroughLedger(
    context.ledger,
    wholeResultRequest("evidence", GET_DIFF_LEDGER_DESCRIPTION),
    async () => {
      const lines = ["MR unified diff:", ...context.diff.split("\n")];
      const budget = applyLineBudget(
        lines,
        context.resultBudgetChars,
        (shown, total) =>
          `Tool result truncated: showing ${shown} of ${total} diff lines (tool result budget ${context.resultBudgetChars} chars exceeded).`,
      );
      return wholeResultDelivery(budget.lines.join("\n"), budget);
    },
  );
