import { piKernel } from "../../gate/pi-kernel.js";
import type { EnvLookup } from "review-llm";
import type { CampaignDeps } from "../campaign/contracts.js";
import {
  GptJudgeClient,
  JUDGE_API_KEY_ENV_VAR,
  JUDGE_URL_ENV_VAR,
  OPENAI_API_KEY_ENV_VAR,
  OPENAI_URL_ENV_VAR,
  createCampaignJudgeClient,
  judgeCompletionCapOf,
  validateModel,
} from "../judge/index.js";

/**
 * 真实 campaign 依赖装配（#40）：pi 内核（E 运行时）+ 真实 LLM-as-judge 链。
 *
 * 装配纪律：
 * - key 只经构造参数进闭包，绝不落盘 / 回显；reviewer 与 judge 端点缺省
 *   由各自解析器读取角色命名环境变量（REVIEWER_* / JUDGE_*，旧 provider
 *   名兼容）；
 * - judge 与被测模型必须异构（GptJudgeClient 构造期校验）；自定义接入点
 *   标记透传（无信封家族的 completion 容量回落）；
 * - 单单元超时有界（真实网络可能挂起）：kernel 20 min / judge 30 min，
 *   超时由 runner 按阶段留痕，不拖垮整批。
 *
 * 本模块零网络副作用：构造客户端不发起请求；真实调用由 campaign runner
 * 在环境变量门控后触发。
 */

/** kernel 单单元超时缺省 20 分钟（E 内核 ≤5 轮 / ≤6 次工具调用） */
export const DEFAULT_KERNEL_TIMEOUT_MS = 20 * 60_000;
/** judge 单单元超时缺省 30 分钟（300s 单请求 × 1+3 次有界重试） */
export const DEFAULT_JUDGE_TIMEOUT_MS = 30 * 60_000;

export interface JudgeRoleEnv {
  readonly apiKey: string;
  readonly baseUrl: string | null;
}

/**
 * judge 角色环境变量解析（推荐名 > 旧名；空白视为未设置）。
 * 返回 null = 无 key（调用方报门控错误）；不读取 key 以外内容。
 */
export function resolveJudgeEnv(env: EnvLookup = process.env): JudgeRoleEnv | null {
  const apiKey = firstNonEmpty(env, [JUDGE_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR]);
  if (apiKey === null) {
    return null;
  }
  return {
    apiKey,
    baseUrl: firstNonEmpty(env, [JUDGE_URL_ENV_VAR, OPENAI_URL_ENV_VAR]),
  };
}

export interface RealCampaignDepsOptions {
  /** 被测模型 id（与 plan.model 一致） */
  readonly model: string;
  /** judge 模型 id（必须与被测模型异构） */
  readonly judgeModel: string;
  readonly reviewerApiKey: string;
  readonly reviewerBaseUrl?: string | null;
  readonly judgeApiKey: string;
  readonly judgeBaseUrl?: string | null;
  /** fetch 注入（测试零网络；缺省 globalThis.fetch） */
  readonly fetchFn?: typeof fetch;
  readonly kernelTimeoutMs?: number;
  readonly judgeTimeoutMs?: number;
  readonly now?: () => string;
}

export function createRealCampaignDeps(options: RealCampaignDepsOptions): CampaignDeps {
  if (options.reviewerApiKey.trim() === "") {
    throw new Error(
      "pi kernel reviewer key is missing: set REVIEWER_API_KEY (or DEEPSEEK_API_KEY); " +
        "the key is never logged or persisted.",
    );
  }
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const reviewerBaseUrl = nonEmpty(options.reviewerBaseUrl);
  const judgeBaseUrl = nonEmpty(options.judgeBaseUrl);
  // 异构约束在开跑前 fail fast（客户端内部只在请求构造期校验；一次真实
  // campaign 可能跑数十分钟，配置错误必须立刻暴露）
  validateModel(options.judgeModel, {
    reviewerModel: options.model,
  });
  // wire 容量上界也在开跑前校验：无信封家族的 judge 模型（官方 DeepSeek
  // thinking wire）不能服务恒发 max_tokens 的 judge wire
  judgeCompletionCapOf(options.judgeModel, { customLlmEndpoint: judgeBaseUrl !== null });
  const kernel = piKernel({
    apiKey: options.reviewerApiKey,
    ...(reviewerBaseUrl !== null ? { baseUrl: reviewerBaseUrl } : {}),
    fetch: fetchFn,
  });
  const judgeClient = new GptJudgeClient({
    model: options.judgeModel,
    apiKey: options.judgeApiKey,
    ...(judgeBaseUrl !== null ? { baseUrl: judgeBaseUrl } : {}),
    reviewerModel: options.model,
    // 自定义接入点 = 显式 judge URL 在场（wire 解释权在实验者）
    customLlmEndpoint: judgeBaseUrl !== null,
    fetchFn,
  });
  return {
    kernel,
    judge: createCampaignJudgeClient({ client: judgeClient }),
    kernelTimeoutMs: options.kernelTimeoutMs ?? DEFAULT_KERNEL_TIMEOUT_MS,
    judgeTimeoutMs: options.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
}

function firstNonEmpty(env: EnvLookup, names: readonly string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}
