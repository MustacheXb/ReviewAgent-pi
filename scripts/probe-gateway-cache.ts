/**
 * 网关缓存主动探针（#58 / ADR-0018 §6）：仓内手动 runbook 脚本。
 *
 * 纪律：
 * - 只作手动诊断：不进 CI、不进产品 bin、不进 review-pi CLI；
 * - 会产生少量真实费用（每次 probe 一次 chat completion，max_tokens 很小）；
 * - 只从 REVIEWER_* / DEEPSEEK_* 环境变量取接入点与密钥（resolveReviewerEndpoint），
 *   密钥绝不打印 / 落盘；
 * - 观察项：health、usage 字段族、模型回显、warmup、块对齐、路由亲和。
 *   结论一律标 observed / unknown，不按 0 或固定折扣假设。
 *
 * 用法（先构建 review-pi dist）：
 *   pnpm probe:gateway-cache
 *   REVIEWER_URL=... REVIEWER_API_KEY=... pnpm probe:gateway-cache
 * 详细步骤与解读见 docs/runbooks/cache-contract-probe.md。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVIEW_MODEL_ID,
  cacheHitTokensOf,
  classifyUsageFields,
  endpointKindOf,
  modelEchoOf,
  resolveReviewerEndpoint,
} from "review-pi";

/** 对齐探测的前缀字符规模（≈ chars/4 tokens；只作观测样本） */
const BLOCK_PREFIX_CHARS = [1_000, 2_000, 4_000, 8_000] as const;
/** warmup / 亲和探测的重复次数 */
const REPEAT_CALLS = 3;
/** 每次探针的 max_tokens（成本上界；应答内容不参与判定） */
const PROBE_MAX_TOKENS = 8;

interface ProbeCall {
  readonly status: number;
  readonly respondedModel: string | "unknown";
  readonly promptTokens: number | "unknown";
  readonly completionTokens: number | "unknown";
  readonly cacheHitTokens: number | "unknown";
  readonly usageFieldFamily: string;
  readonly cacheMetering: boolean | "unknown";
  /** 网络 / 解析失败诊断（有界；不含密钥） */
  readonly error?: string;
}

interface PrefixProbe {
  readonly label: string;
  readonly prefixChars: number;
  readonly calls: readonly ProbeCall[];
  /** 后一次调用的 cacheHit 高于首次（observed，不声称因果） */
  readonly warmupObserved: boolean | "unknown";
}

async function main(): Promise<number> {
  const { baseUrl, apiKey } = resolveReviewerEndpoint();
  const model = REVIEW_MODEL_ID;
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const health = await probeHealth(baseUrl, apiKey);
  if (!health.reachable) {
    process.stdout.write(
      `${JSON.stringify(
        {
          kind: "cache-contract-probe",
          manualOnly: true,
          provider: "deepseek",
          endpointKind: endpointKindOf(`${baseUrl}/chat/completions`),
          requestedModel: model,
          respondedModel: "unknown",
          deploymentVersion: "unknown",
          usageFieldFamily: "unknown",
          cacheMetering: "unknown",
          cacheBlockTokens: "unknown",
          cacheWarmupMs: "unknown",
          providerAffinityRequired: "unknown",
          measuredAt: new Date().toISOString(),
          health,
          warmup: null,
          blockAlignment: [],
          affinity: null,
          note: "health unreachable: probes skipped (no further billed calls)",
        },
        null,
        2,
      )}\n`,
    );
    return 1;
  }
  const tag = `cache-probe-${Date.now()}`;
  const warmup = await probePrefix(
    "warmup",
    repeatText(`${tag}-warmup `, Math.max(...BLOCK_PREFIX_CHARS)),
    REPEAT_CALLS,
    endpoint,
    apiKey,
    model,
  );
  const blockAlignment: PrefixProbe[] = [];
  for (const chars of BLOCK_PREFIX_CHARS) {
    blockAlignment.push(
      await probePrefix(
        `block-${chars}`,
        repeatText(`${tag}-block-${chars} `, chars),
        2,
        endpoint,
        apiKey,
        model,
      ),
    );
  }
  const affinity = await probeAffinity(endpoint, apiKey, model, tag);

  const allCalls = [warmup, ...blockAlignment].flatMap((probe) => probe.calls);
  const families = new Set(
    allCalls
      .map((call) => call.usageFieldFamily)
      .filter((family) => family !== "unknown"),
  );
  // 三态聚合：从未观测到 usage → unknown；观测到 usage 但无缓存字段 → false
  const meteredCalls = allCalls.filter((call) => call.cacheMetering !== "unknown");
  const cacheMetering =
    meteredCalls.length === 0 ? "unknown" : meteredCalls.some((call) => call.cacheMetering === true);

  const output = {
    kind: "cache-contract-probe",
    manualOnly: true,
    provider: "deepseek",
    endpointKind: endpointKindOf(endpoint),
    requestedModel: model,
    respondedModel: respondedModelOf([warmup, ...blockAlignment]),
    deploymentVersion: "unknown",
    usageFieldFamily: families.size === 1 ? [...families][0] : "unknown",
    cacheMetering,
    cacheBlockTokens: "unknown",
    cacheWarmupMs: "unknown",
    providerAffinityRequired: "unknown",
    measuredAt: new Date().toISOString(),
    health,
    warmup,
    blockAlignment,
    affinity,
    note: "manual runbook only; not CI; conclusions are observations, not cache-capability claims",
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

async function probeHealth(
  baseUrl: string,
  apiKey: string,
): Promise<{ readonly reachable: boolean; readonly status: number | null; readonly detail?: string }> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    return { reachable: true, status: response.status };
  } catch (error) {
    return { reachable: false, status: null, detail: errorMessage(error) };
  }
}

async function probePrefix(
  label: string,
  prefix: string,
  calls: number,
  endpoint: string,
  apiKey: string,
  model: string,
): Promise<PrefixProbe> {
  const observed: ProbeCall[] = [];
  for (let index = 0; index < calls; index++) {
    observed.push(await probeOnce(endpoint, apiKey, model, `${prefix}\nprobe ${index}`));
  }
  const first = observed[0]?.cacheHitTokens;
  const last = observed.at(-1)?.cacheHitTokens;
  const warmupObserved =
    typeof first === "number" && typeof last === "number" && observed.length > 1
      ? last > first
      : "unknown";
  return { label, prefixChars: prefix.length, calls: observed, warmupObserved };
}

/** 同一请求重复多次：观察 cacheHit 抖动（只记观测，不判定亲和要求） */
async function probeAffinity(
  endpoint: string,
  apiKey: string,
  model: string,
  tag: string,
): Promise<{
  readonly calls: number;
  readonly cacheHitTokens: readonly (number | "unknown")[];
  readonly observedVariance: boolean | "unknown";
}> {
  const prompt = repeatText(`${tag}-affinity `, 2_000);
  const hits: (number | "unknown")[] = [];
  for (let index = 0; index < REPEAT_CALLS; index++) {
    hits.push((await probeOnce(endpoint, apiKey, model, prompt)).cacheHitTokens);
  }
  const numeric = hits.filter((hit): hit is number => typeof hit === "number");
  return {
    calls: REPEAT_CALLS,
    cacheHitTokens: hits,
    observedVariance: numeric.length > 1 ? new Set(numeric).size > 1 : "unknown",
  };
}

async function probeOnce(
  endpoint: string,
  apiKey: string,
  model: string,
  content: string,
): Promise<ProbeCall> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        max_tokens: PROBE_MAX_TOKENS,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    return failedCall(error);
  }
  const text = await response.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 非 JSON 错误页：按缺失字段收口（unknown）
  }
  const usage = isRecord(body.usage) ? body.usage : {};
  const classified = classifyUsageFields(usage);
  return {
    status: response.status,
    respondedModel: modelEchoOf(body) ?? "unknown",
    promptTokens: numberOrUnknown(usage.prompt_tokens),
    completionTokens: numberOrUnknown(usage.completion_tokens),
    cacheHitTokens: cacheHitTokensOf(usage) ?? "unknown",
    usageFieldFamily: classified.usageFieldFamily,
    cacheMetering: Object.keys(usage).length === 0 ? "unknown" : classified.cacheMetering,
  };
}

/** 网络失败的有界诊断（不含密钥）；不中断整轮探针 */
function failedCall(error: unknown): ProbeCall {
  return {
    status: 0,
    respondedModel: "unknown",
    promptTokens: "unknown",
    completionTokens: "unknown",
    cacheHitTokens: "unknown",
    usageFieldFamily: "unknown",
    cacheMetering: "unknown",
    error: errorMessage(error),
  };
}

function respondedModelOf(probes: readonly PrefixProbe[]): string {
  const echoes = new Set(
    probes.flatMap((probe) => probe.calls.map((call) => call.respondedModel)).filter(
      (model) => model !== "unknown",
    ),
  );
  return echoes.size === 1 ? [...echoes][0] ?? "unknown" : "unknown";
}

/** 重复文本到目标字符数（稳定前缀构造；只用于探针） */
function repeatText(unit: string, chars: number): string {
  if (chars <= 0) {
    return "";
  }
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

function numberOrUnknown(value: unknown): number | "unknown" {
  return typeof value === "number" && Number.isFinite(value) ? value : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`probe-gateway-cache: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
