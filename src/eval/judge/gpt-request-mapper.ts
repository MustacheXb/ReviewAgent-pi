/**
 * JudgeRequest → OpenAI Chat Completions 请求体（纯函数）。
 *
 * 字节纪律：字段顺序固定；校准参数锁定 MCR-Bench 论文协议值
 * （temperature 0.2、top_p 0.95）对所有模型不漂移；max_tokens 是防截断的
 * 容量上界——#42 起由共享包 provider 参数画像表驱动（review-llm profileOf）：
 * glm 等推理模型 completion 含 reasoning tokens 得 32768 信封（#39 实测），
 * 未知模型走保守默认画像 8192。
 * 模型异构约束（spec #1 user story 25）：judge 必须与被测模型不同源——
 * 同源判定以被测模型为对照系（reviewerModel：精确同 id 或同已知 provider
 * 家族）；validateModel 在客户端请求构造期拒绝同源。自定义接入点只影响
 * completion 信封回落（customLlmEndpoint），不放松同源拒绝。
 */

import type { JudgeRequest } from "./contracts.js";
import { JudgeClientError } from "./errors.js";
import { buildJudgeMessages } from "./prompt.js";
import type { JudgeContextLimits } from "./contracts.js";
import type { WireGptChatCompletionsRequest } from "./gpt-wire-types.js";
import { DEFAULT_COMPLETION_MAX_TOKENS, profileOf, providerFamilyOf } from "review-llm";

/** 默认 judge 模型：论文 LLM-Hit-Judge 与人工 Human Hit Rate 的 QWK 一致性最高档（0.73） */
export const DEFAULT_PROTOCOL_JUDGE_MODEL = "gpt-5.2-pro";

/** judge 校准参数（论文 LLM-Hit-Judge 协议值，llm_evaluator.py 实测核验） */
export const JUDGE_TEMPERATURE = 0.2;
export const JUDGE_TOP_P = 0.95;

/**
 * 同源校验选项（validateModel）：被测模型对照系 + 预检降级开关。
 */
export interface ModelValidationOptions {
  /**
   * 被测模型 id——同源判定的对照系。缺省 = 保守假设被测为 DeepSeek 系
   * （客户端直用/校准脚本路径，无实验上下文时的兼容默认）。
   */
  readonly reviewerModel?: string;
  /**
   * true = 预检已按 warning 放行（同源 + 自定义接入点在场，不可机械判定）：
   * 跳过同源拒绝。
   */
  readonly heterogeneityDowngraded?: boolean;
}

/**
 * 异构上下文：同源校验（ModelValidationOptions）+ 自定义接入点信封回落。
 */
export interface HeterogeneityOptions extends ModelValidationOptions {
  /**
   * true = 部署经自定义 LLM 接入点（任一侧 URL env 在场）：无信封家族
   * （DeepSeek thinking wire）judge completion 信封回落保守默认——
   * wire 解释权在实验者手里。
   */
  readonly customLlmEndpoint?: boolean;
}

/**
 * 客户端直用路径的保守默认：无对照系信息时假设被测为 DeepSeek 系。
 * validateModel 的同源拒绝以 reviewerModel 为对照系（画像表家族前缀 + 精确同 id）。
 */
const DEEPSEEK_FAMILY_RE = /deepseek/i;

/**
 * 同源判定（单源）：精确同 id，或同已知 provider 家族（画像表前缀）。
 * 未知家族 id 不做前缀联想——自由 id 的家族归属由实验者自证。
 */
function sameSourcePair(judgeModel: string, reviewerModel: string): boolean {
  if (judgeModel === reviewerModel) {
    return true;
  }
  const family = providerFamilyOf(judgeModel);
  return family !== null && family === providerFamilyOf(reviewerModel);
}

/**
 * 模型族感知 completion 预算（#42 起画像表驱动）：容量上界查 review-llm
 * provider 画像（glm 32768 / 默认 8192），校准参数（temperature/top_p）不随
 * 模型族。画像不序列化 max_tokens 的模型族（DeepSeek thinking wire）对 judge
 * 是 fail fast——judge wire 恒发 max_tokens（论文协议形状）；唯一例外是
 * 自定义接入点部署（#43，wire 解释权在实验者）：回落保守默认信封。
 */
export function judgeCompletionCapOf(
  model: string,
  options?: HeterogeneityOptions,
): number {
  const envelope = profileOf(model).completionMaxTokens;
  if (envelope !== undefined) {
    return envelope;
  }
  if (options?.customLlmEndpoint) {
    return DEFAULT_COMPLETION_MAX_TOKENS;
  }
  throw new JudgeClientError(
    `judge model ${JSON.stringify(model)} belongs to a provider family that serializes no max_tokens; the judge wire always sends max_tokens (MCR-Bench protocol shape), so this model family cannot serve the judge chain`,
  );
}

export interface GptRequestMapperOptions extends HeterogeneityOptions {
  readonly model?: string;
  readonly limits?: JudgeContextLimits;
}

export function buildGptJudgeBody(
  request: JudgeRequest,
  options: GptRequestMapperOptions = {},
): WireGptChatCompletionsRequest {
  const model = validateModel(options.model ?? DEFAULT_PROTOCOL_JUDGE_MODEL, options);
  const { systemPrompt, userPrompt } = buildJudgeMessages(request, options.limits);
  return {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: JUDGE_TEMPERATURE,
    top_p: JUDGE_TOP_P,
    max_tokens: judgeCompletionCapOf(model, options),
    stream: false,
  };
}

/**
 * 非空校验 + 异构约束：同源判定以被测模型为对照系（reviewerModel；缺省
 * 保守假设被测为 DeepSeek 系——客户端直用路径），judge 链要求 judge 与被测
 * 不同源（#33 措辞泛化）；#43 异构降级（预检已 warning 放行）时跳过同源
 * 拒绝——非空校验不随降级松动。
 */
export function validateModel(
  model: string,
  options?: ModelValidationOptions,
): string {
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new JudgeClientError(
      `judge model must be a non-empty string (got ${JSON.stringify(model)})`,
    );
  }
  if (options?.heterogeneityDowngraded === true) {
    return model;
  }
  const sameSource =
    options?.reviewerModel === undefined
      ? DEEPSEEK_FAMILY_RE.test(model)
      : sameSourcePair(model, options.reviewerModel);
  if (sameSource) {
    const comparison =
      options?.reviewerModel === undefined
        ? "the DeepSeek system under test (conservatively assumed — no reviewer model provided)"
        : `the review model ${JSON.stringify(options.reviewerModel)}`;
    throw new JudgeClientError(
      `judge model ${JSON.stringify(model)} must be heterogeneous from ${comparison}; the judgment chain requires a model from a different family (spec #1 user story 25)`,
    );
  }
  return model;
}
