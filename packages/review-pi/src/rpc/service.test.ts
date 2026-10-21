/**
 * #22 S1 service：ReviewService 深模块——job 状态机、队列、取消、事件、close
 * drain（spec #21 §6/§7.2、ADR-0012 决策 3）。全程 FakeReviewRunExecutor 驱动，
 * 不触内核。
 */

import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { FakeReviewRunExecutor, ReviewExecutionError, fakeReviewRunSummary } from "./executor.js";
import { createReviewService, type ReviewJobEvent } from "./service.js";
import type { SubmitReviewParams } from "./protocol.js";

/** 固定时钟：jobId（job-<启动毫秒>-<序号>）与 submittedAt 可确定性断言 */
const FIXED_DATE = new Date("2026-10-21T00:00:00.000Z");
const fixedNow = (): Date => FIXED_DATE;

function submitParams(overrides: Partial<SubmitReviewParams> = {}): SubmitReviewParams {
  return {
    caseId: "VUL4J-1",
    repoPath: "repo",
    diff: "--- a\n+++ b\n",
    configId: "E",
    ...overrides,
  };
}

/** 真实可 realpath 的临时目录（repoPath 解析/allowlist 校验走真 fs）；返回 realpath 形态——与 service 内 realpath 口径一致（Windows 8.3 短名/junction 防御） */
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rpc-service-"));
  return realpath(dir);
}

/** 冲刷微任务链（worker 异步启动、事件发射均在微任务） */
const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("submit：入队即返 queued 快照，不等待执行完成（fake 挂起时 submit 已 resolve）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  const view = await service.submit(submitParams({ repoPath: repo }));

  // 快照语义：响应恒为入队时刻的 queued（即使 worker 微任务已抢先启动）
  expect(view.status).toBe("queued");
  expect(view.jobId).toBe(`job-${FIXED_DATE.getTime()}-1`);
  expect(view.caseId).toBe("VUL4J-1");
  expect(view.configId).toBe("E");
  expect(view.submittedAt).toBe(FIXED_DATE.toISOString());
  // 执行已开始但 fake 挂起未结算——submit 早已返回，即「不等待执行完成」
  expect(executor.executions).toHaveLength(1);
});

test("submit：executor 收到规范化 repoPath 与补齐的 issueDescription（内核面必填 string）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  await service.submit(submitParams({ repoPath: repo }));
  await flushAsync();

  expect(executor.executions).toHaveLength(1);
  const execution = executor.executions[0]!;
  expect(execution.request.repoPath).toBe(repo); // realpath 规范化后的绝对路径
  expect(execution.request.issueDescription).toBe(""); // 缺省补齐空串
  expect(execution.ctx.jobId).toBe(`job-${FIXED_DATE.getTime()}-1`);
  expect(execution.ctx.signal.aborted).toBe(false);
  expect(typeof execution.ctx.onProgress).toBe("function");
});

test("job 生命周期：running → resolve → succeeded（事件序 seq 单调，result 进 view）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  const events: ReviewJobEvent[] = [];
  service.subscribe((event) => events.push(event));

  const submitted = await service.submit(submitParams({ repoPath: repo }));
  await flushAsync();

  const summary = fakeReviewRunSummary({ runId: "run-1" });
  executor.executions[0]!.resolve(summary);
  await flushAsync();

  const view = service.get(submitted.jobId);
  expect(view?.status).toBe("succeeded");
  expect(view?.result).toEqual(summary);
  // 事件 = 状态转移点（submit 入队不发事件——响应即首快照）；seq 连接级单调
  expect(events.map((event) => [event.seq, event.job.status])).toEqual([
    [1, "running"],
    [2, "succeeded"],
  ]);
});

test("failed view：合同错误 publicMessage 进 view；非合同异常 → 固定文案（路径/URL 不透传）", async () => {
  const repo = await makeTmpDir();
  const executorA = new FakeReviewRunExecutor();
  const serviceA = createReviewService({ executor: executorA, now: fixedNow });
  const submittedA = await serviceA.submit(submitParams({ repoPath: repo }));
  await flushAsync();

  // 合同错误：publicMessage 进 view，diagnosticMessage（含路径）绝不进
  executorA.executions[0]!.reject(
    new ReviewExecutionError(
      "review failed after 3 rounds",
      "ENOENT: no such file D:\\secret\\repo\\path, connect https://gw.internal/v1",
    ),
  );
  await flushAsync();

  const viewA = serviceA.get(submittedA.jobId);
  expect(viewA?.status).toBe("failed");
  expect(viewA?.error).toEqual({ message: "review failed after 3 rounds" });

  // 非合同异常：固定 generic 文案——异常原文（含路径/URL）不进协议面
  const executorB = new FakeReviewRunExecutor();
  const serviceB = createReviewService({ executor: executorB, now: fixedNow });
  const submittedB = await serviceB.submit(submitParams({ repoPath: repo }));
  await flushAsync();
  executorB.executions[0]!.reject(
    new Error("connect ECONNREFUSED https://gw.example/v1 (D:\\repo)"),
  );
  await flushAsync();

  const viewB = serviceB.get(submittedB.jobId);
  expect(viewB?.status).toBe("failed");
  expect(viewB?.error).toEqual({ message: "review execution failed" });
});

test("并发 1：第二个 job 在第一个终态后自动开工", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  const first = await service.submit(submitParams({ repoPath: repo }));
  const second = await service.submit(
    submitParams({ caseId: "VUL4J-2", repoPath: repo }),
  );
  await flushAsync();

  // concurrency=1：只有第一个在执行
  expect(executor.executions).toHaveLength(1);
  expect(service.get(second.jobId)?.status).toBe("queued");

  executor.executions[0]!.resolve(fakeReviewRunSummary());
  await flushAsync();

  expect(service.get(first.jobId)?.status).toBe("succeeded");
  expect(executor.executions).toHaveLength(2);
  expect(service.get(second.jobId)?.status).toBe("running");
});

test("cancel：queued → 直接 cancelled（出队，永不进执行）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  await service.submit(submitParams({ repoPath: repo })); // 占住 concurrency=1
  const queued = await service.submit(
    submitParams({ caseId: "VUL4J-2", repoPath: repo }),
  );

  const view = await service.cancel(queued.jobId);
  expect(view.status).toBe("cancelled");

  // 占位者终态后，被取消的 job 不再被 pump 启动
  executor.executions[0]!.resolve(fakeReviewRunSummary());
  await flushAsync();
  expect(executor.executions).toHaveLength(1);
  expect(service.get(queued.jobId)?.status).toBe("cancelled");
});

test("cancel：running → cancelling + abort 信号；执行侧错误收场 → cancelled", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  const events: ReviewJobEvent[] = [];
  service.subscribe((event) => events.push(event));

  const submitted = await service.submit(submitParams({ repoPath: repo }));
  await flushAsync();

  const view = await service.cancel(submitted.jobId);
  expect(view.status).toBe("cancelling");
  expect(executor.executions[0]!.ctx.signal.aborted).toBe(true);

  // S2 真内核在 abort 上抛 ReviewAbortedError；S1 由 fake 模拟错误收场
  executor.executions[0]!.reject(new Error("Review aborted"));
  await flushAsync();

  expect(service.get(submitted.jobId)?.status).toBe("cancelled");
  expect(events.map((event) => event.job.status)).toEqual([
    "running",
    "cancelling",
    "cancelled",
  ]);
});

test("cancel 竞速：cancelling 中执行侧成功收场 → succeeded（事实优先，终态不可逆）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  const submitted = await service.submit(submitParams({ repoPath: repo }));
  await flushAsync();
  await service.cancel(submitted.jobId); // cancelling（abort 已发但未生效）

  // executor 无视 abort 完成了检视：结果事实优先，cancel 输掉竞速
  executor.executions[0]!.resolve(fakeReviewRunSummary({ runId: "run-race" }));
  await flushAsync();

  const view = service.get(submitted.jobId);
  expect(view?.status).toBe("succeeded");
  expect(view?.result).toMatchObject({ runId: "run-race" });
  // 后续 cancel 幂等返回 succeeded 终态
  const again = await service.cancel(submitted.jobId);
  expect(again.status).toBe("succeeded");
});

test("cancel：cancelling 重复 cancel 与终态 cancel → 幂等返回当前 view（-32005 不发射）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  const submitted = await service.submit(submitParams({ repoPath: repo }));
  await flushAsync();

  // cancelling 态重复 cancel：幂等
  await service.cancel(submitted.jobId);
  const again = await service.cancel(submitted.jobId);
  expect(again.status).toBe("cancelling");
  expect(executor.executions[0]!.ctx.signal.aborted).toBe(true);

  executor.executions[0]!.reject(new Error("aborted"));
  await flushAsync();

  // 终态 cancel：幂等返回终态 view，不报错不回退
  const terminal = await service.cancel(submitted.jobId);
  expect(terminal.status).toBe("cancelled");
});

test("cancel：unknown jobId → -32001（data 携带 jobId）", async () => {
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  await expect(service.cancel("job-1-999")).rejects.toMatchObject({
    code: -32001,
    data: { jobId: "job-1-999" },
  });
});

test("onProgress：phase/round 边界发事件，计数变化不发（粒度拍板：不逐 toolCall）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  const events: ReviewJobEvent[] = [];
  service.subscribe((event) => events.push(event));

  const submitted = await service.submit(submitParams({ repoPath: repo }));
  await flushAsync();
  const { onProgress } = executor.executions[0]!.ctx;

  onProgress!({ phase: "Deep Reasoning", round: 1, toolCalls: 0 });
  // 同 phase/round 边界、仅 toolCalls/usage 计数推进 → 不发事件
  onProgress!({
    phase: "Deep Reasoning",
    round: 1,
    toolCalls: 2,
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  // round 推进 → 发（计数快照随行）
  onProgress!({
    phase: "Deep Reasoning",
    round: 2,
    toolCalls: 3,
    usage: { inputTokens: 20, outputTokens: 8 },
  });
  // phase 变化 → 发
  onProgress!({ phase: "Judgement", round: 2, toolCalls: 3 });

  expect(events.map((event) => [event.seq, event.job.status, event.job.progress])).toEqual([
    [1, "running", undefined],
    [2, "running", { phase: "Deep Reasoning", round: 1, toolCalls: 0 }],
    [3, "running", { phase: "Deep Reasoning", round: 2, toolCalls: 3, usage: { inputTokens: 20, outputTokens: 8 } }],
    [4, "running", { phase: "Judgement", round: 2, toolCalls: 3 }],
  ]);
  // get 快照为最新 progress
  expect(service.get(submitted.jobId)?.progress).toEqual({
    phase: "Judgement",
    round: 2,
    toolCalls: 3,
  });
});

test("close：drain——立即停止收单（-32010）、取消 queued、等 running 终态、幂等", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  const events: ReviewJobEvent[] = [];
  service.subscribe((event) => events.push(event));

  const running = await service.submit(submitParams({ repoPath: repo }));
  const queued = await service.submit(
    submitParams({ caseId: "VUL4J-2", repoPath: repo }),
  );
  await flushAsync();
  expect(service.get(running.jobId)?.status).toBe("running");

  const closing = service.close();
  // close 立即进入 draining：不等 running 终态就拒绝新单
  expect(service.isDraining()).toBe(true);
  await expect(service.submit(submitParams({ repoPath: repo }))).rejects.toMatchObject({
    code: -32010,
  });
  // queued 被 drain 取消
  expect(service.get(queued.jobId)?.status).toBe("cancelled");

  // running 不中断：executor 完成后 close 才落定
  executor.executions[0]!.resolve(fakeReviewRunSummary());
  await closing;
  expect(service.get(running.jobId)?.status).toBe("succeeded");

  // 幂等：重复 close 无副作用
  await service.close();
  // queued 取消也走事件流
  expect(events.map((event) => event.job.status)).toEqual([
    "running",
    "cancelled",
    "succeeded",
  ]);
});

test("submit：diff 超 maxDiffBytes → -32004（data 带 maxDiffBytes）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({
    executor,
    now: fixedNow,
    limits: { maxDiffBytes: 10 },
  });

  await expect(
    service.submit(submitParams({ repoPath: repo, diff: "x".repeat(11) })),
  ).rejects.toMatchObject({ code: -32004, data: { maxDiffBytes: 10 } });
  // 恰在上限内（字节数按 UTF-8）→ 受理
  const view = await service.submit(submitParams({ repoPath: repo, diff: "x".repeat(10) }));
  expect(view.status).toBe("queued");
});

test("submit：repoPath 越出 allowlist 根 → -32003；根内子目录放行；不存在路径 → -32003", async () => {
  const executor = new FakeReviewRunExecutor();
  const root = await makeTmpDir();
  const inside = await realpath(await mkdtemp(join(root, "repo-")));
  const outside = await makeTmpDir();
  const service = createReviewService({ executor, now: fixedNow, repoRoot: root });

  const insideView = await service.submit(submitParams({ repoPath: inside }));
  expect(insideView.status).toBe("queued");

  // error.data 不放路径（spec §9：只放安全细节）
  await expect(service.submit(submitParams({ repoPath: outside }))).rejects.toMatchObject({
    code: -32003,
    data: undefined,
  });

  await expect(
    service.submit(submitParams({ repoPath: join(tmpdir(), "rpc-service-nonexistent") })),
  ).rejects.toMatchObject({ code: -32003 });
});

test("submit：queued 数达 maxQueueDepth → -32002（data 带 limit）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({
    executor,
    now: fixedNow,
    limits: { maxQueueDepth: 2 },
  });

  await service.submit(submitParams({ repoPath: repo })); // 占住 concurrency=1
  await service.submit(submitParams({ repoPath: repo })); // queued 1
  await service.submit(submitParams({ repoPath: repo })); // queued 2
  await expect(service.submit(submitParams({ repoPath: repo }))).rejects.toMatchObject({
    code: -32002,
    data: { limit: 2 },
  });
});

test("list：提交倒序 + status 过滤", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  const first = await service.submit(submitParams({ repoPath: repo }));
  const second = await service.submit(
    submitParams({ caseId: "VUL4J-2", repoPath: repo }),
  );
  const third = await service.submit(
    submitParams({ caseId: "VUL4J-3", repoPath: repo }),
  );
  await flushAsync();
  executor.executions[0]!.resolve(fakeReviewRunSummary());

  expect(service.list({}).jobs.map((job) => job.caseId)).toEqual([
    "VUL4J-3",
    "VUL4J-2",
    "VUL4J-1",
  ]);
  expect(service.list({ status: "queued" }).jobs.map((job) => job.caseId)).toEqual([
    "VUL4J-3",
    "VUL4J-2",
  ]);
  expect(service.list({}).jobs.map((job) => job.jobId)).toEqual([
    third.jobId,
    second.jobId,
    first.jobId,
  ]);
});

test("concurrency 2：两个 job 同时 running（v1 默认 1，显式配置可放开）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow, concurrency: 2 });

  await service.submit(submitParams({ repoPath: repo }));
  await service.submit(submitParams({ caseId: "VUL4J-2", repoPath: repo }));
  await flushAsync();

  expect(executor.executions).toHaveLength(2);
  const statuses = service
    .list({})
    .jobs.map((job) => job.status)
    .sort();
  expect(statuses).toEqual(["running", "running"]);
});

test("终态 view 不携带 progress（spec §6.1：progress 仅 running/cancelling 存在）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  const events: ReviewJobEvent[] = [];
  service.subscribe((event) => events.push(event));

  const submitted = await service.submit(submitParams({ repoPath: repo }));
  await flushAsync();
  executor.executions[0]!.ctx.onProgress!({
    phase: "Deep Reasoning",
    round: 1,
    toolCalls: 2,
  });
  executor.executions[0]!.resolve(fakeReviewRunSummary());
  await flushAsync();

  // running 事件带 progress；succeeded 终态事件与 get 快照均不带
  expect(events.map((event) => [event.job.status, event.job.progress])).toEqual([
    ["running", undefined],
    ["running", { phase: "Deep Reasoning", round: 1, toolCalls: 2 }],
    ["succeeded", undefined],
  ]);
  expect(service.get(submitted.jobId)?.progress).toBeUndefined();
});

test("close 与 submit 竞速：drain 落定后迟到入队的 job 不开工、收 -32010（S2 后果：不先跑真内核再 abort）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  await service.submit(submitParams({ repoPath: repo })); // A running 占住并发
  // B 的 submit 已过第一道 draining 门、挂在 realpath await 上
  const lateSubmit = service.submit(submitParams({ caseId: "VUL4J-2", repoPath: repo }));
  const closing = service.close(); // drain：此刻 B 尚未入队
  executor.executions[0]!.resolve(fakeReviewRunSummary()); // A 落定 → close 可收尾
  await closing;

  await expect(lateSubmit).rejects.toMatchObject({ code: -32010 });
  await flushAsync();
  expect(executor.executions).toHaveLength(1); // B 从未被 executor 触达
});

test("close 并发：第二个 close 共享同一 drain promise，不提前返回", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  await service.submit(submitParams({ repoPath: repo })); // running 挂起
  const first = service.close();
  const second = service.close();
  let secondResolved = false;
  void second.then(() => {
    secondResolved = true;
  });
  await flushAsync();
  // running 未落定：两个 close 都不得完成
  expect(secondResolved).toBe(false);

  executor.executions[0]!.resolve(fakeReviewRunSummary());
  await Promise.all([first, second]); // 两者共享同一 drain 结果
});

test("repoRoot 书写形态差异（win32 盘符大小写）不误拒根内 repoPath（两侧同走 realpath）", async () => {
  const executor = new FakeReviewRunExecutor();
  const root = await makeTmpDir();
  const repo = await realpath(await mkdtemp(join(root, "repo-")));
  // 同一路径的另一种书写形态：盘符小写（Windows 大小写不敏感文件系统上等价；
  // 旧实现在 resolve 后未 realpath 比较，C: vs c: 会被误拒 -32003）
  const variantRoot = root.replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase());
  const service = createReviewService({ executor, now: fixedNow, repoRoot: variantRoot });

  const view = await service.submit(submitParams({ repoPath: repo }));
  expect(view.status).toBe("queued");
});

test("subscribe：通知中注销不影响本轮快照遍历，注销后不再收后续事件", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  const received: number[] = [];
  // 第一个 listener 在首事件（running）里注销第二个——快照遍历保证第二个仍收本轮
  let unsubscribeSecond: () => void = () => {};
  service.subscribe((event) => {
    if (event.seq === 1) {
      unsubscribeSecond();
    }
  });
  unsubscribeSecond = service.subscribe((event) => received.push(event.seq));

  const submitted = await service.submit(submitParams({ repoPath: repo }));
  await flushAsync();
  expect(received).toEqual([1]); // 本轮快照仍送达

  executor.executions[0]!.resolve(fakeReviewRunSummary());
  await flushAsync();
  expect(received).toEqual([1]); // 后续事件不再送达
  expect(service.get(submitted.jobId)?.status).toBe("succeeded");
});
