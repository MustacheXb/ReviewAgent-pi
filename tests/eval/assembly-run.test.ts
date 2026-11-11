import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_REAL_ENV_VAR,
  prepareRealCampaign,
  type GitRunner,
} from "../../src/eval/assembly/index.js";

/**
 * 真实 campaign 装配缝（#40）：门控 → 端点解析 → 依赖 + provenance。
 * 构造期零网络；key 只进闭包、不进返回值。
 */

const GIT: GitRunner = (args) => {
  const command = args.join(" ");
  if (command === "rev-parse --abbrev-ref HEAD") return "eval/bench";
  if (command === "rev-parse HEAD") return "0123456789abcdef";
  return null;
};

const ENV = {
  [CAMPAIGN_REAL_ENV_VAR]: "1",
  REVIEWER_API_KEY: "reviewer-secret",
  REVIEWER_URL: "https://ark.cn-beijing.volces.com/api/v3",
  JUDGE_API_KEY: "judge-secret",
  JUDGE_URL: "https://ark.cn-beijing.volces.com/api/v3",
};

const OPTIONS = {
  model: "deepseek-v4-flash",
  judgeModel: "glm-5-3-260814",
  env: ENV,
  git: GIT,
} as const;

describe("prepareRealCampaign — 装配与 provenance", () => {
  it("门控关闭时拒绝（真实冒烟不进默认路径）", () => {
    expect(() =>
      prepareRealCampaign({ ...OPTIONS, env: { ...ENV, [CAMPAIGN_REAL_ENV_VAR]: undefined } }),
    ).toThrowError(/CAMPAIGN_REAL/);
  });

  it("门控开启时返回真实依赖与完整 provenance", () => {
    const setup = prepareRealCampaign(OPTIONS);
    expect(setup.deps.kernel.id).toBe("pi");
    expect(setup.deps.kernelTimeoutMs).toBeGreaterThan(0);
    expect(setup.deps.judgeTimeoutMs).toBeGreaterThan(0);
    expect(setup.environment).toMatchObject({
      evaluation: { branch: "eval/bench", calibrationRef: null },
      git: { branch: "eval/bench", commit: "0123456789abcdef", tag: null },
      model: {
        requestedId: "deepseek-v4-flash",
        providerClass: "volcengine",
        baseUrlClass: "gateway-endpoint",
      },
      judge: { model: "glm-5-3-260814" },
    });
  });

  it("显式 calibrationRef 透传（未提供 = null，不拿 baseline ref 冒充）", () => {
    const setup = prepareRealCampaign({ ...OPTIONS, calibrationRef: "null-control-2026-11-11" });
    expect(setup.environment.evaluation.calibrationRef).toBe("null-control-2026-11-11");
  });

  it("provenance 序列化不含 key 值", () => {
    const setup = prepareRealCampaign(OPTIONS);
    const serialized = JSON.stringify(setup.environment);
    expect(serialized).not.toContain("reviewer-secret");
    expect(serialized).not.toContain("judge-secret");
  });

  it("judge 与被测模型同源时开跑前拒绝", () => {
    expect(() =>
      prepareRealCampaign({ ...OPTIONS, judgeModel: "deepseek-v4-flash" }),
    ).toThrowError(/heterogeneous/);
  });

  it("缺 judge key 时拒绝并列出环境变量名", () => {
    expect(() =>
      prepareRealCampaign({ ...OPTIONS, env: { ...ENV, JUDGE_API_KEY: undefined } }),
    ).toThrowError(/JUDGE_API_KEY/);
  });
});
