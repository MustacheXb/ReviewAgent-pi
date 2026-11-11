import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_REAL_ENV_VAR,
  assertRealCampaignGate,
} from "../../src/eval/assembly/gate.js";

/**
 * 真实冒烟门控（#40）：真实网关 / judge 调用必须由环境变量显式开启，
 * 默认关闭（零网络纪律）；缺凭据 fail fast 且错误信息不回显 key 值。
 */

const OK_ENV = {
  [CAMPAIGN_REAL_ENV_VAR]: "1",
  REVIEWER_API_KEY: "reviewer-secret",
  JUDGE_API_KEY: "judge-secret",
};

describe("assertRealCampaignGate — 环境变量门控", () => {
  it("缺 CAMPAIGN_REAL=1 时拒绝真实运行并给出开启方式", () => {
    expect(() => assertRealCampaignGate({ ...OK_ENV, [CAMPAIGN_REAL_ENV_VAR]: undefined })).toThrowError(
      /CAMPAIGN_REAL/,
    );
    expect(() => assertRealCampaignGate({ ...OK_ENV, [CAMPAIGN_REAL_ENV_VAR]: "0" })).toThrowError(
      /CAMPAIGN_REAL/,
    );
  });

  it("门控开启但缺 reviewer key → 报缺 REVIEWER_API_KEY（别名一并列出）", () => {
    expect(() =>
      assertRealCampaignGate({ [CAMPAIGN_REAL_ENV_VAR]: "1", JUDGE_API_KEY: "judge-secret" }),
    ).toThrowError(/REVIEWER_API_KEY/);
  });

  it("门控开启但缺 judge key → 报缺 JUDGE_API_KEY / OPENAI_API_KEY", () => {
    expect(() =>
      assertRealCampaignGate({ [CAMPAIGN_REAL_ENV_VAR]: "1", REVIEWER_API_KEY: "reviewer-secret" }),
    ).toThrowError(/JUDGE_API_KEY/);
  });

  it("全部就绪时通过", () => {
    expect(() => assertRealCampaignGate(OK_ENV)).not.toThrow();
  });

  it("错误信息不回显 key 值", () => {
    try {
      assertRealCampaignGate({ [CAMPAIGN_REAL_ENV_VAR]: "1", REVIEWER_API_KEY: "reviewer-secret" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain("reviewer-secret");
    }
  });

  it("空白 key 视为未设置；旧名 OPENAI_API_KEY / DEEPSEEK_API_KEY 兼容", () => {
    expect(() =>
      assertRealCampaignGate({ [CAMPAIGN_REAL_ENV_VAR]: "1", REVIEWER_API_KEY: " " }),
    ).toThrowError(/REVIEWER_API_KEY/);
    expect(() =>
      assertRealCampaignGate({
        [CAMPAIGN_REAL_ENV_VAR]: "1",
        DEEPSEEK_API_KEY: "reviewer-legacy",
        OPENAI_API_KEY: "judge-legacy",
      }),
    ).not.toThrow();
  });
});
