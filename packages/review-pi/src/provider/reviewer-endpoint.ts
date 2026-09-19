import {
  DEEPSEEK_API_BASE_URL,
  REVIEWER_API_KEY_ENV_VARS,
  REVIEWER_URL_ENV_VARS,
  resolveApiKey,
  type EnvLookup,
} from "review-llm";

// 检视链网关接入解析（#4，spec「密钥」决策）：url/key 走角色命名
// REVIEWER_URL / REVIEWER_API_KEY（> 旧 DEEPSEEK_* 别名），常量单源 =
// review-llm（冻结仪器，零改动只消费）；key 只经环境变量注入，
// 绝不硬编码、绝不出现在错误信息或任何落盘产物中。
//
// 与 DSH 线 env.ts reviewerBaseUrlOf 同名同序同 trim/尾斜杠语义；
// 差异：本包消费方是 pi-ai（OpenAI SDK 在 baseURL 上自行拼
// /chat/completions），故解析产物是 base URL 本身，不追加路径——
// 网关 URL 需自带 /v1（OpenAI SDK 只追加 /chat/completions）。

/** 服务标签：错误消息前缀（接入点可指向自定义网关，不称 DeepSeek API） */
const REVIEWER_SERVICE_LABEL = "reviewer LLM API";

/** 已解析的检视链接入点（真跑冒烟与后续实验共用） */
export interface ReviewerEndpoint {
  /** base URL（trim、尾斜杠已归一；不追加 /chat/completions） */
  readonly baseUrl: string;
  readonly apiKey: string;
}

/**
 * 解析检视链接入点（纯函数，env 注入以便离线测试；缺省读 process.env）。
 * baseUrl 优先序：REVIEWER_URL > DEEPSEEK_URL > 官方缺省；
 * apiKey 优先序：REVIEWER_API_KEY > DEEPSEEK_API_KEY（缺失 fail fast）。
 */
export function resolveReviewerEndpoint(env: EnvLookup = process.env): ReviewerEndpoint {
  return {
    baseUrl: resolveReviewerBaseUrl(env),
    apiKey: resolveApiKey({
      envVarNames: [...REVIEWER_API_KEY_ENV_VARS],
      serviceLabel: REVIEWER_SERVICE_LABEL,
      clientError: (message) => new Error(message),
      env,
    }),
  };
}

/** base URL 解析：按序探测角色环境变量，首个非空（trim 后）胜出；协议校验 + 尾斜杠归一 */
function resolveReviewerBaseUrl(env: EnvLookup): string {
  for (const name of REVIEWER_URL_ENV_VARS) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) {
      return baseUrlOf(value, name);
    }
  }
  return baseUrlOf(DEEPSEEK_API_BASE_URL, "default");
}

/**
 * 协议校验 + 尾斜杠归一。语义镜像 review-llm resolver.ts 的 endpointOf
 * （冻结仪器零改动，不能 import 复用）——唯一差异：不追加
 * /chat/completions（pi-ai 侧 SDK 自行拼接）。resolver 侧若改语义，
 * 此处需同步（漂移锚点）。
 */
function baseUrlOf(value: string, source: string): string {
  if (!/^https?:\/\//.test(value)) {
    throw new Error(
      `reviewer base URL must start with http:// or https:// (from ${source}: ${JSON.stringify(value)})`,
    );
  }
  return value.replace(/\/+$/, "");
}
