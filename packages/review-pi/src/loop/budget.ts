/**
 * 内核内部预算注入面（#53 / ADR-0018 §1）：五类独立预算。
 *
 * 纪律：
 * - 预算只存在于内核内部输入（runReview → runAgentReviewLoop），不进入协议
 *   字段、CLI 参数或环境变量（ADR-0015 §3、ADR-0018 §7）；
 * - 缺省值是安全上界，不是目标档；未触发任何预算的 run，wire 请求字节与
 *   既有行为逐字节不变；
 * - attempts 与 executed 是独立计数器：attempt 含被拒调用，executed 只计
 *   真正进入执行的调用（ADR-0018 §1「两个独立闸」）。
 */

/** 五类独立预算（命名以 ADR-0018 §1 为准） */
export interface ReviewBudget {
  /** 每发往 provider 一次请求计 1（发送前计数；越界判定在下一请求前） */
  readonly maxRequests: number;
  /** 六阶段完整一遍为一轮；越界判定在轮次边界 */
  readonly maxRounds: number;
  /** 实际进入工具执行计 1（失败也计入；跨轮不重置） */
  readonly maxExecutedToolCalls: number;
  /** Attempt Budget（尝试预算）：模型每发出一个 toolCall 内容块计 1（含被拒调用） */
  readonly maxToolAttempts: number;
  /** 每收到 assistant usage 后累计输出；只在阶段边界事后判定 */
  readonly maxOutputTokens: number;
}

/** 内部输入覆盖面：只给出要收紧的预算字段 */
export type ReviewBudgetOverride = Partial<ReviewBudget>;

/** 安全上界缺省档（ADR-0018 §1） */
export const DEFAULT_REVIEW_BUDGET: ReviewBudget = {
  maxRequests: 24,
  maxRounds: 5,
  maxExecutedToolCalls: 6,
  maxToolAttempts: 12,
  maxOutputTokens: 48_000,
};

/** 补全缺省并校验覆盖值（预算必须是正整数——0 会静默关闭整类预算） */
export function resolveReviewBudget(override: ReviewBudgetOverride = {}): ReviewBudget {
  return {
    maxRequests: resolveField("maxRequests", override.maxRequests),
    maxRounds: resolveField("maxRounds", override.maxRounds),
    maxExecutedToolCalls: resolveField("maxExecutedToolCalls", override.maxExecutedToolCalls),
    maxToolAttempts: resolveField("maxToolAttempts", override.maxToolAttempts),
    maxOutputTokens: resolveField("maxOutputTokens", override.maxOutputTokens),
  };
}

function resolveField(field: keyof ReviewBudget, value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_REVIEW_BUDGET[field];
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `review budget ${field} must be a positive integer, got ${String(value)}`,
    );
  }
  return value;
}
