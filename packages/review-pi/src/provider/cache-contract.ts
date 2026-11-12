import type { FetchFunction } from "@earendil-works/pi-ai";
import {
  classifyUsageFields,
  endpointKindOf,
  modelEchoOf,
  usageOf,
  type CacheContract,
  type EndpointKind,
  type UsageFieldFamily,
} from "../contracts/cache-contract.js";

/**
 * 缓存合同被动采集器（#58 / ADR-0018 §6）：包装注入的 FetchFunction，
 * 旁路读取响应副本提取 usage 字段族与模型回显。
 *
 * - 不改传输语义：原 Response 原样返回；响应副本异步解析，解析失败静默
 *   记为未观察到（观测永不击穿主链）；
 * - 不读密钥 / 不记录请求头：只保留 response 头的部署版本（若有）与响应体
 *   的 model / usage 字段名；
 * - 未知记 unknown，不按 0 / 固定折扣假设。
 */

export interface CacheContractInputs {
  readonly provider: string;
  readonly requestedModel: string;
  readonly measuredAt: string;
}

export interface CacheContractCollector {
  /** 包装 fetch：返回原 Response，同时旁路观测响应副本 */
  wrap(fetch: FetchFunction): FetchFunction;
  /** 等待所有在途观测落定（run 结束后调用） */
  settle(): Promise<void>;
  /** 汇总合同（unknown / N/A 纪律在此收口） */
  contract(inputs: CacheContractInputs): CacheContract;
}

/** 观测累积器（run 内顺序单写；与审计累加器同风格） */
interface CollectorState {
  readonly pending: Set<Promise<void>>;
  readonly families: Set<UsageFieldFamily>;
  endpointKind?: EndpointKind;
  respondedModel?: string;
  deploymentVersion?: string;
  usageObserved: boolean;
  cacheMetered: boolean;
}

export function createCacheContractCollector(): CacheContractCollector {
  const state = createCollectorState();
  return {
    wrap: (fetch) => wrapFetch(fetch, state),
    settle: () => settlePending(state),
    contract: (inputs) => contractOf(state, inputs),
  };
}

function createCollectorState(): CollectorState {
  return {
    pending: new Set(),
    families: new Set(),
    usageObserved: false,
    cacheMetered: false,
  };
}

/** 包装 fetch：原 Response 直返；响应副本入队异步观测（失败静默） */
function wrapFetch(fetch: FetchFunction, state: CollectorState): FetchFunction {
  return async (input, init) => {
    const response = await fetch(input, init);
    try {
      const clone = response.clone();
      const task = observeResponse(clone, normalizeUrl(input), state).catch(() => undefined);
      state.pending.add(task);
      void task.finally(() => state.pending.delete(task));
    } catch {
      // Response 不支持 clone：跳过观测，不击穿主链
    }
    return response;
  };
}

async function settlePending(state: CollectorState): Promise<void> {
  while (state.pending.size > 0) {
    await Promise.all([...state.pending]);
  }
}

async function observeResponse(
  response: Response,
  url: string,
  state: CollectorState,
): Promise<void> {
  state.endpointKind ??= endpointKindOf(url);
  const version =
    response.headers.get("x-deployment-version") ??
    response.headers.get("x-model-version") ??
    undefined;
  if (version !== undefined && version.length > 0) {
    state.deploymentVersion ??= version;
  }
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") || text.trimStart().startsWith("data:")) {
    absorbSse(text, state);
    return;
  }
  try {
    absorbBody(JSON.parse(text) as unknown, state);
  } catch {
    // 非 JSON 响应（错误页等）：不观测，合同按 unknown 收口
  }
}

function absorbBody(body: unknown, state: CollectorState): void {
  const echo = modelEchoOf(body);
  if (echo !== undefined) {
    state.respondedModel = echo;
  }
  const usage = usageOf(body) ?? choiceUsageOf(body);
  if (usage === undefined || Object.keys(usage).length === 0) {
    // 无 usage 或空 usage：字段缺失 → 保持 unknown（不按 0 冒充已观测）
    return;
  }
  state.usageObserved = true;
  const classified = classifyUsageFields(usage);
  state.families.add(classified.usageFieldFamily);
  if (classified.cacheMetering) {
    state.cacheMetered = true;
  }
}

function contractOf(state: CollectorState, inputs: CacheContractInputs): CacheContract {
  return {
    provider: inputs.provider.length > 0 ? inputs.provider : "unknown",
    endpointKind: state.endpointKind ?? "unknown",
    requestedModel: inputs.requestedModel,
    respondedModel: state.respondedModel ?? "unknown",
    deploymentVersion: state.deploymentVersion ?? "unknown",
    usageFieldFamily: familyOf(state.families),
    cacheMetering: state.usageObserved ? state.cacheMetered : "unknown",
    cacheBlockTokens: "unknown",
    cacheWarmupMs: "unknown",
    providerAffinityRequired: "unknown",
    measuredAt: inputs.measuredAt,
  };
}

/** 单一家族才记家族；混合 / 未观察 → unknown（不猜口径） */
function familyOf(families: ReadonlySet<UsageFieldFamily>): UsageFieldFamily {
  if (families.size !== 1) {
    return "unknown";
  }
  for (const family of families) {
    return family;
  }
  return "unknown";
}

/** 逐条 data: 帧解析（SSE）；畸形帧跳过，不影响其余观测 */
function absorbSse(text: string, state: CollectorState): void {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const raw = trimmed.slice("data:".length).trim();
    if (raw.length === 0 || raw === "[DONE]") {
      continue;
    }
    try {
      absorbBody(JSON.parse(raw) as unknown, state);
    } catch {
      // 畸形帧跳过
    }
  }
}

/** 兼容部分 provider 把 usage 放在 choices[0].usage 的形态 */
function choiceUsageOf(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) {
      continue;
    }
    const usage = (choice as Record<string, unknown>).usage;
    if (typeof usage === "object" && usage !== null && !Array.isArray(usage)) {
      return usage as Record<string, unknown>;
    }
  }
  return undefined;
}

function normalizeUrl(input: Parameters<FetchFunction>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}
