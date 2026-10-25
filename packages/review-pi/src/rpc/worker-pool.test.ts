import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import type { ConfigId } from "../contracts/config.js";
import { createTempDirRegistry } from "../testing/temp-dir.js";
import { ReviewAbortedError } from "../run/review-run.js";
import { ReviewExecutionError } from "./executor.js";
import type { ReviewRunContext, ReviewRunProgress, ReviewRunRequest } from "./executor.js";
import { DEFAULT_ABORT_GRACE_MS, WorkerPoolReviewExecutor } from "./worker-pool.js";

// #31 P3b worker 池适配器测试（issue #31 AC：「与 in-process executor 同构」的
// 池侧专测面——同契约套在 executor.contract.test.ts 与 in-process 双跑）：
// - 并发隔离：池大小 2 时并发 job 落在不同 worker 线程、后续 job 复用线程不
//   增殖——「每 worker 独立 parser 状态」的线程级外部证据（worker_threads
//   各自独立 V8 isolate，模块态天然隔离；印记经 summary.runId 回传）；
// - 硬取消专测：worker 无视 abort（协作取消失效面）→ 宽限 → terminate →
//   execute 以 ReviewAbortedError 收场（取消不是失败）+ 池补齐替换 worker；
// - worker 崩溃：在飞 job 以合同错误收场（generic 文案 + 诊断走 sink），
//   替换后池继续可用；
// - 错误/进度/预中止/close 语义：与 in-process executor 端口契约对齐。
//
// 替身：caseId 驱动的假 worker 入口（真 Worker 线程跑协议、行为按 caseId
// 分派）——不 import 内核，专测池的传输/生命周期/硬边界，不测执行本身。

const tempDirs = createTempDirRegistry();
afterAll(() => {
  tempDirs.removeAll();
});

/**
 * 假 worker 入口（.mjs——独立 V8 isolate，协议与真入口 worker-entry.ts 同形）。
 * 行为按 request.caseId 分派：
 * - HANG：回执 diagnostic 后挂死（协作取消失效面——硬取消/宽限专测）；
 * - CRASH：process.exit(3)（worker 意外退出面——崩溃替换专测；worker 线程
 *   内 process.exit 只退本线程）；
 * - FAIL：发 diagnostic + failed(execution) 报告（错误合同重建面）；
 * - PROGRESS：两帧 progress 后 done（进度透传面）；
 * - 其余：保持 ~60ms 后 done + summary.runId = `thread-<threadId>`（线程印记；
 *   保持期让并发 job 真正时间重叠——池才能证明「并发 → 不同线程」，秒回 stub
 *   会让第二个 job 合法复用第一个刚释放的线程）。
 * init 时在 state 目录落 marker 文件（外部可观测「worker 已创建」信号）。
 */
const FAKE_ENTRY_SOURCE = `
import { parentPort, threadId } from "node:worker_threads";
import { writeFileSync } from "node:fs";
const port = parentPort;
if (port === null) throw new Error("fake entry must run as a worker thread");
const stateDir = process.env.REVIEWAGENT_POOL_TEST_STATE ?? ".";
const ZERO = { inputTokens: 0, outputTokens: 0 };
port.on("message", (command) => {
  if (command.kind === "init") {
    writeFileSync(\`\${stateDir}/init-\${threadId}.marker\`, String(threadId), "utf8");
    port.postMessage({ kind: "ready" });
    return;
  }
  if (command.kind === "abort") return; // 无视协作取消（硬取消面）
  if (command.kind !== "execute") return;
  const caseId = command.request.caseId;
  const jobId = command.jobId;
  if (caseId === "HANG") {
    port.postMessage({ kind: "diagnostic", message: "fake-entry: HANG received" });
    return; // 挂死：永不回 done/failed
  }
  if (caseId === "CRASH") {
    process.exit(3);
    return;
  }
  if (caseId === "FAIL") {
    port.postMessage({ kind: "diagnostic", message: "stub diagnostic for FAIL" });
    port.postMessage({ kind: "failed", jobId, failure: { kind: "execution", publicMessage: "review execution failed", diagnosticMessage: "stub diagnostic for FAIL" } });
    return;
  }
  if (caseId === "PROGRESS") {
    port.postMessage({ kind: "progress", jobId, progress: { phase: "phase-1", round: 1, toolCalls: 0, usage: ZERO } });
    port.postMessage({ kind: "progress", jobId, progress: { phase: "phase-2", round: 1, toolCalls: 2, usage: ZERO } });
    port.postMessage({ kind: "done", jobId, summary: { runId: "run-progress", findings: [], usage: ZERO, rounds: 2, toolCalls: 2, truncated: false, auditPath: "audit-stub.json", recordPath: "record-stub.json" } });
    // 迟到帧专设（#31 审查修复 pin）：done 之后的 stale progress——池侧
    // 全帧 jobId 校验必须静默丢弃（onProgress 不得多收第三帧）
    port.postMessage({ kind: "progress", jobId: "stale-" + jobId, progress: { phase: "phase-stale", round: 9, toolCalls: 0, usage: ZERO } });
    return;
  }
  setTimeout(() => {
    port.postMessage({ kind: "done", jobId, summary: { runId: "thread-" + threadId, findings: [], usage: ZERO, rounds: 1, toolCalls: 0, truncated: false, auditPath: "audit-stub.json", recordPath: "record-stub.json" } });
  }, 60);
});
`;

interface PoolFixture {
  readonly pool: WorkerPoolReviewExecutor;
  readonly stateDir: string;
  readonly diagnostics: string[];
}

/** 装配被测池：假入口 + 短宽限（80ms）+ 诊断收集；state 目录供 marker 观测 */
function makePool(overrides: { readonly size?: number } = {}): PoolFixture {
  const stateDir = tempDirs.makeTempDir("rpc-worker-pool-state-");
  const entryDir = tempDirs.makeTempDir("rpc-worker-pool-entry-");
  const entry = path.join(entryDir, "fake-entry.mjs");
  writeFileSync(entry, FAKE_ENTRY_SOURCE, "utf8");
  const diagnostics: string[] = [];
  const pool = new WorkerPoolReviewExecutor({
    size: overrides.size ?? 2,
    workerEntry: entry,
    runsRoot: stateDir,
    abortGraceMs: 80,
    env: { ...process.env, REVIEWAGENT_POOL_TEST_STATE: stateDir },
    onDiagnostic: (message) => {
      diagnostics.push(message);
    },
  });
  return { pool, stateDir, diagnostics };
}

function request(caseId: string): ReviewRunRequest {
  return {
    caseId,
    repoPath: "unused-by-fake-entry",
    diff: "--- a\n+++ b\n",
    issueDescription: "",
    configId: "A" as ConfigId,
  };
}

function ctx(jobId: string, signal?: AbortSignal, onProgress?: (p: ReviewRunProgress) => void): ReviewRunContext {
  return {
    jobId,
    signal: signal ?? new AbortController().signal,
    ...(onProgress !== undefined ? { onProgress } : {}),
  };
}

/** 等到池的 in-flight 派发面就绪（替身回执 diagnostic 即「execute 已达 worker」） */
async function waitForDiagnostic(diagnostics: string[], needle: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (diagnostics.some((message) => message.includes(needle))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`diagnostic "${needle}" not seen within ${timeoutMs}ms; got: ${diagnostics.join(" | ")}`);
}

test("缺省 abort 宽限 = 10s 契约 pin（方案 §7.1「约 10s」——测试注入小值跑时序，生产缺省不漂移）", () => {
  expect(DEFAULT_ABORT_GRACE_MS).toBe(10_000);
});

test("池大小 2：并发 job 落在不同 worker 线程，后续 job 复用线程不增殖（每 worker 独立 parser 状态的线程级证据）", async () => {
  const { pool } = makePool();
  try {
    const first = await Promise.all([
      pool.execute(request("T1"), ctx("job-t1")),
      pool.execute(request("T2"), ctx("job-t2")),
    ]);
    for (const summary of first) {
      expect(summary.runId).toMatch(/^thread-\d+$/);
    }
    expect(first[0]!.runId).not.toBe(first[1]!.runId); // 两个独立 isolate

    const second = await Promise.all([
      pool.execute(request("T3"), ctx("job-t3")),
      pool.execute(request("T4"), ctx("job-t4")),
    ]);
    // 池化复用：4 次 execute 只落在 2 个线程上（无增殖 = 无泄漏的池侧证据）
    const threadIds = new Set([...first, ...second].map((summary) => summary.runId));
    expect(threadIds.size).toBe(2);
  } finally {
    await pool.close();
  }
}, 30_000);

test("硬取消专测：worker 无视 abort → 宽限（80ms）→ terminate → ReviewAbortedError；池补齐替换 worker，后续 job 正常", async () => {
  const { pool, diagnostics } = makePool();
  try {
    const controller = new AbortController();
    const hanging = pool.execute(request("HANG"), ctx("job-hang", controller.signal));
    await waitForDiagnostic(diagnostics, "HANG received"); // execute 已达 worker（再 abort 才是硬取消面）

    controller.abort();
    await expect(hanging).rejects.toBeInstanceOf(ReviewAbortedError); // 取消不是失败
    // 硬边界留痕：宽限耗尽 → terminate（诊断进 sink，不进协议面）
    expect(diagnostics.some((message) => message.includes("terminated after abort grace"))).toBe(true);

    // 替换 worker 补齐：后续 job 正常完成
    const after = await pool.execute(request("T5"), ctx("job-t5"));
    expect(after.runId).toMatch(/^thread-\d+$/);
  } finally {
    await pool.close();
  }
}, 30_000);

test("worker 崩溃：在飞 job 以 ReviewExecutionError 收场（generic 文案 + 诊断进 sink）；替换后池继续可用", async () => {
  const { pool, diagnostics } = makePool();
  try {
    const crashing = pool.execute(request("CRASH"), ctx("job-crash"));
    let caught: unknown;
    try {
      await crashing;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReviewExecutionError);
    const executionError = caught as ReviewExecutionError;
    expect(executionError.publicMessage).toBe("review execution failed"); // 协议面固定 generic
    expect(executionError.message).toContain("worker thread exited"); // 诊断细节只走 Error.message/sink
    expect(diagnostics.some((message) => message.includes("worker thread exited"))).toBe(true);

    const after = await pool.execute(request("T6"), ctx("job-t6"));
    expect(after.runId).toMatch(/^thread-\d+$/);
  } finally {
    await pool.close();
  }
}, 30_000);

test("执行失败报告：worker failed(execution) → ReviewExecutionError 重建（publicMessage + 诊断双通道）", async () => {
  const { pool, diagnostics } = makePool();
  try {
    let caught: unknown;
    try {
      await pool.execute(request("FAIL"), ctx("job-fail"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReviewExecutionError);
    const executionError = caught as ReviewExecutionError;
    expect(executionError.publicMessage).toBe("review execution failed");
    expect(executionError.message).toContain("stub diagnostic for FAIL");
    expect(diagnostics.some((message) => message.includes("stub diagnostic for FAIL"))).toBe(true);
  } finally {
    await pool.close();
  }
}, 30_000);

test("progress 透传：onProgress 收到 worker 上报 + done 后迟到帧静默丢弃（全帧 jobId 校验）", async () => {
  const { pool } = makePool();
  try {
    const progress: ReviewRunProgress[] = [];
    const summary = await pool.execute(request("PROGRESS"), ctx("job-progress", undefined, (p) => progress.push(p)));
    expect(summary.runId).toBe("run-progress");
    expect(progress.map((p) => p.phase)).toEqual(["phase-1", "phase-2"]);
    // 迟到 stale 帧经消息队列必达池侧——等一拍再断言不多收（execute resolve
    // 与 stale 帧到达有竞态，此处给 100ms 排空窗口）
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(progress.map((p) => p.phase)).toEqual(["phase-1", "phase-2"]);
  } finally {
    await pool.close();
  }
}, 30_000);

test("预中止 signal：execute 时已 abort → ReviewAbortedError，不派发 worker（零线程创建）", async () => {
  const { pool, stateDir } = makePool();
  try {
    const controller = new AbortController();
    controller.abort();
    await expect(pool.execute(request("T7"), ctx("job-pre-aborted", controller.signal))).rejects.toBeInstanceOf(
      ReviewAbortedError,
    );
    // in-process 同款契约：runReview 入口即抛——池面不触 worker（init marker 为证）
    expect(existsSync(path.join(stateDir, "init-0.marker"))).toBe(false);
    expect(stateDir).toBeDefined();
  } finally {
    await pool.close();
  }
}, 30_000);

test("abort 等待位 job：未派发即中止 → ReviewAbortedError，不波及在飞 job", async () => {
  const { pool, diagnostics } = makePool({ size: 1 });
  try {
    const controller = new AbortController();
    const hanging = pool.execute(request("HANG"), ctx("job-hang-1"));
    await waitForDiagnostic(diagnostics, "HANG received"); // 唯一 worker 被 HANG 占住

    const waiting = pool.execute(request("T8"), ctx("job-waiting", controller.signal));
    controller.abort(); // 等待位中止：立即收场，不等派发
    await expect(waiting).rejects.toBeInstanceOf(ReviewAbortedError);

    // 在飞 job 不受波及（未 abort）：仍挂死（由 close 收口）
    const settled = await Promise.race([
      hanging.then(() => "settled", () => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("still-hanging"), 200)),
    ]);
    expect(settled).toBe("still-hanging");
  } finally {
    await pool.close();
  }
}, 30_000);

test("close：在飞 HANG job → abort 宽限 → terminate；close 幂等；close 后 execute 拒绝（合同错误）", async () => {
  const { pool, diagnostics } = makePool();
  const hanging = pool.execute(request("HANG"), ctx("job-hang-close"));
  await waitForDiagnostic(diagnostics, "HANG received");

  const closing = pool.close();
  await expect(hanging).rejects.toBeInstanceOf(ReviewAbortedError);
  await closing;
  await pool.close(); // 幂等：共享同一 promise，不二次抛

  let caught: unknown;
  try {
    await pool.execute(request("T9"), ctx("job-after-close"));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReviewExecutionError);
  expect((caught as ReviewExecutionError).message).toContain("closed");
}, 30_000);

test("缺省入口解析失败 → 构造期人话（候选清单 + 环境覆盖说明）", () => {
  const stateDir = tempDirs.makeTempDir("rpc-worker-pool-noentry-");
  expect(() => new WorkerPoolReviewExecutor({ size: 1, runsRoot: stateDir })).toThrow(/worker entry/);
});
