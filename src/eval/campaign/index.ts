/**
 * Campaign runner（#39，eval-only）：计划 → 单元执行 → 记录 → 报告。
 *
 * 落位纪律（ADR-0016）：本目录只在长期 `eval/bench` 分支；生产入口不得
 * import。骨架阶段注入 fake `ReviewKernel` / `JudgeClient`，默认测试零网络。
 */
export {
  campaignExitCode,
  parseCampaignArgs,
  runCampaignCommand,
  type CampaignCliOptions,
  type CampaignCommandResult,
  type CampaignReportOnlyCliOptions,
  type CampaignRunCliOptions,
} from "./cli.js";
export {
  CAMPAIGN_ARMS,
  CAMPAIGN_REPORT_KIND,
  CAMPAIGN_REPORT_SCHEMA_VERSION,
  ENVIRONMENT_REF,
  type CampaignArm,
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
export { rebuildCampaignReport, type RebuildCampaignReportOptions } from "./rebuild.js";
export { runCampaign } from "./runner.js";
