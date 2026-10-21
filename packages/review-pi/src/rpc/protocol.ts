/**
 * #22 S1 protocol：JSON-RPC 2.0 信封、错误码、参数校验（spec #21 §4/§5、
 * ADR-0012 决策 1——与 HTTP 线共享方法契约，stdio v1 为其子集）。
 *
 * 信封纪律（spec §4）：
 * - 每行恰好一个 JSON-RPC 2.0 文档；batch（数组信封）→ -32600；
 * - parse 失败无 id 可提取 → 响应 id:null（JSON-RPC 2.0 §5.1）；
 * - 不支持通知（无 id 请求）：本方法集全部需要应答，缺 id → -32600；
 * - 未知方法 → -32601（信封有效，属方法层错误，由 dispatch 报）。
 */

import { CONFIGS, type ConfigId } from "../contracts/config.js";

/** 错误码表（spec §4.4）；-32005 为保留码：v1 不发射（终态 cancel 幂等返回 view） */
export const JSON_RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  JOB_NOT_FOUND: -32001,
  QUEUE_FULL: -32002,
  REPO_NOT_ALLOWED: -32003,
  PAYLOAD_TOO_LARGE: -32004,
  CANCEL_NOT_ALLOWED: -32005,
  SERVER_DRAINING: -32010,
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

/** 方法名单源（与 HTTP 方案共享契约；stdio v1 为其子集） */
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

/** review.submit 合法参数形态（spec §5；repoPath allowlist 与 diff/repoPath 大小上限属 service 层域校验） */
export interface SubmitReviewParams {
  readonly caseId: string;
  readonly repoPath: string;
  readonly diff: string;
  readonly issueDescription?: string;
  readonly configId: ConfigId;
  readonly modelId?: string;
}

/**
 * caseId 约束（spec §5）：非空 ≤256 字符、路径安全字符集——首字符字母数字，
 * 其余 [A-Za-z0-9._-]。S2 将从 caseId 派生审计目录（audit/<caseId>/...），
 * 分隔符/穿越段必须在协议入口拒绝（S1 是收口的最后低成本窗口）。
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

/** 校验 review.submit 参数：必填 caseId/repoPath/diff/configId（A–E）；可选 issueDescription/modelId */
export function validateSubmitParams(params: unknown): ParamValidation<SubmitReviewParams> {
  if (!isRecord(params)) {
    return { ok: false, error: invalidParams("review.submit params must be an object") };
  }
  const { caseId, repoPath, diff, configId, issueDescription, modelId } = params;
  if (typeof caseId !== "string" || !CASE_ID_PATTERN.test(caseId)) {
    return {
      ok: false,
      error: invalidParams("caseId must be 1-256 chars, path-safe ([A-Za-z0-9] then [A-Za-z0-9._-])"),
    };
  }
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    return { ok: false, error: invalidParams("repoPath must be a non-empty string") };
  }
  if (typeof diff !== "string" || diff.length === 0) {
    // 空 diff 无检视意义（收紧而非放宽：宿主传空串是装配 bug，应尽早暴露）
    return { ok: false, error: invalidParams("diff must be a non-empty string") };
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
  return {
    ok: true,
    value: {
      caseId,
      repoPath,
      diff,
      configId,
      ...(issueDescription !== undefined ? { issueDescription } : {}),
      ...(modelId !== undefined ? { modelId } : {}),
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

/** 解析一行入站文档：合法请求 → request；信封/解析违例 → error（可直接回写） */
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
