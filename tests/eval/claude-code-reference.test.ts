import { describe, expect, it } from "vitest";
import { FakeJudgeClient } from "../../src/eval/judge/fake-judge-client.js";
import {
  buildClaudeCodeColumn,
  createFakeClaudeCodeClient,
  emptyOutcome,
  judgeClaudeCodeFindings,
  renderClaudeCodeColumnMarkdown,
  toClaudeCodeReferenceRecord,
  type ClaudeCodeOutcome,
  type ClaudeCodeReferenceRecord,
} from "../../src/eval/reference/claude-code/index.js";
import { mrCase } from "./campaign-fixtures.js";

/** Claude Code 外部参照：fake client / 同一 judge 链 / 单列报告（#44）。 */

function outcome(overrides: Partial<ClaudeCodeOutcome> = {}): ClaudeCodeOutcome {
  return {
    ...emptyOutcome(),
    findings: [
      {
        id: "F1",
        severity: "P2",
        category: "SECURITY",
        file: "src/main/java/A.java",
        line: 10,
        title: "t",
        description: "d",
        evidence: ["e"],
        rule: "R",
        confidence: 0.8,
      },
    ],
    ...overrides,
  };
}

function record(
  overrides: Partial<ClaudeCodeOutcome> = {},
  requestOverrides: { caseId?: string; rep?: number } = {},
): ClaudeCodeReferenceRecord {
  const request = {
    caseId: requestOverrides.caseId ?? "VUL4J-1",
    mrCase: mrCase(requestOverrides.caseId ?? "VUL4J-1"),
    rep: requestOverrides.rep ?? 1,
  };
  return toClaudeCodeReferenceRecord(request, outcome(overrides));
}

describe("createFakeClaudeCodeClient", () => {
  it("捕获请求 / 按脚本返回 / 可注入失败", async () => {
    const client = createFakeClaudeCodeClient({ outcome: outcome({ numTurns: 2 }) });
    const request = { caseId: "VUL4J-1", mrCase: mrCase("VUL4J-1"), rep: 1 };

    const result = await client.run(request);
    expect(result.numTurns).toBe(2);
    expect(client.calls).toEqual([request]);

    const failing = createFakeClaudeCodeClient({ failWhen: () => true });
    await expect(failing.run(request)).rejects.toThrow(/fake Claude Code client failed/);
  });
});

describe("judgeClaudeCodeFindings", () => {
  it("复用同一 judge 链：合法裁定 → TP/FP/FN", async () => {
    const judged = await judgeClaudeCodeFindings({
      record: record(),
      mrCase: mrCase("VUL4J-1"),
      client: FakeJudgeClient.fromAdjudications([
        {
          matches: [
            {
              findingIndex: 0,
              truthIndex: 0,
              matchConfidence: "high",
              matchReason: "same defect",
            },
          ],
          summary: null,
        },
      ]),
    });

    expect(judged).toEqual({
      status: "judged",
      counts: { tp: 1, fp: 0, fn: 0 },
      anomalies: [],
    });
  });

  it("clean MR → 全 FP；零 finding → 全 FN；不触达 judge", async () => {
    const clean = await judgeClaudeCodeFindings({
      record: record({}, { caseId: "CLEAN-1" }),
      mrCase: mrCase("CLEAN-1", { truth: null }),
      client: FakeJudgeClient.fromAdjudications([]),
    });
    expect(clean).toEqual({
      status: "skipped-clean-mr",
      counts: { tp: 0, fp: 1, fn: 0 },
      anomalies: [],
    });

    const zero = await judgeClaudeCodeFindings({
      record: record({ findings: [] }),
      mrCase: mrCase("VUL4J-1"),
      client: FakeJudgeClient.fromAdjudications([]),
    });
    expect(zero).toEqual({
      status: "skipped-no-findings",
      counts: { tp: 0, fp: 0, fn: 1 },
      anomalies: [],
    });
  });

  it("caseId 错配 fail fast", async () => {
    await expect(
      judgeClaudeCodeFindings({
        record: record({}, { caseId: "OTHER" }),
        mrCase: mrCase("VUL4J-1"),
        client: FakeJudgeClient.fromAdjudications([]),
      }),
    ).rejects.toThrow(/caseId/);
  });
});

describe("buildClaudeCodeColumn", () => {
  it("单列聚合：零 finding 率 / USD / turns / denials / judge（缺字段记 N/A）", () => {
    const records = [
      record({ totalCostUsd: 0.01, numTurns: 2, permissionDenials: 0, actualModels: ["m"] }),
      record(
        { findings: [], totalCostUsd: null, numTurns: null, permissionDenials: 1 },
        { caseId: "VUL4J-2" },
      ),
    ];

    const column = buildClaudeCodeColumn(records, {
      judgeCounts: [{ tp: 1, fp: 0, fn: 0 }],
    });

    expect(column).toMatchObject({
      cases: 2,
      findings: 1,
      zeroFindingRate: 0.5,
      totalCostUsd: null,
      avgTurns: null,
      permissionDenials: 1,
      actualModels: ["m"],
      judge: { tp: 1, fp: 0, fn: 0, recall: 1, precision: 1, f1: 1 },
    });
    expect(column.anomalies).toEqual([]);
  });

  it("空记录 → 可观测字段记 N/A，不写 0", () => {
    expect(buildClaudeCodeColumn([])).toMatchObject({
      cases: 0,
      findings: 0,
      zeroFindingRate: null,
      totalCostUsd: null,
      avgTurns: null,
      permissionDenials: null,
      judge: null,
    });
  });

  it("全字段在场时求和 / 求均值；Markdown 确定性且声明不进 S/A/B", () => {
    const records = [
      record({ totalCostUsd: 0.01, numTurns: 2, permissionDenials: 0 }),
      record(
        { findings: [], totalCostUsd: 0.02, numTurns: 4, permissionDenials: 1 },
        { caseId: "VUL4J-2" },
      ),
    ];
    const column = buildClaudeCodeColumn(records);

    expect(column).toMatchObject({
      totalCostUsd: 0.03,
      avgTurns: 3,
      permissionDenials: 1,
      judge: null,
    });
    const first = renderClaudeCodeColumnMarkdown(column);
    expect(renderClaudeCodeColumnMarkdown(column)).toBe(first);
    expect(first).toContain("# Claude Code 外部参照（单列）");
    expect(first).toContain("不进 S/A/B 主判定");
  });
});
