import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/instrument/contracts/finding.js";
import type { MRCase } from "../../src/instrument/contracts/mr-case.js";
import type { EvalRunRecord } from "../../src/eval/campaign/contracts.js";
import {
  createRealCampaignDeps,
  resolveJudgeEnv,
} from "../../src/eval/assembly/deps.js";

/**
 * 真实依赖装配（#40）：pi 内核 + 真实 judge 客户端。构造期零网络；
 * 模型异构约束与 key 纪律在构造期生效。
 */

const BASE_OPTIONS = {
  model: "deepseek-v4-flash",
  judgeModel: "glm-5-3-260814",
  reviewerApiKey: "reviewer-secret",
  reviewerBaseUrl: "https://gateway.example.com/v1",
  judgeApiKey: "judge-secret",
  judgeBaseUrl: "https://gateway.example.com/v1",
} as const;

describe("createRealCampaignDeps — 装配", () => {
  it("返回 pi 内核 + campaign judge 适配器；不触达网络", () => {
    const deps = createRealCampaignDeps(BASE_OPTIONS);
    expect(deps.kernel.id).toBe("pi");
    expect(typeof deps.kernel.execute).toBe("function");
    expect(typeof deps.judge.judge).toBe("function");
    expect(deps.kernelTimeoutMs).toBeGreaterThan(0);
    expect(deps.judgeTimeoutMs).toBeGreaterThan(0);
    expect(deps.ioTimeoutMs).toBeGreaterThan(0);
  });

  it("judge 与被测模型同源时构造期拒绝（异构约束）", () => {
    expect(() =>
      createRealCampaignDeps({ ...BASE_OPTIONS, judgeModel: "deepseek-v4-flash" }),
    ).toThrowError(/heterogeneous/);
  });

  it("judge 模型族的 wire 容量不可服务时构造期拒绝（不浪费整批运行）", () => {
    // deepseek judge + glm 被测：异构通过，但官方端点的 thinking wire 不序列化
    // max_tokens，无法服务 judge wire（无自定义接入点回落）
    expect(() =>
      createRealCampaignDeps({
        model: "glm-4.7",
        judgeModel: "deepseek-v4-pro",
        reviewerApiKey: "reviewer-secret",
        judgeApiKey: "judge-secret",
      }),
    ).toThrowError(/serializes no max_tokens/);
  });

  it("key 缺失在构造期 fail fast（不回显 key 值）", () => {
    expect(() => createRealCampaignDeps({ ...BASE_OPTIONS, reviewerApiKey: " " })).toThrowError(
      /key is missing/,
    );
    expect(() => createRealCampaignDeps({ ...BASE_OPTIONS, judgeApiKey: "" })).toThrowError(
      /key is missing/,
    );
  });

  it("judge 请求 wire 使用配置的 judge 模型（不是客户端默认 gpt-5.2-pro）", async () => {
    const requests: RecordedRequest[] = [];
    const deps = createRealCampaignDeps({
      ...BASE_OPTIONS,
      fetchFn: async (input, init) => {
        requests.push({
          url: typeof input === "string" ? input : String(input),
          body: typeof init?.body === "string" ? init.body : "",
        });
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: JSON.stringify({ matches: [] }) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await deps.judge.judge({ campaignId: "c", arm: "baseline", rep: 1, mrCase: CASE, record: RECORD });

    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0]?.body ?? "{}") as { model?: string; max_tokens?: number };
    expect(body.model).toBe("glm-5-3-260814");
    // glm 画像 32768 信封（推理模型 completion 含 reasoning tokens）
    expect(body.max_tokens).toBe(32_768);
  });
});

interface RecordedRequest {
  readonly url: string;
  readonly body: string;
}

const FINDING: Finding = {
  id: "F001",
  severity: "P2",
  category: "SECURITY",
  file: "src/A.java",
  line: 11,
  title: "issue",
  description: "description",
  evidence: ["evidence"],
  rule: "R1",
  confidence: 0.8,
};

const CASE: MRCase = {
  caseId: "VUL4J-1",
  repoPath: ".cache/repo",
  diff: "diff",
  issueDescription: "issue",
  truth: {
    locations: [{ file: "src/A.java", lineStart: 10, lineEnd: 12, defectNature: "SECURITY" }],
    fixPatch: "patch",
  },
  labels: { source: "vul4j", riskClass: "High", allowedConfigs: ["E"] },
};

const RECORD: EvalRunRecord = {
  source: "vul4j",
  caseId: "VUL4J-1",
  configId: "E",
  rep: 1,
  model: "deepseek-v4-flash",
  verifier: "off",
  completedAt: "2026-11-11T00:00:00.000Z",
  baseline: {
    findings: [FINDING],
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 },
    rounds: 1,
    toolCalls: 1,
    audit: {
      toolCallLog: [],
      phaseLog: [],
      rejections: [],
      truncated: false,
      truncationReasons: [],
    },
    auditPath: "",
  },
  effective: null,
  verifierPass: null,
  campaignId: "c",
  arm: "baseline",
  evalOnly: true,
  environmentRef: "environment.json",
};

describe("resolveJudgeEnv — judge 角色环境变量解析", () => {
  it("推荐名优先于旧名；空白推荐名回落旧名", () => {
    expect(resolveJudgeEnv({ JUDGE_API_KEY: "new", OPENAI_API_KEY: "old" })).toEqual({
      apiKey: "new",
      baseUrl: null,
    });
    expect(resolveJudgeEnv({ JUDGE_API_KEY: " ", OPENAI_API_KEY: "old" })).toEqual({
      apiKey: "old",
      baseUrl: null,
    });
  });

  it("JUDGE_URL 优先于 OPENAI_URL；缺失为 null", () => {
    expect(
      resolveJudgeEnv({
        JUDGE_API_KEY: "k",
        JUDGE_URL: "https://new.example.com/v1",
        OPENAI_URL: "https://old.example.com/v1",
      }),
    ).toEqual({ apiKey: "k", baseUrl: "https://new.example.com/v1" });
    expect(resolveJudgeEnv({ JUDGE_API_KEY: "k" })).toEqual({ apiKey: "k", baseUrl: null });
  });

  it("无任何 key → null（调用方报门控错误）", () => {
    expect(resolveJudgeEnv({})).toBeNull();
  });
});
