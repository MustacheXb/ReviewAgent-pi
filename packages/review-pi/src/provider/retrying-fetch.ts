import type { FetchFunction } from "@earendil-works/pi-ai";
import { cacheHitTokensOf, usageOf } from "../contracts/cache-contract.js";
import type { LlmUsage } from "../contracts/llm.js";
import type { RetryAttemptRecord, RetryRecord } from "../contracts/retry.js";

/**
 * 首字节前薄重试（#59 / ADR-0018 §7）：包装 FetchFunction。
 *
 * - 仅网络错误 / 429 / 5xx 重试；最多 2 次；退避 500ms / 1500ms + ±20% 抖动；
 * - 服从 `Retry-After`（秒或 HTTP-date，按服务端值，不叠加抖动）；
 * - 一旦 base fetch 返回 2xx（输出开始）原样返回，不再重试；
 * - 取消（AbortError / signal.aborted）不重试；
 * - 失败响应若带 usage，克隆响应体读取并留痕（原响应体在重试前 cancel）。
 *
 * 观测失败永不击穿主链；退避与随机源可注入，测试用 fake timers 确定性驱动。
 */

/** 规格硬上限：最多 2 次重试（不开放覆盖旋钮） */
const MAX_RETRIES = 2;
/** 第 1/2 次重试的基准退避（毫秒） */
const RETRY_DELAYS_MS = [500, 1_500] as const;
/** 抖动幅度（±20%） */
const JITTER_RATIO = 0.2;

/** 视为网络瞬态错误的 Node / undici 错误码 */
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export interface RetryingFetchOptions {
  /** 退避实现（缺省 setTimeout；测试可注入） */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 随机源 [0,1)（缺省 Math.random；测试注入 0.5 = 无抖动） */
  readonly random?: () => number;
  /** 时钟（Retry-After HTTP-date 用；缺省 Date.now） */
  readonly now?: () => number;
}

export interface RetryingFetch {
  readonly fetch: FetchFunction;
  /** 失败尝试留痕（无失败尝试时 undefined；无重试 run 审计省键） */
  summary(): RetryRecord | undefined;
}

interface RetryState {
  readonly records: RetryAttemptRecord[];
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly now: () => number;
  exhausted: boolean;
}

export function createRetryingFetch(
  base: FetchFunction,
  options: RetryingFetchOptions = {},
): RetryingFetch {
  const state: RetryState = {
    records: [],
    sleep: options.sleep ?? sleepByTimeout,
    random: options.random ?? Math.random,
    now: options.now ?? Date.now,
    exhausted: false,
  };
  let requestIndex = 0;

  const fetchFn: FetchFunction = async (input, init) => {
    requestIndex += 1;
    const request = requestIndex;
    for (let failureIndex = 0; ; failureIndex++) {
      let response: Response;
      try {
        response = await base(input, init);
      } catch (error) {
        await handleNetworkFailure(state, error, failureIndex, request, init?.signal);
        continue;
      }
      if (!isRetryableStatus(response.status)) {
        return response;
      }
      const outcome = await handleHttpFailure(
        state,
        response,
        failureIndex,
        request,
        init?.signal,
      );
      if (outcome === "final") {
        return response;
      }
    }
  };

  return {
    fetch: fetchFn,
    summary: (): RetryRecord | undefined => {
      if (state.records.length === 0) {
        return undefined;
      }
      return {
        retries: state.records.filter((record) => record.retried).length,
        failedAttempts: state.records.length,
        exhausted: state.exhausted,
        records: state.records.map(copyRecord),
      };
    },
  };
}

/** 网络错误分支：不可重试 / 耗尽 → 抛出；否则留痕并退避 */
async function handleNetworkFailure(
  state: RetryState,
  error: unknown,
  failureIndex: number,
  request: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  if (!isRetryableError(error, signal)) {
    throw error;
  }
  if (failureIndex >= MAX_RETRIES) {
    state.records.push({
      request,
      attempt: failureIndex + 1,
      reason: "network",
      delayMs: 0,
      retried: false,
    });
    state.exhausted = true;
    throw error;
  }
  const delayMs = jitteredDelay(failureIndex, state.random);
  state.records.push({
    request,
    attempt: failureIndex + 1,
    reason: "network",
    delayMs,
    retried: true,
  });
  await sleepWithSignal(delayMs, signal, state.sleep);
}

/** HTTP 失败分支：重试 → 留痕/退避；耗尽 → 留痕并交给调用方返回最终响应 */
async function handleHttpFailure(
  state: RetryState,
  response: Response,
  failureIndex: number,
  request: number,
  signal: AbortSignal | null | undefined,
): Promise<"retry" | "final"> {
  const usage = await failedUsageOf(response);
  const reason = response.status === 429 ? "http_429" : "http_5xx";
  if (failureIndex >= MAX_RETRIES) {
    state.records.push({
      request,
      attempt: failureIndex + 1,
      reason,
      status: response.status,
      delayMs: 0,
      retried: false,
      ...(usage !== undefined ? { usage } : {}),
    });
    state.exhausted = true;
    return "final";
  }
  const delayMs = retryAfterMs(response.headers.get("retry-after"), state.now()) ??
    jitteredDelay(failureIndex, state.random);
  state.records.push({
    request,
    attempt: failureIndex + 1,
    reason,
    status: response.status,
    delayMs,
    retried: true,
    ...(usage !== undefined ? { usage } : {}),
  });
  await cancelBody(response);
  await sleepWithSignal(delayMs, signal, state.sleep);
  return "retry";
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetryableError(error: unknown, signal: AbortSignal | null | undefined): boolean {
  if (signal?.aborted === true) {
    return false;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return false;
  }
  // 原生 fetch 的传输失败恒为 TypeError；非法 URL 等编程错误不重试
  if (error instanceof TypeError) {
    return !/invalid url|failed to parse url/i.test(error.message);
  }
  const code =
    typeof error === "object" && error !== null
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return typeof code === "string" && NETWORK_ERROR_CODES.has(code);
}

/** 基准退避 × (1 ± 20%)；random 注入 0.5 时恰为基准值 */
function jitteredDelay(attempt: number, random: () => number): number {
  const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 0;
  const unit = Math.min(1, Math.max(0, random()));
  return Math.max(0, Math.round(base * (1 + (unit * 2 - 1) * JITTER_RATIO)));
}

/** 退避等待：可被 signal 中止（取消不必等退避结束） */
async function sleepWithSignal(
  ms: number,
  signal: AbortSignal | null | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal === undefined || signal === null) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) {
    throw abortError();
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortError(): Error {
  const error = new Error("retry backoff aborted");
  error.name = "AbortError";
  return error;
}

/** Retry-After：秒数或 HTTP-date；缺失 / 非法 → undefined（回退基准退避） */
function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (header === null) {
    return undefined;
  }
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

/** 失败响应 usage（克隆体解析；失败/无 usage → undefined，不影响重试） */
async function failedUsageOf(response: Response): Promise<LlmUsage | undefined> {
  try {
    const text = await response.clone().text();
    const raw = usageOf(JSON.parse(text) as unknown);
    return raw === undefined ? undefined : toLlmUsage(raw);
  } catch {
    // 错误体非 JSON / 读取失败：失败尝试 usage 记缺省（不按 0 冒充）
    return undefined;
  }
}

function toLlmUsage(raw: Record<string, unknown>): LlmUsage | undefined {
  const prompt = numberField(raw.prompt_tokens);
  const completion = numberField(raw.completion_tokens);
  if (prompt === undefined && completion === undefined) {
    return undefined;
  }
  const cacheHit = cacheHitTokensOf(raw);
  const details = raw.prompt_tokens_details;
  const cacheWrite =
    numberField(isRecord(details) ? details.cache_write_tokens : undefined) ??
    numberField(raw.cache_write_tokens);
  return {
    // 与 usage-map 口径一致：input = prompt − cacheRead − cacheWrite
    inputTokens: Math.max(0, (prompt ?? 0) - (cacheHit ?? 0) - (cacheWrite ?? 0)),
    outputTokens: completion ?? 0,
    // 缺缓存字段省键（不按 0 冒充已计量）
    ...(cacheHit !== undefined ? { cacheReadTokens: cacheHit } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 取消失败不阻塞重试
  }
}

function copyRecord(record: RetryAttemptRecord): RetryAttemptRecord {
  return {
    ...record,
    ...(record.usage !== undefined ? { usage: { ...record.usage } } : {}),
  };
}

function sleepByTimeout(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
