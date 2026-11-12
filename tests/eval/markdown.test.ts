import { describe, expect, it } from "vitest";
import { analyzeRuns } from "../../src/eval/analysis/index.js";
import { renderAnalysisMarkdown } from "../../src/eval/analysis/markdown.js";
import { FINDING, record, snapshot } from "./fixtures.js";

/**
 * Markdown 报告渲染（#51 报告缝）：只消费 AnalysisReport，输出确定、无时间戳。
 * null（N/A）显示为 N/A，不冒充 0。
 */

function twoRunReport(currency: string | null = null) {
  return analyzeRuns({
    ...(currency === null
      ? {}
      : {
          priceTable: {
            currency,
            priceValidFrom: "2026-11-01T00:00:00Z",
            cacheHitPrice: 0.1,
            cacheMissPrice: 1,
            outputPrice: 2,
          },
        }),
    plannedCases: 2,
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
                { round: 1, phase: "Change Understanding", requestCount: 3 },
                { round: 1, phase: "Evidence Verification", requestCount: 3 },
              ],
              rejections: [],
              truncated: false,
              truncationReasons: [],
            },
          }),
        }),
      },
      {
        record: record({
          caseId: "VUL4J-10",
          configId: "E",
          rep: 2,
          baseline: snapshot({
            usage: { inputTokens: 400, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 0 },
            rounds: 2,
            toolCalls: 1,
            audit: {
              toolCallLog: [
                { name: "review.get_file", argumentsJson: "{}", resultSummary: "ok" },
                { name: "review.get_diff", argumentsJson: "{}", resultSummary: "budget" },
              ],
              phaseLog: [{ round: 1, phase: "Change Understanding", requestCount: 2 }],
              rejections: [],
              truncated: true,
              truncationReasons: ["MAX_ROUNDS_REACHED"],
            },
          }),
        }),
      },
    ],
  });
}

describe("renderAnalysisMarkdown", () => {
  it("输出四行主表、辅助指标、循环/工具计数与逐 run", () => {
    const text = renderAnalysisMarkdown(twoRunReport());

    expect(text).toContain("## 四行主表");
    for (const label of ["cachedInputTokens", "uncachedInputTokens", "outputTokens", "CARC"]) {
      expect(text).toContain(`| ${label} |`);
    }

    expect(text).toContain("## 辅助 token 指标");
    expect(text).toContain("| totalTokens |");
    expect(text).toContain("| cacheHitRate |");

    expect(text).toContain("## 循环与工具");
    for (const label of ["requests", "attemptedToolCalls", "executedToolCalls", "skippedToolCalls"]) {
      expect(text).toContain(`| ${label} |`);
    }

    expect(text).toContain("## 截断");
    expect(text).toContain("- truncatedRuns: 1");
    expect(text).toContain("- MAX_ROUNDS_REACHED: 1");

    expect(text).toContain("## 逐 run");
    expect(text).toContain("| VUL4J-10/E/rep-2 |");
  });

  it("缺价目 / 缺 retry / 缺 summary 时显示 N/A，不显示 0", () => {
    const text = renderAnalysisMarkdown(twoRunReport());

    expect(text).toContain("- currency: N/A");
    expect(text).toContain("- priceValidFrom: N/A");
    expect(text).toMatch(/\| retryCostTokens \| N\/A \| N\/A \| 0 \|/);
    expect(text).toMatch(/\| summaryCostTokens \| N\/A \| N\/A \| 0 \|/);
  });

  it("提供价目时回显币种与生效时间", () => {
    const text = renderAnalysisMarkdown(twoRunReport("CNY"));

    expect(text).toContain("- currency: CNY");
    expect(text).toContain("- priceValidFrom: 2026-11-01T00:00:00Z");
  });

  it("可复用前缀段：标注估算；缺 cacheRead 时 actual/gap 显示 N/A", () => {
    const base = "x".repeat(8);
    const report = analyzeRuns({
      runs: [
        {
          record: record({
            baseline: snapshot({ usage: { inputTokens: 10, outputTokens: 2 } }),
          }),
          wireBodies: [base, `${base}y`],
        },
      ],
    });
    const text = renderAnalysisMarkdown(report);
    expect(text).toContain("## 可复用前缀（估算）");
    expect(text).toContain("不冒充真实计费");
    expect(text).toMatch(/\| VUL4J-1\/E\/rep-1 \| 2 \| 1 \| 2 \| N\/A \| N\/A \|/);
  });

  it("同一报告两次渲染逐字节相同，且不含时间戳", () => {
    const report = twoRunReport();
    const first = renderAnalysisMarkdown(report);
    const second = renderAnalysisMarkdown(report);

    expect(first).toBe(second);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });
});
