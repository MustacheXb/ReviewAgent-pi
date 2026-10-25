/**
 * #31 P3b worker 池适配器（方案 §7.1、ADR-0013 决策 7）：
 * `ReviewRunExecutor` 端口的 worker_threads 实现——生产默认（检视执行与
 * HTTP 面解耦：同步 tree-sitter 解析不再占主线程 event loop，健康检查 /
 * 提交 / 查询 / SSE 不被解析阻塞），与 in-process 适配器（KernelReviewRun
 * Executor，`--executor inprocess` 逃生口）跑同契约测试套。
 *
 * 硬取消边界（本适配器的存在理由）：abort 后协作取消宽限（缺省 ~10s）仍
 * 未收场 → `terminate()` 强制回收线程并以 ReviewAbortedError 收口（取消
 * 不是失败）；被 terminate 的 worker 由池补齐替换（池大小恒定 = 无线程
 * 泄漏）。每 worker 独立 V8 isolate——parser / 模块态天然隔离。
 *
 * 生命周期（父侧单点）：
 * - 懒启动：首个 execute 触发 spawn（idle 不占线程）；worker 常驻复用；
 * - close()：等待位 job 直接拒（合同错误）；在飞 job 发 abort 给宽限；
 *   idle worker 立即 terminate；幂等（共享同一 promise）。
 *
 * 入口解析（缺省候选序）：`REVIEWAGENT_WORKER_ENTRY` 环境覆盖 > 本模块旁
 * `./worker-entry.js`（tsc dist 形态）> 本模块旁 `./review-worker.mjs`
 * （reviewagent esbuild bundle 形态——bundle 内 import.meta.url 即 cli.mjs）。
 * 两者皆缺（如 vitest 源码态）→ 构造期人话（显式传 workerEntry）。
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { ReviewAbortedError } from "../run/review-run.js";
import { RPC_EXPERIMENT_ID, ReviewExecutionError } from "./executor.js";
import type {
  ReviewRunContext,
  ReviewRunExecutor,
  ReviewRunProgress,
  ReviewRunRequest,
  ReviewRunSummary,
} from "./executor.js";
import type { WorkerPoolCommand, WorkerPoolReport } from "./worker-protocol.js";

/** abort 后协作取消宽限（方案 §7.1「约 10s」）；导出面 = 契约 pin 测试单源 */
export const DEFAULT_ABORT_GRACE_MS = 10_000;

export interface WorkerPoolExecutorOptions {
  /** 池大小（并发 worker 数；与 service concurrency 同值接线） */
  readonly size: number;
  /** 产物落盘根（经 init 转交线程内 executor） */
  readonly runsRoot: string;
  /** worker 入口文件；缺省自动解析（见模块注候选序） */
  readonly workerEntry?: string | URL;
  /**
   * worker 环境变量（REVIEWER_URL / REVIEWER_API_KEY 经此注入线程——父进程
   * 启动期已 fail fast 校验过）。缺省继承 process.env 副本。
   */
  readonly env?: Record<string, string | undefined>;
  /**
   * worker 的 Node CLI flags；缺省继承 process.execArgv（生产行为）。测试环境
   * 需显式剥离：vitest fork 以 `--conditions source` 等旗标启动，Worker 继承
   * 会把依赖解析改道 TS 源码（dist 入口即崩）——传 [] 回到干净旗标面。
   */
  readonly execArgv?: readonly string[];
  /** abort 宽限毫秒（缺省 ~10s；测试注入小值） */
  readonly abortGraceMs?: number;
  /** experimentId 派生（缺省恒 RPC_EXPERIMENT_ID；sqlite 装配传 identity） */
  readonly experimentIdOf?: (jobId: string) => string;
  /** 诊断输出缝（worker 崩溃/硬终止/线程侧诊断）；缺省写 stderr */
  readonly onDiagnostic?: (message: string) => void;
}

/** 缺省入口解析（模块注候选序）；解析不到 → 人话（候选全列出） */
export function resolveDefaultWorkerEntry(): URL {
  const override = process.env.REVIEWAGENT_WORKER_ENTRY;
  if (override !== undefined && override.length > 0) {
    return pathToFileURL(override);
  }
  const candidates = [
    new URL("./worker-entry.js", import.meta.url), // dev：tsc dist（本模块旁）
    new URL("./review-worker.mjs", import.meta.url), // prod：esbuild bundle（cli.mjs 旁）
  ];
  for (const candidate of candidates) {
    if (existsSync(fileURLToPath(candidate))) {
      return candidate;
    }
  }
  throw new Error(
    "worker entry not found: set workerEntry explicitly, or export REVIEWAGENT_WORKER_ENTRY, " +
      `or provide one of ${candidates.map((candidate) => fileURLToPath(candidate)).join(", ")} ` +
      "(tsc dist / esbuild bundle layouts are resolved automatically)",
  );
}

interface PoolJob {
  readonly jobId: string;
  readonly request: ReviewRunRequest;
  readonly experimentId: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: ReviewRunProgress) => void;
  resolve(summary: ReviewRunSummary): void;
  reject(error: unknown): void;
  /** 当前承载 worker（undefined = 尚在等待位） */
  worker?: PoolWorker | undefined;
  /** 结算护栏（done/failed/abort/崩溃多路收口互斥） */
  settled: boolean;
  /** abort 已发（宽限计时器在飞） */
  aborting: boolean;
  graceTimer?: NodeJS.Timeout;
  onAbort: () => void;
}

interface PoolWorker {
  readonly worker: Worker;
  ready: boolean;
  job?: PoolJob | undefined;
  /** exit 事件落定（close 等全体退出用） */
  readonly exited: Promise<void>;
  settleExited: () => void;
}

export class WorkerPoolReviewExecutor implements ReviewRunExecutor {
  private readonly size: number;
  private readonly runsRoot: string;
  private readonly workerEntry: URL;
  private readonly env: Record<string, string | undefined> | undefined;
  private readonly execArgv: readonly string[] | undefined;
  private readonly abortGraceMs: number;
  private readonly experimentIdOf: (jobId: string) => string;
  private readonly onDiagnostic: (message: string) => void;

  private readonly workers = new Set<PoolWorker>();
  private readonly waiting: PoolJob[] = [];
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: WorkerPoolExecutorOptions) {
    this.size = options.size;
    this.runsRoot = options.runsRoot;
    this.workerEntry = options.workerEntry !== undefined ? toEntryUrl(options.workerEntry) : resolveDefaultWorkerEntry();
    this.env = options.env;
    this.execArgv = options.execArgv;
    this.abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    this.experimentIdOf = options.experimentIdOf ?? (() => RPC_EXPERIMENT_ID);
    this.onDiagnostic =
      options.onDiagnostic ??
      ((message: string) => {
        process.stderr.write(`${message}\n`);
      });
  }

  execute(request: ReviewRunRequest, ctx: ReviewRunContext): Promise<ReviewRunSummary> {
    if (this.closing) {
      return Promise.reject(
        new ReviewExecutionError("review execution failed", `worker pool is closed (job ${ctx.jobId})`),
      );
    }
    return new Promise<ReviewRunSummary>((resolve, reject) => {
      const job: PoolJob = {
        jobId: ctx.jobId,
        request,
        experimentId: this.experimentIdOf(ctx.jobId),
        signal: ctx.signal,
        ...(ctx.onProgress !== undefined ? { onProgress: ctx.onProgress } : {}),
        resolve,
        reject,
        settled: false,
        aborting: false,
        // 惰性挂接（onAbort 闭包需 job 已成型）
        onAbort: () => undefined,
      };
      job.onAbort = () => this.handleAbort(job);
      job.signal.addEventListener("abort", job.onAbort, { once: true });
      this.dispatch(job);
    });
  }

  /** 幂等且并发安全：重复/并发调用共享同一收口 promise */
  close(): Promise<void> {
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }

  /**
   * 当前存活 worker 数（观测面：soak 泄漏断言 / 运维探针）。恒 ≤ size；
   * close 落定后为 0（全体 terminate 是 close 的收口语义）。
   */
  get workerCount(): number {
    return this.workers.size;
  }

  // ---- 内部：派发与 worker 生命周期 ----

  private dispatch(job: PoolJob): void {
    if (job.signal.aborted) {
      // 预中止：与 in-process 同款契约（runReview 入口即抛）——不触 worker
      this.rejectJob(job, new ReviewAbortedError());
      return;
    }
    let idle: PoolWorker | undefined;
    for (const worker of this.workers) {
      if (worker.ready && worker.job === undefined) {
        idle = worker;
        break;
      }
    }
    if (idle === undefined) {
      if (this.workers.size < this.size && !this.closing) {
        this.spawnWorker();
      }
      this.waiting.push(job);
      return;
    }
    this.assign(idle, job);
  }

  private dispatchWaiting(): void {
    while (this.waiting.length > 0) {
      const job = this.waiting[0]!;
      if (job.signal.aborted) {
        this.waiting.shift();
        this.rejectJob(job, new ReviewAbortedError());
        continue;
      }
      let idle: PoolWorker | undefined;
      for (const worker of this.workers) {
        if (worker.ready && worker.job === undefined) {
          idle = worker;
          break;
        }
      }
      if (idle === undefined) {
        if (this.workers.size < this.size && !this.closing) {
          this.spawnWorker();
        }
        return;
      }
      this.waiting.shift();
      this.assign(idle, job);
    }
  }

  private spawnWorker(): void {
    const worker = new Worker(this.workerEntry, {
      ...(this.env !== undefined ? { env: this.env } : {}),
      ...(this.execArgv !== undefined ? { execArgv: [...this.execArgv] } : {}),
    });
    let settleExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      settleExited = resolve;
    });
    const state: PoolWorker = { worker, ready: false, exited, settleExited };
    this.workers.add(state);
    worker.on("message", (report: WorkerPoolReport) => this.handleReport(state, report));
    worker.on("error", (error: Error) => {
      // 线程内未捕获异常：诊断留痕；退出路径（exit 事件）统一收口在飞 job
      this.onDiagnostic(`worker thread error: ${errorMessage(error)}`);
    });
    worker.on("exit", (code: number) => {
      this.workers.delete(state);
      state.settleExited();
      const job = state.job;
      state.job = undefined;
      if (job !== undefined && !job.settled) {
        const diagnostic = `worker thread exited unexpectedly (code ${code}, job ${job.jobId})`;
        this.onDiagnostic(diagnostic); // 崩溃细节走 sink（协议面只见合同错误）
        this.rejectJob(job, new ReviewExecutionError("review execution failed", diagnostic));
      }
      if (!this.closing) {
        this.dispatchWaiting(); // 池大小回补由下一个 dispatch 触发（懒补齐）
      }
    });
    const init: WorkerPoolCommand = { kind: "init", runsRoot: this.runsRoot };
    worker.postMessage(init);
  }

  private assign(worker: PoolWorker, job: PoolJob): void {
    worker.job = job;
    job.worker = worker;
    const command: WorkerPoolCommand = {
      kind: "execute",
      jobId: job.jobId,
      request: job.request,
      experimentId: job.experimentId,
    };
    worker.worker.postMessage(command);
  }

  private handleReport(worker: PoolWorker, report: WorkerPoolReport): void {
    if (report.kind === "ready") {
      worker.ready = true;
      this.dispatchWaiting();
      return;
    }
    if (report.kind === "diagnostic") {
      this.onDiagnostic(report.message);
      return;
    }
    const job = worker.job;
    if (job === undefined || report.jobId !== job.jobId) {
      return; // 迟到帧（job 已结算/换人）：静默丢弃——progress/done/failed 全帧校验
    }
    if (report.kind === "progress") {
      job.onProgress?.(report.progress);
      return;
    }
    if (report.kind === "done") {
      this.settleJob(job, () => job.resolve(report.summary));
      this.releaseWorker(worker);
      return;
    }
    // failed：按判别联合重建合同错误（aborted 原样语义 / execution 双通道）
    this.settleJob(job, () => {
      if (report.failure.kind === "aborted") {
        job.reject(new ReviewAbortedError());
      } else {
        job.reject(
          new ReviewExecutionError(
            report.failure.publicMessage,
            report.failure.diagnosticMessage ?? report.failure.publicMessage,
          ),
        );
      }
    });
    this.releaseWorker(worker);
  }

  /** worker 空闲释放：close 期直接回收，否则补派等待位 */
  private releaseWorker(worker: PoolWorker): void {
    worker.job = undefined;
    if (this.closing) {
      void worker.worker.terminate();
    } else {
      this.dispatchWaiting();
    }
  }

  private handleAbort(job: PoolJob): void {
    if (job.settled) {
      return;
    }
    const worker = job.worker;
    if (worker === undefined) {
      // 等待位中止：立即收场，不占 worker
      const index = this.waiting.indexOf(job);
      if (index !== -1) {
        this.waiting.splice(index, 1);
      }
      this.rejectJob(job, new ReviewAbortedError());
      return;
    }
    if (job.aborting) {
      return;
    }
    job.aborting = true;
    worker.worker.postMessage({ kind: "abort", jobId: job.jobId } satisfies WorkerPoolCommand);
    // 宽限：协作取消未收场 → 硬终止（取消的硬边界，方案 §7.1）
    job.graceTimer = setTimeout(() => {
      if (job.settled) {
        return;
      }
      this.onDiagnostic(
        `worker terminated after abort grace (${this.abortGraceMs}ms, job ${job.jobId}) — cooperative cancel did not settle`,
      );
      this.settleJob(job, () => job.reject(new ReviewAbortedError()));
      this.discardWorker(worker);
    }, this.abortGraceMs);
  }

  /** 废弃 worker（宽限硬终止路径）：摘牌 → terminate（exit 事件收尾）；池在下次派发时懒补齐 */
  private discardWorker(worker: PoolWorker): void {
    worker.job = undefined;
    this.workers.delete(worker);
    void worker.worker.terminate();
    if (!this.closing) {
      this.dispatchWaiting();
    }
  }

  /** 结算护栏：多路收口（done/failed/abort/崩溃）互斥 + 监听器/计时器清理 */
  private settleJob(job: PoolJob, settle: () => void): void {
    if (job.settled) {
      return;
    }
    job.settled = true;
    if (job.graceTimer !== undefined) {
      clearTimeout(job.graceTimer);
    }
    job.signal.removeEventListener("abort", job.onAbort);
    settle();
  }

  private rejectJob(job: PoolJob, error: unknown): void {
    this.settleJob(job, () => job.reject(error));
  }

  private async doClose(): Promise<void> {
    this.closing = true;
    // 等待位 job：服务层已终态化它们（drain 序保证）——防御性合同错误拒收
    for (const job of this.waiting.splice(0)) {
      this.rejectJob(
        job,
        new ReviewExecutionError("review execution failed", `worker pool closed before dispatch (job ${job.jobId})`),
      );
    }
    const states = [...this.workers];
    for (const state of states) {
      if (state.job === undefined) {
        void state.worker.terminate(); // idle：立即回收
      } else {
        // 在飞：abort + 宽限（grace 路径 terminate 该 worker；正常结算走
        // releaseWorker 的 close 期回收）
        this.handleAbort(state.job);
      }
    }
    // 每个 worker 的退出都有保证路径（idle terminate / 结算后 terminate /
    // 宽限 terminate / 崩溃 exit）；兜底强停防止任何理论残余
    const allExited = Promise.all(states.map((state) => state.exited));
    const safety = setTimeout(() => {
      for (const state of [...this.workers]) {
        void state.worker.terminate();
      }
    }, this.abortGraceMs + 5_000);
    try {
      await allExited;
    } finally {
      clearTimeout(safety);
      for (const state of [...this.workers]) {
        void state.worker.terminate();
      }
    }
  }
}

function toEntryUrl(entry: string | URL): URL {
  return typeof entry === "string" ? pathToFileURL(entry) : entry;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
