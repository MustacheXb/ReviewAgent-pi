/**
 * Provider / 网关缓存合同契约（#58 / ADR-0018 §6）。
 *
 * 被动采集：只从实际响应提取 usage 字段族与模型回显；不从密钥、请求头或
 * 环境变量推导缓存能力。审计以可选键 `cacheContract` 留痕，缺省省键、
 * 不含任何密钥，可外发。
 *
 * unknown / N/A 纪律：无法从被动响应推导的字段记 `"unknown"`（不记 0、
 * 不按固定折扣率假设）。`cacheMetering` 三态：true = 响应含缓存计量字段，
 * false = 有 usage 但无缓存字段，`"unknown"` = 未观察到 usage。
 */

/** usage 字段族（决定 cacheRead 的口径来源） */
export type UsageFieldFamily = "deepseek-native" | "openai-cached-tokens" | "unknown";

/** 接入点类型（按 URL path 判定；封闭集合） */
export type EndpointKind = "chat-completions" | "responses" | "anthropic-messages" | "unknown";

/** 一次 run 的缓存合同（审计可选尾键；字段值 unknown 表示被动采集不可得） */
export interface CacheContract {
  /** provider id（来自实际响应/内核适配器；未知记 "unknown"） */
  readonly provider: string;
  /** 接入点类型 */
  readonly endpointKind: EndpointKind;
  /** 实际请求的模型 id（wire model） */
  readonly requestedModel: string;
  /** 响应回显的模型 id；无回显记 "unknown" */
  readonly respondedModel: string;
  /** 部署版本（响应头可观测时记录；否则 "unknown"） */
  readonly deploymentVersion: string;
  readonly usageFieldFamily: UsageFieldFamily;
  /** 缓存是否可计量：true / false / unknown（未观察到 usage） */
  readonly cacheMetering: boolean | "unknown";
  /** 缓存块对齐 token 数（被动采集不可得 → "unknown"） */
  readonly cacheBlockTokens: number | "unknown";
  /** 预热耗时（被动采集不可得 → "unknown"） */
  readonly cacheWarmupMs: number | "unknown";
  /** 是否要求路由亲和（被动采集不可得 → "unknown"） */
  readonly providerAffinityRequired: boolean | "unknown";
  /** 测量时间（ISO 8601） */
  readonly measuredAt: string;
  /**
   * 价目三元组 / 币种 / 生效时间（ADR-0018 §6）：运行期不读价目文件，
   * 故审计侧缺省省键；分析命令提供静态价目表时由报告层附加（#58）。
   */
  readonly cacheHitPrice?: number;
  readonly cacheMissPrice?: number;
  readonly cacheWritePrice?: number;
  readonly currency?: string;
  readonly priceValidFrom?: string;
}

/**
 * 从原始 usage 对象判定字段族与缓存可计量性（纯函数）。
 * - DeepSeek 原生：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；
 * - OpenAI 口径：`prompt_tokens_details.cached_tokens` 或顶层 `cached_tokens`。
 * 有 usage 但无上述字段 → family unknown + metered=false；不看数值（0 也是
 * 已计量，不能因 0 判定为「未计量」）。
 */
export function classifyUsageFields(usage: Record<string, unknown>): {
  readonly usageFieldFamily: UsageFieldFamily;
  readonly cacheMetering: boolean;
} {
  if (
    isFiniteNumber(usage.prompt_cache_hit_tokens) ||
    isFiniteNumber(usage.prompt_cache_miss_tokens)
  ) {
    return { usageFieldFamily: "deepseek-native", cacheMetering: true };
  }
  const details = usage.prompt_tokens_details;
  if (
    (isRecord(details) && isFiniteNumber(details.cached_tokens)) ||
    isFiniteNumber(usage.cached_tokens)
  ) {
    return { usageFieldFamily: "openai-cached-tokens", cacheMetering: true };
  }
  return { usageFieldFamily: "unknown", cacheMetering: false };
}

/** 响应中的 cache hit token（DeepSeek / OpenAI 两族；缺失 undefined） */
export function cacheHitTokensOf(usage: Record<string, unknown>): number | undefined {
  if (isFiniteNumber(usage.prompt_cache_hit_tokens)) {
    return usage.prompt_cache_hit_tokens;
  }
  const details = usage.prompt_tokens_details;
  if (isRecord(details) && isFiniteNumber(details.cached_tokens)) {
    return details.cached_tokens;
  }
  return isFiniteNumber(usage.cached_tokens) ? usage.cached_tokens : undefined;
}

/** 接入点类型（按 URL path 判定；不读密钥 / 环境变量） */
export function endpointKindOf(url: string): EndpointKind {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  if (pathname.includes("/chat/completions")) {
    return "chat-completions";
  }
  if (pathname.includes("/responses")) {
    return "responses";
  }
  if (pathname.includes("/messages")) {
    return "anthropic-messages";
  }
  return "unknown";
}

/** 响应回显模型（SSE / JSON 共用；无回显时 undefined） */
export function modelEchoOf(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  return typeof body.model === "string" && body.model.length > 0 ? body.model : undefined;
}

/** 响应 usage 对象（SSE chunk.usage；无则 undefined） */
export function usageOf(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  return isRecord(body.usage) ? body.usage : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
