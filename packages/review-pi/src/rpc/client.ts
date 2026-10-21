/**
 * #24 S3 client：stdio JSONL 长驻模式（ADR-0012）的宿主侧客户端。
 *
 * 宿主（评测驱动器 / 未来的 IDE 扩展或 MCP 网关）持有一个 ReviewRpcClient：
 * start() spawn 真 bin（review-pi rpc）长驻，六方法 typed 请求 + review.event
 * 事件订阅，stop() 优雅收口。机制对齐 pi
 * `packages/coding-agent/src/modes/rpc/rpc-client.ts`，本仓差异：
 * - stdout 读侧用自家 jsonl reader（LF-only——通用行读取器会按 U+2028/
 *   U+2029 断行，协议在写侧不转义这俩字符，读侧必须禁 readline）；
 * - stderr 累积有界（滚动尾段 8KB，错误消息只引尾段），可选实时转发宿主
 *   stderr（转发不改累积语义）；
 * - 停止升级链按平台分支：POSIX 独立进程组（组 SIGTERM → 组 SIGKILL）；
 *   Windows 无信号语义，taskkill /T /F 树杀（防孤儿 node 进程——本机历史
 *   教训：kill 壳进程后 node 子进程幸存继续跑）。
 *
 * 错误面三层：
 * - RpcResponseError：服务端正常回了 error 响应（协议错误码透传，含
 *   -32001 job_not_found 等应用层错误）——请求完成，不是进程事故；
 * - 单请求超时（requestTimeoutMs，缺省 30s）：只 reject 该请求，不杀进程
 *   （长检视合法地慢，超时语义由宿主决定）；
 * - 进程面事故（spawn 失败 / 意外退出 / stdin EPIPE）：reject 全部 pending，
 *   消息含退出码与 stderr 尾段。
 *
 * 生命周期：start 一次（再 start 抛错；客户端不设计成可重启——进程身份、
 * 事件 seq、stderr 上下文都绑进程）。宿主必须 stop()（或先 shutdown() 再
 * stop()）；弃用不 stop = 服务端进程泄漏（宿主崩溃时子进程独立存续，与 pi
 * 同语义——升级链只在宿主主动 stop 时生效）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { RpcServerInfo } from "./main.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import { RPC_METHOD, type ReviewJobStatus, type SubmitReviewParams } from "./protocol.js";
import type { ReviewJobEvent, ReviewJobView } from "./service.js";

/** stderr 滚动缓冲上限（错误消息只引尾段；长跑服务端的 stderr 不无限累积） */
const STDERR_TAIL_LIMIT = 8_192;

/** 单请求响应超时缺省（spec #21 §5：超时 reject 该请求不杀进程） */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** stop() 升级链缺省：EOF 优雅等待（drain 可能要等 running job 落定） */
const DEFAULT_STOP_EOF_TIMEOUT_MS = 10_000;

/** stop() 升级链缺省：SIGTERM（POSIX）后等待 drain 退出的上限 */
const DEFAULT_STOP_TERM_TIMEOUT_MS = 5_000;

/** SIGKILL / taskkill 终结后的兜底等待 */
const FINAL_KILL_WAIT_MS = 2_000;

/** 服务端 error 响应的透传形态（code/message/data；spec §5 错误码表） */
export class RpcResponseError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcResponseError";
  }
}

export interface ReviewRpcClientOptions {
  /** spawn 可执行文件（缺省 process.execPath；测试注入 `node -e` fake server 时同值） */
  readonly command?: string;
  /** 整参覆盖（缺省 [command, binPath, "rpc", ...rpcArgs]；测试 fake server 全量替换） */
  readonly args?: readonly string[];
  /** bin 路径覆盖（缺省包内 bin/review-pi.js——src 与 dist 同深度解析） */
  readonly binPath?: string;
  /** 子进程 cwd（rpc 的 .env.local 解析与相对 --out 基准） */
  readonly cwd?: string;
  /** 附加环境变量（合并到 process.env 之上；哨兵 key 等注入面） */
  readonly env?: Record<string, string>;
  /** rpc 子命令附加旗标（--out / --repo-root / --concurrency） */
  readonly rpcArgs?: readonly string[];
  /** 单请求响应超时毫秒（缺省 30s；计时起点 = send() 调用——含写队列排队时间，大 diff 背压下后续请求可能一行未发即计时；超时只 reject 该请求） */
  readonly requestTimeoutMs?: number;
  /** stop() EOF 优雅等待上限（缺省 10s；running job 的 drain 可更久，宿主按需调大） */
  readonly stopEofTimeoutMs?: number;
  /** stop() SIGTERM（POSIX）后等待上限（缺省 5s；Windows 无此级——直接树杀） */
  readonly stopTermTimeoutMs?: number;
  /** stderr 是否实时转发到宿主 stderr（缺省仅累积） */
  readonly stderrForward?: boolean;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** 退出快照（getExitInfo 供宿主与测试断言退出码契约） */
export interface RpcProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class ReviewRpcClient {
  private readonly options: ReviewRpcClientOptions;
  private readonly requestTimeoutMs: number;
  private readonly stopEofTimeoutMs: number;
  private readonly stopTermTimeoutMs: number;

  private child: ChildProcess | undefined;
  private exitInfo: RpcProcessExit | undefined;
  private exitError: Error | undefined;
  private detachStdoutReader: (() => void) | undefined;

  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: ReviewJobEvent) => void>();
  /** 写序 = 调用序：单写队列串行化（backpressure 等 drain 不打乱后续请求） */
  private writeQueue: Promise<void> = Promise.resolve();
  private requestCounter = 0;
  private stderrBuffer = "";

  constructor(options: ReviewRpcClientOptions = {}) {
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.stopEofTimeoutMs = options.stopEofTimeoutMs ?? DEFAULT_STOP_EOF_TIMEOUT_MS;
    this.stopTermTimeoutMs = options.stopTermTimeoutMs ?? DEFAULT_STOP_TERM_TIMEOUT_MS;
  }

  /**
   * spawn 服务端进程并挂读面。给一轮事件循环让 spawn error / 立即退出先
   * 落地——fail fast 在 start 面就给人话（而非拖到首个请求的 reject）。
   */
  async start(): Promise<void> {
    if (this.child !== undefined) {
      throw new Error("review-pi rpc client: already started (client is single-use)");
    }
    const binPath = this.options.binPath ?? fileURLToPath(new URL("../../bin/review-pi.js", import.meta.url));
    const command = this.options.command ?? process.execPath;
    const args =
      this.options.args ?? [binPath, "rpc", ...(this.options.rpcArgs ?? [])];
    const child = spawn(command, args, {
      ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX：独立进程组——升级面按组发信号（bin + 内核派生的 rg 等子进程
      // 一并收口）；Windows 无进程组语义，树杀走 taskkill /T
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child = child;

    child.once("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.rejectAllPending(this.fatalProcessError());
    });
    child.once("error", (error) => {
      this.exitError = new Error(`review-pi rpc process failed to start: ${error.message}`);
      this.rejectAllPending(this.exitError);
    });
    // stdin EPIPE（服务端已退后再写）等——不上抛成宿主 uncaught，落 pending 面
    child.stdin?.on("error", (error) => {
      this.exitError ??= new Error(`review-pi rpc stdin error: ${error.message}`);
      this.rejectAllPending(this.fatalProcessError());
    });
    // stdout 读面错误（Windows named pipe 对端异常终止可发 ECONNRESET）——
    // 流 error 无监听会同步上抛成宿主 uncaught；收进 pending 面
    child.stdout?.on("error", (error) => {
      this.exitError ??= new Error(`review-pi rpc stdout error: ${error.message}`);
      this.rejectAllPending(this.fatalProcessError());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrBuffer = (this.stderrBuffer + text).slice(-STDERR_TAIL_LIMIT);
      if (this.options.stderrForward === true) {
        process.stderr.write(text);
      }
    });
    this.detachStdoutReader = attachJsonlLineReader(child.stdout, (line) => this.onStdoutLine(line));

    await new Promise<void>((resolve) => setImmediate(resolve));
    if (this.exitError !== undefined) {
      await this.cleanup();
      throw this.exitError;
    }
    if (this.exitInfo !== undefined) {
      const error = this.fatalProcessError();
      await this.cleanup();
      throw error;
    }
  }

  /** server.capabilities → 协议版本 / serverId / 方法表 / limits */
  capabilities(): Promise<RpcServerInfo> {
    return this.send<RpcServerInfo>(RPC_METHOD.CAPABILITIES);
  }

  /** review.submit → 排队后的 job 快照（status queued） */
  submit(params: SubmitReviewParams): Promise<ReviewJobView> {
    return this.send<ReviewJobView>(RPC_METHOD.SUBMIT, params);
  }

  /** review.get → job 快照；不存在抛 RpcResponseError(-32001) */
  get(jobId: string): Promise<ReviewJobView> {
    return this.send<ReviewJobView>(RPC_METHOD.GET, { jobId });
  }

  /** review.list → 快照全集（可选按状态过滤；缺席省 params 键） */
  list(status?: ReviewJobStatus): Promise<{ readonly jobs: readonly ReviewJobView[] }> {
    return this.send<{ jobs: readonly ReviewJobView[] }>(
      RPC_METHOD.LIST,
      status !== undefined ? { status } : undefined,
    );
  }

  /** review.cancel → cancelling/cancelled 快照；不存在抛 RpcResponseError(-32001) */
  cancel(jobId: string): Promise<ReviewJobView> {
    return this.send<ReviewJobView>(RPC_METHOD.CANCEL, { jobId });
  }

  /** shutdown → 响应后服务端 drain 自退（宿主随后 stop() 收口读面即可） */
  shutdown(): Promise<{ readonly status: string }> {
    return this.send<{ status: string }>(RPC_METHOD.SHUTDOWN);
  }

  /** review.event 订阅（返回退订函数）；监听器异常不扯断读循环 */
  onEvent(listener: (event: ReviewJobEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** stderr 滚动尾段（有界 8KB；诊断用，不含协议面） */
  getStderr(): string {
    return this.stderrBuffer;
  }

  /** 进程退出快照（未退 = undefined；宿主/测试断言退出码契约用） */
  getExitInfo(): RpcProcessExit | undefined {
    return this.exitInfo;
  }

  /**
   * 停止服务端，三级升级：
   * 1. stdin EOF（优雅）——服务端 drain（取消 queued、等 running、flush）
   *    后自然退 0。running job 未落定超时则升级；
   * 2. POSIX：进程组 SIGTERM——空闲态走内核 drain 跳过 flush 退 143；若
   *    drain 已在进行（处理器已注销）则走默认处置即死，128+n 退出码由
   *    bin 的 close 映射保证。Windows 无信号语义（kill() 即硬杀），直接
   *    taskkill /T /F 树杀（即第 3 级）；
   * 3. POSIX：进程组 SIGKILL（终结）。
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      return;
    }
    if (this.exitInfo !== undefined || this.exitError !== undefined) {
      await this.cleanup();
      return;
    }
    try {
      child.stdin?.end();
    } catch {
      // stdin 已毁——进程将自行退出，走升级链等待
    }
    if (await this.waitForExit(this.stopEofTimeoutMs)) {
      await this.cleanup();
      return;
    }
    if (process.platform === "win32") {
      await treeKillWindows(child.pid);
    } else if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // 进程组已消失——exit 事件在路上
      }
    }
    if (await this.waitForExit(this.stopTermTimeoutMs)) {
      await this.cleanup();
      return;
    }
    if (process.platform === "win32") {
      await treeKillWindows(child.pid);
    } else if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // 进程组已消失
      }
    }
    await this.waitForExit(FINAL_KILL_WAIT_MS);
    await this.cleanup();
  }

  // ---- 内部面 ----

  /** stdout 一行 = 一个 JSON 文档：id 关联响应，review.event 分发事件 */
  private onStdoutLine(line: string): void {
    let document: unknown;
    try {
      document = JSON.parse(line);
    } catch {
      return; // 非协议行忽略（防御：服务端 stdout 契约是每行恰好一个 JSON）
    }
    if (!isRecord(document)) {
      return;
    }
    const id = document.id;
    if (typeof id === "string") {
      const pending = this.pendingRequests.get(id);
      if (pending !== undefined) {
        this.pendingRequests.delete(id);
        settlePending(pending, document);
        return;
      }
      // 无 pending 的响应 = 超时后的迟到响应，忽略
    }
    if (document.method === "review.event") {
      const params = document.params;
      if (isRecord(params) && isRecord(params.job) && typeof params.seq === "number" && typeof params.job.jobId === "string" && typeof params.job.status === "string") {
        const event = params as unknown as ReviewJobEvent;
        for (const listener of [...this.eventListeners]) {
          try {
            listener(event);
          } catch {
            // 宿主监听器异常不扯断读循环
          }
        }
      }
    }
  }

  /** 发请求：pending 先入表，写经单队列（写序 = 调用序），超时只拒自身 */
  private send<T>(method: string, params?: unknown): Promise<T> {
    const stdin = this.child?.stdin;
    if (this.child === undefined || stdin == null) {
      throw new Error("review-pi rpc client: not started (call start() first)");
    }
    if (this.exitInfo !== undefined || this.exitError !== undefined) {
      throw this.fatalProcessError();
    }
    const id = `req-${(this.requestCounter += 1)}`;
    const request = {
      jsonrpc: "2.0" as const,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const payload = serializeJsonLine(request);

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `review-pi rpc: no response to ${method} (id ${id}) within ${this.requestTimeoutMs}ms. Stderr tail: ${this.stderrTail()}`,
          ),
        );
      }, this.requestTimeoutMs);
      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.writeQueue = this.writeQueue.then(async () => {
        try {
          await this.writeLine(payload);
        } catch (error) {
          const pending = this.pendingRequests.get(id);
          if (pending !== undefined) {
            this.pendingRequests.delete(id);
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
    });
  }

  /** 写一行（backpressure：drain 前不返回——大 diff 请求不无限积压内存） */
  private async writeLine(line: string): Promise<void> {
    const stdin = this.child?.stdin;
    if (stdin == null || stdin.destroyed || !stdin.writable) {
      throw this.fatalProcessError();
    }
    if (stdin.write(line)) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(this.fatalProcessError(error));
      };
      const cleanup = (): void => {
        stdin.off("drain", onDrain);
        stdin.off("error", onError);
      };
      stdin.once("drain", onDrain);
      stdin.once("error", onError);
    });
  }

  /** 进程事故消息：退出态 + stderr 尾段（人话排障锚点） */
  private fatalProcessError(cause?: Error): Error {
    if (this.exitError !== undefined) {
      return new Error(`review-pi rpc process error: ${this.exitError.message}. Stderr tail: ${this.stderrTail()}`, { cause });
    }
    const state =
      this.exitInfo !== undefined
        ? `exited (code=${this.exitInfo.code} signal=${this.exitInfo.signal ?? "null"})`
        : "is no longer running";
    return new Error(`review-pi rpc process ${state}. Stderr tail: ${this.stderrTail()}`, { cause });
  }

  private stderrTail(): string {
    const tail = this.stderrBuffer.trim();
    return tail.length > 0 ? tail : "(empty)";
  }

  private rejectAllPending(error: Error): void {
    const pending = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const request of pending) {
      request.reject(error);
    }
  }

  /** exit 事件在 timeoutMs 内落地 → true（exitInfo 已由 start 挂的监听先置位） */
  private waitForExit(timeoutMs: number): Promise<boolean> {
    const child = this.child;
    if (child === undefined || this.exitInfo !== undefined) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once("exit", onExit);
    });
  }

  /** 读面收口（不杀进程——进程终结由 stop 升级链负责；幂等） */
  private async cleanup(): Promise<void> {
    this.detachStdoutReader?.();
    this.detachStdoutReader = undefined;
  }
}

/** 响应落定：error 成员存在 = error 响应（RpcResponseError 透传 code/data） */
function settlePending(pending: PendingRequest, document: Record<string, unknown>): void {
  const error = document.error;
  if (isRecord(error)) {
    pending.reject(
      new RpcResponseError(
        typeof error.code === "number" ? error.code : -32603,
        typeof error.message === "string" ? error.message : "unknown error",
        error.data,
      ),
    );
    return;
  }
  pending.resolve(document.result);
}

/** Windows 树杀（终结级）：taskkill /T 连孙进程一并收口——kill(pid) 只杀壳会孤儿化 node 子进程 */
function treeKillWindows(pid: number | undefined): Promise<void> {
  if (pid === undefined) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => resolve());
    killer.once("close", () => resolve());
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
