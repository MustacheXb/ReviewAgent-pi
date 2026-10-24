/**
 * #28 typed HTTP client（方案 §6）：面向 `POST /rpc` 的 JSON-RPC 客户端——
 * 信封构造 / 响应解包 / 错误透传（`HttpRpcResponseError` 携 HTTP 状态与
 * Retry-After）。与 rpc/client.ts（stdio 面）共享 `RpcResponseError` 语义：
 * 应用码（-32001/-32016/...）与传输码（-32006/-32002/...）统一走同一异常
 * 面调用方单一路径 catch。demo 走 capabilities → submit → 轮询 get → cancel。
 *
 * 薄边界：不内置重试 / 超时 / 轮询策略（调用方决策——重试语义依赖调用方
 * 的幂等键持有情况）；`healthz` 是唯一 REST 辅助（匿名 liveness 探测）。
 */

import { randomUUID } from "node:crypto";

import { RpcResponseError } from "../rpc/client.js";
import type { RpcServerInfo } from "../rpc/main.js";
import { RPC_METHOD, type ListReviewParams, type ReviewRequest } from "../rpc/protocol.js";
import type { ReviewJobPage, ReviewJobView } from "../rpc/service.js";

/** JSON-RPC error 响应 + HTTP 传输细节（429/503 的 Retry-After 暴露给重试决策） */
export class HttpRpcResponseError extends RpcResponseError {
  constructor(
    code: number,
    message: string,
    data: unknown,
    /** HTTP 状态码（200+envelope 的应用错误 / 401/403/413/429/503 传输错误） */
    readonly httpStatus: number,
    /** Retry-After 头解析值（秒；429/503 才有） */
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(code, message, data);
    this.name = "HttpRpcResponseError";
  }
}

export interface ReviewHttpClientOptions {
  /** 服务基地址（如 `http://127.0.0.1:8787`——不带路径） */
  readonly baseUrl: string;
  /** Bearer token 值（构造 Authorization 头；不进任何错误消息） */
  readonly token: string;
  /** fetch 注入（测试面；缺省全局 fetch） */
  readonly fetchImpl?: typeof fetch;
}

interface EnvelopeLike {
  readonly jsonrpc?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown; readonly data?: unknown };
}

export class ReviewHttpClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetchImpl: typeof fetch;
  #nextId = 0;

  constructor(options: ReviewHttpClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  /** server.capabilities（POST /rpc 方法面；与 GET /v1/capabilities 同源同构） */
  capabilities(): Promise<RpcServerInfo> {
    return this.#call<RpcServerInfo>(RPC_METHOD.CAPABILITIES, undefined);
  }

  /** review.submit → 202 + envelope result（jobView 初始 queued） */
  submit(request: ReviewRequest): Promise<ReviewJobView> {
    return this.#call<ReviewJobView>(RPC_METHOD.SUBMIT, request);
  }

  reviewGet(jobId: string): Promise<ReviewJobView> {
    return this.#call<ReviewJobView>(RPC_METHOD.GET, { jobId });
  }

  reviewList(params: ListReviewParams = {}): Promise<ReviewJobPage> {
    return this.#call<ReviewJobPage>(RPC_METHOD.LIST, params);
  }

  reviewCancel(jobId: string): Promise<ReviewJobView> {
    return this.#call<ReviewJobView>(RPC_METHOD.CANCEL, { jobId });
  }

  /** GET /healthz（匿名）：进程活着 → true；非 200 / 连接失败 → false */
  async healthz(): Promise<boolean> {
    try {
      const res = await this.#fetchImpl(`${this.#baseUrl}/healthz`);
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async #call<T>(method: string, params: unknown): Promise<T> {
    const requestId = `client-${randomUUID()}`;
    const res = await this.#fetchImpl(`${this.#baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#token}`,
        "X-Request-Id": requestId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.#nextId, method, params }),
    });

    let envelope: EnvelopeLike;
    try {
      envelope = (await res.json()) as EnvelopeLike;
    } catch {
      // 非契约响应（如裸 404）：无信封可解——固定文案，不回显 body（可能非文本）
      throw new Error(`unexpected non-JSON response from ${this.#baseUrl} (HTTP ${res.status})`);
    }
    if (envelope.error !== undefined) {
      const { code, message, data } = envelope.error;
      if (typeof code !== "number" || typeof message !== "string") {
        throw new Error(`malformed error envelope from ${this.#baseUrl} (HTTP ${res.status})`);
      }
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterSeconds =
        res.status === 429 || res.status === 503 ? Number(retryAfterHeader) : undefined;
      throw new HttpRpcResponseError(
        code,
        message,
        data,
        res.status,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
      );
    }
    return envelope.result as T;
  }
}
