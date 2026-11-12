import { describe, expect, it } from "vitest";
import {
  ClaudeCodeOutputError,
  normalizeClaudeCodeFindings,
  parseClaudeCodeStdout,
} from "../../src/eval/reference/claude-code/index.js";

/**
 * Claude Code 输出归一（#44）：合法 / 非法 / 截断 / 重复条目留痕；
 * stdout JSON → findings / usage / cost / turns / denials。
 */

const VALID_FINDING = {
  id: "F1",
  severity: "P1",
  category: "SECURITY",
  file: "src/A.java",
  line: 10,
  title: "unsafe parse",
  description: "componentType is used instead of componentClass",
  evidence: ["src/A.java:10"],
  rule: "SECURITY-001",
  confidence: 0.9,
};

describe("normalizeClaudeCodeFindings", () => {
  it("markdown 围栏内的合法 JSON 数组 → 统一 Finding Schema", () => {
    const result = normalizeClaudeCodeFindings(
      ["Here are the findings:", "```json", JSON.stringify([VALID_FINDING]), "```"].join("\n"),
    );
    expect(result).toEqual({ findings: [VALID_FINDING], anomalies: [] });
  });

  it("非法条目 / 重复 id / 缺省字段 → 有界留痕，合法条目保留", () => {
    const result = normalizeClaudeCodeFindings(
      JSON.stringify([
        VALID_FINDING,
        { ...VALID_FINDING }, // duplicate id
        { id: "F2", title: "no file", line: 3 }, // missing file
        { id: "F3", file: "src/B.java", line: 0, title: "bad line" }, // bad line
        {
          file: "src/C.java",
          line: 7,
          title: "minimal",
          severity: "high",
          evidence: "not-an-array",
          confidence: 2,
        },
      ]),
    );

    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toEqual(VALID_FINDING);
    expect(result.findings[1]).toMatchObject({
      id: "CC-5",
      severity: "P2",
      file: "src/C.java",
      line: 7,
      title: "minimal",
      category: "UNKNOWN",
      evidence: [],
      rule: "CLAUDE-CODE",
      confidence: 0.5,
    });
    expect(result.anomalies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/duplicate finding id/),
        expect.stringMatching(/entry 3: missing\/invalid file/),
        expect.stringMatching(/entry 4: missing\/invalid line/),
        expect.stringMatching(/entry 5: missing id/),
        expect.stringMatching(/entry 5: missing\/invalid severity/),
        expect.stringMatching(/entry 5: evidence is not an array/),
        expect.stringMatching(/entry 5: missing\/out-of-range confidence/),
      ]),
    );
  });

  it("空数组合法；无 JSON 数组 / 非法 JSON → 显式抛错（不伪装零 finding）", () => {
    expect(normalizeClaudeCodeFindings("[]")).toEqual({ findings: [], anomalies: [] });
    expect(() => normalizeClaudeCodeFindings("no findings here")).toThrow(ClaudeCodeOutputError);
    expect(() => normalizeClaudeCodeFindings("[{not valid json}")).toThrow(
      ClaudeCodeOutputError,
    );
  });
});

describe("parseClaudeCodeStdout", () => {
  it("result / usage / cost / turns / denials / modelUsage 全量映射", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify([VALID_FINDING]),
      num_turns: 4,
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 1200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 4000,
        output_tokens: 500,
      },
      modelUsage: { "claude-sonnet-5-0": { inputTokens: 1200 } },
      permission_denials: [{ tool: "Bash" }, { tool: "Edit" }],
      duration_ms: 65432,
    });

    const outcome = parseClaudeCodeStdout(stdout);

    expect(outcome.findings).toEqual([VALID_FINDING]);
    expect(outcome.anomalies).toEqual([]);
    expect(outcome).toMatchObject({
      actualModels: ["claude-sonnet-5-0"],
      numTurns: 4,
      totalCostUsd: 0.0123,
      usage: {
        inputTokens: 1200,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 4000,
        outputTokens: 500,
      },
      permissionDenials: 2,
      durationMs: 65432,
      resultText: JSON.stringify([VALID_FINDING]),
    });
  });

  it("is_error（含 max-turns 截断）保留元数据并留痕；缺 result / 非法 stdout 抛错", () => {
    const truncated = parseClaudeCodeStdout(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        result: "max turns reached",
        num_turns: 5,
        total_cost_usd: 0.02,
        usage: { input_tokens: 10, output_tokens: 5 },
        modelUsage: { "claude-test-model": { inputTokens: 10, outputTokens: 5 } },
        permission_denials: [{ tool: "Bash" }],
        duration_ms: 5000,
      }),
    );
    expect(truncated).toMatchObject({
      findings: [],
      truncated: true,
      error: "max turns reached",
      numTurns: 5,
      totalCostUsd: 0.02,
      permissionDenials: 1,
      modelUsage: {
        "claude-test-model": { inputTokens: 10, outputTokens: 5 },
      },
    });
    expect(truncated.anomalies.join("\n")).toMatch(/error_max_turns.*truncated/);

    expect(() => parseClaudeCodeStdout(JSON.stringify({ type: "result" }))).toThrow(
      /missing the result text/,
    );
    expect(() => parseClaudeCodeStdout("not json")).toThrow(/not valid JSON/);
  });

  it("缺失可选字段记 null，不写 0", () => {
    const outcome = parseClaudeCodeStdout(
      JSON.stringify({ type: "result", subtype: "success", result: "[]" }),
    );
    expect(outcome).toMatchObject({
      actualModels: null,
      numTurns: null,
      totalCostUsd: null,
      usage: null,
      modelUsage: null,
      permissionDenials: null,
      durationMs: null,
      error: null,
      truncated: false,
    });
  });
});
