/**
 * 首字节前薄重试契约（#59 / ADR-0018 §7）。
 *
 * 重试只发生在首字节前：网络错误 / 429 / 5xx；一旦收到 2xx（输出开始）
 * 不再重试。审计以可选尾键 `retry` 留痕；无重试时省键。
 */

import type { LlmUsage } from "./llm.js";

/** 重试原因（网络错误 / 限流 / 服务端 5xx） */
export type RetryReason = "network" | "http_429" | "http_5xx";

/** 一次失败尝试（重试链的单环） */
export interface RetryAttemptRecord {
  /** 1-based 逻辑请求序号（一次 fetch 调用 = 一个请求；重试环内相同） */
  readonly request: number;
  /** 1-based 失败尝试序号（成功的那次不计；每个请求内从 1 起） */
  readonly attempt: number;
  readonly reason: RetryReason;
  /** HTTP 状态码（network 失败缺席） */
  readonly status?: number;
  /** 本次失败后到下一尝试的退避毫秒数；最终失败（不再重试）为 0 */
  readonly delayMs: number;
  /** 是否实际发起了下一次尝试（false = 重试耗尽后的最终失败） */
  readonly retried: boolean;
  /** 失败响应携带的 usage（无则省键；不按 0 冒充） */
  readonly usage?: LlmUsage;
}

/** 一次 run 的重试留痕（无重试时审计省键） */
export interface RetryRecord {
  /** 实际发起的重试次数（≤ 2） */
  readonly retries: number;
  /** 失败尝试总数（含最终未重试的失败） */
  readonly failedAttempts: number;
  /** 重试耗尽后仍失败 */
  readonly exhausted: boolean;
  readonly records: readonly RetryAttemptRecord[];
}
