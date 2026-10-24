/**
 * #22 S1 service：ReviewService 深模块——job 状态机、队列、取消、事件、close
 * drain（spec #21 §6/§7.2、ADR-0012 决策 3）。
 * #27 v2（ADR-0013）：统一 `ReviewRequest` 入参 + `CallContext`/Principal 贯穿
 * 全方法（决策 3/5——job 属主租户快照，越权统一 not found，stdio 面合成 local
 * principal）；repoRoot/allowlist 移除——路径解析只做 realpath + 目录/文件
 * 存在性校验（失败 -32012）；diff 判别联合（file kind 在此读内容，executor
 * 端口恒收 diff 文本）；事件 per-job seq（SSE `Last-Event-ID` 重放同口径）。
 *
 * 不变量（spec §7.2）：
 * - submit 只受理并入队，不等待执行完成（worker 启动排微任务，响应恒为 queued 快照）；
 * - 同一 job 至多一个执行实例；状态单调推进，终态不可逆；
 * - 断连不取消 job——只有显式 cancel 或 close drain 才取消；
 * - close 幂等：停止收单（draining → -32010）、取消 queued、等待 running。
 *
 * 事件纪律（拍板 2026-10-21；#27 v2 修订 seq 语义）：发射点 = 状态转移或
 * phase/round 边界，payload 携带累计 toolCalls/usage 快照，不逐 toolCall 发射；
 * submit 入队本身不发事件（submit 响应即首快照，避免宿主双收）。seq 为
 * per-job 单调（首事件 = 1）——多 job 事件在同一连接交错时各自计数。
 */

import { readFile, realpath, stat } from "node:fs/promises";

import type { ConfigId } from "../contracts/config.js";
import { resolvePath } from "../shared/paths.js";
import type { CallContext } from "./context.js";
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
  type ReviewRequest,
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
  /**
   * `repoPath` 省略时的缺省值（stdio = `--cwd` 值；CLI = `process.cwd()`；
   * HTTP #28 起不传——必填显式）。未配置时回退 `process.cwd()`
   * （「omit to discover, provide to override」，ADR-0013 决策 3）。
   * 只覆盖缺省值：显式 repoPath 的相对解析基准仍是 `process.cwd()`（拍板 25）。
   */
  readonly defaultRepoPath?: string;
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

/** job 事件：{seq, job}（spec §4.3）；seq per-job 单调、live-only（断线后用 get 查快照） */
export interface ReviewJobEvent {
  readonly seq: number;
  readonly job: ReviewJobView;
}

export type ReviewJobListener = (event: ReviewJobEvent) => void;

/** list 结果页（P1 内存态：仅 jobs；#28 store 落地后按需扩分页游标） */
export interface ReviewJobPage {
  readonly jobs: readonly ReviewJobView[];
}

export interface ReviewService {
  submit(request: ReviewRequest, ctx: CallContext): Promise<ReviewJobView>;
  get(jobId: string, ctx: CallContext): Promise<ReviewJobView | undefined>;
  list(query: ListReviewParams, ctx: CallContext): Promise<ReviewJobPage>;
  cancel(jobId: string, ctx: CallContext): Promise<ReviewJobView>;
  /**
   * 事件订阅（P1 全连接广播形态；HTTP 方案 §3.3 的 per-job + afterSeq 重放
   * 形态随 #28 store 落地升级）。ctx 参与租户过滤——只收本租户 job 的事件
   * （与 get/list/cancel 同口径，事件面不越租户）。
   */
  subscribe(listener: ReviewJobListener, ctx: CallContext): () => void;
  close(): Promise<void>;
  isDraining(): boolean;
  readonly limits: ReviewServiceLimits;
}

interface InternalJob {
  readonly jobId: string;
  /** 属主租户（submit 时刻 CallContext.principal.tenantId 快照；查询层过滤口径） */
  readonly tenantId: string;
  status: ReviewJobStatus;
  readonly request: ReviewRunRequest;
  readonly submittedSeq: number;
  readonly submittedAt: string;
  /** per-job 事件序（首事件 = 1；SSE Last-Event-ID 重放同口径） */
  eventSeq: number;
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
  const defaultRepoPath = options.defaultRepoPath;
  // jobId 的启动毫秒单源（spec §6.2：job-<进程启动毫秒>-<进程内单调序号>）
  const startMs = now().getTime();

  const jobs = new Map<string, InternalJob>();
  const queue: InternalJob[] = [];
  /** 订阅注册体（listener + 属主租户——emitEvent 按租户过滤投递） */
  const listeners = new Set<{ readonly listener: ReviewJobListener; readonly tenantId: string }>();
  let jobCounter = 0;
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

  // listeners 快照遍历：通知中注销自身不破坏本轮迭代（pi rpc-mode 同款教训）；
  // 只投递给属主租户的订阅（事件面与 get/list/cancel 同隔离口径）
  const emitEvent = (job: InternalJob): void => {
    job.eventSeq += 1;
    const event: ReviewJobEvent = { seq: job.eventSeq, job: viewOf(job) };
    for (const { listener, tenantId } of [...listeners]) {
      if (tenantId === job.tenantId) {
        listener(event);
      }
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

  /** -32012 单源构造（消息不含路径值——spec §9 安全细节纪律） */
  const repoNotFound = (field: string, expected: "directory" | "file"): RpcError =>
    new RpcError(
      JSON_RPC_ERROR.REPO_NOT_FOUND,
      `${field} does not resolve to an accessible ${expected}`,
    );

  /**
   * 统一路径域校验（#27 v2）：`resolvePath`（含 ~、file: URL、Git Bash 盘符
   * 形态归一）→ `realpath`（存在性 + 形态归一）→ `stat` 目录/文件性。
   * 任何一步不可达或类型不符 → -32012 repo_not_found（data 不放路径——
   * spec §9 安全细节纪律；ADR-0013 决策 3：无 allowlist/根包含判定）。
   */
  const resolveExistingPath = async (
    input: string,
    expected: "directory" | "file",
    field: string,
  ): Promise<string> => {
    let real: string;
    try {
      real = await realpath(resolvePath(input));
      const info = await stat(real);
      if (expected === "directory" ? !info.isDirectory() : !info.isFile()) {
        throw new Error(`${field} is not a ${expected}`);
      }
    } catch {
      throw repoNotFound(field, expected);
    }
    return real;
  };

  /** repoPath 解析：省略走缺省链（--cwd → process.cwd()）；相对基准恒 process.cwd()（拍板 25） */
  const resolveRepoPath = async (repoPath: string | undefined): Promise<string> =>
    resolveExistingPath(repoPath ?? defaultRepoPath ?? process.cwd(), "directory", "repoPath");

  /** diff 判别联合解析：file kind 读入内容（此后全链路只传文本）；inline 原样透传 */
  const resolveDiffText = async (diff: ReviewRequest["diff"]): Promise<string> => {
    if (diff.kind === "inline") {
      return diff.text;
    }
    const real = await resolveExistingPath(diff.path, "file", "diff.path");
    try {
      return await readFile(real, "utf8");
    } catch {
      // stat 与 read 间的竞态窗口（删除/权限变化）——同 -32012 口径收口
      throw repoNotFound("diff.path", "file");
    }
  };

  const submit = async (
    request: ReviewRequest,
    ctx: CallContext,
  ): Promise<ReviewJobView> => {
    if (draining) {
      throw new RpcError(JSON_RPC_ERROR.SERVER_DRAINING, "server is draining");
    }
    const repoPath = await resolveRepoPath(request.repoPath);
    const diffText = await resolveDiffText(request.diff);
    // 空 diff 无检视意义（inline 空串协议层已拒，此处兜底直调与 file 空文件同口径）
    if (diffText.length === 0) {
      throw new RpcError(JSON_RPC_ERROR.INVALID_PARAMS, "diff must not be empty");
    }
    const diffBytes = Buffer.byteLength(diffText, "utf8");
    if (diffBytes > limits.maxDiffBytes) {
      throw new RpcError(JSON_RPC_ERROR.PAYLOAD_TOO_LARGE, "diff exceeds maxDiffBytes", {
        maxDiffBytes: limits.maxDiffBytes,
      });
    }
    // 入队前二次门：路径解析 await 期间 close 可能已置 draining——迟到入队的
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
      tenantId: ctx.principal.tenantId,
      status: "queued",
      request: {
        caseId: request.caseId,
        repoPath,
        diff: diffText,
        issueDescription: request.issueDescription ?? "",
        configId: request.configId,
        ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
      },
      submittedSeq: jobCounter,
      submittedAt: now().toISOString(),
      eventSeq: 0,
      controller: new AbortController(),
      settled,
      settle: settleJobPromise,
    };
    jobs.set(jobId, job);
    queue.push(job);
    schedulePump();
    return viewOf(job);
  };

  /** 租户口径的 job 定位：异租户与不存在同面（越权统一 not found，不泄漏存在性） */
  const findJob = (jobId: string, ctx: CallContext): InternalJob | undefined => {
    const job = jobs.get(jobId);
    return job !== undefined && job.tenantId === ctx.principal.tenantId ? job : undefined;
  };

  const get = async (
    jobId: string,
    ctx: CallContext,
  ): Promise<ReviewJobView | undefined> => {
    const job = findJob(jobId, ctx);
    return job === undefined ? undefined : viewOf(job);
  };

  const list = async (
    query: ListReviewParams,
    ctx: CallContext,
  ): Promise<ReviewJobPage> => {
    const views = [...jobs.values()]
      .filter((job) => job.tenantId === ctx.principal.tenantId)
      .sort((a, b) => b.submittedSeq - a.submittedSeq)
      .map(viewOf);
    const filtered =
      query.status === undefined
        ? views
        : views.filter((view) => view.status === query.status);
    return { jobs: filtered };
  };

  /** 状态转移单源（public cancel 与 close drain 共用；drain 是服务端自身行为，不走租户门） */
  const cancelJob = (job: InternalJob): void => {
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
  };

  const cancel = async (jobId: string, ctx: CallContext): Promise<ReviewJobView> => {
    const job = findJob(jobId, ctx);
    if (job === undefined) {
      throw new RpcError(JSON_RPC_ERROR.JOB_NOT_FOUND, `Unknown job: ${jobId}`, { jobId });
    }
    cancelJob(job);
    return viewOf(job);
  };

  let closePromise: Promise<void> | undefined;

  const doClose = async (): Promise<void> => {
    draining = true;
    // 取消全部 queued（running 不中断——drain 是等待，不是杀）
    for (const job of [...queue]) {
      cancelJob(job);
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
    subscribe: (listener: ReviewJobListener, ctx: CallContext): (() => void) => {
      const registration = { listener, tenantId: ctx.principal.tenantId };
      listeners.add(registration);
      return () => {
        listeners.delete(registration);
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
