import { hasJudgeApiKey } from "../judge/gpt-judge-client.js";
import { hasReviewerApiKey } from "review-llm";
import type { EnvLookup } from "review-llm";

/**
 * 真实冒烟门控（#40）：真实网关 / judge 调用烧真钱且依赖网络，必须由
 * 环境变量 `CAMPAIGN_REAL=1` 显式开启；默认关闭（零网络纪律，ADR-0016
 * 「真实网关 / 冒烟不进默认 CI」）。
 *
 * 凭据只做存在性判断（推荐名 + 兼容别名，与客户端解析同名同序），
 * 错误信息绝不回显 key 值。
 */

export const CAMPAIGN_REAL_ENV_VAR = "CAMPAIGN_REAL";

export function assertRealCampaignGate(env: EnvLookup = process.env): void {
  if (env[CAMPAIGN_REAL_ENV_VAR]?.trim() !== "1") {
    throw new Error(
      `real campaign run is gated: set ${CAMPAIGN_REAL_ENV_VAR}=1 to allow real gateway + judge calls ` +
        "(they cost money and need network; the deterministic suite never runs them). " +
        "Use --fake for the offline harness tracer bullet.",
    );
  }
  if (!hasReviewerApiKey(env)) {
    throw new Error(
      "real campaign run needs a reviewer API key: set REVIEWER_API_KEY " +
        "(or the legacy alias DEEPSEEK_API_KEY); the key is never logged or persisted.",
    );
  }
  if (!hasJudgeApiKey(env)) {
    throw new Error(
      "real campaign run needs a judge API key: set JUDGE_API_KEY " +
        "(or the legacy alias OPENAI_API_KEY); the key is never logged or persisted.",
    );
  }
}
