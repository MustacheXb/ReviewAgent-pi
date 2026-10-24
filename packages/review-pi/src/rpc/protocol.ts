/**
 * #22 S1 protocol：JSON-RPC 2.0 信封、错误码、参数校验（spec #21 §4/§5、
 * ADR-0012 决策 1——与 HTTP 线共享方法契约，stdio 为其子集）。
 * #27 v2：submit 参数切统一 `ReviewRequest`（ADR-0013 决策 3——三形态共享
 * 单源校验器；diff 判别联合、repoPath 可省、无 v1 旧扁平形 alias，
 * `protocolVersion` 2 即唯一切换信号）。
 *
 * 信封纪律（spec §4）：
 * - 每行恰好一个 JSON-RPC 2.0 文档；batch（数组信封）→ -32600；
 * - parse 失败无 id 可提取 → 响应 id:null（JSON-RPC 2.0 §5.1）；
 * - 不支持通知（无 id 请求）：本方法集全部需要应答，缺 id → -32600；
 * - 未知方法 → -32601（信封有效，属方法层错误，由 dispatch 报）。
 */

import { CONFIGS, type ConfigId } from "../contracts/config.js";

/**
 * 错误码表（HTTP 方案 §4.4 全表为单源 + ADR-0013 决策 9 补 -32018——
 * stdio 侧同步补齐常量，防号码复用；发射面归属见各码注）：
 * - stdio v2 在场发射：-32001 / -32002 / -32004 / -32010 / -32012；
 * - 保留不发射：-32003 / -32005 / -32011（allowlist v2 移除、终态 cancel
 *   幂等、running cancel 可用——决策 9）；
 * - HTTP #28 起发射：-32006..-32009 / -32013..-32018（401/403 在 HTTP 层
 *   返回、不作方法级业务错误发射——决策 9；幂等 / 限流 / 超时 / 产物保留
 *   均属 HTTP 线件）。
 */
export const JSON_RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  JOB_NOT_FOUND: -32001,
  QUEUE_FULL: -32002,
  /** 保留不发射（v2 起 allowlist 随 --repo-root 一并移除） */
  REPO_NOT_ALLOWED: -32003,
  PAYLOAD_TOO_LARGE: -32004,
  /** 保留不发射（终态 cancel 幂等返回 view） */
  CANCEL_NOT_ALLOWED: -32005,
  /** HTTP 层 401（不作方法级业务错误发射——决策 9） */
  UNAUTHORIZED: -32006,
  /** HTTP 层 403（同上） */
  FORBIDDEN: -32007,
  /** 上游网关不可达（HTTP #28） */
  GATEWAY_UNAVAILABLE: -32008,
  /** job 执行失败的错误响应面（HTTP #28；stdio 经 job view error 字段承载） */
  JOB_FAILED: -32009,
  SERVER_DRAINING: -32010,
  /** 保留/过渡期（running cancel 可用时不发射——决策 9） */
  CANCEL_NOT_SUPPORTED: -32011,
  /** repoPath / diff.path 不存在或不可访问（#27 v2） */
  REPO_NOT_FOUND: -32012,
  /** 租户级限流（与 queue_full 区分；HTTP #28） */
  RATE_LIMITED: -32013,
  /** job 执行超时（HTTP #28） */
  JOB_TIMEOUT: -32014,
  /** 重启恢复时 running → failed（HTTP #28） */
  SERVER_RESTART: -32015,
  /** 同 clientRequestId 不同参数（HTTP #28 幂等实装） */
  IDEMPOTENCY_CONFLICT: -32016,
  /** 产物超出保留窗口（HTTP #28） */
  ARTIFACT_EXPIRED: -32017,
  /** 排队超 queueTimeout 自动终态化（§7.2 引用，决策 9 补号；HTTP #28） */
  QUEUE_TIMEOUT: -32018,
} as const;

/** JSON-RPC id：响应必须原样回显请求 id；parse 失败时为 null */
export type JsonRpcId = string | number | null;

/** review job 状态全集（spec §6.1 状态机；list 参数校验与 service 状态机共用单源） */
export const REVIEW_JOB_STATUSES = [
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type ReviewJobStatus = (typeof REVIEW_JOB_STATUSES)[number];

/** 方法名单源（与 HTTP 方案共享契约；stdio 为其子集） */
export const RPC_METHOD = {
  CAPABILITIES: "server.capabilities",
  SUBMIT: "review.submit",
  GET: "review.get",
  LIST: "review.list",
  CANCEL: "review.cancel",
  SHUTDOWN: "shutdown",
} as const;
export type RpcMethodName = (typeof RPC_METHOD)[keyof typeof RPC_METHOD];

/**
 * capabilities `features` 能力声明（#27 v2，ADR-0013 中性后果项——按形态声明
 * 差异，客户端据此降级）。stdio v2：sse/artifactDownload/idempotency=false、
 * listFilters=["status"]、defaultRepo="cwd"、无 submitHttpStatus（无 HTTP 传输
 * 不声明）。HTTP（#28 起，见 server/http-server.ts HTTP_RPC_FEATURES 单源）：
 * idempotency=true、defaultRepo=null、submitHttpStatus=202；sse 与
 * artifactDownload 在 #29（P2b 事件流与产物下载）落地前恒 false——声明 true
 * 会诱导客户端连不存在的路由，listFilters 以实装过滤面为准（当前 ["status"]）。
 */
export interface RpcFeatures {
  readonly sse: boolean;
  readonly artifactDownload: boolean;
  readonly idempotency: boolean;
  readonly listFilters: readonly string[];
  /** 省略 repoPath 时的默认值来源：stdio="cwd"（--cwd / process.cwd()）；HTTP=null（必填显式） */
  readonly defaultRepo: "cwd" | null;
  readonly diffKinds: readonly ("file" | "inline")[];
  /**
   * `review.submit` 成功的 HTTP 状态码（HTTP 面声明 202——202 + Location:
   * /v1/jobs/{jobId}；stdio 等无 HTTP 传输的形态缺席不声明）。缺席省键，
   * 不取 null——「无 HTTP 传输」与「HTTP 但 200」语义有别（后者未来可能出现）。
   */
  readonly submitHttpStatus?: 202;
}

/**
 * 应用层协议错误：service / dispatch 抛出，由输出层映射为 error 响应。
 * data 只放安全细节（jobId/limit/maxDiffBytes 等）——不放路径、key、内部堆栈。
 */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * 统一提交参数模型 `ReviewRequest`（#27 v2，ADR-0013 决策 3——三形态共享）：
 * stdio / HTTP 的 `review.submit` params 直接使用该模型；CLI `review` 旗标在
 * cli/main.ts 投影为该模型——三者过同一校验器。校验器形态无关：repoPath
 * 协议层可选（省略时的默认值属形态面职责——stdio = `--cwd` /
 * `process.cwd()`，CLI = `process.cwd()`，HTTP 必填显式）；路径的存在性 /
 * realpath 校验属 service 层域校验（失败 -32012）。
 */
export interface ReviewRequest {
  /** 幂等键（HTTP #28 实装 (tenantId, clientRequestId) 唯一；stdio v2 接受不承诺） */
  readonly clientRequestId?: string;
  readonly caseId: string;
  /** 扁平字符串，绝对或相对均可（不引入 repoId / repo-registry / repo-root） */
  readonly repoPath?: string;
  readonly diff:
    | { readonly kind: "inline"; readonly text: string }
    | { readonly kind: "file"; readonly path: string };
  readonly issueDescription?: string;
  readonly configId: ConfigId;
  readonly modelId?: string;
  /** 自由元数据（透传留痕，不参与执行语义；幂等对比口径亦不含——ADR-0013 决策 4） */
  readonly metadata?: Record<string, unknown>;
}

/**
 * caseId 约束（spec §5）：非空 ≤256 字符、路径安全字符集——首字符字母数字，
 * 其余 [A-Za-z0-9._-]。S2 起从 caseId 派生审计目录（audit/<caseId>/...），
 * 分隔符/穿越段必须在协议入口拒绝（协议层是收口的最后低成本窗口）。
 */
const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export type ParamValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RpcError };

export interface JobRefParams {
  readonly jobId: string;
}

function invalidParams(message: string): RpcError {
  return new RpcError(JSON_RPC_ERROR.INVALID_PARAMS, message);
}

/** 校验 review.get / review.cancel 参数（同形：jobId 必填非空 string） */
function validateJobRefParams(params: unknown, method: string): ParamValidation<JobRefParams> {
  if (!isRecord(params)) {
    return { ok: false, error: invalidParams(`${method} params must be an object`) };
  }
  const { jobId } = params;
  if (typeof jobId !== "string" || jobId.length === 0) {
    return { ok: false, error: invalidParams("jobId must be a non-empty string") };
  }
  return { ok: true, value: { jobId } };
}

export function validateGetParams(params: unknown): ParamValidation<JobRefParams> {
  return validateJobRefParams(params, "review.get");
}

export function validateCancelParams(params: unknown): ParamValidation<JobRefParams> {
  return validateJobRefParams(params, "review.cancel");
}

export interface ListReviewParams {
  readonly status?: ReviewJobStatus;
}

/** review.list 的 status 合法值守卫（单源 REVIEW_JOB_STATUSES） */
function isReviewJobStatus(value: string): value is ReviewJobStatus {
  return (REVIEW_JOB_STATUSES as readonly string[]).includes(value);
}

/** 校验 review.list 参数：可选 status 过滤（合法状态集内） */
export function validateListParams(params: unknown): ParamValidation<ListReviewParams> {
  if (params === undefined) {
    return { ok: true, value: {} };
  }
  if (!isRecord(params)) {
    return { ok: false, error: invalidParams("review.list params must be an object") };
  }
  const { status } = params;
  if (status === undefined) {
    return { ok: true, value: {} };
  }
  if (typeof status !== "string" || !isReviewJobStatus(status)) {
    return {
      ok: false,
      error: invalidParams(`status must be one of ${REVIEW_JOB_STATUSES.join(", ")}`),
    };
  }
  return { ok: true, value: { status } };
}

/** configId 合法值守卫（A–E；单源 CONFIGS，不另列字母表；hasOwn 防原型链成员混入） */
function isConfigId(value: string): value is ConfigId {
  return Object.hasOwn(CONFIGS, value);
}

/** diff 判别联合校验：inline 非空 text / file 非空 path；其余形态（含 v1 旧扁平形）拒绝 */
function validateDiffParam(
  diff: Record<string, unknown>,
): ParamValidation<ReviewRequest["diff"]> {
  if (diff.kind === "inline") {
    // 空 diff 无检视意义（收紧而非放宽：宿主传空串是装配 bug，应尽早暴露）
    if (typeof diff.text !== "string" || diff.text.length === 0) {
      return { ok: false, error: invalidParams("diff.text must be a non-empty string") };
    }
    return { ok: true, value: { kind: "inline", text: diff.text } };
  }
  if (diff.kind === "file") {
    if (typeof diff.path !== "string" || diff.path.length === 0) {
      return { ok: false, error: invalidParams("diff.path must be a non-empty string") };
    }
    return { ok: true, value: { kind: "file", path: diff.path } };
  }
  // v1 旧扁平形（diff 纯字符串）经外层 isRecord 在此/彼一并拒绝——无 legacy alias
  return {
    ok: false,
    error: invalidParams("diff must be {kind:'inline',text} or {kind:'file',path}"),
  };
}

/**
 * 校验 review.submit 参数（统一 `ReviewRequest` 单源，三形态共享）：
 * 必填 caseId / diff 判别联合 / configId（A–E）；可选 repoPath（在场必须非空）、
 * issueDescription / modelId / clientRequestId / metadata。v1 旧扁平形
 * （diff 纯字符串）无 legacy alias——直接 invalid_params（ADR-0013 决策 3）。
 */
export function validateReviewRequest(params: unknown): ParamValidation<ReviewRequest> {
  if (!isRecord(params)) {
    return { ok: false, error: invalidParams("review.submit params must be an object") };
  }
  const { caseId, repoPath, diff, configId, issueDescription, modelId, clientRequestId, metadata } =
    params;
  if (typeof caseId !== "string" || !CASE_ID_PATTERN.test(caseId)) {
    return {
      ok: false,
      error: invalidParams("caseId must be 1-256 chars, path-safe ([A-Za-z0-9] then [A-Za-z0-9._-])"),
    };
  }
  if (repoPath !== undefined && (typeof repoPath !== "string" || repoPath.length === 0)) {
    return { ok: false, error: invalidParams("repoPath must be a non-empty string when present") };
  }
  if (!isRecord(diff)) {
    return {
      ok: false,
      error: invalidParams("diff must be {kind:'inline',text} or {kind:'file',path}"),
    };
  }
  const diffValidation = validateDiffParam(diff);
  if (!diffValidation.ok) {
    return diffValidation;
  }
  if (typeof configId !== "string" || !isConfigId(configId)) {
    return { ok: false, error: invalidParams("configId must be one of A-E") };
  }
  if (issueDescription !== undefined && typeof issueDescription !== "string") {
    return { ok: false, error: invalidParams("issueDescription must be a string when present") };
  }
  if (modelId !== undefined && typeof modelId !== "string") {
    return { ok: false, error: invalidParams("modelId must be a string when present") };
  }
  if (clientRequestId !== undefined && (typeof clientRequestId !== "string" || clientRequestId.length === 0)) {
    return { ok: false, error: invalidParams("clientRequestId must be a non-empty string when present") };
  }
  if (metadata !== undefined && !isRecord(metadata)) {
    return { ok: false, error: invalidParams("metadata must be an object when present") };
  }
  return {
    ok: true,
    value: {
      caseId,
      diff: diffValidation.value,
      configId,
      ...(repoPath !== undefined ? { repoPath } : {}),
      ...(issueDescription !== undefined ? { issueDescription } : {}),
      ...(modelId !== undefined ? { modelId } : {}),
      ...(clientRequestId !== undefined ? { clientRequestId } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    },
  };
}

export interface ParsedIncomingRequest {
  readonly kind: "request";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: unknown;
}

export interface ParsedIncomingError {
  readonly kind: "error";
  readonly id: JsonRpcId;
  readonly error: { readonly code: number; readonly message: string };
}

export type ParsedIncomingLine = ParsedIncomingRequest | ParsedIncomingError;

/** 出站响应/通知文档形态（serializeJsonLine 单行落 stdout） */
export interface JsonRpcSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export interface JsonRpcEventNotification {
  readonly jsonrpc: "2.0";
  readonly method: "review.event";
  readonly params: unknown;
}

export function successResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

/** error.data 缺席省键（安全细节才带：jobId/limit/maxDiffBytes 类，不放路径/key/堆栈） */
export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/** job 事件通知（spec §4.3：params = {seq, job}，seq 连接级单调） */
export function eventNotification(params: unknown): JsonRpcEventNotification {
  return { jsonrpc: "2.0", method: "review.event", params };
}

/**
 * 解析一行入站文档：合法请求 → request；信封/解析违例 → error（可直接回写）。
 * HTTP 面（#28）经 parseIncomingDocument 复用同一信封纪律（整个 body 一个
 * JSON 文档，无行概念）。
 */
export function parseIncomingLine(line: string): ParsedIncomingLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    // parse 失败无 id 可提取（JSON-RPC 2.0 §5.1：响应 id 必须为 null）
    return {
      kind: "error",
      id: null,
      error: { code: JSON_RPC_ERROR.PARSE_ERROR, message: "Parse error" },
    };
  }
  return parseIncomingDocument(value);
}

/**
 * 校验一个已解析的入站文档（信封纪律单源，#28 起两传输共享）：
 * 合法请求 → request；违例 → error（携带可提取 id 或 null）。
 */
export function parseIncomingDocument(value: unknown): ParsedIncomingLine {
  if (!isRecord(value)) {
    // batch（数组信封，spec §4.4 不支持）与一切非对象形态
    return invalidRequest(null);
  }
  const extractableId = isJsonRpcId(value.id) ? value.id : null;
  if (value.jsonrpc !== "2.0") {
    return invalidRequest(extractableId);
  }
  if (typeof value.method !== "string" || value.method.length === 0) {
    return invalidRequest(extractableId);
  }
  if (!("id" in value)) {
    // 不支持通知：本方法集全部需要应答（spec §4 信封纪律）
    return invalidRequest(null);
  }
  if (!isJsonRpcId(value.id)) {
    return invalidRequest(null);
  }
  if (value.params !== undefined && !isParamsShape(value.params)) {
    // JSON-RPC 规范：params 必须为 object/array（数组放行，由方法层校验）
    return invalidRequest(extractableId);
  }
  return {
    kind: "request",
    id: value.id,
    method: value.method,
    params: value.params,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null;
}

function isParamsShape(value: unknown): boolean {
  return isRecord(value) || Array.isArray(value);
}

function invalidRequest(id: JsonRpcId): ParsedIncomingError {
  return {
    kind: "error",
    id,
    error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: "Invalid Request" },
  };
}
