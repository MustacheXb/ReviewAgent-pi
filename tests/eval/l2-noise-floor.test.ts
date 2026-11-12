import { describe, expect, it } from "vitest";
import type { Stat } from "../../src/eval/analysis/contracts.js";
import type {
  L2ArmMetrics,
  L2MetricSet,
  L2PairedSet,
  L2Report,
} from "../../src/eval/l2/contracts.js";
import {
  DEFAULT_L2_GATE_THRESHOLDS,
  L2_REPORT_KIND,
  L2_REPORT_SCHEMA_VERSION,
  type L2GateThresholds,
} from "../../src/eval/l2/contracts.js";
import {
  buildNoiseFloorReport,
  renderNoiseFloorMarkdown,
} from "../../src/eval/l2/calibration.js";
import type { EnvironmentManifest } from "../../src/eval/campaign/contracts.js";

/**
 * 噪声底报告（#42）：从 `L2Report + environment.json` 生成机读 JSON 与确定性
 * Markdown；只用于复核 provisional 阈值，不判定优化收益（claimsAllowed 恒 false）。
 */

/**
 * 校准生成时的 provisional 阈值快照（2026-11-12 更新前）。噪声底报告的
 * 「保留 / 调整」建议针对**当时的 provisional**；当前默认值已按校准结果更新，
 * 由 l2-gates 的默认阈值回归锁覆盖。
 */
const CALIBRATION_TIME_THRESHOLDS: L2GateThresholds = {
  maxCarcRatio: 0.9,
  maxCarcRatioCiUpper: 1.0,
  maxUncachedRatio: 1.0,
  maxOutputRatio: 1.05,
  maxAttemptsRatio: 1.0,
  maxRequestsRatio: 1.0,
  qualityNonInferiorityPp: 0.03,
  maxZeroFindingRateIncreasePp: 0.02,
  maxNegativeControlFpSigma: 1,
  minCoverage: 0.95,
  maxAttemptedToolCalls: 12,
  maxRequests: 24,
  maxOutputTokens: 48_000,
};

function stat(mean: number, std = 0, count = 30): Stat {
  return { count, mean, std };
}

function metricSet(overrides: {
  readonly carc?: number;
  readonly judgeRecall?: number;
  readonly attempts?: number;
} = {}): L2MetricSet {
  return {
    runs: 30,
    cases: 30,
    cost: {
      cachedInputTokens: stat(60_000, 20_000),
      uncachedInputTokens: stat(34_000, 3_800),
      cacheWriteTokens: stat(0),
      outputTokens: stat(14_700, 1_800),
      totalInputTokens: stat(94_000, 23_000),
      totalTokens: stat(109_000, 30_000),
      cacheHitRate: stat(0.62, 0.07),
      carc: stat(overrides.carc ?? 48_700, 5_000),
    },
    loop: {
      requests: stat(9.7, 0.9),
      rounds: stat(1, 0),
      attemptedToolCalls: stat(overrides.attempts ?? 10.9, 1.3),
      executedToolCalls: stat(6, 0),
    },
    quality: {
      judgeRecall: stat(overrides.judgeRecall ?? 0.41, 0.24),
      judgePrecision: stat(0.41, 0.21),
      judgeF1: stat(0.37, 0.19),
      ruleRecall: stat(0.2, 0.2),
      rulePrecision: stat(0.17, 0.17),
      zeroFindingRate: stat(0),
      negativeControlFpPerCase: null,
    },
  };
}

interface RatioOverrides {
  readonly pairs?: number;
  readonly mean?: number | null;
  readonly std?: number;
  readonly ci95?: readonly [number, number] | null;
}

function ratio(overrides: RatioOverrides = {}) {
  const mean = overrides.mean === undefined ? 1 : overrides.mean;
  return {
    pairs: overrides.pairs ?? 30,
    mean,
    median: mean,
    std: overrides.std ?? 0.05,
    ci95:
      overrides.ci95 === undefined
        ? mean === null
          ? null
          : ([mean - 0.02, mean + 0.02] as const)
        : overrides.ci95,
    absoluteDiff:
      mean === null
        ? null
        : { pairs: 30, mean: 0, median: 0, std: 0, ci95: [-0.01, 0.01] as const },
  };
}

function diff(overrides: RatioOverrides = {}) {
  const mean = overrides.mean === undefined ? 0 : overrides.mean;
  return {
    pairs: overrides.pairs ?? 30,
    mean,
    median: mean,
    std: overrides.std ?? 0.03,
    ci95:
      overrides.ci95 === undefined
        ? mean === null
          ? null
          : ([mean - 0.02, mean + 0.02] as const)
        : overrides.ci95,
  };
}

function pairedSet(overrides: {
  readonly carc?: RatioOverrides;
  readonly uncached?: RatioOverrides;
  readonly output?: RatioOverrides;
  readonly attempts?: RatioOverrides;
  readonly requests?: RatioOverrides;
  readonly recall?: RatioOverrides;
  readonly precision?: RatioOverrides;
  readonly zeroFinding?: RatioOverrides;
} = {}): L2PairedSet {
  return {
    carcRatio: ratio(overrides.carc),
    uncachedRatio: ratio(overrides.uncached),
    outputRatio: ratio(overrides.output),
    totalTokensRatio: ratio(),
    cachedInputRatio: ratio(),
    attemptsRatio: ratio(overrides.attempts),
    requestsRatio: ratio(overrides.requests),
    cacheHitRateDiff: diff(),
    judgeRecallDiff: diff(overrides.recall),
    judgePrecisionDiff: diff(overrides.precision),
    zeroFindingRateDiff: diff(overrides.zeroFinding),
    negativeControlFpDiff: diff({ pairs: 0, mean: null, ci95: null }),
  };
}

function arm(overrides: { carc?: number; judgeRecall?: number } = {}): L2ArmMetrics {
  return { warm: metricSet(overrides), cold: metricSet(overrides) };
}

export function l2ReportFixture(
  overrides: {
    readonly campaignId?: string;
    readonly campaignType?: "calibration" | "formal";
    readonly calibrationRef?: string | null;
    readonly outputDir?: string;
    readonly paired?: L2PairedSet;
    readonly coldPaired?: L2PairedSet;
    readonly bounds?: Partial<L2Report["bounds"]>;
    readonly negativeControl?: number;
    readonly gates?: Partial<L2Report["gates"]>;
    readonly thresholds?: Partial<L2Report["thresholds"]>;
  } = {},
): L2Report {
  const campaignId = overrides.campaignId ?? "p1-calibration-2026-11-11";
  const negativeControl = overrides.negativeControl ?? 0;
  const paired = overrides.paired ?? pairedSet();
  return {
    kind: L2_REPORT_KIND,
    schemaVersion: L2_REPORT_SCHEMA_VERSION,
    campaignId,
    campaignType: overrides.campaignType ?? "calibration",
    calibrationRef:
      overrides.calibrationRef === undefined ? campaignId : overrides.calibrationRef,
    outputDir: overrides.outputDir ?? `runs/eval/${campaignId}`,
    baseline: { ref: "eval-e-baseline-2026-11-11", model: "deepseek-v4-flash" },
    candidate: { ref: "eval-e-baseline-2026-11-11", model: "deepseek-v4-flash" },
    dataset: {
      cases: 30,
      negativeControl,
      hash: "31a326bd1722042a1790d4bffbc05c02086098a212bedd785e6f51dbb4fcd8ba",
    },
    environmentRef: "environment.json",
    sampling: { cases: 30, reps: 3, arms: 2, planned: 180 },
    coverage: {
      planned: 180,
      executed: 180,
      judged: 180,
      failed: 0,
      ratio: 1,
      note: "30 case × 3 reps × 2 arms",
    },
    bounds: {
      maxAttemptedToolCalls: 12,
      maxRequests: 20,
      maxOutputTokens: 30_000,
      truncatedRuns: 0,
      ...overrides.bounds,
    },
    metrics: {
      baseline: arm(),
      candidate: arm(),
      paired: { warm: paired, cold: overrides.coldPaired ?? paired },
    },
    gates: {
      cost: { pass: false, rule: "cost", detail: "CARC ratio 1.010 > maxCarcRatio 0.900" },
      quality: { pass: true, rule: "quality", detail: "ok" },
      boundedness: { pass: true, rule: "boundedness", detail: "180 runs within bounds" },
      reproducibility: { pass: true, rule: "reproducibility", detail: "ok" },
      ...overrides.gates,
    },
    claimsAllowed: false,
    bootstrap: { iterations: 10_000, seed: 20_261_111, confidence: 0.95 },
    thresholds: { ...CALIBRATION_TIME_THRESHOLDS, ...overrides.thresholds },
  };
}

export function environmentFixture(
  overrides: Partial<EnvironmentManifest> = {},
): EnvironmentManifest {
  return {
    campaignId: "p1-calibration-2026-11-11",
    evaluation: {
      branch: "eval/bench",
      campaign: "p1-calibration-2026-11-11",
      calibrationRef: "p1-calibration-2026-11-11",
    },
    git: { branch: "eval/bench", commit: "deadbeef", tag: null },
    runtime: { node: "v24.13.0", os: "win32-x64", machine: "dev" },
    model: {
      requestedId: "deepseek-v4-flash",
      actualDeployment: null,
      providerClass: "volcengine",
      baseUrlClass: "gateway-endpoint",
    },
    gateway: { cacheProbeBefore: null, cacheProbeAfter: null },
    judge: {
      model: "glm-5.2",
      promptVersion: "mcr-bench-llm-hit-judge-2026-09-03+poc1-ext-1",
      temperature: 0.2,
      topP: 0.95,
    },
    prompts: { zoneA: null, toolsSchema: null },
    claudeCode: {
      cliVersion: null,
      requestedModel: null,
      actualModels: null,
      maxTurns: null,
    },
    window: {
      start: "2026-11-11T06:13:08.569Z",
      end: "2026-11-12T02:00:00.000Z",
      timezone: "Asia/Shanghai",
    },
    dataset: {
      casesFile: "data/vul4j/target-cases.json",
      caseCount: 30,
      hash: "31a326bd1722042a1790d4bffbc05c02086098a212bedd785e6f51dbb4fcd8ba",
    },
    ...overrides,
  };
}

describe("buildNoiseFloorReport", () => {
  it("只接受空对照校准：正式 campaign fail fast", () => {
    expect(() =>
      buildNoiseFloorReport({
        l2: l2ReportFixture({ campaignType: "formal", calibrationRef: "cal-1" }),
        environment: environmentFixture(),
      }),
    ).toThrow(/calibration/);
  });

  it("记录身份 / 样本量 / 窗口 / judge / 数据集 hash；claimsAllowed 恒 false", () => {
    const report = buildNoiseFloorReport({
      l2: l2ReportFixture(),
      environment: environmentFixture(),
    });

    expect(report).toMatchObject({
      kind: "l2-noise-floor",
      schemaVersion: 1,
      campaignId: "p1-calibration-2026-11-11",
      calibrationRef: "p1-calibration-2026-11-11",
      campaignType: "calibration",
      outputDir: "runs/eval/p1-calibration-2026-11-11",
      dataset: { cases: 30, negativeControl: 0 },
      sampling: { cases: 30, reps: 3, arms: 2, planned: 180 },
      environment: {
        git: { commit: "deadbeef" },
        model: { requestedId: "deepseek-v4-flash", providerClass: "volcengine" },
        judge: { model: "glm-5.2" },
        window: {
          start: "2026-11-11T06:13:08.569Z",
          end: "2026-11-12T02:00:00.000Z",
          timezone: "Asia/Shanghai",
        },
      },
      bootstrap: { iterations: 10_000, seed: 20_261_111, confidence: 0.95 },
      conclusion: { noiseFloorMeasured: true, claimsAllowed: false },
    });
    expect(report.metrics.paired.warm.carcRatio.mean).toBe(1);
    expect(report.metrics.paired.cold.carcRatio.mean).toBe(1);
  });

  it("阈值复核：噪声在 provisional 边界内 → keep", () => {
    const report = buildNoiseFloorReport({
      l2: l2ReportFixture({
        paired: pairedSet({
          carc: { mean: 1, ci95: [0.98, 1.02] },
          uncached: { mean: 0.98, std: 0.02, ci95: [0.97, 0.99] },
          output: { mean: 1, std: 0.01, ci95: [0.99, 1.01] },
          attempts: { mean: 0.98, std: 0.02, ci95: [0.97, 0.99] },
          requests: { mean: 0.98, std: 0.02, ci95: [0.97, 0.99] },
          recall: { mean: -0.01, ci95: [-0.02, 0] },
          precision: { mean: -0.01, ci95: [-0.02, 0] },
          zeroFinding: { mean: 0, ci95: [-0.01, 0.01] },
        }),
      }),
      environment: environmentFixture(),
    });

    const byName = Object.fromEntries(report.thresholdReview.map((entry) => [entry.name, entry]));
    expect(byName["maxCarcRatio"]).toMatchObject({
      recommendation: "keep",
      observed: 1,
      provisional: 0.9,
    });
    expect(byName["qualityNonInferiorityPp"]).toMatchObject({
      recommendation: "keep",
      observed: -0.02,
      provisional: 0.03,
    });
    expect(byName["maxZeroFindingRateIncreasePp"]).toMatchObject({ recommendation: "keep" });
    expect(byName["maxUncachedRatio"]?.recommendation).toBe("keep");
    expect(byName["maxAttemptsRatio"]?.recommendation).toBe("keep");
    expect(byName["maxAttemptedToolCalls"]).toMatchObject({
      recommendation: "keep",
      observed: 12,
      provisional: 12,
    });
    expect(byName["maxNegativeControlFpSigma"]?.recommendation).toBe("n/a");
  });

  it("阈值复核：质量 CI 噪声超过 −3pp → 建议放宽到覆盖噪声", () => {
    const report = buildNoiseFloorReport({
      l2: l2ReportFixture({
        paired: pairedSet({
          recall: { mean: -0.01, ci95: [-0.052, 0.02] },
          precision: { mean: 0, ci95: [-0.02, 0.03] },
        }),
      }),
      environment: environmentFixture(),
    });

    const quality = report.thresholdReview.find(
      (entry) => entry.name === "qualityNonInferiorityPp",
    );
    expect(quality).toMatchObject({
      recommendation: "adjust",
      observed: -0.052,
      suggested: 0.055,
    });
    expect(quality?.rationale).toMatch(/noise|噪声/i);
  });

  it("阈值复核：30 案 CARC CI 半宽 >10pp → 目标 0.90 不可达成，建议扩样", () => {
    const report = buildNoiseFloorReport({
      l2: l2ReportFixture({
        paired: pairedSet({
          carc: { mean: 1, ci95: [0.85, 1.15] },
        }),
      }),
      environment: environmentFixture(),
    });

    const carc = report.thresholdReview.find((entry) => entry.name === "maxCarcRatio");
    expect(carc).toMatchObject({
      recommendation: "gather-more",
      observed: 1,
      suggestedCases: 68,
    });
    expect(carc?.rationale).toMatch(/sample|样本|案/i);
  });

  it("阈值复核：1.00 比率守卫在空对照上会假失败 → 建议按单侧 95% 上界放宽", () => {
    const report = buildNoiseFloorReport({
      l2: l2ReportFixture({
        paired: pairedSet({
          attempts: { mean: 1.02, std: 0.1, ci95: [0.98, 1.06] },
          requests: { mean: 1.01, std: 0.05, ci95: [0.99, 1.03] },
        }),
      }),
      environment: environmentFixture(),
    });

    const attempts = report.thresholdReview.find((entry) => entry.name === "maxAttemptsRatio");
    expect(attempts).toMatchObject({ recommendation: "adjust", suggested: 1.06 });
    const requests = report.thresholdReview.find((entry) => entry.name === "maxRequestsRatio");
    expect(requests).toMatchObject({ recommendation: "adjust", suggested: 1.03 });
  });

  it("阈值复核：观测上界超过 provisional → 建议按实测定界", () => {
    const report = buildNoiseFloorReport({
      l2: l2ReportFixture({
        bounds: {
          maxAttemptedToolCalls: 14,
          maxRequests: 30,
          maxOutputTokens: 60_000,
          truncatedRuns: 2,
        },
      }),
      environment: environmentFixture(),
    });

    const byName = Object.fromEntries(report.thresholdReview.map((entry) => [entry.name, entry]));
    expect(byName["maxAttemptedToolCalls"]).toMatchObject({
      recommendation: "adjust",
      suggested: 16,
    });
    expect(byName["maxRequests"]).toMatchObject({ recommendation: "adjust", suggested: 33 });
    expect(byName["maxOutputTokens"]).toMatchObject({
      recommendation: "adjust",
      suggested: 66_000,
    });
  });

  it("Markdown 确定性：同输入两次渲染字节一致，且明确不得宣称收益", () => {
    const report = buildNoiseFloorReport({
      l2: l2ReportFixture(),
      environment: environmentFixture(),
    });
    const first = renderNoiseFloorMarkdown(report);
    const second = renderNoiseFloorMarkdown(report);

    expect(first).toBe(second);
    expect(first).toContain("# L2 空对照校准噪声底报告 p1-calibration-2026-11-11");
    expect(first).toContain("calibrationRef: `p1-calibration-2026-11-11`");
    expect(first).toContain("30 case × 3 reps × 2 arms");
    expect(first).toContain("clean MR N/A");
    expect(first).toContain("--out runs/eval/p1-calibration-2026-11-11");
    expect(first).toContain("2026-11-11T06:13:08.569Z");
    expect(first).toMatch(/不得.*宣称|not.*claim/i);
    expect(first).toContain("CARC ratio");
    expect(first).toContain("judgeRecall");
    expect(first).toContain("阈值复核建议");
  });

  it("绝对 outputDir 在 Markdown 复算命令中投影为仓库相对 runs/eval 路径（报告入库不泄露本机路径）", () => {
    const report = buildNoiseFloorReport({
      l2: l2ReportFixture({
        outputDir: "D:\\repo\\ReviewAgent-pi\\runs\\eval\\p1-calibration-2026-11-11",
      }),
      environment: environmentFixture(),
    });
    const markdown = renderNoiseFloorMarkdown(report);

    expect(markdown).toContain("--out runs/eval/p1-calibration-2026-11-11");
    expect(markdown).not.toContain("D:\\repo");
  });
});
