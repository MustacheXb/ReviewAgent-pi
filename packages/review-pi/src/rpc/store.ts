/**
 * #30 P3a：ReviewJobStore 端口（spec #25「端口与适配器」、ADR-0013 决策 6）——
 * job 状态与事件日志的持久化缝：memory（测试 / `--store memory` 逃生口）+
 * `node:sqlite`（生产默认）双实现，同契约（store.contract.test.ts 同套测试
 * 双实现跑）。
 *
 * 接口纪律（刻意的同步面）：
 * - `node:sqlite` 的 `DatabaseSync` 是同步 API，memory 天然同步——端口全同步，
 *   service 的「readEvents 零 await」性质（SSE 先 subscribe 再 readEvents 无
 *   发射窗口）原样保留；
 * - store 不做租户过滤 / 语义判定：`getJob`/`listJobs` 的 tenant 过滤与
 *   readEvents 的 gap/replay 判定归 service（越权统一 not found 的口径单源）；
 *   `listJobs(tenantId, …)` 的租户参数是查询下推（租户-状态-时间索引的
 *   存在理由），不是执法；
 * - 事件日志单源在 store（memory = 进程内数组 + maxJobEvents 保留窗；sqlite
 *   = job_events 表恒全量保留）——跨重启 SSE `Last-Event-ID` 重放依赖它。
 *
 * 崩溃窗口收敛语义（service 转移点「先 saveJob 后 appendEvent」的写序配合）：
 * 两写之间崩溃留下「状态已推进、事件缺尾」的中间态——重启恢复以 job 行
 * 状态为准（loadActiveJobs），事件序从 lastSeq 延续，缺帧可接受（崩溃本身
 * 是异常路径；恢复的 failed 转移事件照常 append，SSE 重放仍连续不回退）。
 */

import type { ReviewRunProgress, ReviewRunRequest, ReviewRunSummary } from "./executor.js";
import type { ReviewJobStatus } from "./protocol.js";
import type { ReviewJobEvent } from "./service.js";

/**
 * job 的持久形态：service `InternalJob` 的全量可序列化投影（request 为
 * submit 时刻已解析的执行输入——realpath repoPath + diff 文本；恢复时
 * 重新执行的全部材料）。progress/result/error 为缺席省键（与 view 同纪律）。
 */
export interface StoredReviewJob {
  readonly jobId: string;
  /** 属主租户（submit 时刻 principal.tenantId 快照） */
  readonly tenantId: string;
  readonly status: ReviewJobStatus;
  readonly request: ReviewRunRequest;
  readonly submittedAt: string;
  /** 提交序（list 降序排序键；跨 store 生命周期单调——allocateJobId 单源） */
  readonly submittedSeq: number;
  /** 终态落定时刻（epoch ms；保留窗口判定基准）；非终态缺席 */
  readonly finishedAtMs?: number;
  /** 执行中间态（仅 running/cancelling 期有意义——view 投影过滤） */
  readonly progress?: ReviewRunProgress;
  readonly result?: ReviewRunSummary;
  readonly error?: { readonly message: string };
}

/** allocateJobId 产物：jobId 与提交序同源分配（service 的 submittedSeq 单源） */
export interface AllocatedJobId {
  /** 形态 `job-<startMs>-<seq>`（对外不透明——ADR-0013 决策 2；内部形态可演化） */
  readonly jobId: string;
  readonly seq: number;
}

/**
 * 事件日志切片（service readEvents 的 gap/replay 判定材料）：
 * - `events`：afterSeq 之后按 seq 升序（过滤下推，全量保留实现亦可全返）；
 * - `firstRetainedSeq`：保留窗起点（无保留事件 = lastSeq + 1）；
 * - `lastSeq`：当前事件位（最后发射的 seq；从未发射 = 0）。
 * afterSeq 落在保留窗之前 → service 判 gap（reset + 最新快照兜底）。
 */
export interface ReviewJobEventSlice {
  readonly events: readonly ReviewJobEvent[];
  readonly firstRetainedSeq: number;
  readonly lastSeq: number;
}

/**
 * jobId 形态单源（`job-<startMs>-<seq>`；对外不透明——ADR-0013 决策 2，内部
 * 形态可演化）：memory / sqlite 两实现的分配器共指——两处字面量会静默漂移
 * （sqlite 的持久计数器与 memory 的进程计数器各写一份时尤甚）。
 */
export const formatJobId = (startMs: number, seq: number): string => `job-${startMs}-${seq}`;

/**
 * ReviewJobStore 端口。实现约束：
 * - `saveJob` upsert 语义（同 jobId 全量覆写）；调用方（service）保证转移
 *   单调——store 不做状态机校验；
 * - `appendEvent` 的 seq 由调用方分配（per-job 单调、首事件 = 1）；实现保证
 *   与既有日志不冲突（sqlite 主键冲突即 fail fast 暴露分配 bug）；
 * - `allocateJobId` 跨 store 实例防碰撞（sqlite：持久计数器；memory：进程内
 *   计数器）——重启后新 job 与历史 job 不撞（时钟回拨 / 同毫秒双启动面）；
 * - `close` 幂等；sqlite 实现落盘收口。
 */
export interface ReviewJobStore {
  allocateJobId(startMs: number): AllocatedJobId;
  saveJob(job: StoredReviewJob): void;
  getJob(jobId: string): StoredReviewJob | undefined;
  /** 按提交序降序（新 job 在前）；status 过滤可选 */
  listJobs(tenantId: string, status?: ReviewJobStatus): readonly StoredReviewJob[];
  appendEvent(jobId: string, event: ReviewJobEvent): void;
  /** 未知 jobId → undefined（存在性判定归调用方语义层） */
  readJobEvents(jobId: string, afterSeq: number): ReviewJobEventSlice | undefined;
  /** 启动恢复面：全部非终态 job（queued / running / cancelling），提交序升序 */
  loadActiveJobs(): readonly StoredReviewJob[];
  close(): void;
}

/** memory store 构造参数 */
export interface MemoryJobStoreOptions {
  /**
   * per-job 事件日志保留上限（#29 SSE `Last-Event-ID` 重放单源的内存保护闸）：
   * 超出丢最旧。缺省不设限（进程生命周期内全量保留）。sqlite 实现恒全量
   * 保留（跨重启重放依赖），保留窗语义只在 memory 面。
   */
  readonly maxJobEvents?: number;
}

/** 非终态集（loadActiveJobs 过滤单源；终态 = succeeded/failed/cancelled） */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "cancelling"]);

/**
 * memory store（#29 起的 service 缺省内态提取；#30 起作为端口适配器）：
 * 纯进程内 Map——测试 / `--store memory` 逃生口。快照进出皆拷贝（调用方
 * 对返回值的后续变更不污染 store 内态——不可变纪律的结构性实现）。
 */
export function createMemoryJobStore(options: MemoryJobStoreOptions = {}): ReviewJobStore {
  const maxJobEvents = options.maxJobEvents;
  const jobs = new Map<string, StoredReviewJob>();
  const events = new Map<string, ReviewJobEvent[]>();
  let counter = 0;

  return {
    allocateJobId(startMs: number): AllocatedJobId {
      counter += 1;
      return { jobId: formatJobId(startMs, counter), seq: counter };
    },

    saveJob(job: StoredReviewJob): void {
      jobs.set(job.jobId, { ...job });
    },

    getJob(jobId: string): StoredReviewJob | undefined {
      const job = jobs.get(jobId);
      return job === undefined ? undefined : { ...job };
    },

    listJobs(tenantId: string, status?: ReviewJobStatus): readonly StoredReviewJob[] {
      return [...jobs.values()]
        .filter((job) => job.tenantId === tenantId && (status === undefined || job.status === status))
        .sort((a, b) => b.submittedSeq - a.submittedSeq)
        .map((job) => ({ ...job }));
    },

    appendEvent(jobId: string, event: ReviewJobEvent): void {
      const log = events.get(jobId) ?? [];
      log.push(event);
      if (maxJobEvents !== undefined && log.length > maxJobEvents) {
        log.splice(0, log.length - maxJobEvents);
      }
      events.set(jobId, log);
    },

    readJobEvents(jobId: string, afterSeq: number): ReviewJobEventSlice | undefined {
      if (!jobs.has(jobId)) {
        return undefined;
      }
      const log = events.get(jobId) ?? [];
      const lastSeq = log.length > 0 ? log[log.length - 1]!.seq : 0;
      const firstRetainedSeq = log.length > 0 ? log[0]!.seq : lastSeq + 1;
      return {
        events: log.filter((event) => event.seq > afterSeq),
        firstRetainedSeq,
        lastSeq,
      };
    },

    loadActiveJobs(): readonly StoredReviewJob[] {
      return [...jobs.values()]
        .filter((job) => ACTIVE_STATUSES.has(job.status))
        .sort((a, b) => a.submittedSeq - b.submittedSeq)
        .map((job) => ({ ...job }));
    },

    close(): void {
      // no-op（进程内数据，无落盘面）；幂等天然成立
    },
  };
}
