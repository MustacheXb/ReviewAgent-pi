import { describe, expect, it } from "vitest";
import { buildMetricSet, buildPairedSet } from "../../src/eval/l2/metrics.js";
import { l2Sample as sample } from "./l2-fixtures.js";

/**
 * L2 配对统计 seam（#41）：按 case 等权（先 case 内跨 rep 均值，再配对），
 * 成本用比率、质量用差值；N/A 不写 0；相同臂不变量。
 */

describe("buildMetricSet", () => {
  it("按 case 等权：先 case 内跨 rep 均值，再跨 case", () => {
    const metrics = buildMetricSet([
      sample({ caseId: "A", rep: 1, carc: 100 }),
      sample({ caseId: "A", rep: 2, carc: 300 }),
      sample({ caseId: "B", rep: 1, carc: 50 }),
    ]);

    expect(metrics.runs).toBe(3);
    expect(metrics.cases).toBe(2);
    expect(metrics.cost.carc).toEqual({ count: 2, mean: 125, std: Math.sqrt(11250) });
  });

  it("judge 列排除 clean MR；阴性对照 FP 按 case 等权", () => {
    const metrics = buildMetricSet([
      sample({ caseId: "A", rep: 1, truth: "provided", judgeRecall: 0.5, judgePrecision: 1, findingCount: 1 }),
      sample({
        caseId: "B",
        rep: 1,
        truth: "clean",
        judgeRecall: 0.9,
        judgePrecision: 0.9,
        findingCount: 3,
      }),
      sample({ caseId: "B", rep: 2, truth: "clean", findingCount: 1 }),
    ]);

    expect(metrics.quality.judgeRecall).toEqual({ count: 1, mean: 0.5, std: 0 });
    expect(metrics.quality.zeroFindingRate).toEqual({ count: 2, mean: 0, std: 0 });
    // clean 案每案 FP：B = (3+1)/2 = 2
    expect(metrics.quality.negativeControlFpPerCase).toEqual({ count: 1, mean: 2, std: 0 });
  });

  it("零 finding 率先 case 内跨 rep 平均，再跨 case", () => {
    const metrics = buildMetricSet([
      sample({ caseId: "A", rep: 1, zeroFindings: true }),
      sample({ caseId: "B", rep: 1, truth: "clean", findingCount: 1 }),
      sample({ caseId: "B", rep: 2, truth: "clean", findingCount: 1 }),
    ]);

    expect(metrics.quality.zeroFindingRate).toEqual({
      count: 2,
      mean: 0.5,
      std: Math.sqrt(0.5),
    });
  });

  it("缺失缓存计量 → totalTokens 为 N/A（null），不按 0 计入", () => {
    const metrics = buildMetricSet([
      sample({ caseId: "A", rep: 1, carc: 10, total: null }),
      sample({ caseId: "B", rep: 1, carc: 20, total: 100 }),
    ]);

    expect(metrics.cost.totalTokens).toEqual({ count: 1, mean: 100, std: 0 });
    expect(metrics.cost.carc).toEqual({ count: 2, mean: 15, std: Math.sqrt(50) });
  });
});

describe("buildPairedSet: 相同臂不变量", () => {
  it("同一数据两臂 → 成本比率 1、质量差 0、CI 包含 0", () => {
    const runs = [
      sample({
        caseId: "A",
        rep: 2,
        carc: 100,
        uncached: 60,
        output: 40,
        total: 300,
        cacheHit: 0.5,
        attempts: 4,
        requests: 5,
        judgeRecall: 0.4,
        judgePrecision: 0.6,
        findingCount: 1,
      }),
      sample({
        caseId: "B",
        rep: 2,
        carc: 200,
        uncached: 120,
        output: 80,
        total: 600,
        cacheHit: 0.25,
        attempts: 6,
        requests: 7,
        judgeRecall: 0.8,
        judgePrecision: 0.2,
        findingCount: 2,
      }),
    ];

    const paired = buildPairedSet(runs, runs);

    for (const ratio of [
      paired.carcRatio,
      paired.uncachedRatio,
      paired.outputRatio,
      paired.totalTokensRatio,
      paired.attemptsRatio,
      paired.requestsRatio,
    ]) {
      expect(ratio.pairs).toBe(2);
      expect(ratio.mean).toBe(1);
      expect(ratio.median).toBe(1);
      expect(ratio.std).toBe(0);
      expect(ratio.ci95).toEqual([1, 1]);
      expect(ratio.absoluteDiff?.mean).toBe(0);
      expect(ratio.absoluteDiff?.ci95).toEqual([0, 0]);
    }
    for (const diff of [
      paired.cacheHitRateDiff,
      paired.judgeRecallDiff,
      paired.judgePrecisionDiff,
      paired.zeroFindingRateDiff,
    ]) {
      expect(diff.pairs).toBe(2);
      expect(diff.mean).toBe(0);
      expect(diff.ci95).toEqual([0, 0]);
    }
  });
});

describe("buildPairedSet: 配对口径", () => {
  it("先 case 内跨 rep 均值再配对（避免把 rep 当独立样本）", () => {
    const baseline = [
      sample({ caseId: "A", rep: 2, carc: 100 }),
      sample({ caseId: "A", rep: 3, carc: 300 }),
      sample({ caseId: "B", rep: 2, carc: 100 }),
      sample({ caseId: "B", rep: 3, carc: 100 }),
    ];
    const candidate = [
      sample({ caseId: "A", rep: 2, carc: 100 }),
      sample({ caseId: "A", rep: 3, carc: 100 }),
      sample({ caseId: "B", rep: 2, carc: 100 }),
      sample({ caseId: "B", rep: 3, carc: 100 }),
    ];

    const paired = buildPairedSet(baseline, candidate);

    expect(paired.carcRatio.pairs).toBe(2);
    expect(paired.carcRatio.mean).toBeCloseTo(Math.SQRT1_2, 10);
    expect(paired.carcRatio.absoluteDiff?.mean).toBe(-50);
  });

  it("N/A 指标不参与配对：候选臂 totalTokens 缺失的 case 被排除", () => {
    const baseline = [
      sample({ caseId: "A", rep: 2, carc: 10, total: 100 }),
      sample({ caseId: "B", rep: 2, carc: 20, total: 200 }),
    ];
    const candidate = [
      sample({ caseId: "A", rep: 2, carc: 5, total: null }),
      sample({ caseId: "B", rep: 2, carc: 10, total: 100 }),
    ];

    const paired = buildPairedSet(baseline, candidate);

    expect(paired.carcRatio.pairs).toBe(2);
    expect(paired.totalTokensRatio.pairs).toBe(1);
    expect(paired.totalTokensRatio.mean).toBe(0.5);
  });

  it("比率只在正数基线域定义：baseline 为 0 的 case 被排除", () => {
    const baseline = [
      sample({ caseId: "A", rep: 2, carc: 0 }),
      sample({ caseId: "B", rep: 2, carc: 10 }),
    ];
    const candidate = [
      sample({ caseId: "A", rep: 2, carc: 0 }),
      sample({ caseId: "B", rep: 2, carc: 5 }),
    ];

    const paired = buildPairedSet(baseline, candidate);

    expect(paired.carcRatio.pairs).toBe(1);
    expect(paired.carcRatio.mean).toBe(0.5);
  });

  it("无配对样本 → 统计量为 null（N/A，不写 0）", () => {
    const paired = buildPairedSet([], []);

    expect(paired.carcRatio.pairs).toBe(0);
    expect(paired.carcRatio.mean).toBeNull();
    expect(paired.carcRatio.ci95).toBeNull();
    expect(paired.judgeRecallDiff.mean).toBeNull();
  });
});
