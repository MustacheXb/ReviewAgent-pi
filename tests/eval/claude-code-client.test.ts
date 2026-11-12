import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_ALLOWED_TOOLS,
  createClaudeCodeClient,
  detectClaudeCodeVersion,
  parseClaudeCodeVersion,
  toClaudeCodeReferenceRecord,
  type ClaudeCodeCommandInput,
  type ClaudeCodeCommandResult,
} from "../../src/eval/reference/claude-code/index.js";
import { mrCase } from "./campaign-fixtures.js";

/** Claude Code CLI client seam（#44）：命令参数 / stdin / JSON 解析 / 失败留痕。 */

const JSON_STDOUT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: JSON.stringify([
    {
      id: "F1",
      severity: "P2",
      category: "SECURITY",
      file: "src/A.java",
      line: 3,
      title: "t",
      description: "d",
      evidence: ["e"],
      rule: "R",
      confidence: 0.8,
    },
  ]),
  num_turns: 2,
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5 },
  modelUsage: { "claude-test-model": {} },
  permission_denials: [],
  duration_ms: 1000,
});

function capturingRunner(
  result: ClaudeCodeCommandResult = { stdout: JSON_STDOUT, stderr: "", exitCode: 0 },
): { readonly runner: (input: ClaudeCodeCommandInput) => Promise<ClaudeCodeCommandResult>; readonly calls: ClaudeCodeCommandInput[] } {
  const calls: ClaudeCodeCommandInput[] = [];
  return {
    calls,
    runner: async (input) => {
      calls.push(input);
      return result;
    },
  };
}

describe("CLI 版本", () => {
  it("解析 `claude --version` 输出；失败 / 空输出记 null", async () => {
    expect(parseClaudeCodeVersion("2.1.241 (Claude Code)\n")).toBe("2.1.241");
    expect(parseClaudeCodeVersion("weird-build")).toBe("weird-build");
    expect(parseClaudeCodeVersion("   ")).toBeNull();

    const runner = async (input: ClaudeCodeCommandInput): Promise<ClaudeCodeCommandResult> => ({
      stdout: input.args[0] === "--version" ? "2.1.241 (Claude Code)\n" : "",
      stderr: "",
      exitCode: 0,
    });
    await expect(detectClaudeCodeVersion({ runner })).resolves.toBe("2.1.241");

    const failed = async (): Promise<ClaudeCodeCommandResult> => ({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
    });
    await expect(detectClaudeCodeVersion({ runner: failed })).resolves.toBeNull();
  });
});

describe("createClaudeCodeClient", () => {
  it("命令参数固定 max-turns 5 / Read,Grep,Glob；cwd = repoPath；提示词走 stdin", async () => {
    const { runner, calls } = capturingRunner();
    const client = createClaudeCodeClient({ runner, cliVersion: "2.1.241" });
    const caseInput = mrCase("VUL4J-1");

    const outcome = await client.run({ caseId: "VUL4J-1", mrCase: caseInput, rep: 1 });

    const call = calls[0] as ClaudeCodeCommandInput;
    expect(call.command).toBe("claude");
    expect(call.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--max-turns",
      "5",
      "--tools",
      CLAUDE_CODE_ALLOWED_TOOLS.join(","),
      "--allowedTools",
      CLAUDE_CODE_ALLOWED_TOOLS.join(","),
    ]);
    expect(call.cwd).toBe(caseInput.repoPath);
    expect(call.stdin).toContain(caseInput.issueDescription);
    expect(call.stdin).toContain(caseInput.diff);
    expect(call.stdin).toContain("Return ONLY a JSON array");
    expect(outcome).toMatchObject({
      cliVersion: "2.1.241",
      requestedModel: null,
      actualModels: ["claude-test-model"],
      numTurns: 2,
      totalCostUsd: 0.01,
      permissionDenials: 0,
    });
    expect(outcome.findings).toHaveLength(1);
  });

  it("--model 透传；maxTurns 不允许超过 5", async () => {
    const { runner, calls } = capturingRunner();
    const client = createClaudeCodeClient({ runner, model: "claude-sonnet-5-0", maxTurns: 10 });

    await client.run({ caseId: "VUL4J-1", mrCase: mrCase("VUL4J-1"), rep: 1 });

    const call = calls[0] as ClaudeCodeCommandInput;
    const turnsIndex = call.args.indexOf("--max-turns");
    expect(call.args[turnsIndex + 1]).toBe("5");
    expect(call.args).toContain("--model");
    expect(call.args).toContain("claude-sonnet-5-0");
  });

  it("非零退出且 stdout 不可用 → 显式抛错；非零但 JSON 完整 → 保留截断记录", async () => {
    const failed = capturingRunner({ stdout: "", stderr: "permission denied", exitCode: 2 });
    const client = createClaudeCodeClient({ runner: failed.runner });
    await expect(
      client.run({ caseId: "VUL4J-1", mrCase: mrCase("VUL4J-1"), rep: 1 }),
    ).rejects.toThrow(/exit 2.*permission denied/s);

    const truncated = capturingRunner({
      stdout: JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        result: "max turns reached",
        num_turns: 5,
        total_cost_usd: 0.02,
        usage: { input_tokens: 10, output_tokens: 5 },
        modelUsage: { "claude-test-model": { inputTokens: 10, outputTokens: 5 } },
        permission_denials: [],
        duration_ms: 5000,
      }),
      stderr: "",
      exitCode: 1,
    });
    const outcome = await createClaudeCodeClient({ runner: truncated.runner }).run({
      caseId: "VUL4J-1",
      mrCase: mrCase("VUL4J-1"),
      rep: 1,
    });
    expect(outcome).toMatchObject({
      truncated: true,
      error: "max turns reached",
      numTurns: 5,
      totalCostUsd: 0.02,
      permissionDenials: 0,
    });
    expect(outcome.findings).toEqual([]);
    expect(outcome.anomalies.join("\n")).toMatch(/error_max_turns/);

    const thrown = createClaudeCodeClient({
      runner: async () => {
        throw new Error("timed out");
      },
    });
    await expect(
      thrown.run({ caseId: "VUL4J-1", mrCase: mrCase("VUL4J-1"), rep: 1 }),
    ).rejects.toThrow(/timed out/);
  });

  it("toClaudeCodeReferenceRecord 标记 evalOnly / 上界 / 允许工具", async () => {
    const { runner } = capturingRunner();
    const client = createClaudeCodeClient({ runner, cliVersion: "2.1.241" });
    const request = { caseId: "VUL4J-1", mrCase: mrCase("VUL4J-1"), rep: 2 };
    const outcome = await client.run(request);

    const record = toClaudeCodeReferenceRecord(request, outcome);
    expect(record).toMatchObject({
      kind: "claude-code-reference",
      schemaVersion: 1,
      evalOnly: true,
      caseId: "VUL4J-1",
      rep: 2,
      maxTurns: 5,
      allowedTools: ["Read", "Grep", "Glob"],
      cliVersion: "2.1.241",
    });
  });
});
