/**
 * #31 P3b worker 池消息协议（方案 §7.1）：池（父线程）与 worker 入口
 * （worker-entry.ts）之间的全部消息形态。纯类型零依赖——两端共享单源，
 * 序列化走 worker_threads 结构化克隆（JSON 形态对象，无函数/句柄）。
 *
 * 生命周期序：父发 init（一次）→ worker 回 ready → execute/abort 交错 →
 * done/failed/progress/diagnostic 上报。错误不抛过线程边界（Error 自定义
 * 属性不保证克隆保真）——按判别联合报告，父侧重建合同错误对象。
 */

import type { ReviewRunProgress, ReviewRunRequest, ReviewRunSummary } from "./executor.js";

/** 父 → worker 命令 */
export type WorkerPoolCommand =
  | {
      readonly kind: "init";
      /** 产物落盘根（--out resolve 产物；转交线程内 executor） */
      readonly runsRoot: string;
    }
  | {
      readonly kind: "execute";
      readonly jobId: string;
      readonly request: ReviewRunRequest;
      /** 本 job 的实验标识（experimentIdOf 已在父侧按 jobId 派生——单源） */
      readonly experimentId: string;
    }
  | { readonly kind: "abort"; readonly jobId: string };

/**
 * 线程侧执行失败的重建原料（spec §9 安全缝跨线程版）：
 * - aborted：协作取消命中（取消不是失败）→ 父侧重建 ReviewAbortedError；
 * - execution：合同错误 → 父侧重建 ReviewExecutionError（publicMessage 进
 *   协议面，diagnosticMessage 只进 Error.message 与诊断 sink 双通道）。
 */
export type WorkerPoolFailure =
  | { readonly kind: "aborted" }
  | {
      readonly kind: "execution";
      readonly publicMessage: string;
      readonly diagnosticMessage?: string;
    };

/** worker → 父上报 */
export type WorkerPoolReport =
  | { readonly kind: "ready" }
  | { readonly kind: "progress"; readonly jobId: string; readonly progress: ReviewRunProgress }
  | { readonly kind: "diagnostic"; readonly message: string }
  | { readonly kind: "done"; readonly jobId: string; readonly summary: ReviewRunSummary }
  | { readonly kind: "failed"; readonly jobId: string; readonly failure: WorkerPoolFailure };
