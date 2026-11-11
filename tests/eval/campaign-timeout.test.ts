import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JudgeClient } from "../../src/eval/campaign/index.js";
import { runCampaign } from "../../src/eval/campaign/index.js";
import type { ReviewKernel } from "../../src/gate/review-kernel.js";
import {
  NOW,
  fakeJudge,
  fakeKernel,
  mrCase,
  plan,
  provenance,
  tempDirRegistry,
  writeCases,
} from "./campaign-fixtures.js";

/**
 * 单元超时失败隔离（#40）：真实网络挂起时按 kernel / judge 阶段留痕，
 * 不拖垮整批；不设超时（fake 路径）时行为与 #39 一致。
 */

const tempDirs = tempDirRegistry();

afterEach(async () => {
  await tempDirs.cleanup();
});

function hangingJudge(): JudgeClient {
  return { judge: () => new Promise(() => {}) };
}

describe("runCampaign: 单单元超时", () => {
  it("kernel 超时按 kernel 阶段留痕，后续单元继续执行", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir, arms: ["baseline", "candidate"] });
    let calls = 0;
    const kernel: ReviewKernel = {
      id: "pi",
      execute: async (request) => {
        calls += 1;
        if (calls === 1) {
          return new Promise(() => {});
        }
        return fakeKernel().execute(request);
      },
    };

    const result = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      { kernel, judge: fakeJudge(), now: () => NOW, kernelTimeoutMs: 20 },
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.arm).toBe("candidate");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      caseId: "VUL4J-1",
      arm: "baseline",
      stage: "kernel",
    });
    expect(result.failures[0]?.error).toContain("kernel execution timed out after 20ms");
  });

  it("judge 超时按 judge 阶段留痕；单元记录保留、judge 列 N/A", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir, arms: ["baseline"] });

    const result = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      { kernel: fakeKernel(), judge: hangingJudge(), now: () => NOW, judgeTimeoutMs: 20 },
    );

    expect(result.records).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ stage: "judge" });
    expect(result.failures[0]?.error).toContain("judge execution timed out after 20ms");
    expect(result.report.arms.baseline?.runs[0]?.quality.judge).toBeNull();
  });

  it("缺省不设超时：快路径行为不变", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const campaign = plan({ casesFile, outputDir, arms: ["baseline"] });

    const result = await runCampaign(
      { plan: campaign, environment: provenance(campaign.model) },
      { kernel: fakeKernel(), judge: fakeJudge(), now: () => NOW },
    );

    expect(result.failures).toEqual([]);
    expect(result.records).toHaveLength(1);
  });
});
