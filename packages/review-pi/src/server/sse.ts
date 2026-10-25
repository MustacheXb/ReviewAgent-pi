/**
 * #29 P2b：SSE 事件流端点 `GET /v1/jobs/{jobId}/events`（ADR-0013 决策 7）。
 *
 * 语义（方案 §4.3 + ADR-0013 决策 7）：
 * - `text/event-stream`；首帧 `retry: 5000`（断线 5s 重连指示）；
 * - 帧 = `event: job|error|reset` + `id: <per-job seq>` + `data: {seq, ...job 视图}`
 *   （HTTP 投影——result 路径换 artifact 逻辑引用，见 http-view.ts）；
 * - 重连携 `Last-Event-ID: <seq>` → service.readEvents 连续补发；保留窗覆盖
 *   不到 → `reset` 帧携最新快照（客户端以快照重建状态，seq 跳到当前位）；
 * - 心跳：静默 20s 发 `: heartbeat` 注释帧（不进客户端事件面，防中间层空闲断连）；
 * - 订阅上限：8/job、32/租户——超限 429 + Retry-After（-32013）；
 * - 慢消费者：写队列积压超 1 MiB 即断开（客户端凭 Last-Event-ID 重连或转
 *   review.get 轮询恢复——决策 7）；
 * - drain：closeAll() 断开全部连接（main.ts 在 server.close 前调——open
 *   stream 会卡死 close），重连方收 503 + Retry-After。
 *
 * 错误面：未知/异租户 job → 200 + envelope -32001（越权统一 not found，与
 * /rpc 同口径）；订阅超限 → 429 + -32013；draining → 503 + -32010。
 * scope 执法（review:read）与鉴权在 http-server 路由层（传输面单点）。
 *
 * 重放/live 不重不漏：先 subscribe 再 readEvents（readEvents 方法体零 await，
 * 两步之间无发射窗口）；重放落定前到达的 live 事件入缓冲，头部写出后按序
 * 补投（seq 去重护栏兜底交错）。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { CallContext, Principal } from "../rpc/context.js";
import { JSON_RPC_ERROR } from "../rpc/protocol.js";
import type { ReviewJobEvent, ReviewJobListener, ReviewService } from "../rpc/service.js";
import { toHttpJobView } from "./http-view.js";
import {
  RETRY_AFTER_SECONDS,
  SSE_HEARTBEAT_FRAME,
  SSE_RETRY_FRAME,
  sseDataFrame,
  writeEnvelopeError,
} from "./http-wire.js";

/** spec §4.3：心跳间隔缺省 20s（静默保活） */
export const DEFAULT_HEARTBEAT_MS = 20_000;
/** 决策 7：订阅上限缺省——8/job、32/租户 */
export const DEFAULT_MAX_SUBSCRIPTIONS_PER_JOB = 8;
export const DEFAULT_MAX_SUBSCRIPTIONS_PER_TENANT = 32;
/** 慢消费者写队列积压上限缺省 1 MiB（超出即断开——恢复走重连/get 轮询） */
export const DEFAULT_MAX_BACKLOG_BYTES = 1024 * 1024;

export interface SseLimits {
  readonly maxSubscriptionsPerJob: number;
  readonly maxSubscriptionsPerTenant: number;
  readonly heartbeatMs: number;
  readonly maxBacklogBytes: number;
}

export interface SseEndpointOptions {
  readonly service: ReviewService;
  readonly limits?: Partial<SseLimits>;
}

export interface SseEndpoint {
  /** 处理一条已鉴权/已过 scope 执法的 events 订阅请求（同步入口，重放走微任务） */
  handleEvents(
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    requestId: string,
    jobId: string,
  ): void;
  /** 断开全部订阅（drain 收口：先于 server.close——open stream 会卡死 close） */
  closeAll(): void;
  /** 活跃订阅数（观测/测试面） */
  readonly activeSubscriptions: number;
}

/** SSE 响应头（无缓冲直达客户端——X-Accel-Buffering 防反代攒帧） */
const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
};

/** `Last-Event-ID` 头解析：非负整数；缺失/畸形视为 0（fresh 连接，全量重放） */
function parseLastEventId(header: unknown): number {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** 事件 → 帧名：failed 转移走 error 帧（其余状态转移一律 job 帧） */
function frameEventName(event: ReviewJobEvent): "job" | "error" {
  return event.job.status === "failed" ? "error" : "job";
}

/** data 载荷扁平形态（方案 §4.3）：{seq, ...HTTP job 视图} */
function sseData(event: ReviewJobEvent): unknown {
  return { seq: event.seq, ...toHttpJobView(event.job) };
}

export function createSseEndpoint(options: SseEndpointOptions): SseEndpoint {
  const { service } = options;
  const limits: SseLimits = {
    maxSubscriptionsPerJob:
      options.limits?.maxSubscriptionsPerJob ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_JOB,
    maxSubscriptionsPerTenant:
      options.limits?.maxSubscriptionsPerTenant ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_TENANT,
    heartbeatMs: options.limits?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    maxBacklogBytes: options.limits?.maxBacklogBytes ?? DEFAULT_MAX_BACKLOG_BYTES,
  };

  interface Subscription {
    readonly jobId: string;
    readonly tenantId: string;
    /** 幂等收尾：注销 + 停心跳 + 摘登记 + 计数递减（close 与 terminate 双触发安全） */
    readonly teardown: () => void;
    /** teardown + 断开连接（closeAll / 慢消费者断开用） */
    readonly terminate: () => void;
  }
  const subscriptions = new Set<Subscription>();
  const perJobCounts = new Map<string, number>();
  const perTenantCounts = new Map<string, number>();

  const incrementCount = (counts: Map<string, number>, key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const decrementCount = (counts: Map<string, number>, key: string): void => {
    const current = counts.get(key);
    if (current === undefined) {
      return;
    }
    if (current <= 1) {
      counts.delete(key);
    } else {
      counts.set(key, current - 1);
    }
  };

  const handleEvents = (
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    requestId: string,
    jobId: string,
  ): void => {
    // drain 期新订阅直接 503（open stream 会卡死 server.close——先拒绝比挂死好）
    if (service.isDraining()) {
      writeEnvelopeError(res, 503, JSON_RPC_ERROR.SERVER_DRAINING, "server is draining", undefined, {
        retryAfter: RETRY_AFTER_SECONDS,
      });
      return;
    }
    // 订阅上限（决策 7）：超限 429——job/tenant 维在 message 报因；data 只留
    // 决策 9 白名单键（limit = 上限数值，与 QUEUE_FULL 同形）
    if ((perJobCounts.get(jobId) ?? 0) >= limits.maxSubscriptionsPerJob) {
      writeEnvelopeError(
        res,
        429,
        JSON_RPC_ERROR.RATE_LIMITED,
        "subscription limit reached for job",
        { limit: limits.maxSubscriptionsPerJob },
        { retryAfter: RETRY_AFTER_SECONDS },
      );
      return;
    }
    if ((perTenantCounts.get(principal.tenantId) ?? 0) >= limits.maxSubscriptionsPerTenant) {
      writeEnvelopeError(
        res,
        429,
        JSON_RPC_ERROR.RATE_LIMITED,
        "subscription limit reached for tenant",
        { limit: limits.maxSubscriptionsPerTenant },
        { retryAfter: RETRY_AFTER_SECONDS },
      );
      return;
    }

    const ctx: CallContext = { principal, requestId };
    const afterSeq = parseLastEventId(req.headers["last-event-id"]);
    let lastDeliveredSeq = afterSeq;
    /** SSE 头部尚未写出（重放微任务未落定）：live 事件入缓冲，防止 res.write
     * 抢先隐式发头（默认 200 无 Content-Type，后续 writeHead 会 ERR_HTTP_HEADERS_SENT） */
    let headersWritten = false;
    const pendingLive: ReviewJobEvent[] = [];
    let tornDown = false;
    let unsubscribe: () => void = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const subscription: Subscription = {
      jobId,
      tenantId: principal.tenantId,
      teardown: (): void => {
        if (tornDown) {
          return;
        }
        tornDown = true;
        unsubscribe();
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
        }
        subscriptions.delete(subscription);
        decrementCount(perJobCounts, jobId);
        decrementCount(perTenantCounts, principal.tenantId);
      },
      terminate: (): void => {
        subscription.teardown();
        res.destroy();
      },
    };
    subscriptions.add(subscription);
    incrementCount(perJobCounts, jobId);
    incrementCount(perTenantCounts, principal.tenantId);

    /** 写帧 + 慢消费者护栏（积压超上限即断开——决策 7） */
    const writeFrame = (frame: string): void => {
      if (tornDown) {
        return;
      }
      res.write(frame);
      if (res.writableLength > limits.maxBacklogBytes) {
        subscription.terminate();
      }
    };

    /** 投递一条事件（seq 去重护栏：≤ 已投递位的不重发——重放/缓冲交错兜底） */
    const deliver = (event: ReviewJobEvent): void => {
      if (event.seq <= lastDeliveredSeq) {
        return;
      }
      lastDeliveredSeq = event.seq;
      writeFrame(sseDataFrame(frameEventName(event), event.seq, sseData(event)));
    };

    const listener: ReviewJobListener = (event) => {
      if (headersWritten) {
        deliver(event);
      } else {
        pendingLive.push(event);
      }
    };
    unsubscribe = service.subscribe(listener, ctx);

    res.on("close", () => subscription.teardown());
    res.on("error", () => subscription.teardown());

    // 先订阅后读取（readEvents 方法体零 await——两步间无发射窗口）
    void service.readEvents(jobId, afterSeq, ctx).then((replay) => {
      if (replay === undefined) {
        // 未知/异租户 job：头部未写，仍可回 JSON 错误信封（200 + -32001）
        subscription.teardown();
        writeEnvelopeError(res, 200, JSON_RPC_ERROR.JOB_NOT_FOUND, `Unknown job: ${jobId}`, {
          jobId,
        });
        return;
      }
      res.writeHead(200, SSE_HEADERS);
      res.write(SSE_RETRY_FRAME);
      headersWritten = true;
      if (replay.kind === "gap") {
        // reset：重放不可能——最新快照重建状态，seq 盖当前位（续用该 id 重连）
        lastDeliveredSeq = replay.snapshot.seq;
        writeFrame(
          sseDataFrame("reset", replay.snapshot.seq, {
            seq: replay.snapshot.seq,
            ...toHttpJobView(replay.snapshot.job),
          }),
        );
      } else {
        for (const event of replay.events) {
          deliver(event);
        }
      }
      // 缓冲期 live 事件按序补投（seq 恒大于重放集——readEvents 过滤快照之后才发射）
      for (const event of pendingLive.splice(0)) {
        deliver(event);
      }
      // 心跳随头部启停（错误响应连接无心跳面）
      heartbeat = setInterval(() => writeFrame(SSE_HEARTBEAT_FRAME), limits.heartbeatMs);
      heartbeat.unref(); // 进程退出不被空闲心跳拖住（closeAll/close 面另有收口）
    });

    req.resume(); // GET 无 body；排空防御（连接复用纪律）
  };

  return {
    handleEvents,
    closeAll: (): void => {
      for (const subscription of [...subscriptions]) {
        subscription.terminate();
      }
    },
    get activeSubscriptions(): number {
      return subscriptions.size;
    },
  };
}
