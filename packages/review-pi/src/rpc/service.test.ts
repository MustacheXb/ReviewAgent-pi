/**
 * #22 S1 service：ReviewService 深模块——job 状态机、队列、取消、事件、close
 * drain（spec #21 §6/§7.2、ADR-0012 决策 3）。全程 FakeReviewRunExecutor 驱动，
 * 不触内核。
 * #27 v2：submit 切统一 ReviewRequest + CallContext 贯穿全方法（ADR-0013 决策
 * 3/5——越权统一 not found）；repoRoot/allowlist 移除换 defaultRepoPath +
 * realpath/存在性校验（-32012）；diff 判别联合（file 读内容）；事件 per-job seq。
 */

import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative as relativePath } from "node:path";

import { expect, test } from "vitest";

import { FakeReviewRunExecutor, ReviewExecutionError, fakeReviewRunSummary } from "./executor.js";
import { localCallContext, type CallContext } from "./context.js";
import { createReviewService, type ReviewJobEvent } from "./service.js";
import type { ReviewRequest } from "./protocol.js";

/** 固定时钟：jobId（job-<启动毫秒>-<序号>）与 submittedAt 可确定性断言 */
const FIXED_DATE = new Date("2026-10-21T00:00:00.000Z");
const fixedNow = (): Date => FIXED_DATE;

/** stdio 面合成 local principal 的 ctx（多租户用例外，另造 tenantCtx） */
const CTX: CallContext = localCallContext("req-test");

/** 异租户 ctx（租户隔离用例）；scope 空——service 只认 tenant 隔离不执法 scope */
const tenantCtx = (tenantId: string): CallContext => ({
  principal: { tenantId, subject: `subject-${tenantId}`, scopes: [] },
  requestId: `req-${tenantId}`,
});

function reviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    caseId: "VUL4J-1",
    diff: { kind: "inline", text: "--- a\n+++ b\n" },
    configId: "E",
    ...overrides,
  };
}

/** 真实可 realpath 的临时目录（repoPath 解析走真 fs）；返回 realpath 形态——与 service 内 realpath 口径一致（Windows 8.3 短名/junction 防御） */
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rpc-service-"));
  return realpath(dir);
}

/** 真实临时 diff 文件（diff {kind:"file"} 解析走真 fs）；返回 realpath 形态 */
async function makeTmpDiffFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rpc-service-diff-"));
  const file = join(dir, "case.diff");
  await writeFile(file, content, "utf8");
  return realpath(file);
}

/** 冲刷微任务链（worker 异步启动、事件发射均在微任务） */
const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("submit：入队即返 queued 快照，不等待执行完成（fake 挂起时 submit 已 resolve）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  const view = await service.submit(reviewRequest({ repoPath: repo }), CTX);

  // 快照语义：响应恒为入队时刻的 queued（即使 worker 微任务已抢先启动）
  expect(view.status).toBe("queued");
  expect(view.jobId).toBe(`job-${FIXED_DATE.getTime()}-1`);
  expect(view.caseId).toBe("VUL4J-1");
  expect(view.configId).toBe("E");
  expect(view.submittedAt).toBe(FIXED_DATE.toISOString());
  // 执行已开始但 fake 挂起未结算——submit 早已返回，即「不等待执行完成」
  expect(executor.executions).toHaveLength(1);
});

test("submit：executor 收到规范化 repoPath、diff 文本与补齐的 issueDescription（内核面必填 string）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  await service.submit(reviewRequest({ repoPath: repo }), CTX);
  await flushAsync();

  expect(executor.executions).toHaveLength(1);
  const execution = executor.executions[0]!;
  expect(execution.request.repoPath).toBe(repo); // realpath 规范化后的绝对路径
  expect(execution.request.diff).toBe("--- a\n+++ b\n"); // inline text 原样透传
  expect(execution.request.issueDescription).toBe(""); // 缺省补齐空串
  expect(execution.ctx.jobId).toBe(`job-${FIXED_DATE.getTime()}-1`);
  expect(execution.ctx.signal.aborted).toBe(false);
  expect(typeof execution.ctx.onProgress).toBe("function");
});

test("job 生命周期：running → resolve → succeeded（事件序 per-job seq 单调，result 进 view）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  const events: ReviewJobEvent[] = [];
  service.subscribe((event) => events.push(event), CTX);

  const submitted = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  await flushAsync();

  const summary = fakeReviewRunSummary({ runId: "run-1" });
  executor.executions[0]!.resolve(summary);
  await flushAsync();

  const view = await service.get(submitted.jobId, CTX);
  expect(view?.status).toBe("succeeded");
  expect(view?.result).toEqual(summary);
  // 事件 = 状态转移点（submit 入队不发事件——响应即首快照）；seq per-job 从 1 起
  expect(events.map((event) => [event.seq, event.job.status])).toEqual([
    [1, "running"],
    [2, "succeeded"],
  ]);
});

test("failed view：合同错误 publicMessage 进 view；非合同异常 → 固定文案（路径/URL 不透传）", async () => {
  const repo = await makeTmpDir();
  const executorA = new FakeReviewRunExecutor();
  const serviceA = createReviewService({ executor: executorA, now: fixedNow });
  const submittedA = await serviceA.submit(reviewRequest({ repoPath: repo }), CTX);
  await flushAsync();

  // 合同错误：publicMessage 进 view，diagnosticMessage（含路径）绝不进
  executorA.executions[0]!.reject(
    new ReviewExecutionError(
      "review failed after 3 rounds",
      "ENOENT: no such file D:\\secret\\repo\\path, connect https://gw.internal/v1",
    ),
  );
  await flushAsync();

  const viewA = await serviceA.get(submittedA.jobId, CTX);
  expect(viewA?.status).toBe("failed");
  expect(viewA?.error).toEqual({ message: "review failed after 3 rounds" });

  // 非合同异常：固定 generic 文案——异常原文（含路径/URL）不进协议面
  const executorB = new FakeReviewRunExecutor();
  const serviceB = createReviewService({ executor: executorB, now: fixedNow });
  const submittedB = await serviceB.submit(reviewRequest({ repoPath: repo }), CTX);
  await flushAsync();
  executorB.executions[0]!.reject(
    new Error("connect ECONNREFUSED https://gw.example/v1 (D:\\repo)"),
  );
  await flushAsync();

  const viewB = await serviceB.get(submittedB.jobId, CTX);
  expect(viewB?.status).toBe("failed");
  expect(viewB?.error).toEqual({ message: "review execution failed" });
});

test("并发 1：第二个 job 在第一个终态后自动开工", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  const first = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  const second = await service.submit(
    reviewRequest({ caseId: "VUL4J-2", repoPath: repo }),
    CTX,
  );
  await flushAsync();

  // concurrency=1：只有第一个在执行
  expect(executor.executions).toHaveLength(1);
  expect((await service.get(second.jobId, CTX))?.status).toBe("queued");

  executor.executions[0]!.resolve(fakeReviewRunSummary());
  await flushAsync();

  expect((await service.get(first.jobId, CTX))?.status).toBe("succeeded");
  expect(executor.executions).toHaveLength(2);
  expect((await service.get(second.jobId, CTX))?.status).toBe("running");
});

test("cancel：queued → 直接 cancelled（出队，永不进执行）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  await service.submit(reviewRequest({ repoPath: repo }), CTX); // 占住 concurrency=1
  const queued = await service.submit(
    reviewRequest({ caseId: "VUL4J-2", repoPath: repo }),
    CTX,
  );

  const view = await service.cancel(queued.jobId, CTX);
  expect(view.status).toBe("cancelled");

  // 占位者终态后，被取消的 job 不再被 pump 启动
  executor.executions[0]!.resolve(fakeReviewRunSummary());
  await flushAsync();
  expect(executor.executions).toHaveLength(1);
  expect((await service.get(queued.jobId, CTX))?.status).toBe("cancelled");
});

test("cancel：running → cancelling + abort 信号；执行侧错误收场 → cancelled", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  const events: ReviewJobEvent[] = [];
  service.subscribe((event) => events.push(event), CTX);

  const submitted = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  await flushAsync();

  const view = await service.cancel(submitted.jobId, CTX);
  expect(view.status).toBe("cancelling");
  expect(executor.executions[0]!.ctx.signal.aborted).toBe(true);

  // S2 真内核在 abort 上抛 ReviewAbortedError；S1 由 fake 模拟错误收场
  executor.executions[0]!.reject(new Error("Review aborted"));
  await flushAsync();

  expect((await service.get(submitted.jobId, CTX))?.status).toBe("cancelled");
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

  const submitted = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  await flushAsync();
  await service.cancel(submitted.jobId, CTX); // cancelling（abort 已发但未生效）

  // executor 无视 abort 完成了检视：结果事实优先，cancel 输掉竞速
  executor.executions[0]!.resolve(fakeReviewRunSummary({ runId: "run-race" }));
  await flushAsync();

  const view = await service.get(submitted.jobId, CTX);
  expect(view?.status).toBe("succeeded");
  expect(view?.result).toMatchObject({ runId: "run-race" });
  // 后续 cancel 幂等返回 succeeded 终态
  const again = await service.cancel(submitted.jobId, CTX);
  expect(again.status).toBe("succeeded");
});

test("cancel：cancelling 重复 cancel 与终态 cancel → 幂等返回当前 view（-32005 不发射）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  const submitted = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  await flushAsync();

  // cancelling 态重复 cancel：幂等
  await service.cancel(submitted.jobId, CTX);
  const again = await service.cancel(submitted.jobId, CTX);
  expect(again.status).toBe("cancelling");
  expect(executor.executions[0]!.ctx.signal.aborted).toBe(true);

  executor.executions[0]!.reject(new Error("aborted"));
  await flushAsync();

  // 终态 cancel：幂等返回终态 view，不报错不回退
  const terminal = await service.cancel(submitted.jobId, CTX);
  expect(terminal.status).toBe("cancelled");
});

test("cancel：unknown jobId → -32001（data 携带 jobId）", async () => {
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  await expect(service.cancel("job-1-999", CTX)).rejects.toMatchObject({
    code: -32001,
    data: { jobId: "job-1-999" },
  });
});

test("onProgress：phase/round 边界发事件，计数变化不发（粒度拍板：不逐 toolCall）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  const events: ReviewJobEvent[] = [];
  service.subscribe((event) => events.push(event), CTX);

  const submitted = await service.submit(reviewRequest({ repoPath: repo }), CTX);
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
  expect((await service.get(submitted.jobId, CTX))?.progress).toEqual({
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
  service.subscribe((event) => events.push(event), CTX);

  const running = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  const queued = await service.submit(
    reviewRequest({ caseId: "VUL4J-2", repoPath: repo }),
    CTX,
  );
  await flushAsync();
  expect((await service.get(running.jobId, CTX))?.status).toBe("running");

  const closing = service.close();
  // close 立即进入 draining：不等 running 终态就拒绝新单
  expect(service.isDraining()).toBe(true);
  await expect(service.submit(reviewRequest({ repoPath: repo }), CTX)).rejects.toMatchObject({
    code: -32010,
  });
  // queued 被 drain 取消
  expect((await service.get(queued.jobId, CTX))?.status).toBe("cancelled");

  // running 不中断：executor 完成后 close 才落定
  executor.executions[0]!.resolve(fakeReviewRunSummary());
  await closing;
  expect((await service.get(running.jobId, CTX))?.status).toBe("succeeded");

  // 幂等：重复 close 无副作用
  await service.close();
  // queued 取消也走事件流
  expect(events.map((event) => event.job.status)).toEqual([
    "running",
    "cancelled",
    "succeeded",
  ]);
});

test("submit：diff 超 maxDiffBytes → -32004（data 带 maxDiffBytes；inline/file 同口径）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({
    executor,
    now: fixedNow,
    limits: { maxDiffBytes: 10 },
  });

  await expect(
    service.submit(
      reviewRequest({ repoPath: repo, diff: { kind: "inline", text: "x".repeat(11) } }),
      CTX,
    ),
  ).rejects.toMatchObject({ code: -32004, data: { maxDiffBytes: 10 } });
  // 恰在上限内（字节数按 UTF-8）→ 受理
  const view = await service.submit(
    reviewRequest({ repoPath: repo, diff: { kind: "inline", text: "x".repeat(10) } }),
    CTX,
  );
  expect(view.status).toBe("queued");

  // file kind 按读入内容计字节（不是文件大小口径差异——同一 Buffer.byteLength）
  const diffPath = await makeTmpDiffFile("y".repeat(11));
  await expect(
    service.submit(
      reviewRequest({ repoPath: repo, diff: { kind: "file", path: diffPath } }),
      CTX,
    ),
  ).rejects.toMatchObject({ code: -32004, data: { maxDiffBytes: 10 } });
});

test("submit：diff {kind:'file'} → realpath+isFile 校验后读内容进 request.diff（executor 只见文本）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  const diffPath = await makeTmpDiffFile("--- a\n+++ b\n");

  const view = await service.submit(
    reviewRequest({ repoPath: repo, diff: { kind: "file", path: diffPath } }),
    CTX,
  );
  await flushAsync();

  expect(view.status).toBe("queued");
  expect(executor.executions).toHaveLength(1);
  expect(executor.executions[0]!.request.diff).toBe("--- a\n+++ b\n");
  expect(executor.executions[0]!.request.repoPath).toBe(repo);
});

test("submit：diff file 不存在 / 指向目录 → -32012 repo_not_found（data 不放路径）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  await expect(
    service.submit(
      reviewRequest({
        repoPath: repo,
        diff: { kind: "file", path: join(tmpdir(), "rpc-service-nonexistent.diff") },
      }),
      CTX,
    ),
  ).rejects.toMatchObject({ code: -32012, data: undefined });

  // 目录不是文件：存在但类型不符，同 -32012
  await expect(
    service.submit(
      reviewRequest({ repoPath: repo, diff: { kind: "file", path: repo } }),
      CTX,
    ),
  ).rejects.toMatchObject({ code: -32012 });
});

test("submit：diff 内容为空（file 空文件 / inline 空串）→ -32602 invalid_params", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  const emptyFile = await makeTmpDiffFile("");
  await expect(
    service.submit(
      reviewRequest({ repoPath: repo, diff: { kind: "file", path: emptyFile } }),
      CTX,
    ),
  ).rejects.toMatchObject({ code: -32602 });
  // inline 空串：协议校验器已拒（单源），service 层直调同口径兜底
  await expect(
    service.submit(
      reviewRequest({ repoPath: repo, diff: { kind: "inline", text: "" } }),
      CTX,
    ),
  ).rejects.toMatchObject({ code: -32602 });
});

test("submit：repoPath 不存在 / 指向文件 → -32012 repo_not_found（data 不放路径，spec §9）", async () => {
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  const filePath = await makeTmpDiffFile("d");

  await expect(
    service.submit(
      reviewRequest({ repoPath: join(tmpdir(), "rpc-service-nonexistent") }),
      CTX,
    ),
  ).rejects.toMatchObject({ code: -32012, data: undefined });

  // 文件不是目录：存在但类型不符，同 -32012
  await expect(service.submit(reviewRequest({ repoPath: filePath }), CTX)).rejects.toMatchObject({
    code: -32012,
  });
});

test("submit：repoPath 省略 → defaultRepoPath（--cwd 链路）；显式 repoPath 覆盖缺省（provide to override）", async () => {
  const defaultRepo = await makeTmpDir();
  const otherRepo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({
    executor,
    now: fixedNow,
    defaultRepoPath: defaultRepo,
    concurrency: 2,
  });

  await service.submit(reviewRequest(), CTX); // 省略 → defaultRepoPath
  await service.submit(reviewRequest({ caseId: "VUL4J-2", repoPath: otherRepo }), CTX);
  await flushAsync();

  expect(executor.executions[0]!.request.repoPath).toBe(defaultRepo);
  expect(executor.executions[1]!.request.repoPath).toBe(otherRepo);
});

test("submit：repoPath 省略且未配 defaultRepoPath → process.cwd()（omit to discover）", async () => {
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  await service.submit(reviewRequest(), CTX);
  await flushAsync();

  expect(executor.executions[0]!.request.repoPath).toBe(await realpath(process.cwd()));
});

test("submit：相对 repoPath 按 process.cwd() 解析（拍板 25：--cwd 仅覆盖 repoPath 缺省值）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({
    executor,
    now: fixedNow,
    defaultRepoPath: await makeTmpDir(), // 不得成为相对路径的解析基准
  });

  // 相对形态（跨盘时 relative 回退为绝对路径，同样成立）
  const rel = relativePath(process.cwd(), repo);
  await service.submit(reviewRequest({ repoPath: rel }), CTX);
  await flushAsync();

  expect(executor.executions[0]!.request.repoPath).toBe(repo);
});

test("submit：queued 数达 maxQueueDepth → -32002（data 带 limit）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({
    executor,
    now: fixedNow,
    limits: { maxQueueDepth: 2 },
  });

  await service.submit(reviewRequest({ repoPath: repo }), CTX); // 占住 concurrency=1
  await service.submit(reviewRequest({ repoPath: repo }), CTX); // queued 1
  await service.submit(reviewRequest({ repoPath: repo }), CTX); // queued 2
  await expect(service.submit(reviewRequest({ repoPath: repo }), CTX)).rejects.toMatchObject({
    code: -32002,
    data: { limit: 2 },
  });
});

test("list：提交倒序 + status 过滤", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  const first = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  const second = await service.submit(
    reviewRequest({ caseId: "VUL4J-2", repoPath: repo }),
    CTX,
  );
  const third = await service.submit(
    reviewRequest({ caseId: "VUL4J-3", repoPath: repo }),
    CTX,
  );
  await flushAsync();

  // 此刻：first running（fake 挂起不结算），second/third queued——get/list 异步化后
  // 不再依赖同步快照时机，挂起态一次断言（settle 不会在让点间自发推进）
  expect((await service.list({}, CTX)).jobs.map((job) => job.caseId)).toEqual([
    "VUL4J-3",
    "VUL4J-2",
    "VUL4J-1",
  ]);
  expect((await service.list({ status: "queued" }, CTX)).jobs.map((job) => job.caseId)).toEqual([
    "VUL4J-3",
    "VUL4J-2",
  ]);
  expect((await service.list({ status: "running" }, CTX)).jobs.map((job) => job.caseId)).toEqual([
    "VUL4J-1",
  ]);
  expect((await service.list({}, CTX)).jobs.map((job) => job.jobId)).toEqual([
    third.jobId,
    second.jobId,
    first.jobId,
  ]);
});

test("concurrency 2：两个 job 同时 running（v1 默认 1，显式配置可放开）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow, concurrency: 2 });

  await service.submit(reviewRequest({ repoPath: repo }), CTX);
  await service.submit(reviewRequest({ caseId: "VUL4J-2", repoPath: repo }), CTX);
  await flushAsync();

  expect(executor.executions).toHaveLength(2);
  const statuses = (await service.list({}, CTX))
    .jobs.map((job) => job.status)
    .sort();
  expect(statuses).toEqual(["running", "running"]);
});

test("终态 view 不携带 progress（spec §6.1：progress 仅 running/cancelling 存在）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  const events: ReviewJobEvent[] = [];
  service.subscribe((event) => events.push(event), CTX);

  const submitted = await service.submit(reviewRequest({ repoPath: repo }), CTX);
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
  expect((await service.get(submitted.jobId, CTX))?.progress).toBeUndefined();
});

test("close 与 submit 竞速：drain 落定后迟到入队的 job 不开工、收 -32010（S2 后果：不先跑真内核再 abort）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  await service.submit(reviewRequest({ repoPath: repo }), CTX); // A running 占住并发
  // B 的 submit 已过第一道 draining 门、挂在路径解析 await 上
  const lateSubmit = service.submit(
    reviewRequest({ caseId: "VUL4J-2", repoPath: repo }),
    CTX,
  );
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

  await service.submit(reviewRequest({ repoPath: repo }), CTX); // running 挂起
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

test("租户隔离：get→undefined、cancel→-32001、list 不见——越权统一 not found 不泄漏存在性", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  const owner = tenantCtx("tenant-a");
  const intruder = tenantCtx("tenant-b");

  const submitted = await service.submit(reviewRequest({ repoPath: repo }), owner);
  await flushAsync();

  // 异租户：与 unknown jobId 同一面——undefined / -32001 / 空 list
  expect(await service.get(submitted.jobId, intruder)).toBeUndefined();
  await expect(service.cancel(submitted.jobId, intruder)).rejects.toMatchObject({
    code: -32001,
    data: { jobId: submitted.jobId },
  });
  expect((await service.list({}, intruder)).jobs).toEqual([]);

  // 属主租户不受影响
  expect((await service.get(submitted.jobId, owner))?.status).toBe("running");
  expect((await service.list({}, owner)).jobs.map((job) => job.jobId)).toEqual([
    submitted.jobId,
  ]);
});

test("租户隔离（事件面）：异租户订阅不收本租户 job 事件——subscribe 与 get/list/cancel 同隔离口径", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  const owner = tenantCtx("tenant-a");
  const intruder = tenantCtx("tenant-b");

  const ownerEvents: ReviewJobEvent[] = [];
  const intruderEvents: ReviewJobEvent[] = [];
  service.subscribe((event) => ownerEvents.push(event), owner);
  service.subscribe((event) => intruderEvents.push(event), intruder);

  const submitted = await service.submit(reviewRequest({ repoPath: repo }), owner);
  executor.executions[0]!.resolve(fakeReviewRunSummary());
  await flushAsync();

  expect(ownerEvents.length).toBeGreaterThanOrEqual(2); // running + succeeded
  expect(ownerEvents.every((event) => event.job.jobId === submitted.jobId)).toBe(true);
  expect(intruderEvents).toEqual([]); // 事件不越租户（HTTP #28 多宿主前提）
});

test("事件 per-job seq：双 job 并发交错推进，各自 seq 从 1 独立计数（ADR-0013 中性后果项）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow, concurrency: 2 });
  const events: ReviewJobEvent[] = [];
  service.subscribe((event) => events.push(event), CTX);

  const a = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  const b = await service.submit(
    reviewRequest({ caseId: "VUL4J-2", repoPath: repo }),
    CTX,
  );
  await flushAsync();

  // 交错推进：A 进度、B 进度、A 终态、B 终态
  executor.executions[0]!.ctx.onProgress!({ phase: "Deep Reasoning", round: 1, toolCalls: 1 });
  executor.executions[1]!.ctx.onProgress!({ phase: "Deep Reasoning", round: 1, toolCalls: 1 });
  executor.executions[0]!.resolve(fakeReviewRunSummary());
  executor.executions[1]!.resolve(fakeReviewRunSummary());
  await flushAsync();

  const byJob = (jobId: string) => events.filter((event) => event.job.jobId === jobId);
  expect(byJob(a.jobId).map((event) => [event.seq, event.job.status])).toEqual([
    [1, "running"],
    [2, "running"],
    [3, "succeeded"],
  ]);
  expect(byJob(b.jobId).map((event) => [event.seq, event.job.status])).toEqual([
    [1, "running"],
    [2, "running"],
    [3, "succeeded"],
  ]);
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
  }, CTX);
  unsubscribeSecond = service.subscribe((event) => received.push(event.seq), CTX);

  const submitted = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  await flushAsync();
  expect(received).toEqual([1]); // 本轮快照仍送达

  executor.executions[0]!.resolve(fakeReviewRunSummary());
  await flushAsync();
  expect(received).toEqual([1]); // 后续事件不再送达
  expect((await service.get(submitted.jobId, CTX))?.status).toBe("succeeded");
});

// ---- #29 P2b：per-job 事件日志（SSE Last-Event-ID 重放的单源）+ 产物定位 ----

test("readEvents：afterSeq 之后事件重放（SSE Last-Event-ID 同口径）；未知 job / 异租户 → undefined", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  const submitted = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  await flushAsync(); // running（seq 1）已发
  executor.executions[0]!.resolve(fakeReviewRunSummary({ runId: "run-1" }));
  await flushAsync(); // succeeded（seq 2）已发

  // 从头重放（fresh 连接 = afterSeq 0）
  const fromStart = await service.readEvents(submitted.jobId, 0, CTX);
  expect(fromStart?.kind).toBe("replay");
  if (fromStart?.kind === "replay") {
    expect(fromStart.events.map((event) => [event.seq, event.job.status])).toEqual([
      [1, "running"],
      [2, "succeeded"],
    ]);
  }
  // 断线位 = 1：只补 seq 2
  const afterOne = await service.readEvents(submitted.jobId, 1, CTX);
  expect(afterOne?.kind).toBe("replay");
  if (afterOne?.kind === "replay") {
    expect(afterOne.events.map((event) => event.seq)).toEqual([2]);
  }
  // 已到最新：空重放——进入纯 live
  const upToDate = await service.readEvents(submitted.jobId, 2, CTX);
  expect(upToDate).toEqual({ kind: "replay", events: [] });
  // 超前位（调用方持错位/旧实例 id）：判 gap → reset + 最新快照重建（按空重放
  // 处理会叠加 SSE 投递护栏，静默饿死后续全部 live 事件）
  const ahead = await service.readEvents(submitted.jobId, 99, CTX);
  expect(ahead).toEqual({
    kind: "gap",
    snapshot: {
      seq: 2,
      job: expect.objectContaining({ jobId: submitted.jobId, status: "succeeded" }),
    },
  });

  // 未知 job / 异租户 → undefined（越权统一 not found）
  expect(await service.readEvents("job-does-not-exist", 0, CTX)).toBeUndefined();
  expect(await service.readEvents(submitted.jobId, 0, tenantCtx("tenant-b"))).toBeUndefined();
});

test("readEvents：事件清理后无法连续重放 → gap + 最新快照（memory store 保留上限；#30 SQLite 保留窗口同语义）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  // 上限 1：只留最新一条（seq 1 的 running 即被清理）
  const service = createReviewService({ executor, now: fixedNow, maxJobEvents: 1 });

  const submitted = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  await flushAsync();
  const summary = fakeReviewRunSummary({ runId: "run-1" });
  executor.executions[0]!.resolve(summary);
  await flushAsync();

  // afterSeq 0 需要 seq 1（已清理）→ gap，快照 = 当前 view 盖当前 seq 章
  const gapped = await service.readEvents(submitted.jobId, 0, CTX);
  expect(gapped?.kind).toBe("gap");
  if (gapped?.kind === "gap") {
    expect(gapped.snapshot.seq).toBe(2);
    expect(gapped.snapshot.job.status).toBe("succeeded");
    expect(gapped.snapshot.job.result).toEqual(summary);
  }
  // afterSeq 落在保留窗内（= 最新事件 seq）→ 正常重放
  const covered = await service.readEvents(submitted.jobId, 1, CTX);
  expect(covered?.kind).toBe("replay");
  if (covered?.kind === "replay") {
    expect(covered.events.map((event) => event.seq)).toEqual([2]);
  }
});

test("artifacts：succeeded 带双路径 + finishedAtMs；running 缺席；queued→cancelled 终态也落 finishedAtMs", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });

  const submitted = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  await flushAsync(); // running

  // 非终态：无路径、无落定时刻（保留窗口判定不适用）
  expect(await service.artifacts(submitted.jobId, CTX)).toEqual({ status: "running" });

  const summary = fakeReviewRunSummary({
    runId: "run-1",
    auditPath: "/srv/audit/run-1.json",
    recordPath: "/srv/record/run-1.json",
  });
  executor.executions[0]!.resolve(summary);
  await flushAsync();

  expect(await service.artifacts(submitted.jobId, CTX)).toEqual({
    status: "succeeded",
    auditPath: "/srv/audit/run-1.json",
    recordPath: "/srv/record/run-1.json",
    finishedAtMs: FIXED_DATE.getTime(),
  });

  // 未知 job / 异租户 → undefined
  expect(await service.artifacts("job-does-not-exist", CTX)).toBeUndefined();
  expect(await service.artifacts(submitted.jobId, tenantCtx("tenant-b"))).toBeUndefined();

  // queued → cancelled（drain / 显式取消）同样落 finishedAtMs：并发位被首个
  // running job 占满，第二个 job 滞留 queued 后取消走直接出队分支
  const blockingExecutor = new FakeReviewRunExecutor();
  const blocking = createReviewService({ executor: blockingExecutor, now: fixedNow });
  await blocking.submit(reviewRequest({ repoPath: repo }), CTX); // 占位 running（不 resolve）
  await flushAsync();
  const queued = await blocking.submit(reviewRequest({ caseId: "VUL4J-2", repoPath: repo }), CTX);
  await blocking.cancel(queued.jobId, CTX);
  expect(await blocking.artifacts(queued.jobId, CTX)).toEqual({
    status: "cancelled",
    finishedAtMs: FIXED_DATE.getTime(),
  });
});

// ---- #31 P3b：排队/执行超时自动终态化 + drain 超时硬收口 + 仓库规模准入 ----

test("queueTimeout：queued 超时 → failed(-32018) 出队不再开工；running 位不受影响", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow, queueTimeoutMs: 60 });
  const running = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  await flushAsync(); // job1 占住并发位（fake 挂起）
  const queued = await service.submit(
    reviewRequest({ caseId: "VUL4J-2", repoPath: repo }),
    CTX,
  );
  expect(queued.status).toBe("queued");

  await new Promise((resolve) => setTimeout(resolve, 250));

  // 排队超时自动终态化：死单不无限占用队列位
  const timedOut = await service.get(queued.jobId, CTX);
  expect(timedOut?.status).toBe("failed");
  expect(timedOut?.error?.message).toBe("job exceeded queueTimeout (-32018 QUEUE_TIMEOUT)");
  // running 位不受波及
  expect((await service.get(running.jobId, CTX))?.status).toBe("running");

  // running 落定后不补跑已终态的 queued（出队即出局）
  executor.executions[0]!.resolve(fakeReviewRunSummary());
  await flushAsync();
  expect(executor.executions).toHaveLength(1);
});

test("jobTimeout：running 超时 → abort + failed(-32014)；迟到 resolve 不翻案（终态不可逆）", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow, jobTimeoutMs: 60 });
  const submitted = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  await flushAsync();
  const execution = executor.executions[0]!;
  expect(execution.ctx.signal.aborted).toBe(false);

  await new Promise((resolve) => setTimeout(resolve, 250));

  const timedOut = await service.get(submitted.jobId, CTX);
  expect(timedOut?.status).toBe("failed");
  expect(timedOut?.error?.message).toBe("job exceeded jobTimeout (-32014 JOB_TIMEOUT)");
  // 超时即打 abort（协作取消缝——worker 池面据此走宽限→terminate 硬边界）
  expect(execution.ctx.signal.aborted).toBe(true);

  // 迟到成功不翻案：终态护栏吞掉晚到的 executor 结算
  execution.resolve(fakeReviewRunSummary());
  await flushAsync();
  const late = await service.get(submitted.jobId, CTX);
  expect(late?.status).toBe("failed");
  expect(late?.result).toBeUndefined();
});

test("drain 超时：close 等 running 超drainTimeoutMs 未落定 → force cancelled(SERVER_DRAIN)，close 落定不悬挂", async () => {
  const repo = await makeTmpDir();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow, drainTimeoutMs: 60 });
  const submitted = await service.submit(reviewRequest({ repoPath: repo }), CTX);
  await flushAsync();

  await service.close(); // 不等 fake 落定——超时路径必须让 close 自己收口

  const drained = await service.get(submitted.jobId, CTX);
  expect(drained?.status).toBe("cancelled");
  // SERVER_DRAIN 理由进 error.message（机读码嵌文案，SERVER_RESTART 同款纪律）
  expect(drained?.error?.message).toBe("job cancelled by server drain (-32010 SERVER_DRAIN)");
  expect(executor.executions[0]!.ctx.signal.aborted).toBe(true);

  // 迟到错误不翻案
  executor.executions[0]!.reject(new Error("late failure"));
  await flushAsync();
  expect((await service.get(submitted.jobId, CTX))?.status).toBe("cancelled");
});

test("repo 准入：超 maxRepoFiles → -32004（data 带 maxRepoFiles）；点开头目录（.git 等）不计入", async () => {
  const repo = await makeTmpDir();
  for (let i = 0; i < 3; i += 1) {
    await writeFile(join(repo, `f${i}.txt`), "x", "utf8");
  }
  await mkdir(join(repo, ".git"), { recursive: true });
  for (let i = 0; i < 10; i += 1) {
    await writeFile(join(repo, ".git", `object-${i}`), "x", "utf8");
  }

  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({
    executor,
    now: fixedNow,
    limits: { maxRepoFiles: 2 },
  });
  await expect(service.submit(reviewRequest({ repoPath: repo }), CTX)).rejects.toMatchObject({
    code: -32004,
    data: { maxRepoFiles: 2 },
  });
  expect(executor.executions).toHaveLength(0);

  // 门槛内（.git 10 文件不计）→ 正常受理
  const serviceWithin = createReviewService({
    executor,
    now: fixedNow,
    limits: { maxRepoFiles: 5 },
  });
  const view = await serviceWithin.submit(reviewRequest({ repoPath: repo }), CTX);
  expect(view.status).toBe("queued");
});

test("repo 准入：超 maxRepoBytes → -32004（data 带 maxRepoBytes）", async () => {
  const repo = await makeTmpDir();
  await writeFile(join(repo, "big.txt"), "x".repeat(2000), "utf8");

  const service = createReviewService({
    executor: new FakeReviewRunExecutor(),
    now: fixedNow,
    limits: { maxRepoBytes: 1024 },
  });
  await expect(service.submit(reviewRequest({ repoPath: repo }), CTX)).rejects.toMatchObject({
    code: -32004,
    data: { maxRepoBytes: 1024 },
  });
});

test("超时/准入缺省值锁定（soak 标定落档——调整须有意识决策）：queue 30min / job 60min / drain 60s / repo 20k 文件 512MiB", () => {
  const service = createReviewService({ executor: new FakeReviewRunExecutor() });
  expect(service.limits.maxRepoFiles).toBe(20_000);
  expect(service.limits.maxRepoBytes).toBe(512 * 1024 * 1024);
});
