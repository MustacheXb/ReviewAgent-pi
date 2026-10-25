/**
 * #22 S1 / #24 S3 main：rpc 子命令的会话核心与进程装配。
 *
 * S1 交付纯会话核心 createRpcSession：parse（protocol）→ dispatch → 全部输出
 * （响应 + review.event 通知）经单一 onOutput 缝——进程内可测，无 stdin/stdout
 * 依赖。S3（runRpcMain）在其外包进程面：endpoint fail fast、service/executor
 * 装配、stdio-guard 接管、stdin LF-only 读循环（jsonl reader）、EOF/信号 drain。
 *
 * shutdown 语义（spec §2.3）：先回响应 → 停止收单（draining，submit → -32010）
 * → 取消 queued → 等 running → 由进程面退出。事件通知与响应同缝，天然保序。
 *
 * #27 v2（ADR-0013）：submit 参数切统一 `ReviewRequest`（validateReviewRequest
 * 单源校验）；`CallContext` 贯穿 service 全方法（stdio 面合成 local principal，
 * requestId 逐请求生成）；capabilities `protocolVersion` 2 + `features` 按形态
 * 声明差异（stdio：sse/artifactDownload/idempotency=false、listFilters=
 * ["status"]、defaultRepo="cwd"）；--repo-root/allowlist 装配移除换 --cwd
 * （repoPath 缺省值，缺席省键 = service 回退 process.cwd()）。
 *
 * 退出语义（spec §1 表，128+信号号惯例——pi 同款，本仓加 SIGINT）：
 * - shutdown / stdin EOF → 排空已读入的命令 → drain → flush → 0；
 * - SIGINT → 130 / SIGTERM → 143 / SIGHUP（非 win32）→ 129——信号路径跳过
 *   stdout flush（信号到达时宿主可能已停读，flush 会卡死；pi 实证）；
 * - 启动失败 / stdout 写失败 → 1（cli/main.ts reportErrorAndExit / stdio-guard）。
 *
 * 「已读入」边界 = stdin reader 已 emit 的行；drain 排空 in-flight 行处理后
 * close（取消 queued、等 running）。Windows 退出纪律（cli/main.ts exitGracefully
 * 实证）：runRpcMain 只做 flush（如适用）后返回退出码，process.exitCode 置码与
 * 自然排干（含 8s unref 兜底）由 cli/main.ts 统一施加——真跑过 fetch 后立即
 * process.exit 与句柄清理竞态会崩 0xC0000409。
 */

import { resolve } from "node:path";
import type { Readable } from "node:stream";

import type { RpcCliArgs } from "../cli/args.js";
import { resolveReviewerEndpoint, type ReviewerEndpoint } from "../provider/reviewer-endpoint.js";
import { localCallContext, type CallContext } from "./context.js";
import { KernelReviewRunExecutor, type ReviewRunExecutor } from "./executor.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import {
  JSON_RPC_ERROR,
  RPC_METHOD,
  RpcError,
  errorResponse,
  eventNotification,
  parseIncomingLine,
  successResponse,
  validateCancelParams,
  validateGetParams,
  validateListParams,
  validateReviewRequest,
  type JsonRpcId,
  type RpcFeatures,
} from "./protocol.js";
import type { ReviewService } from "./service.js";
import { createReviewService } from "./service.js";
import { createStdioGuard, type RawStdioSink } from "./stdio-guard.js";

/**
 * stdio v2 能力声明（ADR-0013 中性后果项——按形态声明差异，客户端据此降级）：
 * 无 SSE / 产物下载 / 幂等（#28 起 HTTP 面 sse=artifactDownload=idempotency=true）；
 * list 只支持 status 过滤；repoPath 省略时缺省来自 cwd；diff 双 kind。
 */
const STDIO_RPC_FEATURES: RpcFeatures = {
  sse: false,
  artifactDownload: false,
  idempotency: false,
  listFilters: ["status"],
  defaultRepo: "cwd",
  diffKinds: ["file", "inline"],
};

/** server.capabilities payload（spec §4/§5：协议版本、serverId、方法表、features、limits；S3 装配时 limits 从 service 派生） */
export interface RpcServerInfo {
  /** spec §4：协议版本为数字（v2 = 2，统一契约代数——ADR-0013 决策 3） */
  readonly protocolVersion: number;
  readonly serverId: string;
  readonly methods: readonly string[];
  /** 按形态声明的能力差异（stdio 见 STDIO_RPC_FEATURES；HTTP #28 起另声明） */
  readonly features: RpcFeatures;
  readonly limits: {
    readonly maxDiffBytes: number;
    readonly maxQueueDepth: number;
    /** 仓库规模准入（#31，方案 §7.3）：submit 期普通文件数 / 累计字节上限 */
    readonly maxRepoFiles?: number;
    readonly maxRepoBytes?: number;
    readonly concurrency: number;
    /** HTTP 面专属（#28）：请求 body 上限；stdio 无传输上限概念——缺席省键 */
    readonly maxBodyBytes?: number;
    /** HTTP 面专属（#29）：产物保留窗口天数（succeeded 落定起算；stdio 无下载面） */
    readonly artifactRetentionDays?: number;
  };
}

export interface RpcSessionOptions {
  readonly service: ReviewService;
  readonly serverInfo: RpcServerInfo;
  /** 单一输出缝：协议行（含换行）由此离开会话——S3 接 stdio-guard raw 写 */
  readonly onOutput: (line: string) => void;
}

export interface RpcSession {
  /** 处理一行入站命令（空行已在 jsonl framing 层忽略）；响应/事件经 onOutput */
  handleLine(line: string): Promise<void>;
}

export function createRpcSession(options: RpcSessionOptions): RpcSession {
  const { service, serverInfo, onOutput } = options;

  const write = (document: unknown): void => {
    onOutput(serializeJsonLine(document));
  };

  // job 事件 → review.event 通知（与响应同一输出缝，写队列保序）。会话级
  // ctx：stdio 单会话单 local principal，全租户事件 = 本租户事件
  service.subscribe((event) => write(eventNotification(event)), localCallContext("rpc-events"));

  // stdio 面合成 local principal（ADR-0013 决策 5）：requestId 逐请求生成
  // （日志/审计锚点，service 不解释）
  let requestCounter = 0;
  const nextContext = (): CallContext => {
    requestCounter += 1;
    return localCallContext(`rpc-${requestCounter}`);
  };

  const dispatch = async (id: JsonRpcId, method: string, params: unknown): Promise<void> => {
    switch (method) {
      case RPC_METHOD.CAPABILITIES: {
        write(successResponse(id, serverInfo));
        return;
      }
      case RPC_METHOD.SUBMIT: {
        const validation = validateReviewRequest(params);
        if (!validation.ok) {
          writeRpcError(id, validation.error);
          return;
        }
        write(successResponse(id, await service.submit(validation.value, nextContext())));
        return;
      }
      case RPC_METHOD.GET: {
        const validation = validateGetParams(params);
        if (!validation.ok) {
          writeRpcError(id, validation.error);
          return;
        }
        const view = await service.get(validation.value.jobId, nextContext());
        if (view === undefined) {
          write(
            errorResponse(
              id,
              JSON_RPC_ERROR.JOB_NOT_FOUND,
              `Unknown job: ${validation.value.jobId}`,
              { jobId: validation.value.jobId },
            ),
          );
          return;
        }
        write(successResponse(id, view));
        return;
      }
      case RPC_METHOD.LIST: {
        const validation = validateListParams(params);
        if (!validation.ok) {
          writeRpcError(id, validation.error);
          return;
        }
        write(successResponse(id, await service.list(validation.value, nextContext())));
        return;
      }
      case RPC_METHOD.CANCEL: {
        const validation = validateCancelParams(params);
        if (!validation.ok) {
          writeRpcError(id, validation.error);
          return;
        }
        write(
          successResponse(id, await service.cancel(validation.value.jobId, nextContext())),
        );
        return;
      }
      case RPC_METHOD.SHUTDOWN: {
        // 先回响应，再 drain（spec §2.3）；drain 期间事件继续经输出缝流出
        write(successResponse(id, { status: "shutdown" }));
        await service.close();
        return;
      }
      default: {
        write(errorResponse(id, JSON_RPC_ERROR.METHOD_NOT_FOUND, `Method not found: ${method}`));
        return;
      }
    }
  };

  const writeRpcError = (id: JsonRpcId, error: RpcError): void => {
    write(errorResponse(id, error.code, error.message, error.data));
  };

  return {
    async handleLine(line: string): Promise<void> {
      const parsed = parseIncomingLine(line);
      if (parsed.kind === "error") {
        write(errorResponse(parsed.id, parsed.error.code, parsed.error.message));
        return;
      }
      try {
        await dispatch(parsed.id, parsed.method, parsed.params);
      } catch (error) {
        if (error instanceof RpcError) {
          writeRpcError(parsed.id, error);
          return;
        }
        // 内部异常：固定文案（message 可能携带路径/内部细节，不进协议面——spec §9）
        write(errorResponse(parsed.id, JSON_RPC_ERROR.INTERNAL_ERROR, "Internal error"));
      }
    },
  };
}

// ---- S3 进程面（#24：stdin 读循环 + EOF/信号 drain）----

/** 信号 → 退出码映射（128+信号号惯例；SIGHUP 仅非 win32 注册/可达） */
const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
} as const;

/** 信号面抽象：process 天然满足；测试注入受控触发器（EventEmitter）模拟信号 */
export interface RpcSignalTarget {
  on(signal: NodeJS.Signals, handler: () => void): unknown;
  off(signal: NodeJS.Signals, handler: () => void): unknown;
}

/**
 * runRpcMain 的注入缝（缺省全真）：stdin/stdout/stderr/信号面给进程内测试
 * 替身；endpoint/executor 缺省走真装配（endpoint 启动期解析一次、真适配器
 * runsRoot = resolve(--out)），测试注入 fake executor 时完全离线。
 */
export interface RpcMainIo {
  /** 命令流（缺省 process.stdin） */
  readonly stdin?: Readable;
  /** 协议流目标（缺省 process.stdout——经 stdio-guard 接管） */
  readonly stdout?: RawStdioSink;
  /** 诊断改道目标（缺省 process.stderr） */
  readonly stderr?: RawStdioSink;
  /** 已解析接入点（缺省 resolveReviewerEndpoint()——缺 key 上抛由调用方退 1） */
  readonly endpoint?: ReviewerEndpoint;
  /** 执行器（缺省 KernelReviewRunExecutor——runReview 的唯一调用方） */
  readonly executor?: ReviewRunExecutor;
  /** 信号面（缺省 process） */
  readonly signals?: RpcSignalTarget;
  /** serverId 启动毫秒单源（缺省 Date.now） */
  readonly nowMs?: () => number;
}

/**
 * rpc 进程面主缝：装配（endpoint → executor/service → stdio-guard → session）
 * → stdin LF-only 读循环 → 长驻。resolve 值 = 进程退出码（shutdown/EOF 0、
 * SIGINT 130、SIGTERM 143、SIGHUP 129）；启动失败经异常上抛 → cli/main.ts
 * reportErrorAndExit → 1。进程退出（exitCode 置码 + 事件循环自然排干 +
 * 8s unref 兜底）由 cli/main.ts exitGracefully 统一施加（Windows 纪律）。
 */
export async function runRpcMain(args: RpcCliArgs, io: RpcMainIo = {}): Promise<number> {
  const endpoint = io.endpoint ?? resolveReviewerEndpoint();
  const executor =
    io.executor ??
    new KernelReviewRunExecutor({
      endpoint,
      runsRoot: resolve(args.out),
    });
  const service = createReviewService({
    executor,
    concurrency: args.concurrency,
    // --cwd 仅覆盖 repoPath 缺省值（缺席省键 = service 回退 process.cwd()；
    // 「omit to discover, provide to override」，ADR-0013 决策 3）
    ...(args.cwd !== undefined ? { defaultRepoPath: args.cwd } : {}),
  });
  const serverInfo: RpcServerInfo = {
    protocolVersion: 2,
    serverId: `${process.pid}-${(io.nowMs ?? Date.now)()}`,
    methods: [
      RPC_METHOD.CAPABILITIES,
      RPC_METHOD.SUBMIT,
      RPC_METHOD.GET,
      RPC_METHOD.LIST,
      RPC_METHOD.CANCEL,
      RPC_METHOD.SHUTDOWN,
    ],
    features: STDIO_RPC_FEATURES,
    limits: {
      maxDiffBytes: service.limits.maxDiffBytes,
      maxQueueDepth: service.limits.maxQueueDepth,
      maxRepoFiles: service.limits.maxRepoFiles,
      maxRepoBytes: service.limits.maxRepoBytes,
      concurrency: args.concurrency,
    },
  };

  // stdout 接管：此后一切绕过协议层的直写（console.log / 第三方库）改道 stderr。
  // 尾链致命写失败不立即 process.exit（缺省行为——Windows 0xC0000409 竞态：
  // 真 fetch 在飞时立即 exit 与 undici/AbortSignal 句柄清理撞车）；改走 drain
  // 收场退 1（跳 flush——stdout 已坏，再 flush 只会再失败）
  const guard = createStdioGuard({
    ...(io.stdout !== undefined ? { stdout: io.stdout } : {}),
    ...(io.stderr !== undefined ? { stderr: io.stderr } : {}),
    onFatalError: () => triggerDrain(1, false),
  });
  guard.takeOverStdout();
  const session = createRpcSession({
    service,
    serverInfo,
    onOutput: (line) => guard.writeRawStdout(line),
  });

  // in-flight 行处理跟踪 = drain 的「已读入」边界。行处理并发（pi rpc-mode
  // 同款 fire-and-forget——响应按完成序写出）；每行收尾等写队列 backpressure，
  // 宿主停读 stdout 时消费自然降速，不无限积压。
  const inFlight = new Set<Promise<void>>();
  const handleLine = async (line: string): Promise<void> => {
    await session.handleLine(line);
    await guard.waitForRawStdoutBackpressure();
    // shutdown 方法落定（响应已回、close 已 await）→ 进程面 drain 收尾。
    // isDraining 只由 close 置位：drain 自身的 close 触发此处时为幂等 no-op
    // （drain 定序由首个触发者一次性定死，非首触发不改判）。
    if (service.isDraining()) {
      triggerDrain(0, true);
    }
  };
  const onLine = (line: string): void => {
    // handleLine 内部全兜底（session catch-all + 写队列尾链不 reject）；
    // 此处 catch 只是防意外逃逸成 unhandledRejection 的护栏
    const handling = handleLine(line).catch(() => undefined);
    inFlight.add(handling);
    void handling.finally(() => {
      inFlight.delete(handling);
    });
  };

  // drain 单例：首个触发者一次性定序（EOF/shutdown → 0+flush；信号 →
  // 128+n+跳过 flush——宿主可能已停读，flush 只会卡死）；非首触发一律
  // no-op。drain 开闸即注销信号处理器（runDrain 同步前奏），此后到达的
  // 信号走默认处置（进程即死，128+n 退出码由 bin 的 close 映射保证——
  // 与 pi 上游 rpc-mode 同语义），不存在「drain 进行中覆写退出码」的路径。
  let drainState: { code: number; flush: boolean } | undefined;
  let settleExit!: (code: number) => void;
  const exited = new Promise<number>((resolvePromise) => {
    settleExit = resolvePromise;
  });

  const detachStdin = (() => {
    // 先挂 reader 再挂 end 监听：reader 的 onEnd（尾行冲刷）先于 EOF drain
    // 触发运行，尾行进 inFlight 后 drain 才快照
    const detachReader = attachJsonlLineReader(io.stdin ?? process.stdin, onLine);
    const onStdinEnd = (): void => {
      triggerDrain(0, true);
    };
    (io.stdin ?? process.stdin).on("end", onStdinEnd);
    return () => {
      detachReader();
      (io.stdin ?? process.stdin).off("end", onStdinEnd);
    };
  })();

  const signalCleanup: Array<() => void> = [];
  const registerSignal = (signal: NodeJS.Signals, code: number): void => {
    const handler = (): void => {
      triggerDrain(code, false);
    };
    (io.signals ?? process).on(signal, handler);
    signalCleanup.push(() => (io.signals ?? process).off(signal, handler));
  };

  const runDrain = async (): Promise<void> => {
    // 信号处理只负责首触发；drain 开闸后注销，重复信号不再进 handler
    for (const cleanup of signalCleanup.splice(0)) {
      cleanup();
    }
    detachStdin();
    (io.stdin ?? process.stdin).pause();
    while (inFlight.size > 0) {
      await Promise.all([...inFlight]);
    }
    // settleExit 必须无条件执行：exited 永悬 = cli/main.ts 的 then 不落定、
    // 8s 兜底不挂——只能靠 unhandledRejection 崩溃救场（时序不定）。
    // close / flush 的失败面就地收口为 1（契约：内部错误 / stdout 写失败
    // → 1）；flushRawStdout 的零字节直写绕过尾链 catch，EPIPE 在此上抛。
    let exitCode = drainState?.code ?? 1;
    try {
      await service.close();
    } catch {
      exitCode = 1;
    }
    if (drainState?.flush) {
      try {
        await guard.flushRawStdout();
      } catch {
        exitCode = 1;
      }
    }
    settleExit(exitCode);
  };

  const triggerDrain = (code: number, flush: boolean): void => {
    if (drainState === undefined) {
      drainState = { code, flush };
      void runDrain();
    }
  };

  registerSignal("SIGINT", SIGNAL_EXIT_CODES.SIGINT);
  registerSignal("SIGTERM", SIGNAL_EXIT_CODES.SIGTERM);
  if (process.platform !== "win32") {
    registerSignal("SIGHUP", SIGNAL_EXIT_CODES.SIGHUP);
  }

  // 长驻：drain 落定（EOF/shutdown/信号）前不 resolve；事件循环由 stdin
  // 流与信号监听保活
  return exited;
}
