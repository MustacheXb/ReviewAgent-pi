import { describe, expect, it } from "vitest";
import {
  classifyModelUpgrade,
  runMigrationGate,
  type MigrationGateDeps,
  type MigrationGateInput,
  type ProbeTarget,
  type SmokeProbeOutcome,
} from "../../src/gate/migration-gate.js";
import type { MRCase } from "../../src/instrument/contracts/mr-case.js";
import type { RunResult } from "../../src/instrument/contracts/run.js";
import type { ReviewKernel, UnitReviewRequest } from "../../src/experiment/review-kernel.js";

/**
 * 模型迁移门单测（#14，生产化四必做之三）：纯注入零 pi 依赖——fake 探针 +
 * fake ReviewKernel 离线全覆盖（门模块签名面无网关 key；真跑装配在
 * scripts/run-migration-gate.ts，真跑不进 CI——零网络纪律 #28）。
 *
 * 锁定面（TDD 预先约定的接缝）：
 * - flash→pro 高险判定纯函数口径：同族判高险；同族同档 / 降级 / 跨家族 /
 *   同 id（仅换网关）不判（家族按 id 前缀判定，口径见实现注释）；
 * - 编排串行语义（前步红即停）：探针红不烧单案真跑预算；高险未确认零网络；
 * - 每类失败路径人话诊断在场：探针报告透传 + 门级真跑失败归因（RUN_ERROR /
 *   MODEL_DRIFT / EMPTY_USAGE）+ 高险显式标记文案（§7.7 保守路线）；
 * - 生产入口 config E：单案请求恒 configId "E" + 目标模型 id + rep 1
 *   （2026-10-19 决策评论：冒烟口径 B → E）；
 * - 密钥哨兵：门结果全文本（JSON.stringify + report）零 key。
 */

const BASELINE_MODEL = "deepseek-v4-flash";
const TARGET_MODEL = "glm-5.3-flash";
const PRO_TARGET_MODEL = "deepseek-v4-pro";
const TARGET_BASE_URL = "https://gw.example.com/v1";
/** 密钥哨兵值（装配形态：真值只进闭包/环境变量，门模块签名面无 key 字段） */
const GATE_TEST_KEY = "sk-migration-gate-sentinel-0000";

const GATE_CASE: MRCase = {
  caseId: "VUL4J-38",
  repoPath: "D:/fixtures/vul4j-repos/VUL4J-38-ab6cbdc3da",
  diff: "--- a/x.java\n+++ b/x.java\n@@ -1 +1 @@\n-old\n+new\n",
  issueDescription: "Vulnerability CVE-2014-4172 (CWE-74) in jasig/cas-client.",
  truth: null,
  labels: { source: "vul4j", riskClass: "Medium", allowedConfigs: ["A", "B", "C", "D", "E"] },
};

function gateInput(overrides: Partial<MigrationGateInput> = {}): MigrationGateInput {
  return {
    baselineModelId: BASELINE_MODEL,
    targetModelId: TARGET_MODEL,
    targetBaseUrl: TARGET_BASE_URL,
    mrCase: GATE_CASE,
    experimentRoot: "D:/fixtures/runs/migration-gate",
    confirmHighRiskUpgrade: false,
    ...overrides,
  };
}

function greenRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    caseId: GATE_CASE.caseId,
    configId: "E",
    model: TARGET_MODEL,
    findings: [],
    usage: { inputTokens: 21_000, outputTokens: 4_800, cacheReadTokens: 5_100 },
    rounds: 3,
    toolCalls: 6,
    audit: {
      requests: [],
      toolCallLog: [],
      phaseLog: [],
      rejections: [],
      cacheBreaks: [],
      truncated: false,
      truncationReasons: [],
    },
    auditPath: "D:/fixtures/runs/migration-gate/audit/run-x.json",
    ...overrides,
  };
}

/** fake 探针缝：捕获每次目标参数（断言「换到什么探什么」+ 前步红即停） */
function probeHarness(
  respond: (target: ProbeTarget) => SmokeProbeOutcome | Promise<SmokeProbeOutcome>,
): { readonly runProbes: (target: ProbeTarget) => Promise<SmokeProbeOutcome>; readonly calls: readonly ProbeTarget[] } {
  const calls: ProbeTarget[] = [];
  return {
    runProbes: async (target) => {
      calls.push(target);
      return respond(target);
    },
    calls,
  };
}

/** fake 内核缝：捕获单案请求（断言 config E + 目标模型 + rep 1） */
function fakeKernel(
  respond: (request: UnitReviewRequest) => Promise<RunResult>,
): { readonly kernel: ReviewKernel; readonly requests: readonly UnitReviewRequest[] } {
  const requests: UnitReviewRequest[] = [];
  return {
    kernel: {
      id: "pi",
      execute: async (request) => {
        requests.push(request);
        return respond(request);
      },
    },
    requests,
  };
}

const GREEN_PROBE_REPORT =
  `smoke probes at ${TARGET_BASE_URL} (model ${TARGET_MODEL}): OK\n` +
  "[1/2] gateway health: gateway is up\n" +
  `[2/2] model reachability: model "${TARGET_MODEL}" is reachable`;

/** 门的 deps 装配（脚本同款形态；哨兵 key 只存在于本测试闭包可及范围） */
function gateDeps(
  probes: { readonly runProbes: (target: ProbeTarget) => Promise<SmokeProbeOutcome> },
  kernel: ReviewKernel,
): MigrationGateDeps {
  return {
    runProbes: async (target) => probes.runProbes(target),
    kernel,
  };
}

describe("classifyModelUpgrade — flash→pro 高险判定（纯函数，家族按 id 前缀）", () => {
  it("同族 flash→pro 判高险（deepseek-v4-flash → deepseek-v4-pro；pro 变体后缀同判）", () => {
    const classification = classifyModelUpgrade("deepseek-v4-flash", "deepseek-v4-pro");
    expect(classification.highRiskUpgrade).toBe(true);
    expect(classification.baselineFamily).toBe("deepseek");
    expect(classification.targetFamily).toBe("deepseek");
    expect(classification.baselineTier).toBe("flash");
    expect(classification.targetTier).toBe("pro");
    expect(classifyModelUpgrade("deepseek-v4-flash", "deepseek-v4-pro-preview").highRiskUpgrade).toBe(true);
  });

  it("glm 族同构判定（glm-5.3-flash → glm-5.3-pro 同判——口径对称，非 deepseek 特判）", () => {
    expect(classifyModelUpgrade("glm-5.3-flash", "glm-5.3-pro").highRiskUpgrade).toBe(true);
  });

  it("同族 flash→flash 不判（含版本化 GA 快照 id 与换代 id）", () => {
    expect(classifyModelUpgrade("deepseek-v4-flash", "deepseek-v4-flash-ga-260731").highRiskUpgrade).toBe(false);
    expect(classifyModelUpgrade("deepseek-v4-flash", "deepseek-v5-flash").highRiskUpgrade).toBe(false);
  });

  it("pro→flash 降级不判（消融验证项只拦升级方向）", () => {
    expect(classifyModelUpgrade("deepseek-v4-pro", "deepseek-v4-flash").highRiskUpgrade).toBe(false);
  });

  it("跨家族不判（deepseek flash → glm pro 是换家族迁移，非同族高险升级）", () => {
    const classification = classifyModelUpgrade("deepseek-v4-flash", "glm-5.3-pro");
    expect(classification.highRiskUpgrade).toBe(false);
    expect(classification.baselineFamily).toBe("deepseek");
    expect(classification.targetFamily).toBe("glm");
  });

  it("同 id（仅换网关）不判；非 flash 基线 → pro 不判；黏连 pro 段不判 pro 档", () => {
    expect(classifyModelUpgrade("deepseek-v4-flash", "deepseek-v4-flash").highRiskUpgrade).toBe(false);
    expect(classifyModelUpgrade("deepseek-reasoner", "deepseek-v4-pro").highRiskUpgrade).toBe(false);
    expect(classifyModelUpgrade("deepseek-v4-flash", "deepseek-v4-professional").highRiskUpgrade).toBe(false);
  });
});

describe("runMigrationGate — 编排（串行，前步红即停）", () => {
  it("探针红 → 门红（PROBES_FAILED）+ 探针诊断透传 + 单案真跑不执行", async () => {
    const probes = probeHarness(() => ({
      ok: false,
      report:
        `smoke probes at ${TARGET_BASE_URL} (model ${TARGET_MODEL}): FAILED\n` +
        `[2/2] model reachability: model "${TARGET_MODEL}" was not found (HTTP 404) at ${TARGET_BASE_URL}.`,
    }));
    const kernel = fakeKernel(async () => greenRunResult());
    const result = await runMigrationGate(gateDeps(probes, kernel.kernel), gateInput());

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("PROBES_FAILED");
    expect(result.report).toContain(`model "${TARGET_MODEL}" was not found`);
    expect(result.report).toContain("SKIPPED");
    expect(kernel.requests).toEqual([]);
    expect(probes.calls).toEqual([{ baseUrl: TARGET_BASE_URL, modelId: TARGET_MODEL }]);
  });

  it("探针绿 + 真跑抛错 → 门红（RUN_ERROR）+ 全链失败归因诊断 + 内核错误在场", async () => {
    const probes = probeHarness(() => ({ ok: true, report: GREEN_PROBE_REPORT }));
    const kernel = fakeKernel(async () => {
      throw new Error("pi kernel: gateway dropped the SSE stream mid-turn (request 3)");
    });
    const result = await runMigrationGate(gateDeps(probes, kernel.kernel), gateInput());

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("RUN_ERROR");
    expect(result.report).toContain("gateway dropped the SSE stream mid-turn");
    expect(result.report).toContain("config E");
    expect(result.report).toContain("serialization");
    expect(result.report).toContain("streaming");
  });

  it("探针绿 + 真跑模型漂移 → 门红（MODEL_DRIFT）：口径诚实护栏同款语义", async () => {
    const probes = probeHarness(() => ({ ok: true, report: GREEN_PROBE_REPORT }));
    const kernel = fakeKernel(async () => greenRunResult({ model: "deepseek-v4-flash" }));
    const result = await runMigrationGate(gateDeps(probes, kernel.kernel), gateInput());

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("MODEL_DRIFT");
    expect(result.report).toContain(`"${TARGET_MODEL}"`);
    expect(result.report).toContain('"deepseek-v4-flash"');
  });

  it("真跑完成但 usage 全零 → 门红（EMPTY_USAGE）：静默空流不是放行", async () => {
    const probes = probeHarness(() => ({ ok: true, report: GREEN_PROBE_REPORT }));
    const kernel = fakeKernel(async () => greenRunResult({ usage: { inputTokens: 0, outputTokens: 0 } }));
    const result = await runMigrationGate(gateDeps(probes, kernel.kernel), gateInput());

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("EMPTY_USAGE");
    expect(result.report).toContain("zero usage");
  });

  it("全绿 → 放行：报告 PASS + 单案摘要（轮次/工具/usage）+ 请求恒 config E / 目标模型 / rep 1", async () => {
    const probes = probeHarness(() => ({ ok: true, report: GREEN_PROBE_REPORT }));
    const kernel = fakeKernel(async (request) =>
      greenRunResult({ model: request.model, findings: greenRunResult().findings }),
    );
    const result = await runMigrationGate(gateDeps(probes, kernel.kernel), gateInput());

    expect(result.ok).toBe(true);
    expect(result.failureKind).toBeUndefined();
    expect(result.highRiskUpgrade).toBe(false);
    expect(result.report).toContain("PASS");
    expect(result.report).toContain("config E");
    expect(result.report).toContain("rounds 3");
    expect(result.report).toContain("toolCalls 6");
    expect(result.report).toContain("input 21000 / output 4800");
    expect(result.report).toContain(`model echo ${TARGET_MODEL}`);
    expect(probes.calls).toEqual([{ baseUrl: TARGET_BASE_URL, modelId: TARGET_MODEL }]);
    expect(kernel.requests).toHaveLength(1);
    expect(kernel.requests[0]).toMatchObject({
      unit: { source: "vul4j", caseId: GATE_CASE.caseId, configId: "E", rep: 1 },
      model: TARGET_MODEL,
      experimentRoot: gateInput().experimentRoot,
      mrCase: GATE_CASE,
    });
  });

  it("仅换网关（目标 id = 基线 id）→ 正常过门，报告注明 gateway-only migration", async () => {
    const probes = probeHarness(() => ({ ok: true, report: GREEN_PROBE_REPORT }));
    const kernel = fakeKernel(async (request) => greenRunResult({ model: request.model }));
    const result = await runMigrationGate(
      gateDeps(probes, kernel.kernel),
      gateInput({ targetModelId: BASELINE_MODEL }),
    );

    expect(result.ok).toBe(true);
    expect(result.report).toContain("gateway-only migration");
    expect(kernel.requests[0]?.model).toBe(BASELINE_MODEL);
  });

  it("同族非 pro 换代 / 未知档位基线 → 正常过门，报告注明家族与档位口径", async () => {
    const probes = probeHarness(() => ({ ok: true, report: GREEN_PROBE_REPORT }));
    const kernel = fakeKernel(async (request) => greenRunResult({ model: request.model }));

    const sameFamily = await runMigrationGate(
      gateDeps(probes, kernel.kernel),
      gateInput({ targetModelId: "deepseek-v5-flash" }),
    );
    expect(sameFamily.ok).toBe(true);
    expect(sameFamily.report).toContain("same-family move (deepseek: flash -> flash)");

    const unknownTierBaseline = await runMigrationGate(
      gateDeps(probes, kernel.kernel),
      gateInput({ baselineModelId: "deepseek-reasoner", targetModelId: "deepseek-v4-pro" }),
    );
    expect(unknownTierBaseline.ok).toBe(true);
    expect(unknownTierBaseline.report).toContain("unknown tier -> pro");
  });
});

describe("runMigrationGate — 高险升级门（flash→pro 显式标记，不默认启用）", () => {
  it("同族 flash→pro 未确认 → 红拒绝（HIGH_RISK_UPGRADE_UNCONFIRMED）+ 显式标记文案 + 零网络零真跑", async () => {
    const probes = probeHarness(() => ({ ok: true, report: GREEN_PROBE_REPORT }));
    const kernel = fakeKernel(async (request) => greenRunResult({ model: request.model }));
    const result = await runMigrationGate(
      gateDeps(probes, kernel.kernel),
      gateInput({ targetModelId: PRO_TARGET_MODEL }),
    );

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("HIGH_RISK_UPGRADE_UNCONFIRMED");
    expect(result.highRiskUpgrade).toBe(true);
    // 显式标记文案（§7.7 保守路线）：消融验证项 + 不默认启用 + 确认旗标指引
    expect(result.report).toContain("high-risk upgrade");
    expect(result.report).toContain("flash->pro");
    expect(result.report).toContain("ablation-verification item");
    expect(result.report).toContain("not a default production behavior");
    expect(result.report).toContain("--confirm-high-risk-upgrade");
    expect(probes.calls).toEqual([]);
    expect(kernel.requests).toEqual([]);
  });

  it("同族 flash→pro 已确认 → 正常跑门（探针 + 单案真跑照走，报告注明 CONFIRMED）", async () => {
    const probes = probeHarness(() => ({ ok: true, report: GREEN_PROBE_REPORT }));
    const kernel = fakeKernel(async (request) => greenRunResult({ model: request.model }));
    const result = await runMigrationGate(
      gateDeps(probes, kernel.kernel),
      gateInput({ targetModelId: PRO_TARGET_MODEL, confirmHighRiskUpgrade: true }),
    );

    expect(result.ok).toBe(true);
    expect(result.highRiskUpgrade).toBe(true);
    expect(result.report).toContain("CONFIRMED");
    expect(result.report).toContain("ablation-verification item");
    expect(probes.calls).toEqual([{ baseUrl: TARGET_BASE_URL, modelId: PRO_TARGET_MODEL }]);
    expect(kernel.requests[0]?.model).toBe(PRO_TARGET_MODEL);
  });
});

describe("runMigrationGate — 输入校验（装配面错误 fail fast，非门判定）", () => {
  it.each([
    ["targetModelId", { targetModelId: "  " }],
    ["targetBaseUrl", { targetBaseUrl: "" }],
    ["baselineModelId", { baselineModelId: "" }],
    ["experimentRoot", { experimentRoot: "" }],
    ["mrCase.caseId", { mrCase: { ...GATE_CASE, caseId: "" } }],
    ["mrCase.repoPath", { mrCase: { ...GATE_CASE, repoPath: "" } }],
  ])("空 %s → 抛装配错误（不进任何网络阶段）", async (_label, overrides) => {
    const probes = probeHarness(() => ({ ok: true, report: GREEN_PROBE_REPORT }));
    const kernel = fakeKernel(async () => greenRunResult());
    await expect(
      runMigrationGate(gateDeps(probes, kernel.kernel), gateInput(overrides as Partial<MigrationGateInput>)),
    ).rejects.toThrow("migration gate input");
    expect(probes.calls).toEqual([]);
  });
});

describe("runMigrationGate — 密钥哨兵（门结果零 key）", () => {
  it("全路径门结果（JSON.stringify + report）绝不包含网关 key 值", async () => {
    // 装配同脚本形态：key（此处哨兵值）只存在于闭包可及环境，门模块签名面无 key 字段；
    // 断言锁死回归——后续任何把装配上下文透传进门结果/诊断的改动立即红。
    const scenarios: readonly MigrationGateInput[] = [
      gateInput(),
      gateInput({ targetModelId: PRO_TARGET_MODEL }),
      gateInput({ targetModelId: PRO_TARGET_MODEL, confirmHighRiskUpgrade: true }),
    ];
    for (const input of scenarios) {
      const probes = probeHarness(() => ({ ok: true, report: GREEN_PROBE_REPORT }));
      const kernel = fakeKernel(async (request) => greenRunResult({ model: request.model }));
      const result = await runMigrationGate(gateDeps(probes, kernel.kernel), input);
      expect(`${JSON.stringify(result)}\n${result.report}`).not.toContain(GATE_TEST_KEY);
    }

    const failingProbes = probeHarness(() => ({
      ok: false,
      report: `smoke probes at ${TARGET_BASE_URL}: FAILED\n[2/2] model reachability: authentication failed`,
    }));
    const failingKernel = fakeKernel(async () => greenRunResult({ model: "other-model" }));
    const failResult = await runMigrationGate(
      gateDeps(failingProbes, failingKernel.kernel),
      gateInput({ confirmHighRiskUpgrade: false }),
    );
    expect(`${JSON.stringify(failResult)}\n${failResult.report}`).not.toContain(GATE_TEST_KEY);
  });
});
