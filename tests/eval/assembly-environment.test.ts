import { describe, expect, it } from "vitest";
import { JUDGE_PROMPT_VERSION, JUDGE_TEMPERATURE, JUDGE_TOP_P } from "../../src/eval/judge/index.js";
import {
  classifyBaseUrl,
  classifyProvider,
  collectCampaignEnvironment,
  type CollectCampaignEnvironmentOptions,
  type GitRunner,
} from "../../src/eval/assembly/environment.js";

/**
 * `environment.json` provenance 采集（#40，附录 B.3）：已知值来自注入的
 * git / runtime / 端点；未知值一律 null（N/A，不写 0）；key 绝不落盘。
 */

function gitRunner(table: Readonly<Record<string, string | null>>): GitRunner {
  return (args) => table[args.join(" ")] ?? null;
}

const GIT = gitRunner({
  "rev-parse --abbrev-ref HEAD": "eval/bench",
  "rev-parse HEAD": "74c71d8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "describe --exact-match --tags HEAD": "eval-e-baseline-2026-11-11",
});

function collect(overrides: Partial<CollectCampaignEnvironmentOptions> = {}) {
  return collectCampaignEnvironment({
    model: "deepseek-v4-flash",
    judgeModel: "glm-5-3-260814",
    reviewerBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    git: GIT,
    nodeVersion: "v22.0.0",
    platform: "win32-x64",
    hostname: "eval-box",
    timezone: "Asia/Shanghai",
    ...overrides,
  });
}

describe("collectCampaignEnvironment — 完整 provenance", () => {
  it("记录 git / runtime / 模型 / 网关类别 / judge 版本 / 时间窗", () => {
    const env = collect();
    expect(env.git).toEqual({
      branch: "eval/bench",
      commit: "74c71d8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      tag: "eval-e-baseline-2026-11-11",
    });
    expect(env.runtime).toEqual({ node: "v22.0.0", os: "win32-x64", machine: "eval-box" });
    expect(env.model).toEqual({
      requestedId: "deepseek-v4-flash",
      actualDeployment: null,
      providerClass: "volcengine",
      baseUrlClass: "gateway-endpoint",
    });
    expect(env.judge).toEqual({
      model: "glm-5-3-260814",
      promptVersion: JUDGE_PROMPT_VERSION,
      temperature: JUDGE_TEMPERATURE,
      topP: JUDGE_TOP_P,
    });
    expect(env.window.timezone).toBe("Asia/Shanghai");
    // 运行窗口由 runner 在开跑 / 收尾时补齐
    expect(env.window.start).toBeNull();
    expect(env.window.end).toBeNull();
  });

  it("未知项一律 null（cache 探针 / Zone A / 工具 schema / Claude Code）", () => {
    const env = collect();
    expect(env.gateway).toEqual({ cacheProbeBefore: null, cacheProbeAfter: null });
    expect(env.prompts).toEqual({ zoneA: null, toolsSchema: null });
    expect(env.claudeCode).toEqual({
      cliVersion: null,
      requestedModel: null,
      actualModels: null,
      maxTurns: null,
    });
  });

  it("detached HEAD（branch = HEAD）归一为 null；无精确 tag → null", () => {
    const env = collect({
      git: gitRunner({
        "rev-parse --abbrev-ref HEAD": "HEAD",
        "rev-parse HEAD": "deadbeef",
      }),
    });
    expect(env.git.branch).toBeNull();
    expect(env.git.tag).toBeNull();
    expect(env.git.commit).toBe("deadbeef");
  });

  it("git 命令失败时对应字段 null，不抛错（provenance 不阻断运行）", () => {
    const env = collect({ git: () => null });
    expect(env.git).toEqual({ branch: null, commit: null, tag: null });
  });
});

describe("classifyProvider / classifyBaseUrl — 网关类别", () => {
  it("火山引擎网关 / 官方端点 / 本地端点 / 自定义网关", () => {
    expect(classifyProvider("https://ark.cn-beijing.volces.com/api/v3")).toBe("volcengine");
    expect(classifyBaseUrl("https://ark.cn-beijing.volces.com/api/v3")).toBe("gateway-endpoint");
    // 企业网关实际域名形态（volceapi）
    expect(classifyProvider("https://gw.apigateway-cn-beijing.volceapi.com/v1")).toBe(
      "volcengine",
    );
    expect(classifyBaseUrl("https://gw.apigateway-cn-beijing.volceapi.com/v1")).toBe(
      "gateway-endpoint",
    );
    expect(classifyProvider("https://api.deepseek.com")).toBe("deepseek");
    expect(classifyBaseUrl("https://api.deepseek.com")).toBe("official-endpoint");
    expect(classifyProvider("https://api.openai.com/v1")).toBe("openai");
    expect(classifyBaseUrl("https://api.openai.com/v1")).toBe("official-endpoint");
    expect(classifyProvider("http://127.0.0.1:8080/v1")).toBe("local");
    expect(classifyBaseUrl("http://127.0.0.1:8080/v1")).toBe("local-endpoint");
    expect(classifyProvider("https://gw.internal.example.com/v1")).toBe("custom");
    expect(classifyBaseUrl("https://gw.internal.example.com/v1")).toBe("gateway-endpoint");
  });

  it("端点缺失 / 非法 URL → null（N/A）", () => {
    expect(classifyProvider(null)).toBeNull();
    expect(classifyBaseUrl(null)).toBeNull();
    expect(classifyProvider("not a url")).toBeNull();
    expect(classifyBaseUrl("not a url")).toBeNull();
  });
});

describe("collectCampaignEnvironment — key 纪律", () => {
  it("注入的 API key 绝不出现在 provenance JSON 中", () => {
    const secret = "sk-super-secret-judge-key";
    const env = collect({
      reviewerBaseUrl: `https://gw.example.com/v1?token=${secret}`,
    });
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain(secret);
    // 只记类别，不记 URL 原文
    expect(serialized).not.toContain("gw.example.com");
  });

  it("端点 env 变量只读 URL，不读取 key 值", () => {
    const env = collect();
    expect(JSON.stringify(env)).not.toContain("Bearer");
    expect(env.model.requestedId).toBe("deepseek-v4-flash");
  });
});
