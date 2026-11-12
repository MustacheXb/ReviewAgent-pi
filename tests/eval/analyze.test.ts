import { describe, expect, it } from "vitest";
import { analyzeRuns, validateAnalysisInput } from "../../src/eval/analysis/index.js";
import { FINDING, record, snapshot } from "./fixtures.js";

/**
 * 只读 RunRecord 分析器（#37）主 seam：analyzeRuns(input) → 标准化报告。
 * 全部为离线纯函数测试：零网络、零 LLM、零文件系统。
 */

describe("analyzeRuns: 四行 token 记账（cached / uncached / output / CARC）", () => {
  it("E 记录：缓存字段齐备时按 spec 口径计算四行指标", () => {
    const report = analyzeRuns({
      runs: [
        {
          record: record({
            baseline: snapshot({
              usage: { inputTokens: 400, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 0 },
            }),
          }),
        },
      ],
    });

    expect(report.runs[0]?.cost).toEqual({
      cachedInputTokens: 600,
      uncachedInputTokens: 400,
      cacheWriteTokens: 0,
      outputTokens: 100,
      totalInputTokens: 1000,
      totalTokens: 1100,
      cacheHitRate: 0.6,
      toolCostTokens: 0,
      retryCostTokens: null,
      summaryCostTokens: null,
      carc: 500,
    });
  });

  it("历史 A–D 记录：缺失缓存字段记 null（N/A）而非 0，CARC 按全输入计", () => {
    const report = analyzeRuns({
      runs: [
        {
          record: record({
            configId: "A",
            baseline: snapshot({ usage: { inputTokens: 8502, outputTokens: 10348 } }),
          }),
        },
      ],
    });

    expect(report.runs[0]?.cost).toEqual({
      cachedInputTokens: null,
      uncachedInputTokens: 8502,
      cacheWriteTokens: null,
      outputTokens: 10348,
      totalInputTokens: null,
      totalTokens: null,
      cacheHitRate: null,
      toolCostTokens: 0,
      retryCostTokens: null,
      summaryCostTokens: null,
      carc: 18850,
    });
  });

  it("工具成本计价可注入；CARC 含 toolCostTokens", () => {
    const report = analyzeRuns({
      toolCost: { fixedCostPerCall: 2, costPerResultChar: 0.5 },
      runs: [
        {
          record: record({
            baseline: snapshot({
              usage: { inputTokens: 100, outputTokens: 10 },
              toolCalls: 2,
              audit: {
                toolCallLog: [
                  { name: "review.get_file", argumentsJson: "{}", resultSummary: "abcd" },
                  { name: "review.get_diff", argumentsJson: "{}", resultSummary: "ef" },
                ],
                phaseLog: [],
                rejections: [],
                truncated: false,
                truncationReasons: [],
              },
            }),
          }),
        },
      ],
    });

    expect(report.runs[0]?.cost.toolCostTokens).toBe(7);
    expect(report.runs[0]?.cost.carc).toBe(117);
  });
  it("retry / summary 成本缺省为 null（N/A）；提供时独立报告，不改变 CARC", () => {
    const base = {
      record: record({
        baseline: snapshot({ usage: { inputTokens: 100, outputTokens: 10 } }),
      }),
    };

    const missing = analyzeRuns({ runs: [base] });
    expect(missing.runs[0]?.cost.retryCostTokens).toBeNull();
    expect(missing.runs[0]?.cost.summaryCostTokens).toBeNull();
    expect(missing.runs[0]?.cost.carc).toBe(110);

    const provided = analyzeRuns({
      runs: [{ ...base, retryCostTokens: 7, summaryCostTokens: 3 }],
    });
    expect(provided.runs[0]?.cost.retryCostTokens).toBe(7);
    expect(provided.runs[0]?.cost.summaryCostTokens).toBe(3);
    expect(provided.runs[0]?.cost.carc).toBe(110);
  });

  it("skippedToolCalls = attempted − executed（历史记录缺字段仍可读，不为负）", () => {
    const report = analyzeRuns({
      runs: [
        {
          record: record({
            baseline: snapshot({
              usage: { inputTokens: 1, outputTokens: 1 },
              toolCalls: 2,
              audit: {
                toolCallLog: [
                  { name: "review.get_file", argumentsJson: "{}", resultSummary: "a" },
                  { name: "review.get_file", argumentsJson: "{}", resultSummary: "b" },
                  { name: "review.get_file", argumentsJson: "{}", resultSummary: "budget" },
                ],
                phaseLog: [],
                rejections: [],
                truncated: false,
                truncationReasons: [],
              },
            }),
          }),
        },
      ],
    });

    expect(report.runs[0]?.loop.skippedToolCalls).toBe(1);
    expect(report.summary.loop.skippedToolCalls).toEqual({ count: 1, mean: 1, std: 0 });
  });

  it("缺价目表时 currency / priceValidFrom 为 null；提供时回显", () => {
    const runs = [{ record: record() }];

    const missing = analyzeRuns({ runs });
    expect(missing.currency).toBeNull();
    expect(missing.priceValidFrom).toBeNull();

    const priced = analyzeRuns({
      runs,
      priceTable: {
        currency: "CNY",
        priceValidFrom: "2026-11-01T00:00:00Z",
        cacheHitPrice: 0.1,
        cacheMissPrice: 1,
        outputPrice: 2,
      },
    });
    expect(priced.currency).toBe("CNY");
    expect(priced.priceValidFrom).toBe("2026-11-01T00:00:00Z");
  });

  it("价目表字段非法时 fail fast", () => {
    expect(() =>
      analyzeRuns({
        runs: [{ record: record() }],
        priceTable: {
          currency: "",
          priceValidFrom: "2026-11-01",
          cacheHitPrice: 0,
          cacheMissPrice: 0,
          outputPrice: 0,
        },
      }),
    ).toThrow(/currency/);
    expect(() =>
      analyzeRuns({
        runs: [{ record: record() }],
        priceTable: {
          currency: "CNY",
          priceValidFrom: "2026-11-01",
          cacheHitPrice: -1,
          cacheMissPrice: 0,
          outputPrice: 0,
        },
      }),
    ).toThrow(/cacheHitPrice/);
  });
});

describe("analyzeRuns: 质量列（rule / judge 双列，PRF 零分母记 null）", () => {
  const TRUTH = {
    locations: [
      {
        file: "a/src/main/java/example/ObjectArrayCodec.java",
        lineStart: 170,
        lineEnd: 180,
        defectNature: "security",
      },
    ],
  };

  it("rule 列：文件路径归一 + 行区间 + 性质大小写归一后匹配", () => {
    const report = analyzeRuns({
      runs: [
        {
          record: record({
            baseline: snapshot({
              usage: { inputTokens: 100, outputTokens: 10 },
              findings: [FINDING],
            }),
          }),
          truth: TRUTH,
        },
      ],
    });

    expect(report.runs[0]?.quality).toEqual({
      findingCount: 1,
      zeroFindings: false,
      truth: "provided",
      rule: { recall: 1, precision: 1, f1: 1 },
      judge: null,
    });
  });

  it("rule 列：真值外 finding 记 FP；零 finding 时 precision 为 null（未定义）", () => {
    const report = analyzeRuns({
      runs: [
        {
          record: record({
            caseId: "VUL4J-2",
            baseline: snapshot({
              usage: { inputTokens: 100, outputTokens: 10 },
              findings: [FINDING, { ...FINDING, id: "F002", line: 999 }],
            }),
          }),
          truth: TRUTH,
        },
        {
          record: record({
            caseId: "VUL4J-3",
            baseline: snapshot({ usage: { inputTokens: 100, outputTokens: 10 } }),
          }),
          truth: TRUTH,
        },
      ],
    });

    expect(report.runs[0]?.quality.rule).toEqual({ recall: 1, precision: 0.5, f1: 2 / 3 });
    expect(report.runs[1]?.quality.rule).toEqual({ recall: 0, precision: null, f1: null });
    expect(report.runs[1]?.quality.zeroFindings).toBe(true);
  });

  it("judge 列：消费预计算的 judge 行级计数；未提供时为 null", () => {    const report = analyzeRuns({
      runs: [
        {
          record: record({ caseId: "VUL4J-1", rep: 1 }),
          judgeCounts: { tp: 1, fp: 1, fn: 0 },
        },
        { record: record({ caseId: "VUL4J-2", rep: 1 }) },
      ],
    });

    expect(report.runs[0]?.quality.judge).toEqual({
      recall: 1,
      precision: 0.5,
      f1: 2 / 3,
    });
    expect(report.runs[1]?.quality.judge).toBeNull();
  });

  it("clean MR（truth = null）：rule / judge 列 N/A，阴性对照不计入主质量列", () => {
    const report = analyzeRuns({
      runs: [
        {
          record: record({
            caseId: "CLEAN-1",
            baseline: snapshot({
              usage: { inputTokens: 100, outputTokens: 10 },
              findings: [FINDING],
            }),
          }),
          truth: null,
          judgeCounts: { tp: 0, fp: 1, fn: 0 },
        },
      ],
    });

    expect(report.runs[0]?.quality).toEqual({
      findingCount: 1,
      zeroFindings: false,
      truth: "clean",
      rule: null,
      judge: { recall: null, precision: 0, f1: null },
    });
    expect(report.l1.judge.runs).toBe(0);
  });
});

describe("analyzeRuns: L1 报告与跨 case 汇总", () => {
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

  function l1Fixture() {
    return {
      runs: [
        {
          record: record({
            caseId: "VUL4J-1",
            configId: "A",
            rep: 1,
            baseline: snapshot({
              usage: { inputTokens: 100, outputTokens: 10 },
              findings: [FINDING],
              audit: {
                toolCallLog: [],
                phaseLog: [{ round: 1, phase: "Change Understanding", requestCount: 2 }],
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
            caseId: "VUL4J-1",
            configId: "B",
            rep: 1,
            baseline: snapshot({
              usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 50 },
              findings: [],
              audit: {
                toolCallLog: [],
                phaseLog: [{ round: 1, phase: "Change Understanding", requestCount: 3 }],
                rejections: [
                  { candidateId: "F001", stage: "NO_EVIDENCE", reason: "no evidence" },
                  { candidateId: "F002", stage: "VERIFICATION_FAILED", reason: "failed" },
                ],
                truncated: false,
                truncationReasons: [],
              },
            }),
          }),
          truth: TRUTH,
          judgeCounts: { tp: 0, fp: 0, fn: 1 },
        },
        {
          record: record({
            caseId: "VUL4J-2",
            configId: "E",
            rep: 2,
            baseline: snapshot({
              usage: { inputTokens: 400, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 0 },
              findings: [FINDING, { ...FINDING, id: "F002" }],
              toolCalls: 2,
              audit: {
                toolCallLog: [
                  { name: "review.get_file", argumentsJson: "{}", resultSummary: "ok" },
                  { name: "review.get_file", argumentsJson: "{}", resultSummary: "ok" },
                ],
                phaseLog: [{ round: 1, phase: "Change Understanding", requestCount: 1 }],
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
            caseId: "VUL4J-2",
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
      plannedCases: 3,
    } satisfies Parameters<typeof analyzeRuns>[0];
  }

  it("L1：rule / judge 双列按 case 等权聚合；零 finding 率与阴性对照 FP 单列", () => {
    const report = analyzeRuns(l1Fixture());

    expect(report.l1).toEqual({
      runCount: 4,
      caseCount: 2,
      rule: {
        runs: 2,
        recall: { count: 1, mean: 0.5, std: 0 },
        precision: { count: 1, mean: 1, std: 0 },
        f1: { count: 1, mean: 1, std: 0 },
      },
      judge: {
        runs: 2,
        recall: { count: 1, mean: 0.5, std: 0 },
        precision: { count: 1, mean: 1, std: 0 },
        f1: { count: 1, mean: 1, std: 0 },
      },
      zeroFinding: {
        runs: 4,
        zeroRuns: 2,
        rate: { count: 2, mean: 0.5, std: 0 },
      },
      negativeControl: {
        cases: 1,
        runs: 2,
        fpPerCase: { count: 1, mean: 1, std: 0 },
      },
      evidenceGateRejections: {
        SCHEMA_INVALID: 0,
        NON_ENGLISH: 0,
        NO_EVIDENCE: 2,
        VERIFICATION_FAILED: 1,
        DUPLICATE_ID: 0,
      },
      coverage: { plannedCases: 3, executedCases: 2, ratio: 2 / 3 },
    });
  });

  it("汇总：成本 / 循环指标按 case 等权；截断原因按计数报告", () => {
    const report = analyzeRuns(l1Fixture());

    expect(report.summary.runCount).toBe(4);
    expect(report.summary.caseCount).toBe(2);
    expect(report.summary.cost.uncachedInputTokens).toEqual({
      count: 2,
      mean: 275,
      std: Math.sqrt(31_250),
    });
    expect(report.summary.cost.cachedInputTokens?.mean).toBe(325);
    expect(report.summary.cost.cacheHitRate?.mean).toBe(0.4);
    expect(report.summary.cost.cacheWriteTokens?.mean).toBe(0);
    expect(report.summary.loop.requests?.mean).toBe(1.75);
    expect(report.summary.loop.attemptedToolCalls?.mean).toBe(0.5);
    expect(report.summary.truncation).toEqual({
      truncatedRuns: 1,
      reasons: { MAX_ROUNDS_REACHED: 1, TOOL_BUDGET_EXHAUSTED: 1 },
    });
  });

  it("coverage：未提供计划 case 数时为 N/A（null），不记 0", () => {
    const report = analyzeRuns({
      runs: [{ record: record({ baseline: snapshot({ usage: { inputTokens: 1, outputTokens: 1 } }) }) }],
    });

    expect(report.l1.coverage).toEqual({
      plannedCases: null,
      executedCases: 1,
      ratio: null,
    });
  });
});

describe("analyzeRuns: 输入校验与确定性", () => {
  it("外部 JSON（unknown）经 validateAnalysisInput 断言后可直接分析", () => {
    const parsed: unknown = JSON.parse(
      JSON.stringify({ runs: [{ record: record() }], plannedCases: 1 }),
    );

    validateAnalysisInput(parsed);

    expect(analyzeRuns(parsed).l1.coverage.ratio).toBe(1);
  });

  it("runs 按 caseId → configId → rep 稳定排序（与输入顺序无关）", () => {
    const report = analyzeRuns({
      runs: [
        { record: record({ caseId: "VUL4J-2", configId: "E", rep: 1 }) },
        { record: record({ caseId: "VUL4J-10", configId: "A", rep: 2 }) },
        { record: record({ caseId: "VUL4J-1", configId: "E", rep: 1 }) },
        { record: record({ caseId: "VUL4J-1", configId: "A", rep: 2 }) },
        { record: record({ caseId: "VUL4J-1", configId: "A", rep: 1 }) },
      ],
    });

    expect(report.runs.map((run) => `${run.caseId}/${run.configId}/${run.rep}`)).toEqual([
      "VUL4J-1/A/1",
      "VUL4J-1/A/2",
      "VUL4J-1/E/1",
      "VUL4J-10/A/2",
      "VUL4J-2/E/1",
    ]);
  });

  it("重复单元（source/caseId/configId/rep）fail fast", () => {
    expect(() =>
      analyzeRuns({
        runs: [{ record: record() }, { record: record() }],
      }),
    ).toThrow(/duplicate run record/);
  });

  it("缺失 outputTokens / 负 token 数 → 人话错误（含定位）", () => {
    expect(() =>
      analyzeRuns({
        runs: [
          {
            record: record({
              baseline: snapshot({ usage: { inputTokens: 10 } as never }),
            }),
          },
        ],
      }),
    ).toThrow(/VUL4J-1\/E\/rep-1: .*outputTokens/);

    expect(() =>
      analyzeRuns({
        runs: [
          {
            record: record({
              baseline: snapshot({ usage: { inputTokens: -1, outputTokens: 10 } }),
            }),
          },
        ],
      }),
    ).toThrow(/inputTokens.*must be a non-negative integer/);
  });

  it("configId 只接受历史 A–E；plannedCases 必须是非负整数", () => {
    expect(() =>
      analyzeRuns({
        runs: [{ record: record({ configId: "F" as never }) }],
      }),
    ).toThrow(/configId.*must be one of A, B, C, D, E/);

    expect(() =>
      analyzeRuns({
        runs: [{ record: record() }],
        plannedCases: -1,
      }),
    ).toThrow(/plannedCases.*must be a non-negative integer/);
  });

  it("toolCost 非法值 / 未知证据闸阶段 fail fast", () => {
    expect(() =>
      analyzeRuns({
        toolCost: { fixedCostPerCall: -1, costPerResultChar: 0 },
        runs: [{ record: record() }],
      }),
    ).toThrow(/fixedCostPerCall.*non-negative finite number/);

    expect(() =>
      analyzeRuns({
        runs: [
          {
            record: record({
              baseline: snapshot({
                audit: {
                  toolCallLog: [],
                  phaseLog: [],
                  rejections: [{ candidateId: "F001", stage: "UNKNOWN" as never, reason: "x" }],
                  truncated: false,
                  truncationReasons: [],
                },
              }),
            }),
          },
        ],
      }),
    ).toThrow(/rejections\[0\].*stage.*must be one of/);
  });

  it("configId A–E 均为合法读面（历史 A–D 记录只读兼容）", () => {
    const report = analyzeRuns({
      runs: (["A", "B", "C", "D", "E"] as const).map((configId, index) => ({
        record: record({ caseId: `CASE-${index}`, configId, rep: 1 }),
      })),
    });

    expect(report.runs.map((run) => run.configId)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("输入顺序变化不改变报告 JSON 字节（确定性）", () => {
    const first = { record: record({ caseId: "VUL4J-1", configId: "A", rep: 1 }) };
    const second = { record: record({ caseId: "VUL4J-1", configId: "E", rep: 1 }) };

    const forward = JSON.stringify(analyzeRuns({ runs: [first, second] }));
    const reverse = JSON.stringify(analyzeRuns({ runs: [second, first] }));

    expect(forward).toBe(reverse);
  });

  it("同一 case 的真值可得性不一致（跨 rep 混用 provided / clean / unknown）fail fast", () => {
    const truth = {
      locations: [{ file: "a.java", lineStart: 1, lineEnd: 1, defectNature: "SECURITY" }],
    };
    expect(() =>
      analyzeRuns({
        runs: [
          { record: record({ rep: 1 }), truth },
          { record: record({ rep: 2 }), truth: null },
        ],
      }),
    ).toThrow(/mixed truth kinds/);
  });
});

describe("analyzeRuns: 工具 / 截断指标", () => {
  it("requests 取 phaseLog.requestCount 之和；attempts 含预算拒绝的调用", () => {
    const report = analyzeRuns({
      runs: [
        {
          record: record({
            configId: "E",
            rep: 2,
            baseline: snapshot({
              usage: { inputTokens: 400, outputTokens: 100, cacheReadTokens: 600 },
              rounds: 1,
              toolCalls: 2,
              audit: {
                toolCallLog: [
                  { name: "review.get_file", argumentsJson: "{}", resultSummary: "ok" },
                  { name: "review.get_diff", argumentsJson: "{}", resultSummary: "ok" },
                  {
                    name: "review.get_diff",
                    argumentsJson: "{}",
                    resultSummary: "Error: tool call budget exhausted",
                  },
                ],
                phaseLog: [
                  { round: 1, phase: "Change Understanding", requestCount: 4 },
                  { round: 1, phase: "Evidence Verification", requestCount: 1 },
                ],
                rejections: [],
                truncated: false,
                truncationReasons: ["TOOL_BUDGET_EXHAUSTED"],
              },
            }),
          }),
        },
      ],
    });

    expect(report.runs[0]?.loop).toEqual({
      requests: 5,
      rounds: 1,
      attemptedToolCalls: 3,
      executedToolCalls: 2,
      skippedToolCalls: 1,
      truncated: false,
      truncationReasons: ["TOOL_BUDGET_EXHAUSTED"],
    });
  });
});
