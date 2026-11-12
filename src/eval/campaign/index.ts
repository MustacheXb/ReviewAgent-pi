/**
 * Campaign runner（#39 骨架 / #40 真实装配接线，eval-only）：计划 → 单元执行
 * → 记录 → 报告。
 *
 * 落位纪律（ADR-0016）：本目录只在长期 `eval/bench` 分支；生产入口不得
 * import。本目录零网络：真实内核 / judge 装配在 `src/eval/assembly`，由进程
 * 入口在 `CAMPAIGN_REAL=1` 门控后注入；默认测试仍用 fake，零网络。
 */
export {
  campaignExitCode,
  parseCampaignArgs,
  runCampaignCommand,
  type CampaignCliOptions,
  type CampaignCommandResult,
  type CampaignReportOnlyCliOptions,
  type CampaignRunCliOptions,
  type CampaignRunRuntimeOptions,
} from "./cli.js";
export {
  CAMPAIGN_ARMS,
  CAMPAIGN_ARM_ORDERS,
  CAMPAIGN_REPORT_KIND,
  CAMPAIGN_REPORT_SCHEMA_VERSION,
  DEFAULT_ARM_ORDER_SEED,
  DEFAULT_IO_TIMEOUT_MS,
  ENVIRONMENT_REF,
  type CampaignArm,
  type CampaignArmOrder,
  type CampaignCase,
  type CampaignDeps,
  type CampaignEnvironmentInput,
  type CampaignFailure,
  type CampaignFailureStage,
  type CampaignPlan,
  type CampaignReport,
  type CampaignRunResult,
  type CampaignUnit,
  type CacheProbe,
  type EnvironmentManifest,
  type EvalRunRecord,
  type JudgeClient,
  type JudgeRecord,
  type JudgeRequest,
  type RunCampaignOptions,
} from "./contracts.js";
export { expandUnits, parseCampaignCases, validateCampaignCases, validateCampaignPlan } from "./plan.js";
export {
  rebuildCampaignReport,
  type CampaignRebuildResult,
  type RebuildCampaignReportOptions,
} from "./rebuild.js";
export { runCampaign } from "./runner.js";
