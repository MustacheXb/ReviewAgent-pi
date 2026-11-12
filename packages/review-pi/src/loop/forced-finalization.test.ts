import { expect, test } from "vitest";
import type { FakeReply, FakeUsage } from "../provider/fake-fetch.js";
import { fakeFetch } from "../provider/fake-fetch.js";
import { repoFixturePath } from "../testing/repos.js";
import { buildReviewToolkit } from "../tools/toolkit.js";
import type { LlmMessage } from "../contracts/llm.js";
import { runAgentReviewLoop } from "./agent-review-loop.js";
import { FORCED_FINALIZATION_INSTRUCTION } from "./constants.js";

// 尝试预算耗尽 → 强制阶段收尾（#54 / ADR-0018 §2.1）：行为缝测试——只断言
// 审计产物（phaseLog / toolCallLog / truncationReasons / stopReason / requests
// 的 wire 消息序），不窥探内核内部状态。

const SYSTEM = "forced-finalization-test system prompt";
const INITIAL: readonly LlmMessage[] = [{ role: "user", content: "mr message" }];
const DIFF = ["--- a/Foo.java", "+++ b/Foo.java", "@@ -1,2 +1,2 @@", "-old", "+new"].join("\n");

const VALID_CANDIDATE = {
  id: "F001",
  severity: "P3",
  category: "MAINTAINABILITY",
  file: "src/main/java/Foo.java",
  line: 10,
  title: "Unused helper method",
  description: "The helper is never referenced after the change.",
  evidence: ["src/main/java/Foo.java:10 private void helper()"],
  rule: "MAINTAINABILITY-001",
  confidence: 0.7,
} as const;

function usageOf(index: number): FakeUsage {
  return { promptTokens: (index + 1) * 15, completionTokens: index + 1, cacheReadTokens: (index + 1) * 5 };
}

function phaseText(phaseIndex: number): string {
  if (phaseIndex === 4) {
    return `{"candidates":[${JSON.stringify(VALID_CANDIDATE)}]}`;
  }
  if (phaseIndex === 5) {
    return '{"verdicts":[{"id":"F001","pass":true,"reason":"evidence supports"}],"complete":true}';
  }
  return `{"answer":"phase-${phaseIndex + 1}-done"}`;
}

function textReply(text: string, index: number): FakeReply {
  return { text, usage: usageOf(index) };
}

function toolReply(
  calls: readonly { id: string; name: string; args?: Record<string, unknown> }[],
  index: number,
): FakeReply {
  return {
    usage: usageOf(index),
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.args ?? {},
    })),
  };
}

function scriptedLoop(replies: readonly FakeReply[], budget?: { readonly maxToolAttempts?: number }) {
  const script = fakeFetch([...replies]);
  const toolkit = buildReviewToolkit({ repoPath: repoFixturePath("sample"), diff: DIFF });
  return runAgentReviewLoop({
    systemPrompt: SYSTEM,
    initialContextMessages: INITIAL,
    toolkit,
    apiKey: "test-key",
    fetch: script.fetch,
    ...(budget !== undefined ? { budget } : {}),
  });
}

test("尝试预算耗尽：本批结果全部 terminate，下一请求为收尾指令，阶段仍产出结论", async () => {
  const replies: FakeReply[] = [
    textReply(phaseText(0), 0),
    toolReply(
      [
        {
          id: "call-a",
          name: "review_get_file",
          args: { path: "src/main/java/com/example/Alpha.java", startLine: 1, endLine: 1 },
        },
        {
          id: "call-b",
          name: "review_get_file",
          args: { path: "src/main/java/com/example/Alpha.java", startLine: 2, endLine: 2 },
        },
      ],
      1,
    ),
    textReply(phaseText(1), 2),
    textReply(phaseText(2), 3),
    textReply(phaseText(3), 4),
    textReply(phaseText(4), 5),
    textReply(phaseText(5), 6),
  ];
  const outcome = await scriptedLoop(replies, { maxToolAttempts: 2 }).catch((error: unknown) => {
    throw new Error(`run failed: ${String(error)}`);
  });

  // 阶段仍照常产出结论：候选与裁决都在
  expect(outcome.complete).toBe(true);
  expect(outcome.findings.map((finding) => finding.id)).toEqual(["F001"]);
  expect(outcome.audit.stopReason).toBe("MODEL_COMPLETE");

  // 尝试用尽但阶段正常完成：truncated 不翻转
  expect(outcome.audit.truncated).toBe(false);
  expect(outcome.audit.truncationReasons).toEqual(["TOOL_ATTEMPTS_EXHAUSTED"]);

  // 两次尝试都执行（恰好用尽），无跳过
  expect(outcome.toolCalls).toBe(2);
  expect(outcome.audit.phaseLog[1]?.note).toBeUndefined();

  // 下一请求（工具批之后的 recall 请求）末条消息是收尾指令
  const recallRequest = outcome.audit.requests[2];
  const lastMessage = recallRequest?.messages.at(-1);
  expect(lastMessage?.role).toBe("user");
  expect(lastMessage?.content).toBe(FORCED_FINALIZATION_INSTRUCTION);

  // 收尾指令 append-only：前一条工具批请求的消息仍逐字节前缀
  expect(recallRequest?.messages.slice(0, outcome.audit.requests[1]!.messages.length)).toEqual(
    outcome.audit.requests[1]!.messages,
  );
});

test("尝试达上限后不再执行工具：超限调用获尝试耗尽应答，本批结果全部 terminate", async () => {
  const replies: FakeReply[] = [
    textReply(phaseText(0), 0),
    toolReply([
      {
        id: "call-a",
        name: "review_get_file",
        args: { path: "src/main/java/com/example/Alpha.java", startLine: 1, endLine: 1 },
      },
    ], 1),
    toolReply(
      [
        {
          id: "call-b",
          name: "review_get_file",
          args: { path: "src/main/java/com/example/Alpha.java", startLine: 2, endLine: 2 },
        },
        {
          id: "call-c",
          name: "review_get_file",
          args: { path: "src/main/java/com/example/Alpha.java", startLine: 3, endLine: 3 },
        },
      ],
      2,
    ),
    textReply(phaseText(1), 3),
    textReply(phaseText(2), 4),
    textReply(phaseText(3), 5),
    textReply(phaseText(4), 6),
    textReply(phaseText(5), 7),
  ];
  const outcome = await scriptedLoop(replies, { maxToolAttempts: 2 });

  // 第 2 批的第二个调用超限：不执行，应答为尝试耗尽
  expect(outcome.toolCalls).toBe(2);
  expect(outcome.audit.toolCallLog).toHaveLength(3);
  expect(outcome.audit.toolCallLog[2]?.resultSummary).toBe(
    "Error: tool attempt budget exhausted",
  );
  // 阶段留痕：1 次跳过（尝试闸与执行闸同一 note 口径）
  expect(outcome.audit.phaseLog[1]?.note).toBe("1 tool call(s) skipped: budget exhausted");

  // 候选与裁决阶段照常产出结论
  expect(outcome.complete).toBe(true);
  expect(outcome.findings.map((finding) => finding.id)).toEqual(["F001"]);
  expect(outcome.audit.stopReason).toBe("MODEL_COMPLETE");
  expect(outcome.audit.truncated).toBe(false);

  // 下一请求为收尾指令
  const recallRequest = outcome.audit.requests[3];
  expect(recallRequest?.messages.at(-1)?.content).toBe(FORCED_FINALIZATION_INSTRUCTION);
});

test("收尾注入用尽仍调用工具：以 TOOL_ATTEMPTS_EXHAUSTED 终止，不推进阶段", async () => {
  const call = (id: string) => ({
    id,
    name: "review_get_diff",
    args: {},
  });
  const replies: FakeReply[] = [
    toolReply([call("call-a")], 0),
    toolReply([call("call-b")], 1),
    toolReply([call("call-c")], 2),
  ];
  const outcome = await scriptedLoop(replies, { maxToolAttempts: 1 });

  expect(outcome.complete).toBe(false);
  expect(outcome.findings).toEqual([]);
  expect(outcome.audit.stopReason).toBe("TOOL_ATTEMPTS_EXHAUSTED");
  expect(outcome.audit.truncated).toBe(true);
  // 阶段从未完成：无 phaseLog 条目
  expect(outcome.audit.phaseLog).toEqual([]);

  // 三次请求：三批工具调用；每批结果全部 terminate（下一请求必然是收尾指令）
  expect(outcome.audit.requests).toHaveLength(3);
  expect(outcome.audit.requests[1]?.messages.at(-1)?.content).toBe(
    FORCED_FINALIZATION_INSTRUCTION,
  );
  expect(outcome.audit.requests[2]?.messages.at(-1)?.content).toBe(
    FORCED_FINALIZATION_INSTRUCTION,
  );
  // 执行仅 1 次；余下两次为尝试耗尽拦截
  expect(outcome.toolCalls).toBe(1);
  expect(outcome.audit.toolCallLog.map((entry) => entry.resultSummary)).toEqual([
    expect.not.stringContaining("budget exhausted"),
    "Error: tool attempt budget exhausted",
    "Error: tool attempt budget exhausted",
  ]);
});

test("收尾指令后仍不产出文本：以 PHASE_FORCED_INCOMPLETE 终止", async () => {
  const replies: FakeReply[] = [
    toolReply([{ id: "call-a", name: "review_get_diff", args: {} }], 0),
    textReply("", 1),
  ];
  const outcome = await scriptedLoop(replies, { maxToolAttempts: 1 });

  expect(outcome.complete).toBe(false);
  expect(outcome.findings).toEqual([]);
  expect(outcome.audit.stopReason).toBe("PHASE_FORCED_INCOMPLETE");
  expect(outcome.audit.truncated).toBe(true);
  expect(outcome.audit.phaseLog).toEqual([]);
  expect(outcome.audit.requests).toHaveLength(2);
  // 空文本不推进阶段：没有下一阶段指令，也没有额外请求
  expect(outcome.audit.requests[1]?.messages.at(-1)?.content).toBe(
    FORCED_FINALIZATION_INSTRUCTION,
  );
});

test("收尾注入按阶段重置：新阶段重新获得 2 次额度", async () => {
  const replies: FakeReply[] = [
    textReply(phaseText(0), 0),
    // phase-2：第一批用尽尝试预算，注入收尾 #1 后按文本收尾
    toolReply([{ id: "call-a", name: "review_get_diff", args: {} }], 1),
    textReply(phaseText(1), 2),
    // phase-3：两批工具调用分别消耗本阶段的 2 次额度，仍能按文本收尾
    toolReply([{ id: "call-b", name: "review_get_diff", args: {} }], 3),
    toolReply([{ id: "call-c", name: "review_get_diff", args: {} }], 4),
    textReply(phaseText(2), 5),
    textReply(phaseText(3), 6),
    textReply(phaseText(4), 7),
    textReply(phaseText(5), 8),
  ];
  const outcome = await scriptedLoop(replies, { maxToolAttempts: 1 });

  expect(outcome.complete).toBe(true);
  expect(outcome.audit.stopReason).toBe("MODEL_COMPLETE");
  expect(outcome.audit.truncated).toBe(false);
  expect(outcome.audit.requests).toHaveLength(9);
});

// truncated 语义收紧（#54 / ADR-0018 §2.4）：只有「未以模型声明 complete 收尾
// 且有阶段/轮次被跳过」才翻转；单纯工具预算耗尽但阶段正常完成不翻转。
const TRUNCATED_TABLE: readonly {
  readonly name: string;
  readonly budget: { readonly maxToolAttempts?: number; readonly maxExecutedToolCalls?: number };
  readonly script: () => FakeReply[];
  readonly truncated: boolean;
  readonly stopReason: string;
}[] = [
  {
    name: "尝试耗尽但阶段正常完成",
    budget: { maxToolAttempts: 2 },
    script: () => [
      textReply(phaseText(0), 0),
      toolReply(
        [
          {
            id: "call-a",
            name: "review_get_file",
            args: { path: "src/main/java/com/example/Alpha.java", startLine: 1, endLine: 1 },
          },
          {
            id: "call-b",
            name: "review_get_file",
            args: { path: "src/main/java/com/example/Alpha.java", startLine: 2, endLine: 2 },
          },
        ],
        1,
      ),
      textReply(phaseText(1), 2),
      textReply(phaseText(2), 3),
      textReply(phaseText(3), 4),
      textReply(phaseText(4), 5),
      textReply(phaseText(5), 6),
    ],
    truncated: false,
    stopReason: "MODEL_COMPLETE",
  },
  {
    name: "执行耗尽但阶段正常完成",
    budget: { maxExecutedToolCalls: 1 },
    script: () => [
      textReply(phaseText(0), 0),
      toolReply(
        [
          {
            id: "call-a",
            name: "review_get_file",
            args: { path: "src/main/java/com/example/Alpha.java", startLine: 1, endLine: 1 },
          },
          {
            id: "call-b",
            name: "review_get_file",
            args: { path: "src/main/java/com/example/Alpha.java", startLine: 2, endLine: 2 },
          },
        ],
        1,
      ),
      textReply(phaseText(1), 2),
      textReply(phaseText(2), 3),
      textReply(phaseText(3), 4),
      textReply(phaseText(4), 5),
      textReply(phaseText(5), 6),
    ],
    truncated: false,
    stopReason: "MODEL_COMPLETE",
  },
  {
    name: "收尾用尽仍调用工具",
    budget: { maxToolAttempts: 1 },
    script: () => [
      toolReply([{ id: "call-a", name: "review_get_diff", args: {} }], 0),
      toolReply([{ id: "call-b", name: "review_get_diff", args: {} }], 1),
      toolReply([{ id: "call-c", name: "review_get_diff", args: {} }], 2),
    ],
    truncated: true,
    stopReason: "TOOL_ATTEMPTS_EXHAUSTED",
  },
  {
    name: "收尾后仍不产出文本",
    budget: { maxToolAttempts: 1 },
    script: () => [
      toolReply([{ id: "call-a", name: "review_get_diff", args: {} }], 0),
      textReply("", 1),
    ],
    truncated: true,
    stopReason: "PHASE_FORCED_INCOMPLETE",
  },
];

test.each(TRUNCATED_TABLE)("truncated 语义：$name → truncated=$truncated, $stopReason", async (row) => {
  const outcome = await scriptedLoop(row.script(), row.budget);
  expect(outcome.audit.truncated).toBe(row.truncated);
  expect(outcome.audit.stopReason).toBe(row.stopReason);
  expect(outcome.complete).toBe(row.stopReason === "MODEL_COMPLETE");
});

