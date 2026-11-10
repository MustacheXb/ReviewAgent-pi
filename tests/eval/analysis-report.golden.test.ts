import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { analyzeRuns } from "../../src/eval/analysis/index.js";
import { FINDING, record, snapshot } from "./fixtures.js";

/**
 * 报告 schema golden（#37 AC）：标准化报告 JSON 的 key 序、N/A null 语义与
 * 汇总形状以固定字节锁定；任何 schema 漂移（新增 / 删除 / 重命名 / 把 N/A
 * 写成 0）都会让本测试变红。
 *
 * 更新 golden 只能在 schema 版本号同步 + 评审通过后进行。
 */
const TRUTH = {
  locations: [
    {
      file: "src/main/java/example/ObjectArrayCodec.java",
      lineStart: 170,
      lineEnd: 180,
      defectNature: "SECURITY",
    },
  ],
};

it("报告 schema golden：key 序 / N/A null 语义 / 汇总形状稳定", () => {
  const report = analyzeRuns({
    plannedCases: 3,
    runs: [
      {
        record: record({
          caseId: "VUL4J-1",
          configId: "A",
          rep: 1,
          baseline: snapshot({
            usage: { inputTokens: 8502, outputTokens: 10348 },
            findings: [FINDING],
            audit: {
              toolCallLog: [],
              phaseLog: [
                { round: 1, phase: "Change Understanding", requestCount: 1 },
                { round: 1, phase: "Risk Classification", requestCount: 1 },
                { round: 1, phase: "Context Decision", requestCount: 1 },
                { round: 1, phase: "Context Retrieval", requestCount: 1 },
                { round: 1, phase: "Deep Reasoning", requestCount: 1 },
                { round: 1, phase: "Evidence Verification", requestCount: 1 },
              ],
              rejections: [],
              truncated: false,
              truncationReasons: [],
            },
          }),
        }),
        truth: TRUTH,
        judgeCounts: { tp: 1, fp: 0, fn: 0 },
      },
      {
        record: record({
          caseId: "VUL4J-10",
          configId: "E",
          rep: 2,
          baseline: snapshot({
            usage: { inputTokens: 400, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 0 },
            findings: [FINDING, { ...FINDING, id: "F002" }],
            rounds: 2,
            toolCalls: 2,
            audit: {
              toolCallLog: [
                { name: "review.get_file", argumentsJson: "{}", resultSummary: "ok" },
                { name: "review.get_file", argumentsJson: "{}", resultSummary: "ok" },
                {
                  name: "review.get_diff",
                  argumentsJson: "{}",
                  resultSummary: "Error: tool call budget exhausted",
                },
              ],
              phaseLog: [
                { round: 1, phase: "Change Understanding", requestCount: 3 },
                { round: 2, phase: "Evidence Verification", requestCount: 2 },
              ],
              rejections: [{ candidateId: "F003", stage: "NO_EVIDENCE", reason: "no evidence" }],
              truncated: false,
              truncationReasons: ["TOOL_BUDGET_EXHAUSTED"],
            },
          }),
        }),
        truth: null,
      },
      {
        record: record({
          caseId: "VUL4J-10",
          configId: "E",
          rep: 3,
          baseline: snapshot({
            usage: { inputTokens: 400, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 0 },
            findings: [],
            audit: {
              toolCallLog: [],
              phaseLog: [{ round: 1, phase: "Change Understanding", requestCount: 1 }],
              rejections: [],
              truncated: true,
              truncationReasons: ["MAX_ROUNDS_REACHED"],
            },
          }),
        }),
        truth: null,
      },
    ],
  });

  const text = `${JSON.stringify(report, null, 2)}\n`;
  const goldenPath = fileURLToPath(
    new URL("./testdata/analysis-report.golden.json", import.meta.url),
  );
  // schema 变更时显式重建：UPDATE_ANALYSIS_GOLDEN=1 仅用于评审通过的版本升级
  if (process.env.UPDATE_ANALYSIS_GOLDEN === "1") {
    writeFileSync(goldenPath, text, "utf8");
  }
  expect(text).toBe(readFileSync(goldenPath, "utf8"));
});
