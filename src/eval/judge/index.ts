/**
 * Judge 链（#40，eval-only）：LLM-as-judge 语义裁定，离线可测。
 *
 * 落位纪律（ADR-0016）：本目录只在评测面（`eval/bench`），生产入口不得
 * import；campaign 核心（src/eval/campaign）保持零网络，真实客户端由
 * `src/eval/assembly` 装配。
 *
 * 协议：MCR-Bench LLM-Hit-Judge（论文锁值 temperature 0.2 / top_p 0.95），
 * finding↔truth 一对一语义匹配 → TP / FP / FN。judge 必须与被测模型异构。
 */

export {
  DEFAULT_JUDGE_CONTEXT_LIMITS,
  DEFAULT_MATCH_CONFIDENCE_THRESHOLD,
  MATCH_CONFIDENCE_RANK,
  findingToCard,
  truthToCards,
  type JudgeAdjudication,
  type JudgeClient,
  type JudgeContextLimits,
  type JudgeFindingCard,
  type JudgeMatch,
  type JudgeMrContext,
  type JudgeRequest,
  type JudgeTruthCard,
  type MatchConfidence,
  type MatchConfidenceThreshold,
} from "./contracts.js";
export {
  GptJudgeHttpError,
  GptJudgeNetworkError,
  GptJudgeResponseFormatError,
  JudgeClientError,
  RETRYABLE_HTTP_STATUSES,
  isRetryableJudgeError,
  isRetryableStatus,
} from "./errors.js";
export { buildJudgeMessages, JUDGE_PROMPT_VERSION, type JudgeMessages } from "./prompt.js";
export { extractJudgeJsonText, parseJudgeAdjudication } from "./parse.js";
export {
  passesThreshold,
  resolveAdjudication,
  type ResolvedAdjudication,
  type ResolvedMatch,
} from "./resolve.js";
export {
  buildGptJudgeBody,
  JUDGE_TEMPERATURE,
  JUDGE_TOP_P,
  judgeCompletionCapOf,
  validateModel,
  type GptRequestMapperOptions,
  type HeterogeneityOptions,
  type ModelValidationOptions,
} from "./gpt-request-mapper.js";
export { mapGptChatCompletionsResponse, type MappedGptResponse } from "./gpt-response-mapper.js";
export {
  DEFAULT_GPT_JUDGE_MAX_RETRIES,
  DEFAULT_GPT_JUDGE_RETRY_BASE_DELAY_MS,
  DEFAULT_GPT_JUDGE_TIMEOUT_MS,
  GptJudgeClient,
  hasJudgeApiKey,
  JUDGE_API_KEY_ENV_VAR,
  JUDGE_URL_ENV_VAR,
  JUDGE_URL_ENV_VARS,
  OPENAI_API_BASE_URL,
  OPENAI_API_KEY_ENV_VAR,
  OPENAI_URL_ENV_VAR,
  type GptJudgeClientOptions,
} from "./gpt-judge-client.js";
export {
  FakeJudgeClient,
  JudgeScriptExhaustedError,
  type FakeJudgeScriptStep,
} from "./fake-judge-client.js";
export { judgeFindings, type JudgeChainInput, type JudgeChainResult, type JudgeChainStatus } from "./chain.js";
export { createCampaignJudgeClient, type CampaignJudgeClientOptions } from "./campaign-adapter.js";
