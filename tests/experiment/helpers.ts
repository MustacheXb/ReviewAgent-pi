import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MRCase } from "../../src/instrument/contracts/mr-case.js";
import type { RunResult } from "../../src/instrument/contracts/run.js";
import type { JudgeAdjudication } from "../../src/judge/contracts.js";
import type { ExperimentPlan } from "../../src/experiment/plan.js";
import { RunStore, toRunSnapshot } from "../../src/experiment/run-store.js";
import type { RunRecord } from "../../src/experiment/run-store.js";
import type { ReviewKernel, UnitReviewRequest } from "../../src/experiment/review-kernel.js";
import { makeFinding } from "../metrics/helpers.js";
import { SAMPLE_MR_CASE } from "../fixtures/sample-mr-case.js";

/**
 * 实验模块测试夹具：MRCase 工厂（labels.source 取实验词表）、fake 检视内核
 * （#9 P4b 起 runner 测试的执行替身——脚本化 RunResult / 失败注入 + 请求留痕）、
 * judge 裁定、计划工厂（kernel 恒 "pi"）、对齐门 run 目录工厂
 * （RunRecord + RunStore round-trip）。零网络零真实 LLM：全部经 fake 内核 /
 * FakeJudgeClient。
 */

/** 主集 case（truth ≠ null；源默认 defects4j，可覆盖 labels） */
export function experimentMainCase(
  caseId = "exp-main-001",
  overrides: { readonly labels?: Partial<MRCase["labels"]> } = {},
): MRCase {
  return {
    ...SAMPLE_MR_CASE,
    caseId,
    labels: {
      source: "defects4j",
      riskClass: "Medium",
      allowedConfigs: ["A", "B", "C", "D", "E"],
      ...overrides.labels,
    },
  };
}

/** clean MR 阴性对照 case（truth = null；issueDescription 为空串） */
export function experimentCleanCase(
  caseId = "exp-clean-001",
  overrides: { readonly labels?: Partial<MRCase["labels"]> } = {},
): MRCase {
  return {
    ...SAMPLE_MR_CASE,
    caseId,
    issueDescription: "",
    truth: null,
    labels: {
      source: "clean-mr",
      riskClass: "Low",
      allowedConfigs: ["A", "B", "C", "D", "E"],
      ...overrides.labels,
    },
  };
}

/** 缝请求 → 同构 RunResult（单 finding；auditPath 由「内核」自定——验证透传） */
export function kernelResultOf(request: UnitReviewRequest): RunResult {
  return {
    caseId: request.unit.caseId,
    configId: request.unit.configId,
    model: request.model,
    findings: [makeFinding()],
    usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 0 },
    rounds: 1,
    toolCalls: 0,
    audit: {
      requests: [],
      toolCallLog: [],
      phaseLog: [],
      rejections: [],
      cacheBreaks: [],
      truncated: false,
      truncationReasons: [],
    },
    auditPath: path.join(request.experimentRoot, "fake-audit", `${request.unit.caseId}.json`),
  };
}

/** fake 内核的脚本步（result 消费一条；fail 注入确定性失败驱动失败隔离） */
export type FakeKernelStep =
  | { readonly kind: "result"; readonly result: RunResult }
  | { readonly kind: "fail"; readonly error: Error };

/** fake 内核的观测面（kernel 供 ExperimentDeps 注入；requests/callCount 供断言） */
export interface FakeKernel {
  readonly kernel: ReviewKernel;
  /** 收到的全部缝请求（顺序即执行顺序） */
  readonly requests: readonly UnitReviewRequest[];
  readonly callCount: number;
}

/** 脚本化 fake 内核（恒 id="pi"）：按调用顺序消费 steps；脚本耗尽即抛错（显式失败，不静默回退） */
export function scriptedKernel(steps: readonly FakeKernelStep[]): FakeKernel {
  const requests: UnitReviewRequest[] = [];
  let cursor = 0;
  const kernel: ReviewKernel = {
    id: "pi",
    execute: async (request) => {
      requests.push(request);
      const step = steps[cursor];
      cursor += 1;
      if (step === undefined) {
        throw new Error(`fake kernel script exhausted after ${steps.length} step(s)`);
      }
      if (step.kind === "fail") {
        throw step.error;
      }
      return step.result;
    },
  };
  return {
    kernel,
    requests,
    get callCount() {
      return requests.length;
    },
  };
}

/**
 * 记录型 fake 内核（恒 id="pi"）：结果按缝请求回填（model 随计划透传——
 * 口径诚实护栏通过；CLI 接线测试用）。
 */
export function recordingKernel(
  resultOf: (request: UnitReviewRequest) => RunResult = kernelResultOf,
): FakeKernel {
  const requests: UnitReviewRequest[] = [];
  const kernel: ReviewKernel = {
    id: "pi",
    execute: async (request) => {
      requests.push(request);
      return resultOf(request);
    },
  };
  return {
    kernel,
    requests,
    get callCount() {
      return requests.length;
    },
  };
}

/**
 * 快乐路径 fake 内核（恒 id="pi"）：每单元返回一条命中 SAMPLE_MR_CASE 真值的
 * Finding（recall 口径 = 1）；调用超过 units 次即抛错（预算哨兵，防静默回退）。
 */
export function happyKernel(units: number): FakeKernel {
  return scriptedKernel(
    Array.from({ length: units }, () => ({ kind: "result" as const, result: HAPPY_KERNEL_RESULT })),
  );
}

/** 快乐路径内核结果（findings 命中样例真值：MathUtils.java:20 off-by-one） */
export const HAPPY_KERNEL_RESULT: RunResult = {
  caseId: "sample",
  configId: "A",
  model: "deepseek-v4-flash",
  findings: [
    {
      id: "F001",
      severity: "P1",
      category: "CORRECTNESS",
      file: "src/main/java/com/example/math/MathUtils.java",
      line: 20,
      title: "Off-by-one loop bound reads one element beyond the requested range",
      description:
        "The loop condition 'i <= count' accesses values[count]; when count equals values.length this throws an ArrayIndexOutOfBoundsException.",
      evidence: [
        "Diff replaces 'for (int i = 0; i < count; i++)' with 'for (int i = 0; i <= count; i++)' at src/main/java/com/example/math/MathUtils.java line 20",
      ],
      rule: "CORRECTNESS-001",
      confidence: 0.95,
    },
  ],
  usage: { inputTokens: 750, outputTokens: 210, cacheReadTokens: 350, cacheWriteTokens: 40 },
  rounds: 1,
  toolCalls: 0,
  audit: {
    requests: [],
    toolCallLog: [],
    phaseLog: [],
    rejections: [],
    cacheBreaks: [],
    truncated: false,
    truncationReasons: [],
  },
  auditPath: "fake-audit/happy.json",
};

/** judge 裁定：第 1 条 Finding 命中第 1 条真值（high 置信） */
export function judgeAdjudication(): JudgeAdjudication {
  return {
    matches: [
      {
        findingIndex: 0,
        truthIndex: 0,
        matchConfidence: "high",
        matchReason: "Both describe the same off-by-one loop bound defect.",
      },
    ],
    summary: "1 match, 0 unmatched truths",
  };
}

/** 缺省计划（子集/限量/消融字段全覆盖缺省；overrides 局部替换；kernel 恒 pi——P4b 唯一可执行内核） */
export function experimentPlan(overrides: Partial<ExperimentPlan> = {}): ExperimentPlan {
  return {
    experimentId: "test-experiment",
    sources: ["defects4j", "vul4j", "msb-java", "clean-mr"],
    configs: ["A"],
    reps: 1,
    verifier: "off",
    model: "deepseek-v4-flash",
    kernel: "pi",
    highRiskOnly: false,
    perSourceLimit: null,
    caseFilter: [],
    judge: false,
    judgeModel: null,
    humanReviewRate: 0.1,
    humanReviewSeed: "test-seed-2026",
    ...overrides,
  };
}

/** 对齐门测试用 RunResult（单 finding 命中真值；usage/审计零事件；可整体覆盖） */
export function gateRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    caseId: "c1",
    configId: "C",
    findings: [makeFinding()],
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 },
    rounds: 1,
    toolCalls: 0,
    audit: {
      requests: [],
      toolCallLog: [],
      phaseLog: [],
      rejections: [],
      cacheBreaks: [],
      truncated: false,
      truncationReasons: [],
    },
    ...overrides,
  };
}

/** 对齐门测试用 RunRecord（baseline = gateRunResult 快照；effective/rep 等可覆盖） */
export function gateRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    source: "vul4j",
    caseId: "c1",
    configId: "C",
    rep: 1,
    model: "deepseek-v4-flash",
    verifier: "off",
    completedAt: "2026-09-08T22:11:00.000Z",
    baseline: toRunSnapshot(gateRunResult()),
    effective: null,
    verifierPass: null,
    ...overrides,
  };
}

/** 造一个对齐门侧 run 目录：cases.json + runs/ 记录树（记录经 RunStore.save 落盘） */
export async function makeGateRunDir(
  workDir: string,
  name: string,
  cases: readonly MRCase[],
  records: readonly RunRecord[],
): Promise<string> {
  const runDir = path.join(workDir, name);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "cases.json"), JSON.stringify(cases), "utf8");
  const store = new RunStore(path.join(runDir, "runs"));
  for (const entry of records) {
    await store.save(entry);
  }
  return runDir;
}
