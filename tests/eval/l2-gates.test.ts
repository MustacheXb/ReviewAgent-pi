import { describe, expect, it } from "vitest";
import type {
  L2Coverage,
  L2GateInput,
  L2PairedSet,
  L2ReproSample,
  L2RunSample,
  PairedDiff,
} from "../../src/eval/l2/contracts.js";
import { evaluateL2Gates } from "../../src/eval/l2/gates.js";
import { buildMetricSet, buildPairedSet } from "../../src/eval/l2/metrics.js";
import { l2Sample as sample } from "./l2-fixtures.js";

/**
 * L2 门判定 seam（#41）：成本 / 质量非劣 / 有界性 / 可复现四门 + claimsAllowed。
 * 只测公开输入 → 判定结果，不测内部检查顺序。
 */

const PASSING_COVERAGE: L2Coverage = {
  planned: 4,
  executed: 4,
  judged: 4,
  failed: 0,
  ratio: 1,
  note: "2 cases × 1 warm rep × 2 arms",
};

function passingInput(): L2GateInput {
  const baselineRuns = [
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
      judgeRecall: 0.5,
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
      judgeRecall: 0.6,
      judgePrecision: 0.8,
      findingCount: 2,
    }),
  ];
  const candidateRuns = [
    sample({
      caseId: "A",
      rep: 2,
      carc: 80,
      uncached: 48,
      output: 32,
      total: 240,
      cacheHit: 0.5,
      attempts: 4,
      requests: 5,
      judgeRecall: 0.5,
      judgePrecision: 0.6,
      findingCount: 1,
    }),
    sample({
      caseId: "B",
      rep: 2,
      carc: 160,
      uncached: 96,
      output: 64,
      total: 480,
      cacheHit: 0.25,
      attempts: 6,
      requests: 7,
      judgeRecall: 0.6,
      judgePrecision: 0.8,
      findingCount: 2,
    }),
  ];
  return {
    baselineRef: "eval-e-baseline-2026-11-11",
    candidateRef: "0123456789abcdef",
    baseline: buildMetricSet(baselineRuns),
    candidate: buildMetricSet(candidateRuns),
    paired: buildPairedSet(baselineRuns, candidateRuns),
    runs: [...baselineRuns, ...candidateRuns],
    repro: reproSamples(baselineRuns, candidateRuns),
    coverage: PASSING_COVERAGE,
    negativeControlCases: 0,
  };
}

function reproSamples(
  baseline: readonly L2RunSample[],
  candidate: readonly L2RunSample[],
): readonly L2ReproSample[] {
  return [
    ...baseline.map((run) => ({
      caseId: run.caseId,
      arm: "baseline",
      rep: run.rep,
      auditPath: `audit/${run.caseId}/baseline/rep-${run.rep}.json`,
      cacheBreaks: 0,
    })),
    ...candidate.map((run) => ({
      caseId: run.caseId,
      arm: "candidate",
      rep: run.rep,
      auditPath: `audit/${run.caseId}/candidate/rep-${run.rep}.json`,
      cacheBreaks: 0,
    })),
  ];
}

function withDiff(overrides: Partial<PairedDiff>): PairedDiff {
  return { pairs: 2, mean: 0, median: 0, std: 0, ci95: [0, 0], ...overrides };
}

function withPaired(overrides: Partial<L2PairedSet>): L2PairedSet {
  return { ...buildPairedSet([], []), ...overrides };
}

describe("evaluateL2Gates: 全门通过", () => {
  it("成本下降且质量非劣 → 四门 pass，claimsAllowed = true", () => {
    const evaluation = evaluateL2Gates(passingInput());

    expect(evaluation.gates.cost.pass).toBe(true);
    expect(evaluation.gates.quality.pass).toBe(true);
    expect(evaluation.gates.boundedness.pass).toBe(true);
    expect(evaluation.gates.reproducibility.pass).toBe(true);
    expect(evaluation.claimsAllowed).toBe(true);
    expect(evaluation.thresholds.maxCarcRatio).toBe(0.9);
  });

  it("baseline 与 candidate ref 相同（空对照校准）→ claimsAllowed = false", () => {
    const input = { ...passingInput(), candidateRef: "eval-e-baseline-2026-11-11" };

    const evaluation = evaluateL2Gates(input);

    expect(evaluation.gates.cost.pass).toBe(true);
    expect(evaluation.claimsAllowed).toBe(false);
  });

  it("数据集无 clean MR → 阴性对照 N/A，不因此失败", () => {
    const input = passingInput();
    const evaluation = evaluateL2Gates(input);

    expect(input.baseline.quality.negativeControlFpPerCase).toBeNull();
    expect(evaluation.gates.quality.pass).toBe(true);
    expect(evaluation.gates.quality.detail).toMatch(/negative control N\/A/);
  });
});

describe("evaluateL2Gates: 成本门", () => {
  it("CARC 比率超阈值 → cost fail（detail 指名 CARC）", () => {
    const base = passingInput();
    const evaluation = evaluateL2Gates({
      ...base,
      thresholds: { maxCarcRatio: 0.7 },
    });

    expect(evaluation.gates.cost.pass).toBe(false);
    expect(evaluation.gates.cost.detail).toMatch(/CARC/);
    expect(evaluation.claimsAllowed).toBe(false);
  });

  it("uncached 上升 → cost fail", () => {
    const base = passingInput();
    const evaluation = evaluateL2Gates({
      ...base,
      paired: {
        ...base.paired,
        uncachedRatio: {
          pairs: 2,
          mean: 1.2,
          median: 1.2,
          std: 0,
          ci95: [1.2, 1.2],
          absoluteDiff: null,
        },
      },
    });

    expect(evaluation.gates.cost.pass).toBe(false);
    expect(evaluation.gates.cost.detail).toMatch(/uncached/i);
  });

  it("没有 warm 配对样本 → cost / quality 均 fail（不足数据不得放行）", () => {
    const base = passingInput();
    const empty = withPaired({});
    const evaluation = evaluateL2Gates({
      ...base,
      paired: empty,
    });

    expect(evaluation.gates.cost.pass).toBe(false);
    expect(evaluation.gates.cost.detail).toMatch(/N\/A|pairs=0/);
    expect(evaluation.gates.quality.pass).toBe(false);
  });
});

describe("evaluateL2Gates: 质量非劣门", () => {
  it("judge Recall 配对 CI 下界低于 −3pp → quality fail", () => {
    const base = passingInput();
    const evaluation = evaluateL2Gates({
      ...base,
      paired: {
        ...base.paired,
        judgeRecallDiff: withDiff({ mean: -0.1, median: -0.1, std: 0, ci95: [-0.1, -0.1] }),
      },
    });

    expect(evaluation.gates.quality.pass).toBe(false);
    expect(evaluation.gates.quality.detail).toMatch(/judgeRecall/i);
  });

  it("零 finding 率上升超 2pp → quality fail", () => {
    const base = passingInput();
    const evaluation = evaluateL2Gates({
      ...base,
      paired: {
        ...base.paired,
        zeroFindingRateDiff: withDiff({ mean: 0.5, median: 0.5, ci95: [0.5, 0.5] }),
      },
    });

    expect(evaluation.gates.quality.pass).toBe(false);
    expect(evaluation.gates.quality.detail).toMatch(/zero-finding/i);
  });

  it("coverage 低于 95% → quality fail（不许静默丢样）", () => {
    const base = passingInput();
    const evaluation = evaluateL2Gates({
      ...base,
      coverage: { planned: 8, executed: 8, judged: 7, failed: 1, ratio: 7 / 8, note: "x" },
    });

    expect(evaluation.gates.quality.pass).toBe(false);
    expect(evaluation.gates.quality.detail).toMatch(/coverage/i);
  });

  it("数据集有 clean MR 但拿不到阴性对照数据 → quality fail（不足数据不放行）", () => {
    const base = passingInput();
    const evaluation = evaluateL2Gates({ ...base, negativeControlCases: 2 });

    expect(evaluation.gates.quality.pass).toBe(false);
    expect(evaluation.gates.quality.detail).toMatch(/negative control/i);
  });
});

describe("evaluateL2Gates: 有界性与可复现门", () => {
  it("attemptedToolCalls 超绝对上界 → boundedness fail", () => {
    const base = passingInput();
    const evaluation = evaluateL2Gates({
      ...base,
      runs: [
        ...base.runs,
        sample({ caseId: "C", rep: 2, carc: 10, attempts: 13, requests: 5 }),
      ],
    });

    expect(evaluation.gates.boundedness.pass).toBe(false);
    expect(evaluation.gates.boundedness.detail).toMatch(/attemptedToolCalls/);
  });

  it("truncated 但截断原因为空 → boundedness fail（截断原因必须显式）", () => {
    const base = passingInput();
    const evaluation = evaluateL2Gates({
      ...base,
      runs: [
        ...base.runs,
        sample({ caseId: "C", rep: 2, carc: 10, truncated: true, truncationReasons: [] }),
      ],
    });

    expect(evaluation.gates.boundedness.pass).toBe(false);
    expect(evaluation.gates.boundedness.detail).toMatch(/truncation/i);
  });

  it("Cache Break 非 0 → reproducibility fail", () => {
    const base = passingInput();
    const first = base.repro[0] as L2ReproSample;
    const evaluation = evaluateL2Gates({
      ...base,
      repro: [{ ...first, cacheBreaks: 1 }, ...base.repro.slice(1)],
    });

    expect(evaluation.gates.reproducibility.pass).toBe(false);
    expect(evaluation.gates.reproducibility.detail).toMatch(/cache break/i);
  });

  it("审计引用为空 → reproducibility fail（同输入审计不可重放）", () => {
    const base = passingInput();
    const first = base.repro[0] as L2ReproSample;
    const evaluation = evaluateL2Gates({
      ...base,
      repro: [{ ...first, auditPath: "" }, ...base.repro.slice(1)],
    });

    expect(evaluation.gates.reproducibility.pass).toBe(false);
    expect(evaluation.gates.reproducibility.detail).toMatch(/audit/i);
  });
});
