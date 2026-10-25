/**
 * #28 typed HTTP client（方案 §6）：面向 `POST /rpc` 的 JSON-RPC 客户端——
 * 信封构造 / 响应解包 / 错误透传（`HttpRpcResponseError` 携 HTTP 状态与
 * Retry-After）。与 rpc/client.ts（stdio 面）共享 `RpcResponseError` 语义：
 * 应用码（-32001/-32016/...）与传输码（-32006/-32002/...）统一走同一异常
 * 面调用方单一路径 catch。demo 走 capabilities → submit → 轮询 get → cancel。
 *
 * #29 P2b：`events()` async generator（SSE 订阅——for await 逐事件，断线凭
 * `event.seq` 作 Last-Event-ID 重连）与 `downloadArtifact()`（逻辑引用 →
 * 产物内容）；/rpc 面 job 视图类型切 HTTP 投影（`HttpReviewJobView`——
 * result 携 auditRef/recordRef 逻辑引用，不泄漏服务器路径）。
 *
 * 薄边界：不内置重试 / 超时 / 轮询策略（调用方决策——重试语义依赖调用方
 * 的幂等键持有情况）；`healthz` 是唯一 REST 辅助（匿名 liveness 探测）。
 */

import { randomUUID } from "node:crypto";

import { RpcResponseError } from "../rpc/client.js";
import type { RpcServerInfo } from "../rpc/main.js";
import { RPC_METHOD, type ListReviewParams, type ReviewRequest } from "../rpc/protocol.js";
import type { HttpReviewJobView } from "./http-view.js";

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

/** list 结果页（HTTP 投影视图） */
export interface HttpReviewJobPage {
  readonly jobs: readonly HttpReviewJobView[];
}

/**
 * SSE 事件帧的客户端投影（#29 P2b）：data 载荷扁平形态 + 帧名——
 * `{seq, event, ...HttpReviewJobView}`。`seq` 即重连位（Last-Event-ID）；
 * `event === "error"` 为 failed 转移（视图携 error.message），`"reset"` 为
 * 保留窗兜底（快照重建，seq 跳当前位）。
 */
export type ReviewHttpClientEvent = HttpReviewJobView & {
  readonly seq: number;
  readonly event: "job" | "error" | "reset";
};

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

  /** review.submit → 202 + envelope result（jobView 初始 queued；HTTP 投影视图） */
  submit(request: ReviewRequest): Promise<HttpReviewJobView> {
    return this.#call<HttpReviewJobView>(RPC_METHOD.SUBMIT, request);
  }

  reviewGet(jobId: string): Promise<HttpReviewJobView> {
    return this.#call<HttpReviewJobView>(RPC_METHOD.GET, { jobId });
  }

  reviewList(params: ListReviewParams = {}): Promise<HttpReviewJobPage> {
    return this.#call<HttpReviewJobPage>(RPC_METHOD.LIST, params);
  }

  reviewCancel(jobId: string): Promise<HttpReviewJobView> {
    return this.#call<HttpReviewJobView>(RPC_METHOD.CANCEL, { jobId });
  }

  /**
   * SSE 订阅（#29 P2b）：`GET /v1/jobs/{jobId}/events`。async generator——
   * `for await` 逐事件消费；`break` / `return` / 抛错自动收流（finally 收
   * reader，服务端见 close 递减订阅计数）。`lastEventId` 续传断线位
   * （上次收到的 `event.seq`）；非流响应（401/403/429/503/未知 job 信封）
   * 抛 `HttpRpcResponseError`。
   */
  async *events(
    jobId: string,
    options: { readonly lastEventId?: number; readonly signal?: AbortSignal } = {},
  ): AsyncGenerator<ReviewHttpClientEvent, void, unknown> {
    const res = await this.#fetchImpl(`${this.#baseUrl}/v1/jobs/${encodeURIComponent(jobId)}/events`, {
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "X-Request-Id": `client-${randomUUID()}`,
        ...(options.lastEventId !== undefined ? { "Last-Event-ID": String(options.lastEventId) } : {}),
      },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status !== 200 || !contentType.startsWith("text/event-stream")) {
      // 错误面一律 JSON 信封（含 200 + -32001 未知/异租户 job）
      await this.#raiseErrorEnvelope(res);
      return;
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          return; // 传输层断开（drain closeAll / 慢消费者护栏 / 网络中断）：生成器
          // 正常收尾——断线恢复（Last-Event-ID 重连）是调用方策略面
        }
        const { value, done } = chunk;
        if (done) {
          return; // 服务端正常断开：同上，重连由调用方决策
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const event = parseSseFrame(frame);
          if (event !== undefined) {
            yield event;
          }
        }
      }
    } finally {
      // 消费方提前退出（break/throw）：收流释放连接
      await reader.cancel().catch(() => undefined);
    }
  }

  /**
   * 产物下载（#29 P2b）：`GET /v1/jobs/{jobId}/artifacts/{audit|record}`——
   * result 的 `auditRef`/`recordRef` 逻辑引用对应的内容（UTF-8 文本；
   * audit/record 落盘即 JSON）。错误面统一 `HttpRpcResponseError`：非 200
   * 传输码（403/-32007、404/-32017）与 200 + 错误信封（未知/非终态 job 的
   * -32001）——信封按 `jsonrpc+error` 顶层形态判定，不与真产物混淆。
   */
  async downloadArtifact(jobId: string, kind: "audit" | "record"): Promise<string> {
    const res = await this.#fetchImpl(
      `${this.#baseUrl}/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${kind}`,
      {
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "X-Request-Id": `client-${randomUUID()}`,
        },
      },
    );
    const body = await res.text();
    if (res.status !== 200) {
      this.#raiseErrorBody(res, body);
    }
    // 200 面的错误信封（未知/非终态 job → -32001）
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    const envelope = parsed as EnvelopeLike | undefined;
    if (envelope?.jsonrpc === "2.0" && envelope.error !== undefined) {
      this.#raiseHttpError(res, envelope.error);
    }
    return body;
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
      this.#raiseHttpError(res, envelope.error);
    }
    return envelope.result as T;
  }

  /** 错误信封抛出（#call 与 events / downloadArtifact 共享的异常面） */
  #raiseHttpError(
    res: Response,
    error: NonNullable<EnvelopeLike["error"]>,
  ): never {
    if (typeof error.code !== "number" || typeof error.message !== "string") {
      throw new Error(`malformed error envelope from ${this.#baseUrl} (HTTP ${res.status})`);
    }
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterSeconds =
      res.status === 429 || res.status === 503 ? Number(retryAfterHeader) : undefined;
    throw new HttpRpcResponseError(
      error.code,
      error.message,
      error.data,
      res.status,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    );
  }

  /** REST/SSE 面（非 /rpc）错误响应 → 统一异常（信封缺失/畸形 → 固定文案） */
  async #raiseErrorEnvelope(res: Response): Promise<never> {
    return this.#raiseErrorBody(res, await res.text());
  }

  /** 已读 body 的错误响应 → 统一异常（信封缺失/畸形 → 固定文案，不回显 body） */
  #raiseErrorBody(res: Response, body: string): never {
    let envelope: EnvelopeLike;
    try {
      envelope = JSON.parse(body) as EnvelopeLike;
    } catch {
      throw new Error(`unexpected non-JSON response from ${this.#baseUrl} (HTTP ${res.status})`);
    }
    if (envelope.error === undefined) {
      throw new Error(`unexpected response from ${this.#baseUrl} (HTTP ${res.status})`);
    }
    this.#raiseHttpError(res, envelope.error);
  }
}

/**
 * SSE 帧解析（客户端面）：event + data 双行齐备才产出事件——retry 指示帧与
 * 心跳注释帧跳过（重连/保活是调用方策略面）。畸形 data（seq 非 number）
 * 抛错：契约面破损不该被静默吞掉。
 */
function parseSseFrame(frame: string): ReviewHttpClientEvent | undefined {
  const lines = frame.split("\n");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const dataLine = lines.find((line) => line.startsWith("data: "));
  if (eventLine === undefined || dataLine === undefined) {
    return undefined;
  }
  const eventName = eventLine.slice("event: ".length);
  if (eventName !== "job" && eventName !== "error" && eventName !== "reset") {
    throw new Error(`malformed SSE frame: unknown event name ${eventName}`);
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
  } catch {
    throw new Error("malformed SSE frame: data is not valid JSON");
  }
  if (typeof data.seq !== "number") {
    throw new Error("malformed SSE frame: data.seq is not a number");
  }
  const { seq, ...job } = data;
  return { ...job, event: eventName, seq } as ReviewHttpClientEvent;
}
