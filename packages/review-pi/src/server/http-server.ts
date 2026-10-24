/**
 * #28 HTTP JSON-RPC 核心面（ADR-0013 决策 1/5/9）：`node:http` 适配器——
 * 薄到只做路由、鉴权、scope 执法、错误映射、body 上限、幂等编排。
 * 业务全在 ReviewService（#27 P1 核心），信封纪律复用 rpc/protocol 单源。
 *
 * 端点（方案 §4.1）：
 * - POST /rpc：JSON-RPC 2.0 单请求（batch → -32600）；review.submit 成功
 *   202 + `Location: /v1/jobs/{jobId}`，其余方法 200；
 * - GET /healthz：匿名 liveness；GET /readyz：draining → 503；
 * - GET /v1/capabilities：serverInfo 直出（与 server.capabilities 方法同源）。
 *
 * 错误面两分（方案 §4.1 约定、ADR-0013 决策 1/9）：
 * - 信封/方法/参数级错误 → HTTP 200 + JSON-RPC error envelope（携请求 id）；
 * - 传输/鉴权/限流/draining/body 上限 → 401/403/429/503/413 + `id: null`
 *   envelope——调用方单路径凭状态码预判信封形态，不看 id 有无；429/503
 *   必带 Retry-After（秒）。
 * - service 级 RpcError 按错误码表映射状态（queue_full 429 / draining 503 /
 *   payload_too_large 413 / gateway_unavailable 502 / 其余 200）；映射出的
 *   非 200 状态同走 `id: null`（状态码即「传输面」判据，与来源无关）。
 *
 * 安全面：Bearer 鉴权前置（先于 body 收集——未认证方不耗 32MiB 收集面；
 * 401 缺/坏 token、403 scope 不足）+ Principal 服务端派生（params 自报
 * tenant 无效）；access log 只落白名单字段（requestId / method / path /
 * status / tenantId / durationMs）——Authorization、body、params、错误原文
 * 一律不进日志（key 永不落盘回显，方案 §8.3）；内部异常经 onInternalError
 * 缝落服务端日志（运维可见），协议面仍固定文案。
 *
 * 幂等（ADR-0013 决策 4）：(tenantId, clientRequestId) 唯一——同指纹返回
 * 既有 job（202 + Location 同构）、异指纹 -32016；per-key in-flight 表把
 * 同 key 并发请求排成串行链——后到者等首者落定后走完整 lookup→对比序
 * （并发异参由已落记录的指纹对比判 -32016，不透传首者的结果）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import type { CallContext, Principal, ReviewScope } from "../rpc/context.js";
import type { ReviewService, ReviewJobView } from "../rpc/service.js";
import type { RpcServerInfo } from "../rpc/main.js";
import {
  JSON_RPC_ERROR,
  RPC_METHOD,
  RpcError,
  errorResponse,
  parseIncomingDocument,
  successResponse,
  validateCancelParams,
  validateGetParams,
  validateListParams,
  validateReviewRequest,
  type ReviewRequest,
  type RpcFeatures,
} from "../rpc/protocol.js";
import type { Authenticator } from "./auth.js";
import { fingerprintReviewRequest, idempotencyKey, type IdempotencyKeeper } from "./idempotency.js";

/** spec §4.1：请求 body 上限缺省 32 MiB（与 capabilities limits 同源配置） */
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

/** 429 / 503 的 Retry-After（秒；方案 §4.4 未定值，取保守短窗） */
export const RETRY_AFTER_SECONDS = 5;

/**
 * HTTP 形态的 features 诚实声明（与 STDIO_RPC_FEATURES 对偶，装配层单源）：
 * - `sse:false` / `artifactDownload:false`：P2a（#28）不交付事件流与产物下载
 *   端点，声明 true 会诱导客户端连不存在的路由——#29 落地后翻 true；
 * - `idempotency:true`：幂等面本票交付；
 * - `defaultRepo:null`：HTTP 必填显式 repoPath（ADR-0013 决策 3）。
 */
export const HTTP_RPC_FEATURES: RpcFeatures = {
  sse: false,
  artifactDownload: false,
  idempotency: true,
  listFilters: ["status"],
  defaultRepo: null,
  diffKinds: ["file", "inline"],
  submitHttpStatus: 202,
};

export interface HttpReviewServerLimits {
  readonly maxBodyBytes: number;
}

export interface HttpReviewServerOptions {
  readonly service: ReviewService;
  readonly authenticator: Authenticator;
  readonly idempotency: IdempotencyKeeper;
  /** capabilities 单源（HTTP features / limits 由装配层构造——main.ts） */
  readonly serverInfo: RpcServerInfo;
  readonly limits?: Partial<HttpReviewServerLimits>;
  /** access log 缝（缺省 no-op；装配层接 stderr——白名单字段，见 AccessLogEvent） */
  readonly onAccessLog?: (event: AccessLogEvent) => void;
  /** 内部异常（非 RpcError）日志缝（缺省 no-op；装配层接 stderr——500 面对运维可见） */
  readonly onInternalError?: (event: InternalErrorLogEvent) => void;
}

/** access log 白名单事件（Authorization/body/params 绝不进——redaction 的结构性实现） */
export interface AccessLogEvent {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly tenantId?: string;
  readonly durationMs: number;
}

/**
 * 内部异常日志事件：协议面固定 "Internal error"（异常原文可能带路径/key/堆栈，
 * spec §9 不进响应），但长驻服务对运维必须可见——name/message 落此缝，由
 * 装配层决定去处（stderr JSON 行）。errorName/errorMessage 之外不携带。
 */
export interface InternalErrorLogEvent {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly errorName: string;
  readonly errorMessage: string;
}

/** 方法 → 所需 scope（scope 执法属传输面——rpc/context.ts 模块注） */
const METHOD_SCOPES: ReadonlyMap<string, ReviewScope> = new Map([
  [RPC_METHOD.SUBMIT, "review:submit"],
  [RPC_METHOD.GET, "review:read"],
  [RPC_METHOD.LIST, "review:read"],
  [RPC_METHOD.CANCEL, "review:cancel"],
  // server.capabilities：认证即可（发现面，任意 scope 持有者都需读）
]);

/**
 * service 级 RpcError → HTTP 状态映射（方案 §4.4 错误码表的「HTTP 配套」列）。
 * 未列出的应用码（job_not_found / invalid_params / idempotency_conflict 等）
 * 一律 200 + envelope——业务错误不是传输错误。
 */
function rpcErrorStatus(code: number): { readonly status: number; readonly retryAfter?: number } {
  switch (code) {
    case JSON_RPC_ERROR.QUEUE_FULL:
    case JSON_RPC_ERROR.RATE_LIMITED:
      return { status: 429, retryAfter: RETRY_AFTER_SECONDS };
    case JSON_RPC_ERROR.SERVER_DRAINING:
      return { status: 503, retryAfter: RETRY_AFTER_SECONDS };
    case JSON_RPC_ERROR.PAYLOAD_TOO_LARGE:
      return { status: 413 };
    case JSON_RPC_ERROR.GATEWAY_UNAVAILABLE:
      return { status: 502 };
    default:
      return { status: 200 };
  }
}

/** 创建未 listen 的 node:http Server（listen/close 生命周期归装配层） */
export function createReviewHttpServer(options: HttpReviewServerOptions): Server {
  const { service, authenticator, idempotency, serverInfo } = options;
  const maxBodyBytes = options.limits?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const onAccessLog = options.onAccessLog ?? (() => undefined);
  const onInternalError = options.onInternalError ?? (() => undefined);
  /** per-(tenant, clientRequestId) in-flight：并发重试共享同一次 submit */
  const submitInFlight = new Map<string, Promise<ReviewJobView>>();

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    const startedAt = Date.now();
    const requestId = resolveRequestId(req.headers["x-request-id"]);
    let tenantId: string | undefined;

    const finishLog = (status: number): void => {
      onAccessLog({
        requestId,
        method: req.method ?? "",
        path: req.url ?? "",
        status,
        // 401 面无租户可记（token 不可信）；其余记录鉴权后的 tenantId
        ...(tenantId !== undefined ? { tenantId } : {}),
        durationMs: Date.now() - startedAt,
      });
    };

    res.setHeader("X-Request-Id", requestId);
    res.on("finish", () => finishLog(res.statusCode));

    if (req.method === "GET" && req.url === "/healthz") {
      // 匿名 liveness：只证明进程在（draining 期间也活着——readyz 才反映 drain）
      writeJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "GET" && req.url === "/readyz") {
      runGuarded(requestId, req, res, () =>
        handleAuthedEndpoint(req, res, requestId, async (principal) => {
          tenantId = principal.tenantId;
          if (service.isDraining()) {
            writeEnvelopeError(res, 503, JSON_RPC_ERROR.SERVER_DRAINING, "server is draining", undefined, {
              retryAfter: RETRY_AFTER_SECONDS,
            });
            return;
          }
          writeJson(res, 200, { status: "ready" });
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/v1/capabilities") {
      runGuarded(requestId, req, res, () =>
        handleAuthedEndpoint(req, res, requestId, async (principal) => {
          tenantId = principal.tenantId;
          writeJson(res, 200, serverInfo);
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/rpc") {
      runGuarded(requestId, req, res, () =>
        handleRpc(req, res, requestId, (principal) => {
          tenantId = principal.tenantId;
        }),
      );
      return;
    }
    // 非契约面（方法/路径不匹配）：裸 404——不在 JSON-RPC 错误面内，无 id 可携
    writeJson(res, 404, { error: "not found" });
  };

  return createServer(requestHandler);

  // ---- 鉴权包装：401 envelope（WWW-Authenticate 按 RFC 6750）----

  /**
   * 传输层兜底：handler 未预期上抛（鉴权器异常、连接中断读失败等）不留
   * unhandled rejection——Node 默认行为是杀进程，长驻服务不允许；留痕 +
   * 500 面收尾（信封 id:null，与非 200 传输面原则一致）。
   */
  function runGuarded(
    requestId: string,
    req: IncomingMessage,
    res: ServerResponse,
    run: () => Promise<void>,
  ): void {
    run().catch((error: unknown) => {
      logInternalError(requestId, req, error);
      if (!res.headersSent) {
        writeEnvelopeError(res, 500, JSON_RPC_ERROR.INTERNAL_ERROR, "Internal error");
      } else {
        res.destroy(); // 响应已开写不可换面：断连收尾（客户端按传输失败重试）
      }
    });
  }

  async function handleAuthedEndpoint(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    handler: (principal: Principal) => Promise<void>,
  ): Promise<void> {
    const principal = await authenticator.authenticate(authorizationHeader(req));
    if (principal === undefined) {
      req.resume(); // 未消费的请求体排空（连接复用纪律）
      res.setHeader("WWW-Authenticate", 'Bearer realm="reviewagent"');
      writeEnvelopeError(res, 401, JSON_RPC_ERROR.UNAUTHORIZED, "missing or invalid bearer token");
      return;
    }
    try {
      await handler(principal);
    } catch (error) {
      logInternalError(requestId, req, error);
      writeEnvelopeError(res, 200, JSON_RPC_ERROR.INTERNAL_ERROR, "Internal error");
    }
  }

  // ---- POST /rpc 主流程 ----

  async function handleRpc(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    onPrincipal: (principal: Principal) => void,
  ): Promise<void> {
    // body 上限门一：Content-Length 预检（零 IO 拒收——先于鉴权与收集，未认证
    // 方声明超大也不耗收集面）；门二（累计实测，分块/虚报兜底）在 readBody 内
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      writeEnvelopeError(res, 413, JSON_RPC_ERROR.PAYLOAD_TOO_LARGE, "request body exceeds maxBodyBytes", {
        maxBodyBytes,
      });
      req.resume(); // 排空丢弃（不存储）：响应先落地再收尾，拒收不杀连接
      return;
    }

    // 鉴权前置（先于 body 收集）：未认证方不耗 32MiB 收集面；401 排空即返
    const principal = await authenticator.authenticate(authorizationHeader(req));
    if (principal === undefined) {
      req.resume(); // 未消费的请求体排空（连接复用纪律）
      res.setHeader("WWW-Authenticate", 'Bearer realm="reviewagent"');
      writeEnvelopeError(res, 401, JSON_RPC_ERROR.UNAUTHORIZED, "missing or invalid bearer token");
      return;
    }
    onPrincipal(principal);

    const body = await readBody(req, maxBodyBytes);
    if (body === undefined) {
      writeEnvelopeError(res, 413, JSON_RPC_ERROR.PAYLOAD_TOO_LARGE, "request body exceeds maxBodyBytes", {
        maxBodyBytes,
      });
      return;
    }

    // 信封解析（与 stdio 同源纪律：parse/信封错误 → 200 + error envelope）
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(body);
    } catch {
      writeJson(res, 200, errorResponse(null, JSON_RPC_ERROR.PARSE_ERROR, "Parse error"));
      return;
    }
    const parsed = parseIncomingDocument(parsedValue);
    if (parsed.kind === "error") {
      writeJson(res, 200, errorResponse(parsed.id, parsed.error.code, parsed.error.message));
      return;
    }

    // scope 执法（传输面职责）：未知方法不经 scope 直接 -32601
    const requiredScope = METHOD_SCOPES.get(parsed.method);
    if (requiredScope !== undefined && !principal.scopes.includes(requiredScope)) {
      writeEnvelopeError(res, 403, JSON_RPC_ERROR.FORBIDDEN, `token lacks required scope: ${requiredScope}`);
      return;
    }

    const ctx: CallContext = { principal, requestId };
    try {
      await dispatchRpc(res, parsed.id, parsed.method, parsed.params, ctx);
    } catch (error) {
      if (error instanceof RpcError) {
        const { status, retryAfter } = rpcErrorStatus(error.code);
        // 非 200 状态 = 传输面（AC / ADR-0013 决策 1：401/403/413/429/503 的
        // 响应体 id 恒 null）：调用方凭状态码即可预判信封形态，与错误来源
        // （HTTP 层直发 / service 级码映射）无关；200 的应用码回显请求 id
        writeJson(
          res,
          status,
          errorResponse(status === 200 ? parsed.id : null, error.code, error.message, error.data),
          ...(retryAfter !== undefined ? [{ "Retry-After": String(retryAfter) }] : []),
        );
        return;
      }
      // 内部异常：固定文案（异常原文可能携带路径/key/堆栈——绝不进协议面，spec
      // §9）；服务端日志缝留痕（长驻服务的 500 面对运维可见）
      logInternalError(requestId, req, error);
      writeJson(res, 200, errorResponse(parsed.id, JSON_RPC_ERROR.INTERNAL_ERROR, "Internal error"));
    }
  }

  async function dispatchRpc(
    res: ServerResponse,
    id: string | number | null,
    method: string,
    params: unknown,
    ctx: CallContext,
  ): Promise<void> {
    switch (method) {
      case RPC_METHOD.CAPABILITIES: {
        writeJson(res, 200, successResponse(id, serverInfo));
        return;
      }
      case RPC_METHOD.SUBMIT: {
        const validation = validateReviewRequest(params);
        if (!validation.ok) {
          writeJson(res, 200, errorResponse(id, validation.error.code, validation.error.message, validation.error.data));
          return;
        }
        // HTTP 特化（ADR-0013 决策 3）：repoPath 必填显式——无 cwd 缺省链
        if (validation.value.repoPath === undefined) {
          writeJson(
            res,
            200,
            errorResponse(id, JSON_RPC_ERROR.INVALID_PARAMS, "repoPath is required over HTTP (no cwd default)"),
          );
          return;
        }
        const view = await submitWithIdempotency(validation.value, ctx);
        // submit 成功语义统一 202 + Location（幂等命中返回既有 job，同构）
        res.setHeader("Location", `/v1/jobs/${encodeURIComponent(view.jobId)}`);
        writeJson(res, 202, successResponse(id, view));
        return;
      }
      case RPC_METHOD.GET: {
        const validation = validateGetParams(params);
        if (!validation.ok) {
          writeJson(res, 200, errorResponse(id, validation.error.code, validation.error.message, validation.error.data));
          return;
        }
        const view = await service.get(validation.value.jobId, ctx);
        if (view === undefined) {
          writeJson(
            res,
            200,
            errorResponse(id, JSON_RPC_ERROR.JOB_NOT_FOUND, `Unknown job: ${validation.value.jobId}`, {
              jobId: validation.value.jobId,
            }),
          );
          return;
        }
        writeJson(res, 200, successResponse(id, view));
        return;
      }
      case RPC_METHOD.LIST: {
        const validation = validateListParams(params);
        if (!validation.ok) {
          writeJson(res, 200, errorResponse(id, validation.error.code, validation.error.message, validation.error.data));
          return;
        }
        writeJson(res, 200, successResponse(id, await service.list(validation.value, ctx)));
        return;
      }
      case RPC_METHOD.CANCEL: {
        const validation = validateCancelParams(params);
        if (!validation.ok) {
          writeJson(res, 200, errorResponse(id, validation.error.code, validation.error.message, validation.error.data));
          return;
        }
        writeJson(res, 200, successResponse(id, await service.cancel(validation.value.jobId, ctx)));
        return;
      }
      default: {
        // shutdown 等 stdio 面方法不在 HTTP 方法表（进程生命周期归运维信号面）
        writeJson(res, 200, errorResponse(id, JSON_RPC_ERROR.METHOD_NOT_FOUND, `Method not found: ${method}`));
      }
    }
  }

  /** 内部异常日志（name/message 之外不携带——redaction 的结构性实现，见 InternalErrorLogEvent） */
  function logInternalError(requestId: string, req: IncomingMessage, error: unknown): void {
    onInternalError({
      requestId,
      method: req.method ?? "",
      path: req.url ?? "",
      errorName: error instanceof Error ? error.name : "non-error throw",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * 幂等编排：无 clientRequestId 直通；有则 per-key 串行链——后到者等前序
   * 落定后走完整 lookup→对比序（并发异参由已落记录的指纹对比判 -32016，
   * 不透传前序的结果——那是前序调用方的 job）。
   */
  function submitWithIdempotency(request: ReviewRequest, ctx: CallContext): Promise<ReviewJobView> {
    const clientRequestId = request.clientRequestId;
    if (clientRequestId === undefined) {
      return service.submit(request, ctx);
    }
    const key = idempotencyKey(ctx.principal.tenantId, clientRequestId);
    const prior = submitInFlight.get(key);
    // 排队等前序落定（成败都等：前序失败无记录，本请求走全新 submit）；
    // 吞前序错误——它已回给它的调用方，与本请求的判定无关
    const execution: Promise<ReviewJobView> = (prior ?? Promise.resolve())
      .catch((): undefined => undefined)
      .then(() => executeSubmit(request, ctx, clientRequestId))
      .finally(() => {
        // 只有链尾才清表（后来者已改写表项——它们 await 的是本 promise）
        if (submitInFlight.get(key) === execution) {
          submitInFlight.delete(key);
        }
      });
    submitInFlight.set(key, execution);
    return execution;
  }

  async function executeSubmit(
    request: ReviewRequest,
    ctx: CallContext,
    clientRequestId: string,
  ): Promise<ReviewJobView> {
    let fingerprint = await fingerprintReviewRequest(request);
    const existing = idempotency.lookup(ctx.principal.tenantId, clientRequestId);
    if (existing !== undefined && fingerprint === existing.fingerprint) {
      const view = await service.get(existing.jobId, ctx);
      if (view !== undefined) {
        return view; // 幂等命中：返回既有 job（网络重试不产生重复检视）
      }
      // job 已消失（未来保留窗口清理面）：fallthrough 重新 submit 并覆盖记录
    } else if (existing !== undefined && fingerprint !== undefined) {
      throw new RpcError(
        JSON_RPC_ERROR.IDEMPOTENCY_CONFLICT,
        "clientRequestId already used with different parameters",
        { clientRequestId },
      );
    }
    // 指纹 undefined（diff file 读不出）或记录过期：直通 submit——必败请求由
    // service 的 -32012 域校验收口，不在此造占位指纹
    const view = await service.submit(request, ctx);
    fingerprint ??= await fingerprintReviewRequest(request);
    if (fingerprint !== undefined) {
      idempotency.record(ctx.principal.tenantId, clientRequestId, fingerprint, view.jobId);
    }
    return view;
  }
}

// ---- 小件 ----

/** body 收集（上限门）；超限 → undefined（调用方回 413） */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function authorizationHeader(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  return Array.isArray(value) ? value[0] : value;
}

/** X-Request-Id：调用方可带（合法形态回显），缺失生成（方案 §8.4） */
function resolveRequestId(header: unknown): string {
  if (typeof header === "string" && header.length > 0 && header.length <= 128) {
    return header;
  }
  return `req-${randomUUID()}`;
}

function writeJson(
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
function writeEnvelopeError(
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
