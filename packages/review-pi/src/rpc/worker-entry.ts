/**
 * #31 P3b worker 入口（worker_threads 线程体，方案 §7.1）：真执行侧的
 * 线程内装配。与池（worker-pool.ts）之间的全部消息形态见 worker-protocol.ts
 * （单源）；与 in-process 适配器同构——线程内就是一组 KernelReviewRun
 * Executor（experimentId 按 job 转交），错误/进度经协议上报，父侧重建合同
 * 错误对象（Error 自定义属性不保证跨结构化克隆保真，不抛过线程边界）。
 *
 * 职责（刻意最薄）：
 * - init：resolveReviewerEndpoint（env 由池注入副本——父进程启动期已 fail
 *   fast 校验过，此处失败即 failed 报告）+ 回 ready；
 * - execute：每 job 一个 AbortController（abort 命令 → controller.abort()，
 *   协作取消由内核 runReview 的 signal 缝收口），进度经 progress 上报；
 * - 错误合同：ReviewAbortedError → failed(aborted)（取消不是失败）；其余 →
 *   failed(execution)（publicMessage 固定 generic，诊断原文只走 diagnostic
 *   上报 + diagnosticMessage 字段双通道——绝不进协议 view，spec §9）；
 * - 顶层意外（不期望到达的异常/端口关闭）：uncaughtException 守住进程面，
 *   端口关闭即静默退（父侧 close/discard 已收口）。
 */

import { parentPort, type MessagePort } from "node:worker_threads";

import { resolveReviewerEndpoint } from "../provider/reviewer-endpoint.js";
import { KernelReviewRunExecutor, ReviewExecutionError } from "./executor.js";
import { ReviewAbortedError } from "../run/review-run.js";
import type { WorkerPoolCommand, WorkerPoolFailure } from "./worker-protocol.js";

const port = parentPort;
if (port === null) {
  // 独立运行无意义（无命令流）；给清晰人话而非静默挂死
  throw new Error("worker-entry must run as a worker thread (parentPort is null)");
}

/** 实验标识 → 线程内 executor（init 一次；execute 按命令携带的 experimentId 取/建） */
const executors = new Map<string, KernelReviewRunExecutor>();
let runsRoot: string | undefined;
/** jobId → AbortController（abort 命令的路由目标） */
const controllers = new Map<string, AbortController>();

// 守卫后取非空引用（函数声明提升不保留 narrowing，统一经此通道上报）
const channel: MessagePort = port;

const fail = (failure: WorkerPoolFailure, jobId: string): void => {
  channel.postMessage({ kind: "failed", jobId, failure } as const);
};

port.on("message", (command: WorkerPoolCommand) => {
  if (command.kind === "init") {
    runsRoot = command.runsRoot;
    channel.postMessage({ kind: "ready" } as const);
    return;
  }
  if (command.kind === "abort") {
    controllers.get(command.jobId)?.abort();
    return;
  }
  // execute：线程内 executor 派发（同步入口，结算经协议上报）
  const root = runsRoot;
  if (root === undefined) {
    // 协议违约（父侧先 init 再 execute——池实现保证）；防御性合同错误
    fail({ kind: "execution", publicMessage: "review execution failed", diagnosticMessage: "worker received execute before init" }, command.jobId);
    return;
  }
  const { jobId, request, experimentId } = command;
  let executor = executors.get(experimentId);
  if (executor === undefined) {
    executor = new KernelReviewRunExecutor({
      endpoint: resolveReviewerEndpoint(),
      runsRoot: root,
      // 诊断单通道：线程内 sink 直通 port 上报（父侧池的 onDiagnostic 收口），
      // 与 in-process 适配器的 sink 行为同构——不直写线程 stderr 双份留痕
      onDiagnostic: (message) => {
        channel.postMessage({ kind: "diagnostic", message } as const);
      },
      ...(experimentId !== "reviewagent-rpc" ? { experimentIdOf: () => experimentId } : {}),
    });
    executors.set(experimentId, executor);
  }
  const controller = new AbortController();
  controllers.set(jobId, controller);
  void executor
    .execute(request, {
      jobId,
      signal: controller.signal,
      onProgress: (progress) => {
        channel.postMessage({ kind: "progress", jobId, progress } as const);
      },
    })
    .then(
      (summary) => {
        channel.postMessage({ kind: "done", jobId, summary } as const);
      },
      (error: unknown) => {
        // 取消不是失败：原样语义上报（父侧重建 ReviewAbortedError）
        if (error instanceof ReviewAbortedError) {
          fail({ kind: "aborted" }, jobId);
          return;
        }
        // 合同错误：诊断原文已由线程内 sink 单通道上报（onDiagnostic → port），
        // 此处只带重建原料——publicMessage 进协议面，diagnosticMessage 进
        // Error.message（父侧双通道），绝不进协议 view
        if (error instanceof ReviewExecutionError) {
          const diagnostic = error.message;
          fail({ kind: "execution", publicMessage: error.publicMessage, ...(diagnostic !== error.publicMessage ? { diagnosticMessage: diagnostic } : {}) }, jobId);
          return;
        }
        // 非合同异常（理论不可达——executor 内已兜底）：generic 收口
        const diagnostic = `worker unhandled execution error (job ${jobId}): ${error instanceof Error ? error.message : String(error)}`;
        channel.postMessage({ kind: "diagnostic", message: diagnostic } as const);
        fail({ kind: "execution", publicMessage: "review execution failed", diagnosticMessage: diagnostic }, jobId);
      },
    )
    .finally(() => {
      controllers.delete(jobId);
    });
});

// 端口关闭 = 池已收口（close/discard 的 terminate 在途）——静默退
port.on("close", () => {
  // no-op：worker_threads 在 port 关闭后自然退出
});

// 顶层意外兜底：不期望到达的异常不许炸线程成静默崩溃（父侧 exit 路径会把
// 在飞 job 收口成合同错误，这里再留一条诊断线）
process.on("uncaughtException", (error: Error) => {
  try {
    channel.postMessage({ kind: "diagnostic", message: `worker uncaught: ${error.message}` } as const);
  } catch {
    // port 已断（父侧先走）：无处可报，仅静默
  }
});
