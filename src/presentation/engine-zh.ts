import {
  DEEPSEEK_API_BASE_URL,
  resolveApiKey,
  resolveEndpointUrl,
  REVIEWER_API_KEY_ENV_VARS,
  REVIEWER_URL_ENV_VARS,
  type EnvLookup,
} from "review-llm";

import type { TranslateEngine, TerminologyContext } from "./translate-projection.js";
import {
  projectReviewDocument,
  type ProjectedReviewDocument,
  type ReviewPresentationSource,
} from "./translate-projection.js";

/**
 * 真引擎装配（ADR-0010「英文产出 + 核外翻译投影」的消费端接线件）：CLI
 * 呈现投影缝（REVIEW_PI_PRESENTATION_ENGINE 注入的引擎模块）的默认实现。
 *
 * 模块协议（packages/review-pi/src/cli/presentation-projection.ts 单源定义）：
 * ESM default export = (source: { findings, toolCallLog }) => 投影文档
 * { provenance, findings, toolCallLog }——自然语言字段（title / description /
 * resultSummary）经 LLM 译中文，结构化字段字节直通（直通由
 * translate-projection.ts 逐字段锁定，本模块不复查）。运行形状校验在 CLI
 * 缝侧（引擎失败 → 呈现降级英文源，检视产物不丢）。
 *
 * 边界纪律（ADR-0010 Considered Options）：
 * - 翻译是呈现关注点——本模块属核外装配面，**与 translate-projection.ts
 *   不同，本模块持网络与密钥**（真引擎由消费端装配的「装配」即此处）；
 * - 检视链零触碰：本模块不进任何检视请求路径，语言不进实验 plan 与内核
 *   执行缝（评测面语言零漂移回归仍绿）。
 *
 * 接入（经进程环境变量，与检视链同款单源解析 review-llm）：
 * - 网关与凭据复用 REVIEWER_URL / REVIEWER_API_KEY（CLI 进程已在凭据解析
 *   前装载 .env.local——本模块运行于同一进程，无需重复装载）；
 * - 翻译模型 id 走 REVIEW_PI_PRESENTATION_MODEL（缺省 deepseek-v4-flash——
 *   翻译是轻任务；呈现配置不是实验自变量，不与被测模型 --model 耦合）；
 * - key 绝不硬编码、绝不出现在错误信息或任何落盘产物中。
 *
 * 翻译口径：术语表（terminology.ts 单源，随 TerminologyContext 注入）作
 * 引擎参考上下文（非硬替换）；代码标识（类名/方法名/路径/代码摘录）与
 * 结构化标识（P0–P3 等）保持原样不译；temperature 0 求确定译文。
 */

/** 翻译模型 id 环境变量（呈现配置；缺省 DEFAULT_PRESENTATION_MODEL） */
export const PRESENTATION_MODEL_ENV_VAR = "REVIEW_PI_PRESENTATION_MODEL";

/** 缺省翻译模型（轻任务档；消费端可经环境变量覆盖） */
export const DEFAULT_PRESENTATION_MODEL = "deepseek-v4-flash";

/**
 * 单次翻译请求超时（引擎内部；CLI 缝侧另有总兜底）。长 description 的译文
 * 可达数百汉字——非流式 completion 要等全量生成完才回，实测单字段可上探
 * 数十秒（2026-10-20 真跑：~200 词 description 译 >30s 触发旧 30s 上界），
 * 90s 是「慢但可达」与「挂死早暴露」的折中。
 */
const TRANSLATION_REQUEST_TIMEOUT_MS = 90_000;

/** 服务标签：错误消息前缀（与检视链同款角色命名，不称具体服务商） */
const SERVICE_LABEL = "presentation translation LLM API";

/** 引擎装配选项（网络件全注入——测试 fake fetch，真跑 globalThis.fetch） */
export interface GatewayEngineOptions {
  readonly endpointUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly fetchFn: typeof fetch;
  readonly env?: EnvLookup;
}

/**
 * 投影呈现文档（CLI 缝调用入口）：装配网关翻译引擎 → zh 档翻译投影。
 * 网关/凭据解析失败在装配期抛错（CLI 缝归 degraded，呈现降级英文源）。
 */
export default async function projectZhPresentation(
  source: ReviewPresentationSource,
): Promise<ProjectedReviewDocument> {
  const env: EnvLookup = process.env;
  const engine = createGatewayTranslateEngine({
    endpointUrl: resolveEndpointUrl({
      defaultBaseUrl: DEEPSEEK_API_BASE_URL,
      envVarNames: [...REVIEWER_URL_ENV_VARS],
      clientError: (message) => new Error(message),
      env,
    }),
    apiKey: resolveApiKey({
      envVarNames: [...REVIEWER_API_KEY_ENV_VARS],
      serviceLabel: SERVICE_LABEL,
      clientError: (message) => new Error(message),
      env,
    }),
    modelId: resolvePresentationModelId(env),
    fetchFn: globalThis.fetch,
  });
  return projectReviewDocument({ engine }, { source, language: "zh" });
}

/** 翻译模型 id：环境变量显式值优先，缺省轻任务档 */
function resolvePresentationModelId(env: EnvLookup): string {
  const fromEnv = env[PRESENTATION_MODEL_ENV_VAR]?.trim();
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : DEFAULT_PRESENTATION_MODEL;
}

/**
 * 网关翻译引擎（TranslateEngine 实现）：OpenAI 兼容 chat/completions
 * 非流式调用——system 装翻译口径 + 术语表，user 装待译文本，取
 * choices[0].message.content 为译文。空响应/非 2xx/网络异常均抛人话错误
 * （CLI 缝统一归呈现降级，检视产物不丢）。
 */
export function createGatewayTranslateEngine(options: GatewayEngineOptions): TranslateEngine {
  return async (text: string, context: TerminologyContext): Promise<string> => {
    const body = {
      model: options.modelId,
      messages: [
        { role: "system", content: translationSystemPrompt(context) },
        { role: "user", content: text },
      ],
      stream: false,
      temperature: 0,
    };
    let response: Response;
    try {
      response = await options.fetchFn(options.endpointUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TRANSLATION_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${SERVICE_LABEL} request failed: ${message}`);
    }
    if (!response.ok) {
      const detail = await errorSnippetOf(response);
      throw new Error(`${SERVICE_LABEL} returned HTTP ${response.status}: ${detail}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`${SERVICE_LABEL} returned a non-JSON body`);
    }
    const content = readAssistantContent(payload);
    if (content === undefined || content.trim() === "") {
      throw new Error(`${SERVICE_LABEL} returned an empty completion`);
    }
    return content;
  };
}

/**
 * 翻译口径系统提示词：只译自然语言、保留代码标识与结构化标识、术语表
 * 参考口径。随每次调用注入（TerminologyContext 单源——引擎不自带词表）。
 */
function translationSystemPrompt(context: TerminologyContext): string {
  const terminology = context.entries
    .map((entry) => `  - ${entry.en} → ${entry.zh}${entry.note !== undefined ? `（${entry.note}）` : ""}`)
    .join("\n");
  return [
    "你是代码检视结论的翻译引擎。把输入的英文检视文本翻译成简体中文，只输出译文本身，不要任何解释、前后缀或代码块包裹。",
    "翻译规则：",
    "- 代码标识保持原样不译：类名、方法名、变量名、文件路径、代码摘录（如 ObjectArrayCodec.java、parseArray(...)）。",
    "- 结构化标识保持原样不译：严重级代码（P0–P3）、规则 id、配置 id。",
    "- 译文必须完整：不得省略、缩写或合并输入内容。",
    "- 域词按下方术语表口径（参考口径，融进自然叙事，非逐词硬替换）。",
    `术语表（版本 v${context.terminologyVersion}）：`,
    terminology,
  ].join("\n");
}

/** 读取 choices[0].message.content（OpenAI 兼容信封；形状不符返回 undefined） */
function readAssistantContent(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const message = (choices[0] as { message?: unknown })?.message;
  if (message === null || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

/** 非成功响应的报文摘要（错误诊断用；截长防爆屏） */
async function errorSnippetOf(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch {
    return "(unreadable error body)";
  }
}
