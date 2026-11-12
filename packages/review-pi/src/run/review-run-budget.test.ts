import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { DEFAULT_REVIEW_BUDGET } from "../loop/budget.js";
import { fakeFetch, type FakeReply } from "../provider/fake-fetch.js";
import { repoFixturePath } from "../testing/repos.js";
import { SAMPLE_DIFF, sixPhaseNoToolCorpus, tempRunsRoot } from "../testing/seam-fixtures.js";
import { runReview } from "./review-run.js";

// Token 控制面预算注入（#53 / ADR-0018 §1）：五类预算只经 runReview 内部
// 输入注入，不进入协议 / CLI / 环境变量。本文件只观测外部行为——
// RunRecord、审计文件（stopReason / 计数）与 wire 字节，不窥探内核内部状态。
//
// 与 review-run.test.ts 的分工：那边锁 E 全链黄金形态（不改写）；这边锁
// 预算注入的新增行为（独立成文件，零存量测试修改）。

const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;

/** 轮次脚本：每轮六阶段，phase-6 恒 complete:false（靠轮次预算收口） */
function incompleteRoundsCorpus(rounds: number): FakeReply[] {
  const replies: FakeReply[] = [];
  for (let round = 0; round < rounds; round++) {
    replies.push(
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: '{"candidates":[]}', usage: ZERO },
      { text: '{"verdicts":[],"complete":false}', usage: ZERO },
    );
  }
  return replies;
}

function runInput(script: { readonly fetch: FetchFunction }, runsRoot: string) {
  return {
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: SAMPLE_DIFF,
    issueDescription: "Budget injection MR under review.",
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
  } as const;
}

test("预算覆盖：maxRounds=2 经内部输入生效（2 轮收口）；缺省仍为 5 轮", async () => {
  const overrideScript = fakeFetch(incompleteRoundsCorpus(5));
  const override = await runReview({
    ...runInput(overrideScript, tempRunsRoot("review-pi-budget-")),
    budget: { maxRounds: 2 },
  });

  expect(overrideScript.requests).toHaveLength(12);
  expect(override.record.baseline.rounds).toBe(2);
  expect(override.record.baseline.audit.truncated).toBe(true);
  expect(override.record.baseline.audit.truncationReasons).toEqual(["MAX_ROUNDS_REACHED"]);

  // 缺省预算生效：同一脚本无预算输入 → 5 轮上界（30 请求）
  const defaultScript = fakeFetch(incompleteRoundsCorpus(5));
  const defaults = await runReview(runInput(defaultScript, tempRunsRoot("review-pi-budget-")));

  expect(defaultScript.requests).toHaveLength(30);
  expect(defaults.record.baseline.rounds).toBe(5);
  expect(defaults.record.baseline.audit.truncated).toBe(true);
}, 120_000);

test("预算覆盖：maxExecutedToolCalls=1 生效——同批第二次调用获预算耗尽应答", async () => {
  const script = fakeFetch([
    { text: "ok", usage: ZERO },
    {
      text: "Checking alpha ranges.",
      usage: ZERO,
      toolCalls: [
        {
          id: "call-a",
          name: "review_get_file",
          arguments: { path: "src/main/java/com/example/Alpha.java", startLine: 1, endLine: 1 },
        },
        {
          id: "call-b",
          name: "review_get_file",
          arguments: { path: "src/main/java/com/example/Alpha.java", startLine: 2, endLine: 2 },
        },
      ],
    },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: '{"candidates":[]}', usage: ZERO },
    { text: '{"verdicts":[],"complete":true}', usage: ZERO },
  ]);
  const { record } = await runReview({
    ...runInput(script, tempRunsRoot("review-pi-budget-")),
    budget: { maxExecutedToolCalls: 1 },
  });

  expect(script.requests).toHaveLength(7);
  expect(record.baseline.toolCalls).toBe(1);
  const log = record.baseline.audit.toolCallLog;
  expect(log).toHaveLength(2);
  expect(log[0]?.resultSummary).not.toBe("Error: tool call budget exhausted");
  expect(log[1]).toMatchObject({
    name: "review.get_file",
    resultSummary: "Error: tool call budget exhausted",
  });
  // 工具预算耗尽不翻转 truncated（截断语义只归轮次/跳过阶段）
  expect(record.baseline.audit.truncated).toBe(false);
  expect(record.baseline.audit.truncationReasons).toEqual(["TOOL_BUDGET_EXHAUSTED"]);
}, 120_000);

test("stopReason 骨架：模型完成 vs 轮次上界可区分（RunRecord 与审计文件同源）", async () => {
  const completeScript = fakeFetch([
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: '{"candidates":[]}', usage: ZERO },
    { text: '{"verdicts":[],"complete":true}', usage: ZERO },
  ]);
  const complete = await runReview(runInput(completeScript, tempRunsRoot("review-pi-budget-")));
  expect(complete.record.baseline.audit.stopReason).toBe("MODEL_COMPLETE");
  expect(readAuditJson(complete.auditPath).stopReason).toBe("MODEL_COMPLETE");

  const truncatedScript = fakeFetch(incompleteRoundsCorpus(1));
  const truncated = await runReview({
    ...runInput(truncatedScript, tempRunsRoot("review-pi-budget-")),
    budget: { maxRounds: 1 },
  });
  expect(truncated.record.baseline.audit.stopReason).toBe("MAX_ROUNDS_REACHED");
  expect(readAuditJson(truncated.auditPath).stopReason).toBe("MAX_ROUNDS_REACHED");
}, 120_000);

interface AuditJson {
  readonly stopReason?: string;
  readonly requests: readonly { readonly wireBody: string }[];
  readonly phaseLog: readonly { readonly requestCount: number }[];
  readonly toolCallLog: readonly unknown[];
}

function readAuditJson(auditPath: string): AuditJson {
  return JSON.parse(readFileSync(auditPath, "utf8")) as AuditJson;
}

test("未触发预算的 run：显式缺省预算与无预算基线的 wireBody 逐字节一致", async () => {
  const baselineScript = fakeFetch(sixPhaseNoToolCorpus());
  const baseline = await runReview(runInput(baselineScript, tempRunsRoot("review-pi-budget-")));

  const explicitScript = fakeFetch(sixPhaseNoToolCorpus());
  const explicit = await runReview({
    ...runInput(explicitScript, tempRunsRoot("review-pi-budget-")),
    budget: DEFAULT_REVIEW_BUDGET,
  });

  expect(explicitScript.requests).toHaveLength(baselineScript.requests.length);
  expect(readAuditJson(explicit.auditPath).requests.map((request) => request.wireBody)).toEqual(
    readAuditJson(baseline.auditPath).requests.map((request) => request.wireBody),
  );
}, 120_000);

test("审计计数可读：requests / attempted / executed / skipped 从既有日志派生（不落第二真源）", async () => {
  const executedCalls = Array.from({ length: DEFAULT_REVIEW_BUDGET.maxExecutedToolCalls }, (_, index) => ({
    id: `call-e${index}`,
    name: "review_get_file",
    arguments: {
      path: "src/main/java/com/example/Alpha.java",
      startLine: 1,
      endLine: 1 + index,
    },
  }));
  const overflowCalls = [
    { id: "call-o1", name: "review_get_diff", arguments: {} },
    { id: "call-o2", name: "review_get_diff", arguments: {} },
  ];
  const script = fakeFetch([
    { text: "ok", usage: ZERO },
    { text: "Reading alpha ranges.", usage: ZERO, toolCalls: executedCalls },
    { text: "ok", usage: ZERO },
    { text: "Checking the diff.", usage: ZERO, toolCalls: overflowCalls },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: '{"candidates":[]}', usage: ZERO },
    { text: '{"verdicts":[],"complete":true}', usage: ZERO },
  ]);
  const { record, auditPath } = await runReview(runInput(script, tempRunsRoot("review-pi-budget-")));

  const audit = readAuditJson(auditPath);
  const requests = audit.phaseLog.reduce((sum, phase) => sum + phase.requestCount, 0);
  const attempted = audit.toolCallLog.length;
  const executed = record.baseline.toolCalls;
  const skipped = attempted - executed;

  expect(script.requests).toHaveLength(8);
  expect(requests).toBe(script.requests.length);
  expect(attempted).toBe(DEFAULT_REVIEW_BUDGET.maxExecutedToolCalls + overflowCalls.length);
  expect(executed).toBe(DEFAULT_REVIEW_BUDGET.maxExecutedToolCalls);
  expect(skipped).toBe(overflowCalls.length);
  expect(record.baseline.audit.stopReason).toBe("MODEL_COMPLETE");
}, 120_000);
