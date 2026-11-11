import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  rebuildCampaignReport,
  runCampaign,
  type CampaignRunResult,
} from "../../src/eval/campaign/index.js";
import {
  NOW,
  fakeJudge,
  fakeKernel,
  mrCase,
  plan,
  provenance,
  readJson,
  tempDirRegistry,
  writeCases,
} from "./campaign-fixtures.js";

/**
 * `--report-only` seam（#39）：只读已有记录重建 campaign 报告，不执行内核 /
 * judge。报告字节与直接跑出的报告一致；记录 / cases / judge 不一致时 fail fast。
 */

const tempDirs = tempDirRegistry();

afterEach(async () => {
  await tempDirs.cleanup();
});

async function runFixture(): Promise<{ readonly result: CampaignRunResult; readonly outputDir: string }> {
  const dir = await tempDirs.create();
  const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
  const outputDir = path.join(dir, "campaign");
  const campaign = plan({ casesFile, outputDir, reps: 2, arms: ["baseline", "candidate"] });
  const result = await runCampaign(
    { plan: campaign, environment: provenance(campaign.model) },
    { kernel: fakeKernel(), judge: fakeJudge(), now: () => NOW },
  );
  return { result, outputDir };
}

describe("rebuildCampaignReport: 从已有记录重建", () => {
  it("删除 report.json 后可从记录 / judge / cases 重建，字节与直跑报告一致", async () => {
    const { result, outputDir } = await runFixture();
    const reportFile = path.join(outputDir, "report.json");
    const originalBytes = readFileSync(reportFile, "utf8");
    await rm(reportFile);

    const rebuilt = await rebuildCampaignReport({ outDir: outputDir });

    expect(rebuilt.report).toEqual(result.report);
    expect(rebuilt.l2).toEqual(result.l2);
    expect(readFileSync(reportFile, "utf8")).toBe(originalBytes);
    expect(rebuilt.report.kind).toBe("campaign-report");
    expect(rebuilt.report.arms.baseline?.kind).toBe("run-record-analysis");
    expect(rebuilt.report.arms.baseline?.summary.runCount).toBe(2);
    expect(rebuilt.report.arms.candidate?.summary.runCount).toBe(2);
    expect(rebuilt.report.arms.baseline?.l1.judge.runs).toBe(2);
  });

  it("cases.json 与 environment.json 的 dataset hash 不一致时 fail fast", async () => {
    const { outputDir } = await runFixture();
    const casesFile = path.join(outputDir, "cases.json");
    const cases = readJson(casesFile) as Array<Record<string, unknown>>;
    cases[0] = { ...cases[0], issueDescription: "tampered" };
    await writeFile(casesFile, JSON.stringify(cases, null, 2), "utf8");

    await expect(rebuildCampaignReport({ outDir: outputDir })).rejects.toThrow(/hash/);
  });

  it("记录引用 cases.json 中不存在的 case 时 fail fast", async () => {
    const { outputDir } = await runFixture();
    const sourceRecord = readJson(
      path.join(outputDir, "runs", "vul4j", "VUL4J-1", "baseline", "rep-1.json"),
    ) as Record<string, unknown>;
    const orphanFile = path.join(outputDir, "runs", "vul4j", "UNKNOWN", "baseline", "rep-1.json");
    await mkdir(path.dirname(orphanFile), { recursive: true });
    await writeFile(
      orphanFile,
      `${JSON.stringify({ ...sourceRecord, caseId: "UNKNOWN" }, null, 2)}\n`,
      "utf8",
    );

    await expect(rebuildCampaignReport({ outDir: outputDir })).rejects.toThrow(/case/);
  });

  it("judge 留痕找不到对应单元记录时 fail fast", async () => {
    const { outputDir } = await runFixture();
    const sourceJudge = readJson(
      path.join(outputDir, "judge", "vul4j", "VUL4J-1", "baseline", "rep-1.json"),
    ) as Record<string, unknown>;
    const orphanFile = path.join(outputDir, "judge", "vul4j", "UNKNOWN", "baseline", "rep-1.json");
    await mkdir(path.dirname(orphanFile), { recursive: true });
    await writeFile(orphanFile, `${JSON.stringify(sourceJudge, null, 2)}\n`, "utf8");

    await expect(rebuildCampaignReport({ outDir: outputDir })).rejects.toThrow(/judge/);
  });

  it("environment.json 缺失时 fail fast（报告不能无 provenance）", async () => {
    const { outputDir } = await runFixture();
    await rm(path.join(outputDir, "environment.json"));

    await expect(rebuildCampaignReport({ outDir: outputDir })).rejects.toThrow(/environment/);
  });

  it("没有任何单元记录时 fail fast（不生成伪报告）", async () => {
    const { outputDir } = await runFixture();
    await rm(path.join(outputDir, "runs"), { recursive: true, force: true });

    await expect(rebuildCampaignReport({ outDir: outputDir })).rejects.toThrow(/record/);
  });
});
