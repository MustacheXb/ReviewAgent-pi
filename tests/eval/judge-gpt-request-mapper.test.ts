import { describe, expect, it } from "vitest";
import type { JudgeRequest } from "../../src/eval/judge/contracts.js";
import {
  buildGptJudgeBody,
  JUDGE_TEMPERATURE,
  JUDGE_TOP_P,
  judgeCompletionCapOf,
  validateModel,
} from "../../src/eval/judge/gpt-request-mapper.js";

/**
 * 请求体构造（#39 起模型族感知 completion 预算；#42 起预算来源切换为共享包
 * provider 参数画像表 review-llm/profileOf——glm 32768 / 未知模型默认 8192）。
 * 语义界定——max_tokens 是防截断的容量上界，不是校准参数：
 * temperature / top_p 对所有模型恒论文锁值；8192 锚按 gpt-5.2-pro
 * 纯内容剖面所定，glm-5.3 等推理模型 completion 含 reasoning tokens
 * （#34 探针实测 3-finding 裁定 reasoning≈6k，8192 被 reasoning 吃满后
 * content=0 直接截断），需更大信封。
 */

function minimalRequest(): JudgeRequest {
  return {
    caseId: "case-001",
    findings: [
      { id: "F001", title: "t", description: "d", file: "f", line: 1, category: null, evidence: [] },
    ],
    truths: [
      { id: "TRUTH-1", title: "t", description: "d", file: null, lineStart: null, lineEnd: null, category: null, severity: null },
    ],
    context: null,
  };
}

describe("judgeCompletionCapOf — 画像表驱动 completion 预算（#42）", () => {
  it("缺省 gpt-5.2-pro 走默认画像 = 论文协议锚 8192（容量回归锁定，不随本票漂移）", () => {
    expect(judgeCompletionCapOf("gpt-5.2-pro")).toBe(8_192);
  });

  it("glm 系推理模型 = 画像表 32768 信封（#39 实测需求 6447 的 5 倍余量）", () => {
    expect(judgeCompletionCapOf("glm-5-3-260814")).toBe(32_768);
  });

  it("未知模型走保守默认画像 8192（自定义网关模型不 400、不静默截断）", () => {
    expect(judgeCompletionCapOf("qwen3.8-flash")).toBe(8_192);
    expect(judgeCompletionCapOf("MiniMax-M3")).toBe(8_192);
  });

  it("画像不序列化 max_tokens 的模型族（deepseek thinking wire）fail fast", () => {
    // judge wire 恒发 max_tokens（论文协议形状）；未经 #43 降级时
    // validateModel 先拒 deepseek 系 id，此处锚定直查时的防御边界
    expect(() => judgeCompletionCapOf("deepseek-v4-flash")).toThrowError(
      /serializes no max_tokens/,
    );
  });

  it("降级下（#43）deepseek 系回落保守默认信封 8192——降级是为了不阻断（spec #40 user story 6）", () => {
    // 预检降级（warning）必然发生在自定义接入点部署上，回落以 customLlmEndpoint 为键
    expect(judgeCompletionCapOf("deepseek-v4-flash", { customLlmEndpoint: true })).toBe(8_192);
    expect(judgeCompletionCapOf("deepseek-v4-pro", { customLlmEndpoint: true })).toBe(8_192);
  });

  it("回落单键 = 自定义接入点部署：官方端点上 deepseek 家族 wire 恒 fail fast（防御边界不松动）", () => {
    // 异构判定通过（reviewerModel 对照）不等于 wire 可服务：官方 DeepSeek 端点
    // 的 thinking wire 不序列化 max_tokens，不能服务恒发 max_tokens 的 judge wire
    expect(() => judgeCompletionCapOf("deepseek-v4-flash", { reviewerModel: "glm-4.7" })).toThrowError(
      /serializes no max_tokens/,
    );
  });

  it("自定义接入点不改变有信封家族的预算（glm 32768 / 未知 8192 原样）", () => {
    expect(judgeCompletionCapOf("glm-5-3-260814", { customLlmEndpoint: true })).toBe(32_768);
    expect(judgeCompletionCapOf("qwen3.8-flash", { customLlmEndpoint: true })).toBe(8_192);
  });
});

describe("buildGptJudgeBody — max_tokens 随画像表、协议参数不漂移（#39/#42）", () => {
  it("缺省（gpt-5.2-pro）max_tokens = 8192 论文锚", () => {
    const body = buildGptJudgeBody(minimalRequest());
    expect(body.model).toBe("gpt-5.2-pro");
    expect(body.max_tokens).toBe(8_192);
  });

  it("glm-5.3 max_tokens = 画像表 32768；temperature / top_p 仍论文锁值", () => {
    const body = buildGptJudgeBody(minimalRequest(), { model: "glm-5-3-260814" });
    expect(body.model).toBe("glm-5-3-260814");
    expect(body.max_tokens).toBe(32_768);
    // 校准参数不随模型漂移（#39 票面语义界定：容量 ≠ 协议）
    expect(body.temperature).toBe(JUDGE_TEMPERATURE);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(JUDGE_TOP_P);
    expect(body.top_p).toBe(0.95);
  });

  it("未知模型（自定义网关 id）走默认画像 8192 信封（#42 自定义 endpoint 首个受益面）", () => {
    const body = buildGptJudgeBody(minimalRequest(), { model: "qwen3.8-flash" });
    expect(body.model).toBe("qwen3.8-flash");
    expect(body.max_tokens).toBe(8_192);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.95);
  });

  it("自定义接入点部署（#43）：deepseek 系 judge 模型可出 wire（预检降级 + 接入点标记双到场 = warned 路径全形状）", () => {
    const body = buildGptJudgeBody(minimalRequest(), {
      model: "deepseek-v4-flash",
      heterogeneityDowngraded: true,
      customLlmEndpoint: true,
    });
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.max_tokens).toBe(8_192);
    // 校准参数不随降级漂移（协议形状恒定）
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.95);
  });

  it("customLlmEndpoint 单关注点：只管信封回落，不放松同源拒绝", () => {
    // 同源拒绝的跳过键是 heterogeneityDowngraded（预检判定），不是接入点标记
    expect(() =>
      buildGptJudgeBody(minimalRequest(), { model: "deepseek-v4-flash", customLlmEndpoint: true }),
    ).toThrowError(/heterogeneous/);
  });

  it("reviewerModel 对照（#43）：deepseek 系 judge + glm 被测异构放行，但官方端点 cap 仍 fail fast", () => {
    // 分层锚定：异构判定（validateModel）通过 ≠ wire 可服务（cap）——
    // 官方 DeepSeek 端点的 deepseek id 需自定义网关（customLlmEndpoint）才能出 wire
    expect(() =>
      buildGptJudgeBody(minimalRequest(), { model: "deepseek-v4-flash", reviewerModel: "glm-4.7" }),
    ).toThrowError(/serializes no max_tokens/);
  });

  it("reviewerModel 对照 + 自定义接入点（#43）：deepseek 系 judge + glm 被测可出 wire", () => {
    const body = buildGptJudgeBody(minimalRequest(), {
      model: "deepseek-v4-flash",
      reviewerModel: "glm-4.7",
      customLlmEndpoint: true,
    });
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.max_tokens).toBe(8_192);
  });

  it("无对照信息时 buildGptJudgeBody 仍拒 deepseek 系（客户端直用防御边界：保守假设被测为 DeepSeek）", () => {
    expect(() => buildGptJudgeBody(minimalRequest(), { model: "deepseek-v4-flash" })).toThrowError(
      /heterogeneous/,
    );
  });
});

describe("validateModel — 异构判定以被测模型为对照系（#43）", () => {
  it("reviewerModel 对照：deepseek 系 judge + glm 被测 → 放行（自由 id 双向异构）", () => {
    expect(validateModel("deepseek-v4-flash", { reviewerModel: "glm-4.7" })).toBe("deepseek-v4-flash");
  });

  it("reviewerModel 对照：同家族 / 精确同 id → 拒绝", () => {
    expect(() => validateModel("glm-5-3-260814", { reviewerModel: "glm-4.7" })).toThrowError(/heterogeneous/);
    expect(() => validateModel("qwen3.8-flash", { reviewerModel: "qwen3.8-flash" })).toThrowError(/heterogeneous/);
  });

  it("heterogeneityDowngraded = true：同源 id 放行（预检已 warning，客户端不重复拒绝）", () => {
    expect(
      validateModel("deepseek-v4-flash", { reviewerModel: "deepseek-v4-pro", heterogeneityDowngraded: true }),
    ).toBe("deepseek-v4-flash");
  });

  it("降级不松动非空校验（空串/空白仍拒）", () => {
    expect(() => validateModel("", { heterogeneityDowngraded: true })).toThrowError(
      /non-empty string/,
    );
    expect(() => validateModel("   ", { heterogeneityDowngraded: true })).toThrowError(
      /non-empty string/,
    );
  });

  it("缺省 reviewerModel = 保守假设被测为 DeepSeek 系（直用客户端路径行为不变）", () => {
    expect(() => validateModel("deepseek-v4-flash")).toThrowError(/heterogeneous/);
    expect(() => validateModel("deepseek-v4-flash", { heterogeneityDowngraded: false })).toThrowError(
      /heterogeneous/,
    );
    expect(validateModel("glm-5-3-260814")).toBe("glm-5-3-260814");
  });
});
