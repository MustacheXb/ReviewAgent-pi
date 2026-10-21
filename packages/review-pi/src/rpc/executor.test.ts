import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { fakeFetch } from "../provider/fake-fetch.js";
import type { ReviewerEndpoint } from "../provider/reviewer-endpoint.js";
import { repoFixturePath } from "../testing/repos.js";
import {
  SAMPLE_DIFF,
  configDToolCorpus,
  expectEmptyTree,
  sixPhaseNoToolCorpus,
  tempRunsRoot,
} from "../testing/seam-fixtures.js";
import { ReviewAbortedError } from "../run/review-run.js";
import {
  KernelReviewRunExecutor,
  ReviewExecutionError,
} from "./executor.js";
import { createReviewService } from "./service.js";

// S2 真适配器测试（#23）：KernelReviewRunExecutor——runReview 唯一 import 方。
// 三面：
// - 投影：ReviewRunResult → ReviewRunSummary 本地投影（内核返回类型不改），
//   以磁盘真源（record/audit JSON）做独立对照——非自证等值；
// - 错误合同：内核异常 → ReviewExecutionError（publicMessage 固定 generic、
//   诊断细节走 onDiagnostic sink，绝不进协议面）；取消不是失败——
//   ReviewAbortedError 原样透传、不写诊断；
// - service 全链路：真适配器接入后 running cancel——cancelling → executor
//   abort → cancelled，半途中止零落盘（审计与 RunRecord 均不写）。
// 共享最小语料/临时目录助手见 testing/seam-fixtures.ts（与内核缝测试共用）。

/** 离线端点档（baseUrl 指向不通的测试域——离线 run 恒走注入的 fake 传输层） */
const OFFLINE_ENDPOINT: ReviewerEndpoint = {
  baseUrl: "https://reviewer.example.invalid",
  apiKey: "offline-test",
};

const BASE_REQUEST = {
  caseId: "VUL4J-1",
  repoPath: repoFixturePath("sample"),
  diff: SAMPLE_DIFF,
  issueDescription: "Issue description under review.",
} as const;

// ---- 投影：ReviewRunResult → ReviewRunSummary（#23）----

test("投影：summary 与磁盘真源一致（experimentId 恒 review-pi-rpc、rep-1）", async () => {
  const script = fakeFetch(configDToolCorpus());
  const runsRoot = tempRunsRoot("review-pi-rpc-executor-");
  const executor = new KernelReviewRunExecutor({
    endpoint: OFFLINE_ENDPOINT,
    runsRoot,
    fetch: script.fetch,
  });

  const summary = await executor.execute(
    { ...BASE_REQUEST, configId: "D" },
    { jobId: "job-projection-1", signal: new AbortController().signal },
  );

  // 摘要口径（config D：1 轮、1 次工具调用、零 usage、未截断）
  expect(summary.runId).not.toBe("");
  expect(summary.findings).toEqual([]);
  expect(summary.rounds).toBe(1);
  expect(summary.toolCalls).toBe(1);
  expect(summary.truncated).toBe(false);
  expect(summary.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });

  // 磁盘真源独立对照（非自证等值）：record.baseline 与 summary 同值
  const record = JSON.parse(readFileSync(summary.recordPath, "utf8")) as {
    readonly baseline: {
      readonly findings: readonly unknown[];
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
      readonly rounds: number;
      readonly toolCalls: number;
      readonly audit: { readonly truncated: boolean };
    };
  };
  expect(record.baseline.findings).toEqual(summary.findings);
  expect(record.baseline.usage).toEqual(summary.usage);
  expect(record.baseline.rounds).toBe(summary.rounds);
  expect(record.baseline.toolCalls).toBe(summary.toolCalls);
  expect(record.baseline.audit.truncated).toBe(summary.truncated);

  // runId 与审计文件同源；落盘位形：experimentId 恒 review-pi-rpc、rep-1
  const audit = JSON.parse(readFileSync(summary.auditPath, "utf8")) as { readonly runId: string };
  expect(audit.runId).toBe(summary.runId);
  expect(summary.recordPath).toBe(
    path.join(runsRoot, "review-pi-rpc", "runs", "vul4j", "VUL4J-1", "D", "rep-1.json"),
  );
  expect(summary.auditPath).toContain(
    path.join(runsRoot, "review-pi-rpc", "audit", "vul4j", "VUL4J-1", "D", "rep-1", "audit"),
  );
}, 120_000);

// ---- 错误合同：publicMessage 安全文案 + 诊断走注入 sink（#23）----

test("内核错误 → ReviewExecutionError：publicMessage 固定 generic，诊断细节只进 onDiagnostic", async () => {
  // 脚本耗尽：第 2 请求无 canned 回复 → 内核 runReviewTurn 抛错
  const script = fakeFetch(sixPhaseNoToolCorpus().slice(0, 1));
  const runsRoot = tempRunsRoot("review-pi-rpc-executor-");
  const diagnostics: string[] = [];
  const executor = new KernelReviewRunExecutor({
    endpoint: OFFLINE_ENDPOINT,
    runsRoot,
    fetch: script.fetch,
    onDiagnostic: (message) => {
      diagnostics.push(message);
    },
  });

  let caught: unknown;
  try {
    await executor.execute(
      { ...BASE_REQUEST, configId: "A" },
      { jobId: "job-error-1", signal: new AbortController().signal },
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ReviewExecutionError);
  const executionError = caught as ReviewExecutionError;
  // 协议面安全文案：固定 generic——异常原文（路径/URL/堆栈）绝不进 view
  expect(executionError.publicMessage).toBe("review execution failed");
  // 诊断细节（Error.message 载体）与 sink 双通道，均含内核错误原文
  expect(executionError.message).toContain("review turn failed");
  expect(diagnostics.join("\n")).toContain("review turn failed");
  expect(diagnostics.join("\n")).toContain("job-error-1");
  // 失败 run 也不落盘（审计在循环完成后统一写——中途失败零残留）
  expectEmptyTree(runsRoot);
});

test("取消不是失败：ReviewAbortedError 原样透传，不包合同错误、不写诊断", async () => {
  const script = fakeFetch(sixPhaseNoToolCorpus());
  const runsRoot = tempRunsRoot("review-pi-rpc-executor-");
  const diagnostics: string[] = [];
  const executor = new KernelReviewRunExecutor({
    endpoint: OFFLINE_ENDPOINT,
    runsRoot,
    fetch: script.fetch,
    onDiagnostic: (message) => {
      diagnostics.push(message);
    },
  });

  const controller = new AbortController();
  controller.abort(); // 调用前已中止：内核入口立即 ReviewAbortedError

  await expect(
    executor.execute(
      { ...BASE_REQUEST, configId: "A" },
      { jobId: "job-abort-1", signal: controller.signal },
    ),
  ).rejects.toBeInstanceOf(ReviewAbortedError);

  expect(script.requests).toHaveLength(0);
  expect(diagnostics).toHaveLength(0);
  expectEmptyTree(runsRoot);
});

// ---- service 全链路：真适配器 running cancel（#23）----

test("service running cancel 全链路：cancelling → executor abort → cancelled，半途零落盘", async () => {
  // 第 2 次回复挂起到 cancel 之后：cancel 必落在 running 中途（run 不可能在
  // cancel 前完成——6 阶段至少 6 请求，第 2 请求被门挡住）
  const script = fakeFetch(sixPhaseNoToolCorpus());
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let calls = 0;
  const gatingFetch: FetchFunction = async (input, init) => {
    calls += 1;
    const response = await script.fetch(input, init);
    if (calls === 2) {
      await secondGate;
    }
    return response;
  };

  const runsRoot = tempRunsRoot("review-pi-rpc-executor-");
  const executor = new KernelReviewRunExecutor({
    endpoint: OFFLINE_ENDPOINT,
    runsRoot,
    fetch: gatingFetch,
  });
  const fixedNow = (): Date => new Date("2026-10-21T00:00:00.000Z");
  const service = createReviewService({ executor, now: fixedNow });
  const events: { readonly seq: number; readonly job: { readonly status: string } }[] = [];
  service.subscribe((event) => {
    events.push(event as { seq: number; job: { status: string } });
  });

  const submitted = await service.submit({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: SAMPLE_DIFF,
    configId: "E",
  });
  // 冲刷微任务链：worker 启动、内核跑到第 2 请求被门挡住（job 必已 running）
  await new Promise((resolve) => setTimeout(resolve, 0));

  const cancelling = await service.cancel(submitted.jobId);
  expect(cancelling.status).toBe("cancelling");
  releaseSecond();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const final = service.get(submitted.jobId);
  expect(final?.status).toBe("cancelled");
  // 终态 view：无 result、无 error（取消不是失败）
  expect(final?.result).toBeUndefined();
  expect(final?.error).toBeUndefined();

  // 状态转移序列（progress 边界事件归并后仍单调）：running → cancelling → cancelled
  const transitions = events
    .map((event) => event.job.status)
    .filter((status, index, all) => all.indexOf(status) === index);
  expect(transitions).toEqual(["running", "cancelling", "cancelled"]);

  // 半途中止：run 未跑完（< 6 请求），runsRoot 零落盘
  expect(calls).toBeLessThanOrEqual(2);
  expectEmptyTree(runsRoot);
}, 120_000);
