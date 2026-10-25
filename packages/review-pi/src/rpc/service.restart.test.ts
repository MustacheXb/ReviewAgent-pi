/**
 * #30 P3a：service × SQLite store 的重启恢复集成面（issue #30 验收：
 * 「服务重启后 queued 作业自动重入队执行、running / cancelling 作业标记
 * failed（-32015 SERVER_RESTART）不假装续跑；SSE 事件日志持久化使
 * Last-Event-ID 跨重启重放成立；jobId 生成跨重启防碰撞」）。
 *
 * 崩溃语义模拟：serviceA 直接弃（不 close drain——进程被杀，store 落在
 * 最后写入态）；serviceB 携同 dataDir 新 store 实例构造 = 重启。全程
 * FakeReviewRunExecutor 驱动（进程级真崩溃面在 restart.process.test.ts）。
 */

import { realpathSync } from "node:fs";
import { afterAll, expect, test } from "vitest";

import { FakeReviewRunExecutor, fakeReviewRunSummary } from "./executor.js";
import { localCallContext, type CallContext } from "./context.js";
import type { ReviewRequest } from "./protocol.js";
import { SERVER_RESTART_MESSAGE, createReviewService, type ReviewJobEvent } from "./service.js";
import { createSqliteReviewJobStore, type SqliteJobStoreOptions } from "./sqlite-store.js";
import { createTempDirRegistry } from "../testing/temp-dir.js";

/** 固定时钟：跨实例 startMs 相同——jobId 防碰撞只能靠持久计数器（回归面刻意压满） */
const BOOT_A = new Date("2026-10-25T00:00:00.000Z");
const BOOT_B = new Date("2026-10-25T00:00:00.000Z"); // 同毫秒「重启」（时钟回拨面）
const nowOf = (date: Date) => () => date;

const CTX: CallContext = localCallContext("req-restart");

const tempDirs = createTempDirRegistry();

function makeDataDir(): string {
  return tempDirs.makeTempDir("review-pi-restart-");
}

function makeRepoDir(): string {
  return realpathSync(tempDirs.makeTempDir("review-pi-restart-repo-"));
}

afterAll(() => {
  tempDirs.removeAll();
});

function restartRequest(repo: string, overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    caseId: "VUL4J-1",
    repoPath: repo,
    diff: { kind: "inline", text: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n" },
    configId: "E",
    ...overrides,
  };
}

/** 冲刷微任务链（恢复入队的 pump / 事件发射均在微任务） */
const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("恢复：running 作业 → failed（-32015 SERVER_RESTART，不假装续跑）", async () => {
  const dataDir = makeDataDir();
  const repo = makeRepoDir();
  const executorA = new FakeReviewRunExecutor();
  const serviceA = createReviewService({
    executor: executorA,
    store: createSqliteReviewJobStore({ dataDir }),
    now: nowOf(BOOT_A),
  });
  const submitted = await serviceA.submit(restartRequest(repo), CTX);
  await flushAsync(); // running（fake 挂起中）
  // 崩溃：serviceA 直接弃（无 close drain）

  const executorB = new FakeReviewRunExecutor();
  const serviceB = createReviewService({
    executor: executorB,
    store: createSqliteReviewJobStore({ dataDir }),
    now: nowOf(BOOT_B),
  });
  await flushAsync();

  const view = await serviceB.get(submitted.jobId, CTX);
  expect(view?.status).toBe("failed");
  expect(view?.error?.message).toBe(SERVER_RESTART_MESSAGE);
  // 不假装续跑：B 的 executor 只收到恢复入队的 job（本用例无 queued，零执行）
  expect(executorB.executions).toHaveLength(0);
});

test("恢复：queued 作业自动重入队执行——执行输入从 store 完整恢复（diff/issue 全文）", async () => {
  const dataDir = makeDataDir();
  const repo = makeRepoDir();
  const executorA = new FakeReviewRunExecutor();
  const serviceA = createReviewService({
    executor: executorA,
    store: createSqliteReviewJobStore({ dataDir }),
    now: nowOf(BOOT_A),
  });
  // job1 占住并发位（running，fake 挂起）→ job2 滞留 queued
  await serviceA.submit(restartRequest(repo, { caseId: "CASE-RUNNING" }), CTX);
  await flushAsync();
  await serviceA.submit(
    restartRequest(repo, {
      caseId: "CASE-QUEUED",
      issueDescription: "恢复面 issue 全文",
      modelId: "model-x",
    }),
    CTX,
  );
  // 崩溃

  const executorB = new FakeReviewRunExecutor();
  const serviceB = createReviewService({
    executor: executorB,
    store: createSqliteReviewJobStore({ dataDir }),
    now: nowOf(BOOT_B),
  });
  await flushAsync();

  // job2（queued）重入队并开工——A 的 running job 不再执行
  expect(executorB.executions).toHaveLength(1);
  const execution = executorB.executions[0]!;
  expect(execution.request.caseId).toBe("CASE-QUEUED");
  expect(execution.request.repoPath).toBe(repo); // realpath 后原样恢复
  expect(execution.request.diff).toBe("--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n");
  expect(execution.request.issueDescription).toBe("恢复面 issue 全文");
  expect(execution.request.modelId).toBe("model-x");
  expect(execution.ctx.jobId).toBe(`job-${BOOT_A.getTime()}-2`);

  // 重入队的 job 正常跑完（恢复链路全通）
  execution.resolve(fakeReviewRunSummary({ runId: "run-recovered" }));
  await flushAsync();
  const recovered = await serviceB.get(`job-${BOOT_A.getTime()}-2`, CTX);
  expect(recovered?.status).toBe("succeeded");
  expect(recovered?.result?.runId).toBe("run-recovered");
});

test("恢复：cancelling 作业 → failed（-32015；abort 中的取消不跨重启假装继续）", async () => {
  const dataDir = makeDataDir();
  const repo = makeRepoDir();
  const executorA = new FakeReviewRunExecutor();
  const serviceA = createReviewService({
    executor: executorA,
    store: createSqliteReviewJobStore({ dataDir }),
    now: nowOf(BOOT_A),
  });
  const submitted = await serviceA.submit(restartRequest(repo), CTX);
  await flushAsync();
  await serviceA.cancel(submitted.jobId, CTX); // running → cancelling（fake 挂起）
  // 崩溃

  const serviceB = createReviewService({
    executor: new FakeReviewRunExecutor(),
    store: createSqliteReviewJobStore({ dataDir }),
    now: nowOf(BOOT_B),
  });
  const view = await serviceB.get(submitted.jobId, CTX);
  expect(view?.status).toBe("failed");
  expect(view?.error?.message).toBe(SERVER_RESTART_MESSAGE);
});

test("恢复：SSE 事件日志跨重启补齐——readEvents(afterSeq=1) 重放 failed 转移事件", async () => {
  const dataDir = makeDataDir();
  const repo = makeRepoDir();
  const executorA = new FakeReviewRunExecutor();
  const serviceA = createReviewService({
    executor: executorA,
    store: createSqliteReviewJobStore({ dataDir }),
    now: nowOf(BOOT_A),
  });
  const submitted = await serviceA.submit(restartRequest(repo), CTX);
  await flushAsync(); // seq=1 running 已持久
  // 崩溃

  const serviceB = createReviewService({
    executor: new FakeReviewRunExecutor(),
    store: createSqliteReviewJobStore({ dataDir }),
    now: nowOf(BOOT_B),
  });

  // 客户端持 Last-Event-ID: 1 重连——补发重启失败转移（seq=2 failed）
  const replay = await serviceB.readEvents(submitted.jobId, 1, CTX);
  expect(replay?.kind).toBe("replay");
  const events = replay?.kind === "replay" ? replay.events : [];
  expect(events.map((event: ReviewJobEvent) => [event.seq, event.job.status])).toEqual([
    [2, "failed"],
  ]);
  expect(events[0]?.job.error?.message).toBe(SERVER_RESTART_MESSAGE);

  // 零位重连（无 Last-Event-ID）：全量重放（running → failed）
  const full = await serviceB.readEvents(submitted.jobId, 0, CTX);
  const fullEvents = full?.kind === "replay" ? full.events : [];
  expect(fullEvents.map((event: ReviewJobEvent) => [event.seq, event.job.status])).toEqual([
    [1, "running"],
    [2, "failed"],
  ]);
});

test("恢复：重入队 job 的事件 seq 延续（重启前零事件 → 续跑后首事件 seq=1）", async () => {
  const dataDir = makeDataDir();
  const repo = makeRepoDir();
  const executorA = new FakeReviewRunExecutor();
  const serviceA = createReviewService({
    executor: executorA,
    store: createSqliteReviewJobStore({ dataDir }),
    now: nowOf(BOOT_A),
  });
  await serviceA.submit(restartRequest(repo, { caseId: "CASE-RUNNING" }), CTX);
  await flushAsync();
  await serviceA.submit(restartRequest(repo, { caseId: "CASE-QUEUED" }), CTX);
  // 崩溃（queued job 零事件——submit 入队不发事件）

  const executorB = new FakeReviewRunExecutor();
  const serviceB = createReviewService({
    executor: executorB,
    store: createSqliteReviewJobStore({ dataDir }),
    now: nowOf(BOOT_B),
  });
  await flushAsync();

  const replay = await serviceB.readEvents(`job-${BOOT_A.getTime()}-2`, 0, CTX);
  const events = replay?.kind === "replay" ? replay.events : [];
  expect(events.map((event: ReviewJobEvent) => [event.seq, event.job.status])).toEqual([
    [1, "running"], // 重入队开工的首事件（seq 从 1 起——该 job 重启前零事件）
  ]);
});

test("恢复：jobId 跨重启防碰撞——同 startMs 重启后续号延续", async () => {
  const dataDir = makeDataDir();
  const repo = makeRepoDir();
  const storeOptions: SqliteJobStoreOptions = { dataDir };
  const serviceA = createReviewService({
    executor: new FakeReviewRunExecutor(),
    store: createSqliteReviewJobStore(storeOptions),
    now: nowOf(BOOT_A),
  });
  await serviceA.submit(restartRequest(repo, { caseId: "CASE-1" }), CTX);
  await serviceA.submit(restartRequest(repo, { caseId: "CASE-2" }), CTX);
  // 崩溃

  const serviceB = createReviewService({
    executor: new FakeReviewRunExecutor(),
    store: createSqliteReviewJobStore(storeOptions),
    now: nowOf(BOOT_B), // 同 startMs（时钟回拨面）
  });
  const submitted = await serviceB.submit(restartRequest(repo, { caseId: "CASE-3" }), CTX);
  expect(submitted.jobId).toBe(`job-${BOOT_A.getTime()}-3`); // 不与 A 的 1/2 撞
});

test("恢复：list 跨重启可见全部历史 job（含终态）——恢复标记先于任何查询", async () => {
  const dataDir = makeDataDir();
  const repo = makeRepoDir();
  const executorA = new FakeReviewRunExecutor();
  const serviceA = createReviewService({
    executor: executorA,
    store: createSqliteReviewJobStore({ dataDir }),
    now: nowOf(BOOT_A),
  });
  await serviceA.submit(restartRequest(repo, { caseId: "CASE-RUNNING" }), CTX);
  await flushAsync();
  await serviceA.submit(restartRequest(repo, { caseId: "CASE-QUEUED" }), CTX);
  // 崩溃

  const serviceB = createReviewService({
    executor: new FakeReviewRunExecutor(),
    store: createSqliteReviewJobStore({ dataDir }),
    now: nowOf(BOOT_B),
  });
  // 构造期恢复已同步完成（不 flush）：running → failed 已标记；queued 重入队
  // 但 pump 在微任务——状态仍 queued
  const page = await serviceB.list({}, CTX);
  expect(page.jobs.map((job) => [job.caseId, job.status])).toEqual([
    ["CASE-QUEUED", "queued"],
    ["CASE-RUNNING", "failed"],
  ]);

  // 异租户不可见（越权统一 not found 口径跨重启不变）
  const otherTenant: CallContext = {
    principal: { tenantId: "other", subject: "s", scopes: [] },
    requestId: "req-other",
  };
  expect((await serviceB.list({}, otherTenant)).jobs).toEqual([]);
  expect(await serviceB.get(`job-${BOOT_A.getTime()}-1`, otherTenant)).toBeUndefined();
  expect(await serviceB.readEvents(`job-${BOOT_A.getTime()}-1`, 0, otherTenant)).toBeUndefined();
});

test("恢复：跨重启历史终态 job 的 cancel 幂等返回 view（与 get 双读同口径，不当 Unknown job）", async () => {
  const dataDir = makeDataDir();
  const repo = makeRepoDir();
  const executorA = new FakeReviewRunExecutor();
  const serviceA = createReviewService({
    executor: executorA,
    store: createSqliteReviewJobStore({ dataDir }),
    now: nowOf(BOOT_A),
  });
  const submitted = await serviceA.submit(restartRequest(repo), CTX);
  await flushAsync();
  executorA.executions[0]!.resolve(fakeReviewRunSummary()); // succeeded 落定（write-through 持久）
  await flushAsync();
  // 崩溃（终态 job 不进重启实例的内存 Map——store-only 路径）

  const serviceB = createReviewService({
    executor: new FakeReviewRunExecutor(),
    store: createSqliteReviewJobStore({ dataDir }),
    now: nowOf(BOOT_B),
  });
  // cancel 与 get 同口径可查：终态幂等返回当前 view（进程内语义跨重启不变）
  const view = await serviceB.cancel(submitted.jobId, CTX);
  expect(view.status).toBe("succeeded");
  expect(view.result?.runId).toBe("run-fake-1");

  // 越权 / 未知 job 仍 -32001（异租户与不存在同面）
  const otherTenant: CallContext = {
    principal: { tenantId: "other", subject: "s", scopes: [] },
    requestId: "req-other",
  };
  await expect(serviceB.cancel(submitted.jobId, otherTenant)).rejects.toMatchObject({
    code: -32001,
  });
  await expect(serviceB.cancel("job-unknown", CTX)).rejects.toMatchObject({ code: -32001 });
});
