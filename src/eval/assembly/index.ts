/**
 * 真实评测装配（#40，eval-only）：pi 内核 + judge 链 + environment provenance。
 *
 * 与 `src/eval/campaign` 的分工（ADR-0016）：
 * - campaign 核心保持零网络、零真实执行入口（依赖注入）；
 * - 本目录是唯一的真实装配面，由进程入口 `scripts/run-campaign.ts` 在
 *   `CAMPAIGN_REAL=1` 门控后调用；生产入口不得 import。
 */
export {
  DEFAULT_JUDGE_TIMEOUT_MS,
  DEFAULT_KERNEL_TIMEOUT_MS,
  createRealCampaignDeps,
  resolveJudgeEnv,
  type JudgeRoleEnv,
  type RealCampaignDepsOptions,
} from "./deps.js";
export { extractValueFlag, type ExtractValueFlagResult } from "./args.js";
export {
  baselineSubprocessKernel,
  type BaselineSubprocessKernelOptions,
} from "./baseline-kernel.js";
export {
  classifyBaseUrl,
  classifyProvider,
  collectCampaignEnvironment,
  type BaseUrlClass,
  type CollectCampaignEnvironmentOptions,
  type GitRunner,
  type ProviderClass,
} from "./environment.js";
export { CAMPAIGN_REAL_ENV_VAR, assertRealCampaignGate } from "./gate.js";
export {
  prepareRealCampaign,
  type PrepareRealCampaignOptions,
  type RealCampaignSetup,
} from "./run.js";
