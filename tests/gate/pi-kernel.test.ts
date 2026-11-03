import { describe, expect, it } from "vitest";
import type { ReviewRunInput, ReviewRunResult, RunSnapshot } from "review-pi";
import { piKernel, type PiKernelDeps } from "../../src/gate/pi-kernel.js";
import type { MRCase } from "../../src/instrument/contracts/mr-case.js";
import type { RunResult } from "../../src/instrument/contracts/run.js";
import type { UnitReviewRequest } from "../../src/gate/review-kernel.js";

/**
 * pi 内核适配器单测（#8 P4a 执行缝的 pi 侧；#32 缝随评测装置删除落位
 * src/gate）：runReviewFn 注入缝离线全覆盖——真内核不进测试（零网络纪律
 * #28，真跑装配在 scripts/run-migration-gate.ts），装配与映射纪律在 fake
 * 回环上锁定。
 *
 * 锁定面（接缝 = PiKernelDeps.runReviewFn，模块注释明定「测试桩；缺省真
 * pi 内核」）：
 * - source 守卫：非 vul4j 单元 fail fast——不调内核、不产半截结果，错误
 *   消息自证单元（source/caseId/configId/rep）与退役缘由；
 * - 装配纪律：UnitReviewRequest → ReviewRunInput 逐字段映射（persistRecord
 *   恒 false；baseUrl 缺席省键；experimentRoot 拆 runsRoot/experimentId；
 *   fetch 引用透传；无 configId——v3 起配置由内核单源派生，ADR-0015）；
 * - 映射纪律：pi RunRecord.baseline → 根仓 RunResult（requests 恒 []、
 *   cacheBreaks 缺省补 []、model 取内核记录而非请求目标、ledger /
 *   domainWarning 在场透传缺席省键、auditPath 透传）。
 */

const KERNEL_API_KEY = "sk-pi-kernel-adapter-sentinel-0000";
const GATE_BASE_URL = "https://gw.example.com/v1";
const TARGET_MODEL = "glm-5.3-flash";
/** 内核记录的模型 id——与请求目标刻意不同，锁定「model 取内核记录」纪律 */
const KERNEL_MODEL = "deepseek-v4-pro";
const EXPERIMENT_ROOT = "D:/fixtures/runs/migration-gate";
const AUDIT_PATH =
  "D:/fixtures/runs/migration-gate/audit/vul4j/VUL4J-38/E/rep-1/audit/audit.json";

const MR_CASE: MRCase = {
  caseId: "VUL4J-38",
  repoPath: "D:/fixtures/vul4j-repos/VUL4J-38-ab6cbdc3da",
  diff: "--- a/x.java\n+++ b/x.java\n@@ -1 +1 @@\n-old\n+new\n",
  issueDescription: "Vulnerability CVE-2014-4172 (CWE-74) in jasig/cas-client.",
  truth: null,
  labels: { source: "vul4j", riskClass: "Medium", allowedConfigs: ["A", "B", "C", "D", "E"] },
};

/** fetch 传输哨兵：runReviewFn 被 fake 时内核传输面绝不该被触碰 */
const FETCH_SENTINEL: ReviewRunInput["fetch"] = async () => {
  throw new Error("fetch must not be called: runReview is faked in this suite");
};

function unitRequest(overrides: Partial<UnitReviewRequest> = {}): UnitReviewRequest {
  return {
    unit: { source: "vul4j", caseId: MR_CASE.caseId, configId: "E", rep: 1 },
    mrCase: MR_CASE,
    model: TARGET_MODEL,
    experimentRoot: EXPERIMENT_ROOT,
    ...overrides,
  };
}

function piSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    findings: [],
    usage: { inputTokens: 21_000, outputTokens: 4_800, cacheReadTokens: 5_100 },
    rounds: 3,
    toolCalls: 6,
    audit: {
      toolCallLog: [{ name: "review.read_file", argumentsJson: "{}", resultSummary: "read 42 lines" }],
      phaseLog: [{ round: 1, phase: "Change Understanding", requestCount: 1 }],
      rejections: [{ candidateId: "cand-1", stage: "NO_EVIDENCE", reason: "no evidence attached" }],
      truncated: false,
      truncationReasons: [],
    },
    auditPath: AUDIT_PATH,
    ...overrides,
  };
}

function piRunResult(overrides: Partial<ReviewRunResult> = {}): ReviewRunResult {
  return {
    runId: "1760000000000-E-VUL4J-38",
    record: {
      source: "vul4j",
      caseId: MR_CASE.caseId,
      configId: "E",
      rep: 1,
      model: KERNEL_MODEL,
      verifier: "off",
      completedAt: "2026-11-03T09:00:00.000Z",
      baseline: piSnapshot(),
      effective: null,
      verifierPass: null,
    },
    recordPath: "",
    auditPath: AUDIT_PATH,
    ...overrides,
  };
}

/** fake 内核缝：捕获每次 ReviewRunInput（装配纪律的观测对象） */
function fakeRunReview(result: ReviewRunResult): {
  readonly inputs: ReviewRunInput[];
  readonly runReviewFn: NonNullable<PiKernelDeps["runReviewFn"]>;
} {
  const inputs: ReviewRunInput[] = [];
  return {
    inputs,
    runReviewFn: async (input) => {
      inputs.push(input);
      return result;
    },
  };
}

function kernelDeps(overrides: Partial<PiKernelDeps> = {}): PiKernelDeps {
  return { apiKey: KERNEL_API_KEY, fetch: FETCH_SENTINEL, ...overrides };
}

describe("pi 内核适配器（#8 执行缝 pi 侧，#32 落位 src/gate）", () => {
  it("source 守卫：非 vul4j 单元 fail fast——不调内核，错误消息自证单元与退役缘由", async () => {
    const { inputs, runReviewFn } = fakeRunReview(piRunResult());
    const kernel = piKernel({ ...kernelDeps(), runReviewFn });
    const request = unitRequest({ unit: { source: "defects4j", caseId: "DEFECTS4J-1", configId: "E", rep: 1 } });

    await expect(kernel.execute(request)).rejects.toThrow(
      /pi kernel only runs vul4j units \(got source "defects4j" on DEFECTS4J-1\/E\/rep-1\)/,
    );
    await expect(kernel.execute(request)).rejects.toThrow(/retired in P4b/);
    expect(inputs).toEqual([]);
  });

  it("装配：UnitReviewRequest → ReviewRunInput 逐字段映射——persistRecord 恒 false、无 configId 键、baseUrl 缺席省键", async () => {
    const { inputs, runReviewFn } = fakeRunReview(piRunResult());
    const kernel = piKernel({ ...kernelDeps(), runReviewFn });

    const result = await kernel.execute(unitRequest());

    expect(inputs).toHaveLength(1);
    const input = inputs[0];
    if (input === undefined) {
      throw new Error("runReview was not called");
    }
    expect(input.caseId).toBe(MR_CASE.caseId);
    expect(input.repoPath).toBe(MR_CASE.repoPath);
    expect(input.diff).toBe(MR_CASE.diff);
    expect(input.issueDescription).toBe(MR_CASE.issueDescription);
    expect(input.apiKey).toBe(KERNEL_API_KEY);
    expect(input.modelId).toBe(TARGET_MODEL);
    expect(input.fetch).toBe(FETCH_SENTINEL);
    expect(input.persistRecord).toBe(false);
    // experimentRoot 拆分：dirname → runsRoot、basename → experimentId
    expect(input.runsRoot).toBe("D:/fixtures/runs");
    expect(input.experimentId).toBe("migration-gate");
    expect(input.rep).toBe(1);
    // 缺席省键纪律（v3：配置由内核单源派生，装配面无 configId / baseUrl）
    expect("baseUrl" in input).toBe(false);
    expect("configId" in input).toBe(false);
    // 被测返回链照常（映射断言见下组）
    expect(result.caseId).toBe(MR_CASE.caseId);
  });

  it("装配：baseUrl 在场透传（--base-url 旗标形态）", async () => {
    const { inputs, runReviewFn } = fakeRunReview(piRunResult());
    const kernel = piKernel({ ...kernelDeps(), baseUrl: GATE_BASE_URL, runReviewFn });

    await kernel.execute(unitRequest());

    const input = inputs[0];
    if (input === undefined) {
      throw new Error("runReview was not called");
    }
    expect(input.baseUrl).toBe(GATE_BASE_URL);
    expect("baseUrl" in input).toBe(true);
  });

  it("映射：record.baseline → 根仓 RunResult——requests 恒 []、cacheBreaks 缺省补 []、model 取内核记录而非请求目标", async () => {
    const snapshot = piSnapshot(); // 无 cacheBreaks / ledger / domainWarning
    const { runReviewFn } = fakeRunReview({ ...piRunResult(), record: { ...piRunResult().record, baseline: snapshot } });
    const kernel = piKernel({ ...kernelDeps(), runReviewFn });

    const result: RunResult = await kernel.execute(unitRequest());

    expect(result.caseId).toBe(MR_CASE.caseId);
    expect(result.configId).toBe("E");
    expect(result.model).toBe(KERNEL_MODEL); // 口径诚实护栏的对账基准
    expect(result.findings).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 21_000, outputTokens: 4_800, cacheReadTokens: 5_100 });
    expect(result.rounds).toBe(3);
    expect(result.toolCalls).toBe(6);
    expect(result.audit).toEqual({
      requests: [], // 重放字节以审计文件为真源
      toolCallLog: [{ name: "review.read_file", argumentsJson: "{}", resultSummary: "read 42 lines" }],
      phaseLog: [{ round: 1, phase: "Change Understanding", requestCount: 1 }],
      rejections: [{ candidateId: "cand-1", stage: "NO_EVIDENCE", reason: "no evidence attached" }],
      cacheBreaks: [], // pi AuditLight 空时省键 → root 必填字段补 []
      truncated: false,
      truncationReasons: [],
    });
    expect(result.auditPath).toBe(AUDIT_PATH);
    // 缺席省键：无护栏降级 / 无 ledger 快照时不出现键
    expect(result.domainWarning).toBeUndefined();
    expect(result.audit.ledger).toBeUndefined();
  });

  it("映射：cacheBreaks / ledger / domainWarning 在场透传（缺席省键、在场不丢）", async () => {
    const snapshot = piSnapshot({
      audit: {
        toolCallLog: [],
        phaseLog: [],
        rejections: [],
        cacheBreaks: [{ requestIndex: 1, reason: "MODEL_CHANGED", zone: "MODEL", divergeByteOffset: 12 }],
        truncated: false,
        truncationReasons: [],
        ledger: [{ id: "ctx#001", kind: "file", description: "review.read_file x.java" }],
      },
      domainWarning: "MR boundary exceeded: 12 files",
    });
    const { runReviewFn } = fakeRunReview({ ...piRunResult(), record: { ...piRunResult().record, baseline: snapshot } });
    const kernel = piKernel({ ...kernelDeps(), runReviewFn });

    const result: RunResult = await kernel.execute(unitRequest());

    expect(result.audit.cacheBreaks).toEqual([
      { requestIndex: 1, reason: "MODEL_CHANGED", zone: "MODEL", divergeByteOffset: 12 },
    ]);
    expect(result.audit.ledger).toEqual([{ id: "ctx#001", kind: "file", description: "review.read_file x.java" }]);
    expect(result.domainWarning).toBe("MR boundary exceeded: 12 files");
  });
});
