/**
 * #29 P2b：HTTP 传输件共享小件——JSON 写出（自 http-server.ts 迁出，SSE /
 * artifact 端点复用同一信封纪律）、SSE 帧序列化、`/v1/jobs/*` 路径解析。
 * 纯函数 / 纯同步：无 IO、无状态——单测即全测。
 */

import type { ServerResponse } from "node:http";

import { errorResponse } from "../rpc/protocol.js";

/** 429 / 503 的 Retry-After（秒；方案 §4.4 未定值，取保守短窗）——传输件共享单源 */
export const RETRY_AFTER_SECONDS = 5;

/** JSON 写出（Content-Type: application/json；extraHeaders 先置后写不冲突） */
export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (extraHeaders !== undefined) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      res.setHeader(name, value);
    }
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** HTTP 层错误信封（id:null——错误发生在 id 可提取之前；429/503 附 Retry-After） */
export function writeEnvelopeError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  data?: unknown,
  extras?: { readonly retryAfter?: number },
): void {
  writeJson(
    res,
    status,
    errorResponse(null, code, message, data),
    ...(extras?.retryAfter !== undefined ? [{ "Retry-After": String(extras.retryAfter) }] : []),
  );
}

/**
 * SSE data 帧序列化（W3C event-stream 格式）：`event` / `id` / `data` 三行 +
 * 空行终结。id 携 per-job seq——浏览器 EventSource 断线自动回发
 * `Last-Event-ID` 头，服务端据此重放（server/sse.ts）。
 */
export function sseDataFrame(event: string, id: number | string, data: unknown): string {
  return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** SSE 首帧：重连间隔指示（毫秒；方案 §4.3 retry: 5000） */
export const SSE_RETRY_FRAME = "retry: 5000\n\n";

/** SSE 心跳注释帧（20s 静默保活——防中间层空闲超时；注释帧不进客户端事件面） */
export const SSE_HEARTBEAT_FRAME = ": heartbeat\n\n";

/** `/v1/jobs/*` 子路由解析结果 */
export type JobsSubPath =
  | { readonly kind: "events"; readonly jobId: string }
  | { readonly kind: "artifact"; readonly jobId: string; readonly artifact: "audit" | "record" };

/**
 * 解析 `/v1/jobs/{jobId}/events` 与 `/v1/jobs/{jobId}/artifacts/{audit|record}`。
 * jobId 段 URL 解码（Location 头 encodeURIComponent 对偶）；query 串剥离
 * （SSE 重连方可能携带任意查询参数，不参与路由）。不匹配 → undefined。
 */
export function parseJobsPath(url: string): JobsSubPath | undefined {
  const path = url.split("?", 1)[0]!;
  const prefix = "/v1/jobs/";
  if (!path.startsWith(prefix)) {
    return undefined;
  }
  const segments = path
    .slice(prefix.length)
    .split("/")
    .map((segment) => decodeURIComponent(segment));
  const jobId = segments[0];
  if (jobId === undefined || jobId.length === 0) {
    return undefined;
  }
  if (segments.length === 2 && segments[1] === "events") {
    return { kind: "events", jobId };
  }
  if (
    segments.length === 3 &&
    segments[1] === "artifacts" &&
    (segments[2] === "audit" || segments[2] === "record")
  ) {
    return { kind: "artifact", jobId, artifact: segments[2] };
  }
  return undefined;
}
