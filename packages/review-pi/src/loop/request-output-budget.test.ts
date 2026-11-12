import { expect, test } from "vitest";
import type { LlmMessage } from "../contracts/llm.js";
import type { FakeReply, FakeUsage } from "../provider/fake-fetch.js";
import { fakeFetch } from "../provider/fake-fetch.js";
import { repoFixturePath } from "../testing/repos.js";
import { buildReviewToolkit } from "../tools/toolkit.js";
import { runAgentReviewLoop } from "./agent-review-loop.js";
import type { ReviewBudgetOverride } from "./budget.js";
import { PHASE_INSTRUCTIONS } from "./phases.js";

// 请求 / 输出预算与阶段保底（#55 / ADR-0018 §2.2–§2.3）：行为缝测试——只断言
// 审计产物（requests 的 wire 消息序、phaseLog、truncationReasons、stopReason）
// 与运行结果，不窥探内核内部状态。

const SYSTEM = "request-output-budget-test system prompt";
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

/** 每次回复的输出 token 固定为 1（输出预算测试用显式覆盖控制累计） */
const UNIT_USAGE: FakeUsage = { promptTokens: 10, completionTokens: 1, cacheReadTokens: 0 };

function phaseText(phaseIndex: number): string {
  if (phaseIndex === 4) {
    return `{"candidates":[${JSON.stringify(VALID_CANDIDATE)}]}`;
  }
  if (phaseIndex === 5) {
    return verificationText(true);
  }
  return `{"answer":"phase-${phaseIndex + 1}-done"}`;
}

function verificationText(complete: boolean): string {
  return `{"verdicts":[{"id":"F001","pass":true,"reason":"evidence supports"}],"complete":${String(complete)}}`;
}

function textReply(text: string, usage: FakeUsage = UNIT_USAGE): FakeReply {
  return { text, usage };
}

function scriptedLoop(replies: readonly FakeReply[], budget?: ReviewBudgetOverride) {
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

test("请求预算收紧：跳过前四阶段直达候选/裁决，Finding 不因预算丢失", async () => {
  const outcome = await scriptedLoop(
    [textReply(phaseText(0)), textReply(phaseText(4)), textReply(phaseText(5))],
    { maxRequests: 4 },
  );

  // 3 个请求：阶段 1 → 候选 → 裁决（前四阶段的后三个被跳过）
  expect(outcome.audit.requests).toHaveLength(3);
  expect(outcome.findings.map((finding) => finding.id)).toEqual(["F001"]);
  expect(outcome.complete).toBe(true);
  expect(outcome.audit.stopReason).toBe("MODEL_COMPLETE");
  // 阶段被跳过但模型声明 complete：truncated 不翻转（ADR-0018 §2.4）
  expect(outcome.audit.truncated).toBe(false);
  expect(outcome.audit.truncationReasons).toEqual(["REQUEST_BUDGET_PHASES_SKIPPED"]);

  // 被跳过的阶段有显式留痕：phaseLog 逐阶段在场，requestCount = 0 且 note 说明原因
  expect(
    outcome.audit.phaseLog.map((entry) => ({
      phase: entry.phase,
      requestCount: entry.requestCount,
      skipped: entry.note !== undefined,
    })),
  ).toEqual([
    { phase: "Change Understanding", requestCount: 1, skipped: false },
    { phase: "Risk Classification", requestCount: 0, skipped: true },
    { phase: "Context Decision", requestCount: 0, skipped: true },
    { phase: "Context Retrieval", requestCount: 0, skipped: true },
    { phase: "Deep Reasoning", requestCount: 1, skipped: false },
    { phase: "Evidence Verification", requestCount: 1, skipped: false },
  ]);
  for (const entry of outcome.audit.phaseLog.filter((record) => record.note !== undefined)) {
    expect(entry.note).toContain("skipped");
    expect(entry.note).toContain("request budget");
  }

  // 跳过后的下一请求直接是第 5 阶段指令：前四阶段指令不再发往 wire
  expect(outcome.audit.requests[1]?.messages.at(-1)?.content).toBe(PHASE_INSTRUCTIONS[4]);
});

test("请求预算无法保底：以 MAX_REQUESTS_REACHED 收口，被跳过的阶段仍留痕", async () => {
  const outcome = await scriptedLoop([textReply(phaseText(0))], { maxRequests: 1 });

  // 只剩 0 个请求：连候选/裁决的 2 请求保底都凑不齐 → 不开始候选，直接终止
  expect(outcome.audit.requests).toHaveLength(1);
  expect(outcome.findings).toEqual([]);
  expect(outcome.complete).toBe(false);
  expect(outcome.audit.stopReason).toBe("MAX_REQUESTS_REACHED");
  expect(outcome.audit.truncated).toBe(true);
  expect(outcome.audit.truncationReasons).toEqual([
    "REQUEST_BUDGET_PHASES_SKIPPED",
    "MAX_REQUESTS_REACHED",
  ]);
  expect(outcome.audit.phaseLog.map((entry) => [entry.phase, entry.requestCount])).toEqual([
    ["Change Understanding", 1],
    ["Risk Classification", 0],
    ["Context Decision", 0],
    ["Context Retrieval", 0],
  ]);
});

test("候选开始后裁决允许完成：预算刚好用尽也不掐断第 6 阶段", async () => {
  const outcome = await scriptedLoop(
    [textReply(phaseText(0)), textReply(phaseText(4)), textReply(verificationText(false))],
    { maxRequests: 3 },
  );

  // 3 个请求全部发出：阶段 1 → 候选 → 裁决（裁决请求发出时剩余请求已为 0）
  expect(outcome.audit.requests).toHaveLength(3);
  expect(outcome.audit.requests[2]?.messages.at(-1)?.content).toBe(PHASE_INSTRUCTIONS[5]);
  // 裁决已执行、Finding 已产出；complete=false 的下一轮无请求可用 → 硬停
  expect(outcome.findings.map((finding) => finding.id)).toEqual(["F001"]);
  expect(outcome.complete).toBe(false);
  expect(outcome.audit.stopReason).toBe("MAX_REQUESTS_REACHED");
  expect(outcome.audit.truncated).toBe(true);
  expect(outcome.audit.truncationReasons).toEqual([
    "REQUEST_BUDGET_PHASES_SKIPPED",
    "MAX_REQUESTS_REACHED",
  ]);
});

test("输出预算：只在阶段边界停止后续请求，不掐断当前阶段文本", async () => {
  const twoTokens = { promptTokens: 10, completionTokens: 2, cacheReadTokens: 0 };
  const outcome = await scriptedLoop(
    [textReply(phaseText(0)), textReply(phaseText(1), twoTokens)],
    { maxOutputTokens: 2 },
  );

  // 累计输出 1 + 2 = 3 > 2：第 2 阶段照常完成并入 phaseLog，但无第 3 个请求
  expect(outcome.audit.requests).toHaveLength(2);
  expect(outcome.audit.phaseLog.map((entry) => [entry.phase, entry.requestCount])).toEqual([
    ["Change Understanding", 1],
    ["Risk Classification", 1],
  ]);
  expect(outcome.audit.stopReason).toBe("OUTPUT_BUDGET_EXHAUSTED");
  expect(outcome.audit.truncated).toBe(true);
  expect(outcome.audit.truncationReasons).toEqual(["OUTPUT_BUDGET_EXHAUSTED"]);
  expect(outcome.complete).toBe(false);
  // 输出预算不改变请求字节：wire 上不出现 max_tokens
  for (const request of outcome.audit.requests) {
    expect(request.wireBody).not.toContain("max_tokens");
  }
});

test("输出预算不豁免 5/6 保底：候选完成即停，不再发裁决请求", async () => {
  const outcome = await scriptedLoop(
    [
      textReply(phaseText(0)),
      textReply(phaseText(1)),
      textReply(phaseText(2)),
      textReply(phaseText(3)),
      textReply(phaseText(4)),
    ],
    { maxOutputTokens: 4 },
  );

  // 前四阶段累计 4（未超）；候选阶段后累计 5 > 4 → 阶段边界停止
  expect(outcome.audit.requests).toHaveLength(5);
  expect(outcome.audit.requests.at(-1)?.messages.at(-1)?.content).toBe(PHASE_INSTRUCTIONS[4]);
  expect(outcome.audit.phaseLog.at(-1)).toMatchObject({
    phase: "Deep Reasoning",
    requestCount: 1,
  });
  expect(outcome.findings).toEqual([]);
  expect(outcome.audit.stopReason).toBe("OUTPUT_BUDGET_EXHAUSTED");
  expect(outcome.audit.truncated).toBe(true);
});

test("请求预算按总请求数判定：阶段内工具 recall 也占预算，边界跳过后仍产出 Finding", async () => {
  const outcome = await scriptedLoop(
    [
      {
        usage: UNIT_USAGE,
        toolCalls: [{ id: "call-a", name: "review_get_diff", arguments: {} }],
      },
      textReply(phaseText(0)),
      textReply(phaseText(4)),
      textReply(phaseText(5)),
    ],
    { maxRequests: 5 },
  );

  // 请求：工具 + recall（阶段 1 两请求）+ 候选 + 裁决 = 4；阶段 2 边界剩余 3
  // 不足以走完常规序 → 跳过阶段 2–4，Finding 仍产出
  expect(outcome.audit.requests).toHaveLength(4);
  expect(outcome.audit.requests[2]?.messages.at(-1)?.content).toBe(PHASE_INSTRUCTIONS[4]);
  expect(outcome.findings.map((finding) => finding.id)).toEqual(["F001"]);
  expect(outcome.audit.stopReason).toBe("MODEL_COMPLETE");
  expect(outcome.audit.truncated).toBe(false);
  expect(
    outcome.audit.phaseLog.map((entry) => [entry.phase, entry.requestCount]),
  ).toEqual([
    ["Change Understanding", 2],
    ["Risk Classification", 0],
    ["Context Decision", 0],
    ["Context Retrieval", 0],
    ["Deep Reasoning", 1],
    ["Evidence Verification", 1],
  ]);
});

test("输出预算在裁决边界同样生效：complete=false 时不再开启新一轮", async () => {
  const outcome = await scriptedLoop(
    [
      textReply(phaseText(0)),
      textReply(phaseText(1)),
      textReply(phaseText(2)),
      textReply(phaseText(3)),
      textReply(phaseText(4)),
      textReply(verificationText(false)),
    ],
    { maxOutputTokens: 5 },
  );

  // 前五阶段累计 5（未超），裁决后累计 6 > 5 → 轮次边界停止，不发第 7 个请求
  expect(outcome.audit.requests).toHaveLength(6);
  expect(outcome.findings.map((finding) => finding.id)).toEqual(["F001"]);
  expect(outcome.complete).toBe(false);
  expect(outcome.audit.stopReason).toBe("OUTPUT_BUDGET_EXHAUSTED");
  expect(outcome.audit.truncated).toBe(true);
  expect(outcome.audit.truncationReasons).toEqual(["OUTPUT_BUDGET_EXHAUSTED"]);
});

test("轮次边界同受请求预算约束：新一轮直接跳到候选，留痕落在新一轮", async () => {
  const roundOne: FakeReply[] = [
    textReply(phaseText(0)),
    textReply(phaseText(1)),
    textReply(phaseText(2)),
    textReply(phaseText(3)),
    textReply('{"candidates":[]}'),
    textReply(verificationText(false)),
  ];
  // 6 请求完成首轮；剩 2 请求 → 第二轮跳过 1–4 阶段，候选 + 裁决刚好用尽
  const outcome = await scriptedLoop(
    [...roundOne, textReply(phaseText(4)), textReply(verificationText(true))],
    { maxRequests: 8 },
  );

  expect(outcome.audit.requests).toHaveLength(8);
  expect(outcome.audit.requests[6]?.messages.at(-1)?.content).toBe(PHASE_INSTRUCTIONS[4]);
  expect(outcome.rounds).toBe(2);
  expect(outcome.complete).toBe(true);
  expect(outcome.findings.map((finding) => finding.id)).toEqual(["F001"]);
  expect(outcome.audit.stopReason).toBe("MODEL_COMPLETE");
  expect(outcome.audit.truncated).toBe(false);
  expect(outcome.audit.truncationReasons).toEqual(["REQUEST_BUDGET_PHASES_SKIPPED"]);

  // 跳过留痕的 round 属于新一轮（round = 2），不是被收尾的首轮
  expect(
    outcome.audit.phaseLog
      .filter((entry) => entry.round === 2 && entry.note !== undefined)
      .map((entry) => entry.phase),
  ).toEqual([
    "Change Understanding",
    "Risk Classification",
    "Context Decision",
    "Context Retrieval",
  ]);
  expect(
    outcome.audit.phaseLog
      .filter((entry) => entry.round === 2 && entry.note === undefined)
      .map((entry) => entry.phase),
  ).toEqual(["Deep Reasoning", "Evidence Verification"]);
});
