/**
 * #22 S1 service：ReviewService 深模块——job 状态机、队列、取消、事件、close
 * drain（spec #21 §6/§7.2、ADR-0012 决策 3）。
 *
 * 不变量（spec §7.2）：
 * - submit 只受理并入队，不等待执行完成（worker 启动排微任务，响应恒为 queued 快照）；
 * - 同一 job 至多一个执行实例；状态单调推进，终态不可逆；
 * - 断连不取消 job——只有显式 cancel 或 close drain 才取消；
 * - close 幂等：停止收单（draining → -32010）、取消 queued、等待 running。
 *
 * 事件纪律（拍板 2026-10-21）：发射点 = 状态转移或 phase/round 边界，
 * payload 携带累计 toolCalls/usage 快照，不逐 toolCall 发射；submit 入队本身
 * 不发事件（submit 响应即首快照，避免宿主双收）。seq 为 service 级单调——
 * v1 单连接（一进程一宿主），与连接级等价。
 */

import { realpath } from "node:fs/promises";
import {
  isAbsolute as isAbsolutePath,
  relative as relativePath,
  resolve as resolvePath,
  sep,
} from "node:path";

import type { ConfigId } from "../contracts/config.js";
import { ReviewExecutionError, type ReviewRunContext } from "./executor.js";
import type {
  ReviewRunExecutor,
  ReviewRunProgress,
  ReviewRunRequest,
  ReviewRunSummary,
} from "./executor.js";
import {
  JSON_RPC_ERROR,
  RpcError,
  type ListReviewParams,
  type ReviewJobStatus,
  type SubmitReviewParams,
} from "./protocol.js";

/** spec §5：diff 上限 8 MiB（可配置） */
const DEFAULT_MAX_DIFF_BYTES = 8 * 1024 * 1024;
/** spec §6.2：队列深度上限（queued 计数，不含 running） */
const DEFAULT_MAX_QUEUE_DEPTH = 100;
/** spec §6.2：默认并发 1（>1 的安全前提见方案 §6.2，v1 未验证放开） */
const DEFAULT_CONCURRENCY = 1;

export interface ReviewServiceLimits {
  readonly maxDiffBytes: number;
  readonly maxQueueDepth: number;
}

export interface ReviewServiceOptions {
  readonly executor: ReviewRunExecutor;
  readonly limits?: Partial<ReviewServiceLimits>;
  /** 并发执行数；缺省 1 */
  readonly concurrency?: number;
  /** allowlist 根（绝对路径）；submit 的 repoPath realpath 后必须落在其下 */
  readonly repoRoot?: string;
  /** 时钟注入（jobId 启动毫秒与 submittedAt 单源）；缺省真实时间 */
  readonly now?: () => Date;
}

/** job 对外快照：progress/result/error 缺席省键（与内核审计同款纪律） */
export interface ReviewJobView {
  readonly jobId: string;
  readonly status: ReviewJobStatus;
  readonly caseId: string;
  readonly configId: ConfigId;
  readonly submittedAt: string;
  readonly progress?: ReviewRunProgress;
  readonly result?: ReviewRunSummary;
  readonly error?: { readonly message: string };
}

/** job 事件：{seq, job}（spec §4.3）；seq 单调、live-only（断线后用 get 查快照） */
export interface ReviewJobEvent {
  readonly seq: number;
  readonly job: ReviewJobView;
}

export type ReviewJobListener = (event: ReviewJobEvent) => void;

export interface ReviewService {
  submit(params: SubmitReviewParams): Promise<ReviewJobView>;
  get(jobId: string): ReviewJobView | undefined;
  list(params: ListReviewParams): { readonly jobs: readonly ReviewJobView[] };
  cancel(jobId: string): Promise<ReviewJobView>;
  subscribe(listener: ReviewJobListener): () => void;
  close(): Promise<void>;
  isDraining(): boolean;
  readonly limits: ReviewServiceLimits;
}

interface InternalJob {
  readonly jobId: string;
  status: ReviewJobStatus;
  readonly request: ReviewRunRequest;
  readonly submittedSeq: number;
  readonly submittedAt: string;
  progress?: ReviewRunProgress;
  result?: ReviewRunSummary;
  error?: { readonly message: string };
  readonly controller: AbortController;
  /** running 结算后 resolve（close drain 等待用） */
  readonly settled: Promise<void>;
  settle: () => void;
}

export function createReviewService(options: ReviewServiceOptions): ReviewService {
  const limits: ReviewServiceLimits = {
    maxDiffBytes: options.limits?.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES,
    maxQueueDepth: options.limits?.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
  };
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const now = options.now ?? (() => new Date());
  const repoRoot = options.repoRoot !== undefined ? resolvePath(options.repoRoot) : undefined;
  // jobId 的启动毫秒单源（spec §6.2：job-<进程启动毫秒>-<进程内单调序号>）
  const startMs = now().getTime();

  const jobs = new Map<string, InternalJob>();
  const queue: InternalJob[] = [];
  const listeners = new Set<ReviewJobListener>();
  let jobCounter = 0;
  let eventSeq = 0;
  let draining = false;
  let runningCount = 0;
  let pumpScheduled = false;

  const viewOf = (job: InternalJob): ReviewJobView => ({
    jobId: job.jobId,
    status: job.status,
    caseId: job.request.caseId,
    configId: job.request.configId,
    submittedAt: job.submittedAt,
    // progress 仅存在于 running/cancelling（spec §6.1）——终态快照不带执行中间态
    ...(job.progress !== undefined && (job.status === "running" || job.status === "cancelling")
      ? { progress: job.progress }
      : {}),
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
  });

  // listeners 快照遍历：通知中注销自身不破坏本轮迭代（pi rpc-mode 同款教训）
  const emitEvent = (job: InternalJob): void => {
    eventSeq += 1;
    const event: ReviewJobEvent = { seq: eventSeq, job: viewOf(job) };
    for (const listener of [...listeners]) {
      listener(event);
    }
  };

  const schedulePump = (): void => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  };

  const pump = (): void => {
    // drain 后不再开工 queued：迟到的执行许可宁可作废，也不启动后再 abort
    //（S2 后果：真内核跑起来才取消 = token 已花）
    if (draining) return;
    while (runningCount < concurrency && queue.length > 0) {
      const job = queue.shift()!;
      startJob(job);
    }
  };

  const startJob = (job: InternalJob): void => {
    job.status = "running";
    runningCount += 1;
    emitEvent(job);
    const ctx: ReviewRunContext = {
      jobId: job.jobId,
      signal: job.controller.signal,
      onProgress: (progress: ReviewRunProgress) => {
        const previous = job.progress;
        job.progress = progress;
        // 粒度判定（拍板）：phase/round 边界才发射——计数快照随边界事件携带，
        // 不因 toolCalls/usage 计数变化单独发射
        if (
          previous === undefined ||
          previous.phase !== progress.phase ||
          previous.round !== progress.round
        ) {
          emitEvent(job);
        }
      },
    };
    let execution: Promise<ReviewRunSummary>;
    try {
      // 同步调用（pump 拍内触达 executor）；同步 throw 也走统一结算，不逃成 uncaught
      execution = options.executor.execute(job.request, ctx);
    } catch (error) {
      execution = Promise.reject(error);
    }
    void execution.then(
      (summary) => settleJob(job, { kind: "succeeded", summary }),
      (error: unknown) => settleJob(job, { kind: "failed", error }),
    );
  };

  type SettleOutcome =
    | { readonly kind: "succeeded"; readonly summary: ReviewRunSummary }
    | { readonly kind: "failed"; readonly error: unknown };

  const settleJob = (job: InternalJob, outcome: SettleOutcome): void => {
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return; // 终态不可逆（同 job 至多一个执行实例，防御性护栏）
    }
    if (outcome.kind === "succeeded") {
      job.status = "succeeded";
      job.result = outcome.summary;
    } else if (job.status === "cancelling") {
      // cancel 后执行侧以错误收场 → cancelled（abort 响应）
      job.status = "cancelled";
    } else {
      job.status = "failed";
      job.error = { message: failureMessage(outcome.error) };
    }
    runningCount -= 1;
    emitEvent(job);
    job.settle();
    pump();
  };

  // repoRoot 的 realpath 惰性缓存：与 repoPath 同口径消解书写形态差异
  // （Windows 盘符大小写/8.3 短名/junction），只算一次
  let repoRootReal: string | undefined;

  const resolveRepoPath = async (repoPath: string): Promise<string> => {
    const resolved = resolvePath(repoPath);
    let real: string;
    try {
      real = await realpath(resolved);
    } catch {
      throw new RpcError(
        JSON_RPC_ERROR.REPO_NOT_ALLOWED,
        "repoPath does not resolve to an accessible directory",
      );
    }
    if (repoRoot !== undefined) {
      if (repoRootReal === undefined) {
        try {
          repoRootReal = await realpath(repoRoot);
        } catch {
          // 根不可达：无法证明任何 repoPath 在根内 → 拒绝（data 不放路径，spec §9）
          throw new RpcError(
            JSON_RPC_ERROR.REPO_NOT_ALLOWED,
            "repoPath is outside the allowed root",
          );
        }
      }
      // relative 判定包含性：win32 大小写不敏感比较与跨盘拒绝都由它处理；
      // rel === ".." / 以 ../ 起头 / 跨盘绝对路径 → 越界（防 "..hidden" 误伤用精确前缀）
      const rel = relativePath(repoRootReal, real);
      if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolutePath(rel))) {
        throw new RpcError(JSON_RPC_ERROR.REPO_NOT_ALLOWED, "repoPath is outside the allowed root");
      }
    }
    return real;
  };

  const submit = async (params: SubmitReviewParams): Promise<ReviewJobView> => {
    if (draining) {
      throw new RpcError(JSON_RPC_ERROR.SERVER_DRAINING, "server is draining");
    }
    const diffBytes = Buffer.byteLength(params.diff, "utf8");
    if (diffBytes > limits.maxDiffBytes) {
      throw new RpcError(JSON_RPC_ERROR.PAYLOAD_TOO_LARGE, "diff exceeds maxDiffBytes", {
        maxDiffBytes: limits.maxDiffBytes,
      });
    }
    const repoPath = await resolveRepoPath(params.repoPath);
    // 入队前二次门：realpath await 期间 close 可能已置 draining——迟到入队的
    // job 会滞留 queued（无人开工也无人取消），宁可拒单
    if (draining) {
      throw new RpcError(JSON_RPC_ERROR.SERVER_DRAINING, "server is draining");
    }
    if (queue.length >= limits.maxQueueDepth) {
      throw new RpcError(JSON_RPC_ERROR.QUEUE_FULL, "queue is full", {
        limit: limits.maxQueueDepth,
      });
    }
    jobCounter += 1;
    const jobId = `job-${startMs}-${jobCounter}`;
    let settleJobPromise!: () => void;
    const settled = new Promise<void>((resolve) => {
      settleJobPromise = resolve;
    });
    const job: InternalJob = {
      jobId,
      status: "queued",
      request: {
        caseId: params.caseId,
        repoPath,
        diff: params.diff,
        issueDescription: params.issueDescription ?? "",
        configId: params.configId,
        ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
      },
      submittedSeq: jobCounter,
      submittedAt: now().toISOString(),
      controller: new AbortController(),
      settled,
      settle: settleJobPromise,
    };
    jobs.set(jobId, job);
    queue.push(job);
    schedulePump();
    return viewOf(job);
  };

  const get = (jobId: string): ReviewJobView | undefined => {
    const job = jobs.get(jobId);
    return job === undefined ? undefined : viewOf(job);
  };

  const list = (params: ListReviewParams): { readonly jobs: readonly ReviewJobView[] } => {
    const views = [...jobs.values()]
      .sort((a, b) => b.submittedSeq - a.submittedSeq)
      .map(viewOf);
    const filtered =
      params.status === undefined
        ? views
        : views.filter((view) => view.status === params.status);
    return { jobs: filtered };
  };

  const cancel = async (jobId: string): Promise<ReviewJobView> => {
    const job = jobs.get(jobId);
    if (job === undefined) {
      throw new RpcError(JSON_RPC_ERROR.JOB_NOT_FOUND, `Unknown job: ${jobId}`, { jobId });
    }
    if (job.status === "queued") {
      // 直接出队终态：cancelled（drain 取消同路径）
      job.status = "cancelled";
      const queueIndex = queue.indexOf(job);
      if (queueIndex !== -1) {
        queue.splice(queueIndex, 1);
      }
      emitEvent(job);
      job.settle();
    } else if (job.status === "running") {
      job.status = "cancelling";
      job.controller.abort(); // 内核信号缝（S2 实装真实取消）
      emitEvent(job);
    }
    // cancelling / 终态：幂等返回当前 view（拍板 2026-10-21；-32005 保留码不发射）
    return viewOf(job);
  };

  let closePromise: Promise<void> | undefined;

  const doClose = async (): Promise<void> => {
    draining = true;
    // 取消全部 queued（running 不中断——drain 是等待，不是杀）
    for (const job of [...queue]) {
      await cancel(job.jobId);
    }
    // 等待 running/cancelling 全部落定
    const unsettled = [...jobs.values()].filter(
      (job) => job.status === "running" || job.status === "cancelling",
    );
    await Promise.all(unsettled.map((job) => job.settled));
  };

  /** 幂等且并发安全：重复/并发调用共享同一 drain promise（第二个不提前返回） */
  const close = (): Promise<void> => {
    closePromise ??= doClose();
    return closePromise;
  };

  return {
    submit,
    get,
    list,
    cancel,
    subscribe: (listener: ReviewJobListener): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close,
    isDraining: () => draining,
    limits,
  };
}

/**
 * failed view 的 message 单源（H4 安全缝）：合同错误取 publicMessage；
 * 非合同异常一律固定 generic 文案——异常原文（路径/网关 URL/堆栈）绝不进协议面。
 */
function failureMessage(error: unknown): string {
  return error instanceof ReviewExecutionError
    ? error.publicMessage
    : "review execution failed";
}
