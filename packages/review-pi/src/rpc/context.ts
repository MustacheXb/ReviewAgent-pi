/**
 * #27 P1 调用方契约（ADR-0013 决策 5）：Principal / CallContext 贯穿
 * ReviewService 全方法。
 *
 * - `Principal` 由传输面派生，客户端不得在 params 自报 tenant：HTTP（#28 起）
 *   经 `Authorization: Bearer` 头 + Authenticator 解析；stdio 面是本地可信
 *   宿主——合成 local principal（固定 tenant、全 scope）。
 * - service 查询层按 tenantId 过滤，越权统一 not found（不泄漏资源存在性）。
 * - scope 的方法级执法属传输面职责（HTTP 401/403；stdio 无鉴权面），
 *   service 只认 tenant 隔离。
 */

/** 方法级权限面（HTTP Bearer 最小 scope；stdio local principal 全量持有） */
export const REVIEW_SCOPES = [
  "review:submit",
  "review:read",
  "review:cancel",
  "artifact:read",
  "admin",
] as const;
export type ReviewScope = (typeof REVIEW_SCOPES)[number];

export interface Principal {
  readonly tenantId: string;
  readonly subject: string;
  readonly scopes: readonly ReviewScope[];
}

/** 单次服务调用的上下文（service 全方法第一参数之外的伴随面） */
export interface CallContext {
  readonly principal: Principal;
  /** 请求级关联 id（日志/审计锚点；传输面生成，service 不解释） */
  readonly requestId: string;
  // HTTP 方案 §3.4 还定义了 `signal: AbortSignal`（请求级取消）：stdio 面无
  // 取消源（取消走显式 review.cancel，进程面断连即 EOF drain），#28 HTTP
  // 传输层接入时随连接生命周期补齐——刻意延期，非遗漏。
}

/** stdio 面的合成 tenant（本地可信宿主，无多租户隔离语义） */
export const LOCAL_TENANT_ID = "local";

/**
 * stdio 面合成 local principal：固定 tenant、subject="stdio-host"、全 scope
 * （本地形态无鉴权面——scope 执法不发生在 stdio；HTTP 面按 token 派生）。
 */
export const LOCAL_PRINCIPAL: Principal = {
  tenantId: LOCAL_TENANT_ID,
  subject: "stdio-host",
  scopes: REVIEW_SCOPES,
};

/** stdio 会话的 CallContext 工厂（requestId 由 dispatch 层逐请求生成） */
export function localCallContext(requestId: string): CallContext {
  return { principal: LOCAL_PRINCIPAL, requestId };
}
