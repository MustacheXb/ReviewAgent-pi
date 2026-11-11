import { describe, expect, it } from "vitest";
import type { UnitReviewRequest } from "../../src/gate/review-kernel.js";
import type { EvalRunRecord } from "../../src/eval/campaign/index.js";
import {
  createFakeJudgeClient,
  createFakeReviewKernel,
  fakeCampaignEnvironment,
} from "../../src/eval/campaign/fakes.js";
import { MODEL, NOW, mrCase } from "./campaign-fixtures.js";

/**
 * #39 进程入口的显式 fake 依赖（`run-campaign --fake`）：确定性、零网络。
 * 这些 fake 只用于骨架 tracer bullet，记录仍标 evalOnly。
 */

function request(caseId: string, truth: "provided" | "clean"): UnitReviewRequest {
  const base = mrCase(caseId);
  return {
    unit: { source: "vul4j", caseId, configId: "E", rep: 1 },
    mrCase: truth === "clean" ? { ...base, truth: null } : base,
    model: MODEL,
    experimentRoot: "runs/eval/smoke",
  };
}

function record(overrides: Partial<EvalRunRecord> = {}): EvalRunRecord {
  return {
    source: "vul4j",
    caseId: "VUL4J-1",
    configId: "E",
    rep: 1,
    model: MODEL,
    verifier: "off",
    completedAt: NOW,
    baseline: {
      findings: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      rounds: 1,
      toolCalls: 0,
      audit: {
        toolCallLog: [],
        phaseLog: [],
        rejections: [],
        truncated: false,
        truncationReasons: [],
      },
      auditPath: "",
    },
    effective: null,
    verifierPass: null,
    campaignId: "smoke-2026-11-11",
    arm: "baseline",
    evalOnly: true,
    environmentRef: "environment.json",
    ...overrides,
  };
}

describe("fake ReviewKernel / JudgeClient", () => {
  it("fake 内核在有真值时产出一条命中行位的 finding，clean MR 产出空集", async () => {
    const kernel = createFakeReviewKernel();
    const withTruth = await kernel.execute(request("VUL4J-1", "provided"));
    expect(withTruth).toMatchObject({ caseId: "VUL4J-1", configId: "E", model: MODEL });
    expect(withTruth.findings).toHaveLength(1);
    expect(withTruth.findings[0]).toMatchObject({
      file: "src/main/java/A.java",
      line: 10,
    });
    expect(withTruth.usage).toEqual({
      inputTokens: 1100,
      outputTokens: 200,
      cacheReadTokens: 600,
      cacheWriteTokens: 0,
    });

    const clean = await kernel.execute(request("CLEAN-1", "clean"));
    expect(clean.findings).toEqual([]);
  });

  it("fake judge 按文件 / 行区间统计 TP / FP / FN", async () => {
    const judge = createFakeJudgeClient();
    const caseWithTwoLocations = mrCase("VUL4J-1", {
      truth: {
        locations: [
          { file: "src/main/java/A.java", lineStart: 10, lineEnd: 12, defectNature: "SECURITY" },
          { file: "src/main/java/A.java", lineStart: 40, lineEnd: 42, defectNature: "CORRECTNESS" },
        ],
        fixPatch: "patch",
      },
    });
    const counts = await judge.judge({
      campaignId: "smoke-2026-11-11",
      arm: "baseline",
      rep: 1,
      mrCase: caseWithTwoLocations,
      record: record({
        baseline: {
          ...record().baseline,
          findings: [
            {
              id: "F001",
              severity: "P2",
              category: "SECURITY",
              file: "src/main/java/A.java",
              line: 11,
              title: "title",
              description: "description",
              evidence: ["evidence"],
              rule: "SECURITY-001",
              confidence: 0.8,
            },
            {
              id: "F002",
              severity: "P3",
              category: "STYLE",
              file: "src/main/java/A.java",
              line: 99,
              title: "title",
              description: "description",
              evidence: ["evidence"],
              rule: "STYLE-001",
              confidence: 0.5,
            },
          ],
        },
      }),
    });

    expect(counts).toEqual({ tp: 1, fp: 1, fn: 1 });
  });

  it("fake environment 使用 plan 模型，未知字段为 null", () => {
    const environment = fakeCampaignEnvironment(MODEL);
    expect(environment.model.requestedId).toBe(MODEL);
    expect(environment.evaluation).toEqual({ branch: "eval/bench", calibrationRef: null });
    expect(environment.window).toEqual({ start: null, end: null, timezone: null });
    expect(environment.git).toEqual({ branch: null, commit: null, tag: null });
  });
});
