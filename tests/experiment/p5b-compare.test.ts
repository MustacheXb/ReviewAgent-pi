import { describe, expect, it } from "vitest";
import type { JudgeRunResult } from "../../src/judge/orchestrate.js";
import type { JudgeStageReport } from "../../src/experiment/report.js";
import { METRICS_FIELDS } from "../../src/metrics/types.js";
import {
  crossSideRange,
  judgeNineDims,
  repSigma,
  sampleStd,
  zeroFindingRate,
} from "../../src/experiment/p5b-compare.js";

// ── fixture 工厂：JudgeRunResult 只填 σ 面消费的字段，其余默认 ──
function row(overrides: {
  caseId: string;
  configId: "A" | "B" | "C" | "D" | "E";
  repIndex: number;
  recall: number | null;
  precision: number | null;
  totalTokens: number | null;
  cacheHitRate: number | null;
}): JudgeRunResult {
  return {
    caseId: overrides.caseId,
    configId: overrides.configId,
    repIndex: overrides.repIndex,
    status: "judged",
    errorMessage: null,
    anomalies: [],
    judgeVerdicts: [],
    judgeMisses: [],
    judgeCounts: { truePositives: 0, falsePositives: 0, falseNegatives: 0 },
    judgePrf: { recall: 0, precision: 0, f1: 0 },
    judgeEfficiency: { rie: 0, carc: 0 },
    ruleCounts: { truePositives: 0, falsePositives: 0, falseNegatives: 0 },
    rulePrf: { recall: overrides.recall, precision: overrides.precision, f1: 0 },
    ruleEfficiency: { rie: 0, carc: 0 },
    tokens: { totalTokens: overrides.totalTokens ?? 0, cacheHitRate: overrides.cacheHitRate, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0 },
    toolCostTokens: 0,
    toolCalls: 0,
    rounds: 0,
    disagreements: [],
  } as unknown as JudgeRunResult;
}

// ── fixture 工厂：MetricsStats（九维度提取面）──
function judgeEntry(values: Partial<Record<string, { count: number; mean: number; std: number } | null>>): JudgeStageReport["perConfig"][number] {
  const full: Record<string, { count: number; mean: number; std: number } | null> = {};
  // 字段全集取自契约 METRICS_FIELDS（避免与 MetricsField 漂移）
  for (const field of METRICS_FIELDS) {
    full[field] = null;
  }
  Object.assign(full, values);
  return {
    configId: "A",
    runCount: 90,
    rule: { sampleCount: 90, values: full as never },
    judge: { sampleCount: 90, values: full as never },
  };
}

describe("sampleStd（#36 口径，n-1 分母）", () => {
  it("n=2 样本 std = 偏差 × √2（ADR-0007 σ 算术测试纪律）", () => {
    expect(sampleStd([2, 4])).toBeCloseTo(Math.SQRT2, 12);
  });
  it("n=3 均匀样本 std = 1", () => {
    expect(sampleStd([1, 2, 3])).toBeCloseTo(1, 12);
  });
  it("n<2 → NaN", () => {
    expect(Number.isNaN(sampleStd([5]))).toBe(true);
  });
});

describe("repSigma（跨 rep σ：按 (caseId,configId) 分组、null 剔除、≥2 有效 rep、对案均值）", () => {
  it("同 cell 3-rep σ 与跨 cell 均值正确", () => {
    const results = [
      row({ caseId: "X", configId: "A", repIndex: 0, recall: 0.2, precision: null, totalTokens: 1000, cacheHitRate: null }),
      row({ caseId: "X", configId: "A", repIndex: 1, recall: 0.4, precision: null, totalTokens: 2000, cacheHitRate: null }),
      row({ caseId: "X", configId: "A", repIndex: 2, recall: 0.6, precision: null, totalTokens: 3000, cacheHitRate: null }),
    ];
    const sigma = repSigma(results);
    expect(sigma.get("A/lineRecall")).toBeCloseTo(0.2, 12);
    expect(sigma.get("A/totalTokens")).toBeCloseTo(1000, 12);
    // 无 precision 样本 → NaN
    expect(Number.isNaN(sigma.get("A/linePrecision") ?? NaN)).toBe(true);
    // B 无数据 → NaN
    expect(Number.isNaN(sigma.get("B/lineRecall") ?? NaN)).toBe(true);
  });
  it("null 值剔除后 ≥2 有效 rep 仍计（2-rep cell σ = 偏差 × √2）", () => {
    const results = [
      row({ caseId: "X", configId: "A", repIndex: 0, recall: 0.1, precision: null, totalTokens: null, cacheHitRate: null }),
      row({ caseId: "X", configId: "A", repIndex: 1, recall: 0.3, precision: null, totalTokens: null, cacheHitRate: null }),
      row({ caseId: "X", configId: "A", repIndex: 2, recall: null, precision: null, totalTokens: null, cacheHitRate: null }),
    ];
    expect(repSigma(results).get("A/lineRecall")).toBeCloseTo(0.1 * Math.SQRT2, 12);
  });
  it("多 cell 取均值", () => {
    const results = [
      row({ caseId: "X", configId: "A", repIndex: 0, recall: 0.2, precision: null, totalTokens: null, cacheHitRate: null }),
      row({ caseId: "X", configId: "A", repIndex: 1, recall: 0.4, precision: null, totalTokens: null, cacheHitRate: null }),
      row({ caseId: "Y", configId: "A", repIndex: 0, recall: 0.1, precision: null, totalTokens: null, cacheHitRate: null }),
      row({ caseId: "Y", configId: "A", repIndex: 1, recall: 0.3, precision: null, totalTokens: null, cacheHitRate: null }),
    ];
    // 两 cell σ 相同（0.1×√2）→ 均值 = 0.1×√2
    expect(repSigma(results).get("A/lineRecall")).toBeCloseTo(0.1 * Math.SQRT2, 12);
  });
});

describe("crossSideRange（跨侧极差：全部侧在场才算，任一侧缺失 → null）", () => {
  it("三侧全在场 → max − min", () => {
    expect(crossSideRange([0.5, 0.2, 0.9])).toBeCloseTo(0.7, 12);
  });
  it("任一侧缺失 → null（避免缺侧极差被误读为全侧极差）", () => {
    expect(crossSideRange([1, null, 3])).toBeNull();
    expect(crossSideRange([null])).toBeNull();
  });
  it("全相等 → 0；空数组 → null", () => {
    expect(crossSideRange([2, 2, 2])).toBe(0);
    expect(crossSideRange([])).toBeNull();
  });
});

describe("zeroFindingRate（判定形态：零 finding 率）", () => {
  it("skippedNoFindings / runCount", () => {
    const judge = {
      runCount: 450,
      judgedCount: 426,
      skippedCleanMrCount: 0,
      skippedNoFindingsCount: 24,
      errorCount: 0,
      perConfig: [],
      results: [],
    } as unknown as JudgeStageReport;
    expect(zeroFindingRate(judge)).toEqual({
      runCount: 450,
      skippedNoFindings: 24,
      rate: 24 / 450,
    });
  });
  it("runCount 0 → rate null（分母护栏）", () => {
    const judge = {
      runCount: 0,
      judgedCount: 0,
      skippedCleanMrCount: 0,
      skippedNoFindingsCount: 0,
      errorCount: 0,
      perConfig: [],
      results: [],
    } as unknown as JudgeStageReport;
    expect(zeroFindingRate(judge).rate).toBeNull();
  });
});

describe("judgeNineDims（九维度提取：judge 口径九指标）", () => {
  it("九字段 mean 提取正确、null Stat → null", () => {
    const stat = (mean: number) => ({ count: 90, mean, std: 0 });
    const entry = judgeEntry({
      lineRecall: stat(0.555),
      linePrecision: stat(0.281),
      lineF1: stat(0.35),
      totalTokens: stat(25613),
      cacheHitRate: stat(0.0768),
      rie: stat(0.02),
      carc: stat(1000),
      toolCalls: stat(0),
      rounds: stat(1.33),
    });
    const dims = judgeNineDims(entry);
    expect(dims.lineRecall).toBeCloseTo(0.555, 12);
    expect(dims.totalTokens).toBeCloseTo(25613, 12);
    expect(dims.toolCalls).toBe(0);
    expect(dims.rounds).toBeCloseTo(1.33, 12);
  });
});
