import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  rebuildCampaignReport,
  runCampaign,
  type EvalRunRecord,
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
  sha256,
  tempDirRegistry,
  writeCases,
} from "./campaign-fixtures.js";

/**
 * Campaign runner seam（#39）：fake ReviewKernel / JudgeClient + 临时目录，
 * 走完「plan → 单元执行 → 记录 → 报告」。零网络；文件落盘断言走真实 fs。
 */

const tempDirs = tempDirRegistry();

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("runCampaign: E-only 单案 tracer bullet", () => {
  it("fake kernel / judge 下写出单元记录、报告、environment.json 与 failures.json", async () => {
    const dir = await tempDirs.create();
    const cases = [mrCase("VUL4J-1")];
    const casesFile = await writeCases(dir, cases);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir });
    const kernel = fakeKernel();
    const judge = fakeJudge();

    const result = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      { kernel, judge, now: () => NOW },
    );

    expect(result.failures).toEqual([]);
    expect(result.units).toEqual([
      { source: "vul4j", caseId: "VUL4J-1", arm: "baseline", rep: 1 },
    ]);
    expect(result.records).toHaveLength(1);

    const record = result.records[0] as EvalRunRecord;
    expect(record).toMatchObject({
      source: "vul4j",
      caseId: "VUL4J-1",
      configId: "E",
      rep: 1,
      model: MODEL,
      verifier: "off",
      completedAt: NOW,
      campaignId: campaign.campaignId,
      arm: "baseline",
      evalOnly: true,
      environmentRef: "environment.json",
    });

    // 单元记录落盘：设计布局 runs/<source>/<case>/<arm>/rep-<n>.json，字节稳定
    const recordFile = path.join(outputDir, "runs", "vul4j", "VUL4J-1", "baseline", "rep-1.json");
    expect(existsSync(recordFile)).toBe(true);
    expect(readFileSync(recordFile, "utf8")).toBe(`${JSON.stringify(record, null, 2)}\n`);

    // judge 结果独立落盘，供 --report-only 重建
    const judgeFile = path.join(outputDir, "judge", "vul4j", "VUL4J-1", "baseline", "rep-1.json");
    expect(existsSync(judgeFile)).toBe(true);
    expect(readJson(judgeFile)).toMatchObject({ status: "judged", counts: { tp: 1, fp: 0, fn: 0 } });

    // 报告按 arm 分节，每节复用只读分析器 schema；指标按独立字面值断言
    const reportFile = path.join(outputDir, "report.json");
    expect(existsSync(reportFile)).toBe(true);
    const report = readJson(reportFile) as {
      kind: string;
      schemaVersion: number;
      campaignId: string;
      arms: Record<
        string,
        {
          kind: string;
          schemaVersion: number;
          runs: Array<{ cost: Record<string, number | null>; quality: { judge: unknown } }>;
          summary: { runCount: number; caseCount: number };
          l1: { judge: { recall: unknown }; coverage: Record<string, unknown> };
        }
      >;
    };
    expect(report.kind).toBe("campaign-report");
    expect(report.schemaVersion).toBe(1);
    expect(report.campaignId).toBe(campaign.campaignId);
    const baseline = report.arms.baseline;
    expect(baseline?.kind).toBe("run-record-analysis");
    expect(baseline?.schemaVersion).toBe(1);
    expect(baseline?.runs).toHaveLength(1);
    expect(baseline?.runs[0]?.cost).toEqual({
      cachedInputTokens: 600,
      uncachedInputTokens: 1000,
      cacheWriteTokens: 0,
      outputTokens: 200,
      totalInputTokens: 1600,
      totalTokens: 1800,
      cacheHitRate: 0.375,
      toolCostTokens: 0,
      carc: 1200,
    });
    expect(baseline?.runs[0]?.quality.judge).toEqual({ recall: 1, precision: 1, f1: 1 });
    expect(baseline?.summary).toMatchObject({ runCount: 1, caseCount: 1 });
    expect(baseline?.l1.judge.recall).toEqual({ count: 1, mean: 1, std: 0 });
    expect(baseline?.l1.coverage).toEqual({ plannedCases: 1, executedCases: 1, ratio: 1 });
    expect(result.report).toEqual(report);

    // environment.json：B.3 形状 + 数据集 hash（原始 cases 字节的 sha256）
    const environmentFile = path.join(outputDir, "environment.json");
    expect(existsSync(environmentFile)).toBe(true);
    const casesText = readFileSync(casesFile, "utf8");
    const environment = readJson(environmentFile) as Record<string, unknown>;
    expect(Object.keys(environment)).toEqual([
      "campaignId",
      "evaluation",
      "git",
      "runtime",
      "model",
      "gateway",
      "judge",
      "prompts",
      "claudeCode",
      "window",
      "dataset",
    ]);
    expect(environment.campaignId).toBe(campaign.campaignId);
    expect(environment.evaluation).toEqual({
      branch: "eval/bench",
      campaign: campaign.campaignId,
      calibrationRef: null,
    });
    expect(environment.model).toMatchObject({ requestedId: MODEL });
    expect(environment.dataset).toEqual({
      casesFile,
      caseCount: 1,
      hash: sha256(casesText),
    });

    // plan.json / cases.json / failures.json 全部落盘；cases.json 保留原始字节
    expect(readJson(path.join(outputDir, "plan.json"))).toEqual(campaign);
    expect(readFileSync(path.join(outputDir, "cases.json"), "utf8")).toBe(casesText);
    expect(readJson(path.join(outputDir, "failures.json"))).toEqual([]);

    // 内核请求面：E 恒定、实验根 = campaign 输出目录
    expect(kernel.calls).toHaveLength(1);
    expect(kernel.calls[0]).toMatchObject({
      unit: { source: "vul4j", caseId: "VUL4J-1", configId: "E", rep: 1 },
      model: MODEL,
      experimentRoot: outputDir,
    });
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]).toMatchObject({ campaignId: campaign.campaignId, arm: "baseline", rep: 1 });
  });
});

describe("runCampaign: 双臂 / 多 rep 展开与汇总", () => {
  it("按 case → rep → arm 顺序执行，报告覆盖全部单元", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir, reps: 2, arms: ["baseline", "candidate"] });
    const kernel = fakeKernel();

    const result = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      { kernel, judge: fakeJudge(), now: () => NOW },
    );

    expect(
      result.records.map((record) => `${record.arm}/rep-${record.rep}`),
    ).toEqual(["baseline/rep-1", "candidate/rep-1", "baseline/rep-2", "candidate/rep-2"]);
    expect(kernel.calls).toHaveLength(4);
    expect(result.report.arms.baseline?.summary).toMatchObject({ runCount: 2, caseCount: 1 });
    expect(result.report.arms.candidate?.summary).toMatchObject({ runCount: 2, caseCount: 1 });
    expect(result.report.arms.baseline?.l1.coverage).toEqual({
      plannedCases: 1,
      executedCases: 1,
      ratio: 1,
    });
  });
});

describe("runCampaign: 失败隔离留痕", () => {
  it("单单元 kernel 失败不拖垮整批：其余单元照常记录，failures.json 留痕", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir, arms: ["baseline", "candidate"] });
    const kernel = fakeKernel({ failWhen: (_request, callIndex) => callIndex === 1 });
    const judge = fakeJudge();

    const result = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      { kernel, judge, now: () => NOW },
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.arm).toBe("baseline");
    expect(result.failures).toEqual([
      {
        campaignId: campaign.campaignId,
        source: "vul4j",
        caseId: "VUL4J-1",
        arm: "candidate",
        rep: 1,
        stage: "kernel",
        error: "kernel failed for VUL4J-1/rep-1",
        at: NOW,
      },
    ]);
    expect(readJson(path.join(outputDir, "failures.json"))).toEqual(result.failures);
    expect(judge.calls).toHaveLength(1);
    expect(existsSync(path.join(outputDir, "report.json"))).toBe(true);
    expect(result.report.arms.baseline?.summary.runCount).toBe(1);
    expect(result.report.arms.candidate).toBeUndefined();
  });

  it("judge 失败不丢单元记录：judge 记录标 failed，报告对应行为 N/A", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir, arms: ["baseline", "candidate"] });
    const judge = fakeJudge({ failWhen: (request) => request.arm === "candidate" });

    const result = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      { kernel: fakeKernel(), judge, now: () => NOW },
    );

    expect(result.records).toHaveLength(2);
    expect(result.failures).toEqual([
      {
        campaignId: campaign.campaignId,
        source: "vul4j",
        caseId: "VUL4J-1",
        arm: "candidate",
        rep: 1,
        stage: "judge",
        error: "judge failed for candidate",
        at: NOW,
      },
    ]);
    const judgeFile = path.join(outputDir, "judge", "vul4j", "VUL4J-1", "candidate", "rep-1.json");
    expect(readJson(judgeFile)).toMatchObject({ status: "failed", error: "judge failed for candidate" });
    expect(result.report.arms.candidate?.runs[0]?.quality.judge).toBeNull();
    expect(result.report.arms.baseline?.runs[0]?.quality.judge).toEqual({
      recall: 1,
      precision: 1,
      f1: 1,
    });
    expect(result.report.arms.baseline?.l1.judge.runs).toBe(1);
    expect(result.report.arms.candidate?.l1.judge.runs).toBe(0);
  });
});

describe("runCampaign: 同目录重跑", () => {
  it("清理上次单元产物，report-only 不重建陈旧记录", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir, arms: ["baseline", "candidate"] });

    const first = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      { kernel: fakeKernel(), judge: fakeJudge(), now: () => NOW },
    );
    expect(first.records).toHaveLength(2);

    // 真跑内核审计落在 <out>/audit（重放字节）；重跑必须同代清理
    const staleAudit = path.join(outputDir, "audit", "stale.json");
    mkdirSync(path.dirname(staleAudit), { recursive: true });
    writeFileSync(staleAudit, "{}\n", "utf8");

    const second = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      {
        kernel: fakeKernel({ failWhen: (_request, callIndex) => callIndex === 1 }),
        judge: fakeJudge(),
        now: () => NOW,
      },
    );

    expect(second.records).toHaveLength(1);
    expect(second.failures).toHaveLength(1);
    expect(second.report.arms.candidate).toBeUndefined();

    const rebuilt = await rebuildCampaignReport({ outDir: outputDir });
    expect(rebuilt.report).toEqual(second.report);
    expect(
      existsSync(path.join(outputDir, "runs", "vul4j", "VUL4J-1", "candidate", "rep-1.json")),
    ).toBe(false);
    expect(
      existsSync(path.join(outputDir, "judge", "vul4j", "VUL4J-1", "candidate", "rep-1.json")),
    ).toBe(false);
    expect(existsSync(staleAudit)).toBe(false);
  });
});

describe("runCampaign: judge 有界失败留痕", () => {
  it("judge 丢弃畸形 / 越界条目时 anomalies 落盘（不静默吞掉）", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir, arms: ["baseline"] });
    const anomalies = ["dropped malformed match entry 2 (invalid shape/index/confidence)"];

    const result = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      { kernel: fakeKernel(), judge: fakeJudge({ anomalies }), now: () => NOW },
    );

    expect(result.failures).toEqual([]);
    const judgeFile = path.join(outputDir, "judge", "vul4j", "VUL4J-1", "baseline", "rep-1.json");
    expect(readJson(judgeFile)).toMatchObject({ status: "judged", anomalies });
  });
});

describe("runCampaign: 进度回调（#40 事故诊断）", () => {
  it("按阶段发出进度事件；回调异常不影响评测", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir, arms: ["baseline"] });
    const events: string[] = [];

    const result = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model), progress: (event) => events.push(event) },
      { kernel: fakeKernel(), judge: fakeJudge(), now: () => NOW },
    );

    expect(result.failures).toEqual([]);
    expect(events[0]).toMatch(/^run-start /);
    expect(events).toContain("unit-start VUL4J-1/baseline/rep-1");
    expect(events).toContain("kernel-done");
    expect(events).toContain("record-written");
    expect(events.some((event) => event.startsWith("judge-done"))).toBe(true);
    expect(events).toContain("unit-done VUL4J-1/baseline/rep-1");
    expect(
      events.some((event) => event.startsWith("run-done records=1 failures=0")),
    ).toBe(true);

    // 诊断回调抛错不得拖垮运行
    const throwing = await runCampaign(
      {
        plan: campaign,
        environment: provenance(campaign.model),
        progress: () => {
          throw new Error("progress sink failed");
        },
      },
      { kernel: fakeKernel(), judge: fakeJudge(), now: () => NOW },
    );
    expect(throwing.failures).toEqual([]);
    expect(throwing.records).toHaveLength(1);
  });
});

describe("runCampaign: repoPath 解析基准", () => {
  it("相对 repoPath 按 repoRoot 解析后送入内核；cases 原始字节不变", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir, arms: ["baseline"] });
    const kernel = fakeKernel();
    const repoRoot = path.join(dir, "repo-root");

    await runCampaign(
      { plan: campaign, environment: provenance(campaign.model), repoRoot },
      { kernel, judge: fakeJudge(), now: () => NOW },
    );

    expect(kernel.calls[0]?.mrCase.repoPath).toBe(
      path.resolve(repoRoot, ".cache/datasets/vul4j-repos/VUL4J-1"),
    );
    // 数据集 hash 依据原始 cases 字节：不写回绝对路径
    expect(readFileSync(path.join(outputDir, "cases.json"), "utf8")).toBe(
      readFileSync(casesFile, "utf8"),
    );
  });
});

describe("runCampaign: --resume 续跑（长跑中断恢复）", () => {
  it("跳过已完成单元，只重跑缺失 / 失败单元；报告覆盖全量", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1"), mrCase("VUL4J-2")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir, arms: ["baseline"] });

    const first = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      {
        kernel: fakeKernel({ failWhen: (_request, callIndex) => callIndex === 1 }),
        judge: fakeJudge(),
        now: () => NOW,
      },
    );
    expect(first.records).toHaveLength(1);
    expect(first.failures).toHaveLength(1);

    const kernel = fakeKernel();
    const judge = fakeJudge();
    const resumed = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model), resume: true },
      { kernel, judge, now: () => NOW },
    );

    expect(resumed.records.map((record) => record.caseId)).toEqual(["VUL4J-1", "VUL4J-2"]);
    expect(resumed.failures).toEqual([]);
    expect(kernel.calls.map((call) => call.unit.caseId)).toEqual(["VUL4J-2"]);
    expect(judge.calls.map((call) => call.record.caseId)).toEqual(["VUL4J-2"]);
    expect(resumed.report.arms.baseline?.summary).toMatchObject({ runCount: 2, caseCount: 2 });
  });

  it("记录已落盘但 judge 失败：续跑只补判，不重跑内核", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir, arms: ["baseline"] });

    const first = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      {
        kernel: fakeKernel(),
        judge: fakeJudge({ failWhen: () => true }),
        now: () => NOW,
      },
    );
    expect(first.records).toHaveLength(1);
    expect(first.failures).toHaveLength(1);

    const kernel = fakeKernel();
    const judge = fakeJudge();
    const resumed = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model), resume: true },
      { kernel, judge, now: () => NOW },
    );

    expect(kernel.calls).toEqual([]);
    expect(judge.calls).toHaveLength(1);
    expect(resumed.failures).toEqual([]);
    expect(resumed.records).toHaveLength(1);
    expect(resumed.report.arms.baseline?.l1.judge.runs).toBe(1);
  });

  it("无既有产物时 resume 等价全新运行", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir, arms: ["baseline"] });
    const kernel = fakeKernel();

    const resumed = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model), resume: true },
      { kernel, judge: fakeJudge(), now: () => NOW },
    );

    expect(kernel.calls).toHaveLength(1);
    expect(resumed.records).toHaveLength(1);
    expect(resumed.failures).toEqual([]);
  });
});

describe("runCampaign: 环境口径守卫", () => {
  it("environment 的被测模型必须与 plan.model 一致", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const campaign = plan({ casesFile, outputDir: path.join(dir, "campaign") });

    await expect(
      runCampaign(
        { plan: campaign, environment: provenance("other-model") },
        { kernel: fakeKernel(), judge: fakeJudge(), now: () => NOW },
      ),
    ).rejects.toThrow(/model/);
  });
});
