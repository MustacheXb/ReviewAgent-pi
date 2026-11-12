import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewKernel } from "../../src/gate/review-kernel.js";
import type { UnitReviewRequest } from "../../src/gate/review-kernel.js";
import type { RunResult } from "../../src/instrument/contracts/run.js";
import {
  rebuildCampaignReport,
  runCampaign,
  type CampaignArm,
  type CampaignDeps,
  type CampaignRunResult,
  type JudgeClient,
} from "../../src/eval/campaign/index.js";
import {
  MODEL,
  NOW,
  fakeJudge,
  fakeKernel,
  mrCase,
  plan,
  provenance,
  readJson,
  runResult,
  sha256,
  tempDirRegistry,
  writeCases,
} from "./campaign-fixtures.js";

/**
 * L2 报告装配 seam（#41）：campaign runner 落 `l2-report.json`；双 arm 同窗口
 * 交错、冷热分离、四门判定与 claimsAllowed；`--report-only` 字节稳定。
 */

const tempDirs = tempDirRegistry();

afterEach(async () => {
  await tempDirs.cleanup();
});

/** usage 按 harness 调用序号注入（单元序 = case → rep → arm） */
function kernelWithUsage(
  usageFor: (callIndex: number, request: UnitReviewRequest) => Partial<RunResult["usage"]>,
): ReviewKernel {
  let callIndex = 0;
  return {
    id: "pi",
    execute: async (request) => {
      const index = callIndex;
      callIndex += 1;
      const base = runResult(request);
      return { ...base, usage: { ...base.usage, ...usageFor(index, request) } };
    },
  };
}

function l2File(outputDir: string): string {
  return path.join(outputDir, "l2-report.json");
}

async function runDualArm(
  overrides: {
    readonly kernel?: ReviewKernel;
    readonly armKernels?: Partial<Record<CampaignArm, ReviewKernel>>;
    readonly judge?: JudgeClient;
    readonly candidateRef?: string;
    readonly calibrationRef?: string | null;
  } = {},
): Promise<{ readonly result: CampaignRunResult; readonly outputDir: string }> {
  const dir = await tempDirs.create();
  const casesFile = await writeCases(dir, [mrCase("VUL4J-1"), mrCase("VUL4J-2")]);
  const outputDir = path.join(dir, "campaign");
  const campaign = plan({
    casesFile,
    outputDir,
    reps: 2,
    arms: ["baseline", "candidate"],
    ...(overrides.candidateRef !== undefined
      ? { candidateRef: overrides.candidateRef }
      : {}),
  });
  const deps: CampaignDeps = {
    kernel: overrides.kernel ?? fakeKernel(),
    judge: overrides.judge ?? fakeJudge(),
    now: () => NOW,
    ...(overrides.armKernels !== undefined ? { armKernels: overrides.armKernels } : {}),
  };
  const result = await runCampaign(
    {
      plan: campaign,
      environment: provenance(campaign.model, overrides.calibrationRef ?? null),
    },
    deps,
  );
  return { result, outputDir };
}

describe("runCampaign: L2 报告落盘", () => {
  it("l2-report.json 形状：refs / dataset / coverage / 冷热分离 / bootstrap 留痕", async () => {
    const { result, outputDir } = await runDualArm();

    expect(result.failures).toEqual([]);
    expect(existsSync(l2File(outputDir))).toBe(true);
    const report = readJson(l2File(outputDir));
    expect(report).toEqual(result.l2);
    expect(report).toMatchObject({
      kind: "l2-token-bench",
      schemaVersion: 3,
      campaignId: "smoke-2026-11-11",
      campaignType: "formal",
      calibrationRef: null,
      baseline: { ref: "eval-e-baseline-2026-11-11", model: MODEL },
      candidate: { ref: "0123456789abcdef", model: MODEL },
      environmentRef: "environment.json",
      coverage: {
        planned: 8,
        executed: 8,
        failed: 0,
        ratio: 1,
        note: "2 case × 2 reps × 2 arms",
      },
      sampling: { cases: 2, reps: 2, arms: 2, planned: 8 },
      bounds: {
        maxAttemptedToolCalls: 1,
        maxRequests: 2,
        maxOutputTokens: 200,
        truncatedRuns: 0,
      },
      bootstrap: { iterations: 10_000, seed: 20_261_111, confidence: 0.95 },
    });

    const casesText = readFileSync(path.join(outputDir, "cases.json"), "utf8");
    expect((report as { dataset: unknown }).dataset).toEqual({
      cases: 2,
      negativeControl: 0,
      hash: sha256(casesText),
    });

    // 冷热分离：rep1 单列，rep2+ 进主口径（两臂同数据 → CARC 1200 / 1200）
    const typed = report as {
      metrics: {
        baseline: {
          warm: { runs: number; cases: number; cost: { carc: { mean: number; count: number } } };
          cold: { runs: number; cost: { carc: { mean: number } } };
        };
        candidate: { warm: { runs: number }; cold: { runs: number } };
        paired: { warm: { carcRatio: { mean: number; ci95: number[] } } };
      };
    };
    expect(typed.metrics.baseline.warm).toMatchObject({ runs: 2, cases: 2 });
    expect(typed.metrics.baseline.warm.cost.carc).toEqual({ count: 2, mean: 1200, std: 0 });
    expect(typed.metrics.baseline.cold).toMatchObject({ runs: 2 });
    expect(typed.metrics.candidate.warm.runs).toBe(2);
    expect(typed.metrics.candidate.cold.runs).toBe(2);
  });

  it("相同臂同数据 → 成本比率 1、质量差 0、CI 包含 0；成本门 fail（无收益不得放行）", async () => {
    const { result } = await runDualArm();
    const warm = result.l2.metrics.paired.warm;

    expect(warm.carcRatio.mean).toBe(1);
    expect(warm.carcRatio.ci95).toEqual([1, 1]);
    expect(warm.judgeRecallDiff.mean).toBe(0);
    expect(warm.judgeRecallDiff.ci95).toEqual([0, 0]);
    expect(warm.judgePrecisionDiff.ci95).toEqual([0, 0]);

    expect(result.l2.gates.cost.pass).toBe(false);
    expect(result.l2.gates.quality.pass).toBe(true);
    expect(result.l2.gates.boundedness.pass).toBe(true);
    expect(result.l2.gates.reproducibility.pass).toBe(true);
    expect(result.l2.claimsAllowed).toBe(false);
  });

  it("候选臂 CARC 减半且质量不变 → 四门全过，claimsAllowed = true", async () => {
    // 单元序：case → rep → arm → 候选臂（奇数调用）用量减半
    const kernel = kernelWithUsage((index) =>
      index % 2 === 1
        ? { inputTokens: 500, cacheReadTokens: 300, outputTokens: 100 }
        : {},
    );

    const { result } = await runDualArm({ kernel });

    expect(result.l2.metrics.paired.warm.carcRatio.mean).toBe(0.5);
    expect(result.l2.metrics.paired.warm.uncachedRatio.mean).toBe(0.5);
    expect(result.l2.metrics.paired.warm.outputRatio.mean).toBe(0.5);
    expect(result.l2.gates.cost.pass).toBe(true);
    expect(result.l2.gates.quality.pass).toBe(true);
    expect(result.l2.claimsAllowed).toBe(true);
    expect(readJson(l2File(result.outDir))).toEqual(result.l2);
  });

  it("armKernels 按 arm 路由：baseline / candidate 可用不同运行器（跨 commit 对照缝）", async () => {
    const baselineKernel = kernelWithUsage(() => ({}));
    const candidateKernel = kernelWithUsage(() => ({
      inputTokens: 500,
      cacheReadTokens: 300,
      outputTokens: 100,
    }));

    const { result } = await runDualArm({
      armKernels: { baseline: baselineKernel, candidate: candidateKernel },
    });

    expect(result.l2.metrics.paired.warm.carcRatio.mean).toBe(0.5);
    expect(result.l2.claimsAllowed).toBe(true);
  });

  it("judge 失败不静默：coverage.judged < executed，质量门 fail", async () => {
    const { result } = await runDualArm({
      judge: fakeJudge({ failWhen: (request) => request.arm === "candidate" }),
    });

    expect(result.l2.coverage).toMatchObject({
      planned: 8,
      executed: 8,
      judged: 4,
      failed: 4,
      ratio: 0.5,
    });
    expect(result.l2.gates.quality.pass).toBe(false);
    expect(result.l2.claimsAllowed).toBe(false);
  });

  it("冷热口径分离：rep1 用量不同不影响 warm 主口径", async () => {
    // 所有 arm 的 rep1 用 1000 input，rep2 用 2000 input → cold CARC 1200 / warm 2200
    const kernel = kernelWithUsage((_index, request) =>
      request.unit.rep === 1 ? {} : { inputTokens: 2000, cacheReadTokens: 1200 },
    );

    const { result } = await runDualArm({ kernel });
    const baseline = result.l2.metrics.baseline;

    expect(baseline.cold.cost.carc?.mean).toBe(1200);
    expect(baseline.warm.cost.carc?.mean).toBe(2200);
  });

  it("双 arm 按 case × rep 交错执行（同窗口相邻）", async () => {
    const { result } = await runDualArm();

    expect(
      result.units.map((unit) => `${unit.caseId}/rep-${unit.rep}/${unit.arm}`),
    ).toEqual([
      "VUL4J-1/rep-1/baseline",
      "VUL4J-1/rep-1/candidate",
      "VUL4J-1/rep-2/baseline",
      "VUL4J-1/rep-2/candidate",
      "VUL4J-2/rep-1/baseline",
      "VUL4J-2/rep-1/candidate",
      "VUL4J-2/rep-2/baseline",
      "VUL4J-2/rep-2/candidate",
    ]);
  });
});

describe("L2 报告：空对照校准标识（#42）", () => {
  it("同 ref 双 arm → campaignType = calibration，calibrationRef 自指 campaignId", async () => {
    const { result, outputDir } = await runDualArm({
      candidateRef: "eval-e-baseline-2026-11-11",
    });

    expect(result.l2.campaignType).toBe("calibration");
    expect(result.l2.calibrationRef).toBe("smoke-2026-11-11");
    expect(result.l2.baseline.ref).toBe(result.l2.candidate.ref);
    // environment 与 l2 报告的 calibrationRef 必须一致（不留 null/id 裂缝）
    const environment = readJson(path.join(outputDir, "environment.json")) as {
      evaluation: { calibrationRef: string | null };
    };
    expect(environment.evaluation.calibrationRef).toBe("smoke-2026-11-11");
    // 空对照即使偶然出现成本下降也不得宣称收益
    expect(result.l2.claimsAllowed).toBe(false);
  });

  it("同 ref 双 arm 显式给自指 calibrationRef → 接受", async () => {
    const { result } = await runDualArm({
      candidateRef: "eval-e-baseline-2026-11-11",
      calibrationRef: "smoke-2026-11-11",
    });

    expect(result.l2.calibrationRef).toBe("smoke-2026-11-11");
  });

  it("同 ref 双 arm 但 calibrationRef 指向别的 campaign → fail fast（烧网关前）", async () => {
    await expect(
      runDualArm({
        candidateRef: "eval-e-baseline-2026-11-11",
        calibrationRef: "some-other-campaign",
      }),
    ).rejects.toThrow(/calibrationRef/);
  });

  it("正式 campaign 记录引用的 calibrationRef（可空）", async () => {
    const { result } = await runDualArm({
      calibrationRef: "p1-calibration-2026-11-11",
    });

    expect(result.l2.campaignType).toBe("formal");
    expect(result.l2.calibrationRef).toBe("p1-calibration-2026-11-11");
  });

  it("空对照校准落 noise-floor.json + NOISE-FLOOR.md；正式 campaign 不落", async () => {
    const calibration = await runDualArm({
      candidateRef: "eval-e-baseline-2026-11-11",
    });
    expect(calibration.result.noiseFloor).not.toBeNull();
    expect(calibration.result.noiseFloor?.calibrationRef).toBe("smoke-2026-11-11");
    expect(existsSync(path.join(calibration.outputDir, "noise-floor.json"))).toBe(true);
    expect(existsSync(path.join(calibration.outputDir, "NOISE-FLOOR.md"))).toBe(true);

    const formal = await runDualArm();
    expect(formal.result.noiseFloor).toBeNull();
    expect(existsSync(path.join(formal.outputDir, "noise-floor.json"))).toBe(false);
    expect(existsSync(path.join(formal.outputDir, "NOISE-FLOOR.md"))).toBe(false);
  });

  it("--report-only 重建噪声底产物，字节与直跑一致", async () => {
    const { result, outputDir } = await runDualArm({
      candidateRef: "eval-e-baseline-2026-11-11",
    });
    const noiseJson = path.join(outputDir, "noise-floor.json");
    const noiseMd = path.join(outputDir, "NOISE-FLOOR.md");
    const originalJson = readFileSync(noiseJson, "utf8");
    const originalMd = readFileSync(noiseMd, "utf8");

    await rm(noiseJson);
    await rm(noiseMd);

    const rebuilt = await rebuildCampaignReport({ outDir: outputDir });

    expect(rebuilt.noiseFloor).toEqual(result.noiseFloor);
    expect(readFileSync(noiseJson, "utf8")).toBe(originalJson);
    expect(readFileSync(noiseMd, "utf8")).toBe(originalMd);
  });
});

describe("runCampaign: 10×2 双 arm 冒烟（fake 依赖）", () => {
  it("10 case × 2 reps × 2 arms = 40 单元跑通，L2 报告完整（真实冒烟的离线等价）", async () => {
    const dir = await tempDirs.create();
    const cases = Array.from({ length: 10 }, (_, index) =>
      mrCase(`VUL4J-${String(index + 1).padStart(2, "0")}`),
    );
    const casesFile = await writeCases(dir, cases);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({
      campaignId: "p1-l2-smoke-fake",
      casesFile,
      outputDir,
      reps: 2,
      arms: ["baseline", "candidate"],
    });

    const result = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      { kernel: fakeKernel(), judge: fakeJudge(), now: () => NOW },
    );

    expect(result.failures).toEqual([]);
    expect(result.records).toHaveLength(40);
    expect(result.l2.coverage).toMatchObject({
      planned: 40,
      executed: 40,
      failed: 0,
      ratio: 1,
    });
    expect(result.l2.metrics.baseline.warm).toMatchObject({ runs: 10, cases: 10 });
    expect(result.l2.metrics.baseline.cold).toMatchObject({ runs: 10, cases: 10 });
    expect(result.l2.metrics.paired.warm.carcRatio).toMatchObject({ pairs: 10, mean: 1 });
    expect(result.l2.gates.cost.pass).toBe(false);
    expect(result.l2.gates.quality.pass).toBe(true);
    expect(result.l2.gates.boundedness.pass).toBe(true);
    expect(result.l2.gates.reproducibility.pass).toBe(true);
    expect(existsSync(l2File(outputDir))).toBe(true);
  });
});

describe("runCampaign: 单臂 / 缺证据不放行", () => {
  it("candidate 臂缺失 → 配对门 fail，claimsAllowed = false，报告仍落盘", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir, reps: 2, arms: ["baseline"] });

    const result = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      { kernel: fakeKernel(), judge: fakeJudge(), now: () => NOW },
    );

    expect(result.l2.gates.cost.pass).toBe(false);
    expect(result.l2.gates.quality.pass).toBe(false);
    expect(result.l2.claimsAllowed).toBe(false);
    expect(result.l2.coverage).toMatchObject({ planned: 2, executed: 2, ratio: 1 });
    expect(existsSync(l2File(outputDir))).toBe(true);
  });

  it("单元失败计入 coverage（failed），不静默剔除", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({
      casesFile,
      outputDir,
      reps: 2,
      arms: ["baseline", "candidate"],
    });

    const result = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      {
        kernel: fakeKernel({ failWhen: (_request, index) => index === 1 }),
        judge: fakeJudge(),
        now: () => NOW,
      },
    );

    expect(result.l2.coverage).toMatchObject({
      planned: 4,
      executed: 3,
      judged: 3,
      failed: 1,
      ratio: 0.75,
    });
    expect(result.l2.gates.quality.pass).toBe(false);
  });
});

describe("--report-only: L2 报告重建", () => {
  it("l2-report.json 可从记录重建，字节与直跑一致", async () => {
    const { result, outputDir } = await runDualArm();
    const originalL2 = readFileSync(l2File(outputDir), "utf8");

    await rm(l2File(outputDir));

    const rebuilt = await rebuildCampaignReport({ outDir: outputDir });

    expect(rebuilt.report).toEqual(result.report);
    expect(rebuilt.l2).toEqual(result.l2);
    expect(readFileSync(l2File(outputDir), "utf8")).toBe(originalL2);
  });
});
