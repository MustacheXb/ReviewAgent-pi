import type { EnvLookup } from "review-llm";
import { resolveReviewerEndpoint } from "review-pi";
import type { CampaignDeps, CampaignEnvironmentInput } from "../campaign/contracts.js";
import { createRealCampaignDeps, resolveJudgeEnv } from "./deps.js";
import { collectCampaignEnvironment, type GitRunner } from "./environment.js";
import { assertRealCampaignGate } from "./gate.js";

/**
 * 真实 campaign 装配（#40）：门控 → reviewer / judge 端点解析 → 依赖 +
 * `environment.json` provenance 一揽子产出。
 *
 * 调用侧（进程入口）只提供 campaign 身份（模型 / judge 模型 / 可选校准 ref）
 * 与注入缝；key 只进闭包，不出现在返回值与错误信息中。
 */

export interface PrepareRealCampaignOptions {
  /** 被测模型 id（与 plan.model 一致） */
  readonly model: string;
  /** judge 模型 id（必须与被测模型异构） */
  readonly judgeModel: string;
  /**
   * 空对照校准 campaign ref（ADR-0017 §5）；未做过校准 = null。
   * 注意：这不是 E 基线 ref——baseline ref 在 plan.json，不冒充校准锚。
   */
  readonly calibrationRef?: string | null;
  /** env 注入（测试）；缺省 process.env */
  readonly env?: EnvLookup;
  /** 默认 git runner 的工作目录（仓库根） */
  readonly repoRoot?: string;
  /** git 命令注入（测试） */
  readonly git?: GitRunner;
  /** fetch 注入（测试零网络；缺省 globalThis.fetch） */
  readonly fetchFn?: typeof fetch;
  readonly kernelTimeoutMs?: number;
  readonly judgeTimeoutMs?: number;
}

export interface RealCampaignSetup {
  readonly deps: CampaignDeps;
  readonly environment: CampaignEnvironmentInput;
}

export function prepareRealCampaign(options: PrepareRealCampaignOptions): RealCampaignSetup {
  const env = options.env ?? process.env;
  assertRealCampaignGate(env);
  const reviewer = resolveReviewerEndpoint(env);
  const judgeEnv = resolveJudgeEnv(env);
  if (judgeEnv === null) {
    // assertRealCampaignGate 已覆盖；保留显式守卫防将来门控调整后静默错配
    throw new Error(
      "real campaign run needs a judge API key: set JUDGE_API_KEY (or OPENAI_API_KEY)",
    );
  }
  const deps = createRealCampaignDeps({
    model: options.model,
    judgeModel: options.judgeModel,
    reviewerApiKey: reviewer.apiKey,
    reviewerBaseUrl: reviewer.baseUrl,
    judgeApiKey: judgeEnv.apiKey,
    judgeBaseUrl: judgeEnv.baseUrl,
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    ...(options.kernelTimeoutMs !== undefined ? { kernelTimeoutMs: options.kernelTimeoutMs } : {}),
    ...(options.judgeTimeoutMs !== undefined ? { judgeTimeoutMs: options.judgeTimeoutMs } : {}),
  });
  const environment = collectCampaignEnvironment({
    model: options.model,
    judgeModel: options.judgeModel,
    reviewerBaseUrl: reviewer.baseUrl,
    calibrationRef: options.calibrationRef ?? null,
    ...(options.git !== undefined ? { git: options.git } : {}),
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
  });
  return { deps, environment };
}
