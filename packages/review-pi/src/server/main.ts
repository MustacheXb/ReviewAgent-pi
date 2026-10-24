/**
 * #28 server 子命令的进程面（方案 §4.1）：装配（token 文件 fail fast →
 * endpoint 启动期解析 → executor/service → HTTP server）→ listen → 长驻 →
 * 信号 drain。与 rpc/main.ts runRpcMain 同构的退出纪律：resolve 值 = 进程
 * 退出码，exitCode 置码 + 自然排干 + 8s unref 兜底由 cli/main.ts
 * exitGracefully 统一施加（Windows 0xC0000409 竞态实证）。
 *
 * 启动顺序（spec）：token 文件校验 → .env.local（cli/main.ts 已装载）→
 * endpoint 解析（REVIEWER_URL / REVIEWER_API_KEY 仅启动期从环境注入一次——
 * 客户端不可传 apiKey / 任意 baseUrl，防 SSRF）→ listen（HOST / PORT 环境
 * 变量可覆盖缺省；显式旗标优先）。
 *
 * 退出码：SIGINT 130 / SIGTERM 143 / 启动失败（token 文件、endpoint、端口
 * 占用等）异常上抛 → cli reportErrorAndExit → 1。drain 序：停收新连接
 * （server.close + closeIdleConnections）→ service.close（取消 queued、等
 * running 落定）→ settle；drain 开闸即注销信号处理器，重复信号走默认处置。
 *
 * HOST / PORT 优先级：显式旗标 > HOST / PORT 环境变量 > 127.0.0.1:8787。
 * 环境变量坏值（PORT 非端口数）fail fast 在 parse 层（cli/args.ts）。
 */

import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import type { ServerCliArgs } from "../cli/args.js";
import { resolveReviewerEndpoint, type ReviewerEndpoint } from "../provider/reviewer-endpoint.js";
import { RPC_METHOD } from "../rpc/protocol.js";
import { KernelReviewRunExecutor, type ReviewRunExecutor } from "../rpc/executor.js";
import type { RpcServerInfo, RpcSignalTarget } from "../rpc/main.js";
import { createReviewService } from "../rpc/service.js";
import { createTokenFileAuthenticator, type Authenticator } from "./auth.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  HTTP_RPC_FEATURES,
  createReviewHttpServer,
  type AccessLogEvent,
  type InternalErrorLogEvent,
} from "./http-server.js";
import { createIdempotencyKeeper } from "./idempotency.js";

/** 信号 → 退出码（128+信号号惯例；与 rpc/main.ts 同表） */
const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
} as const;

/** access log 缺省落点：stderr 单行 JSON（白名单字段——见 AccessLogEvent） */
function defaultAccessLogSink(event: AccessLogEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

/** 内部异常日志缺省落点：stderr 单行 JSON（500 面——name/message 之外不携带） */
function defaultInternalErrorSink(event: InternalErrorLogEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

export interface ServerMainIo {
  /** 已解析接入点（缺省 resolveReviewerEndpoint()——缺 key 上抛退 1） */
  readonly endpoint?: ReviewerEndpoint;
  /** 执行器（缺省 KernelReviewRunExecutor——runReview 唯一调用方；测试注入 fake） */
  readonly executor?: ReviewRunExecutor;
  /** 信号面（缺省 process） */
  readonly signals?: RpcSignalTarget;
  /** listen 落定缝（缺省 stderr 一行；demo/e2e 以此为就绪信号） */
  readonly onListening?: (address: { readonly host: string; readonly port: number }) => void;
  /** access log 缝（缺省 stderr JSON 行） */
  readonly onAccessLog?: (event: AccessLogEvent) => void;
  /** 内部异常日志缝（缺省 stderr JSON 行——500 面对运维可见） */
  readonly onInternalError?: (event: InternalErrorLogEvent) => void;
  /** serverId 启动毫秒单源（缺省 Date.now） */
  readonly nowMs?: () => number;
}

/**
 * server 进程面主缝：装配 + listen + 长驻 + 信号 drain。resolve 值 = 进程
 * 退出码；启动失败经异常上抛 → cli/main.ts reportErrorAndExit → 1。
 */
export async function runServerMain(args: ServerCliArgs, io: ServerMainIo = {}): Promise<number> {
  // 1. token 文件 fail fast（缺文件 / 非法内容拒启动——authenticator 构造期全量校验）
  const authenticator: Authenticator = createTokenFileAuthenticator({ tokenFile: args.authTokenFile });

  // 2. endpoint 启动期解析一次（环境注入面；key 绝不进日志 / 错误 / capabilities）
  const endpoint = io.endpoint ?? resolveReviewerEndpoint();

  // 3. service 装配（executor 经端口注入内核——server 子树不 import run/ 内件）
  const executor =
    io.executor ??
    new KernelReviewRunExecutor({
      endpoint,
      runsRoot: resolve(args.out),
    });
  const service = createReviewService({ executor, concurrency: args.concurrency });
  const serverInfo: RpcServerInfo = {
    protocolVersion: 2,
    serverId: `${process.pid}-${(io.nowMs ?? Date.now)()}`,
    // HTTP 方法表不含 shutdown（进程生命周期归运维信号面——ADR-0013 决策 9）
    methods: [
      RPC_METHOD.CAPABILITIES,
      RPC_METHOD.SUBMIT,
      RPC_METHOD.GET,
      RPC_METHOD.LIST,
      RPC_METHOD.CANCEL,
    ],
    features: HTTP_RPC_FEATURES,
    limits: {
      maxDiffBytes: service.limits.maxDiffBytes,
      maxQueueDepth: service.limits.maxQueueDepth,
      concurrency: args.concurrency,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    },
  };

  const server = createReviewHttpServer({
    service,
    authenticator,
    idempotency: createIdempotencyKeeper(),
    serverInfo,
    limits: { maxBodyBytes: DEFAULT_MAX_BODY_BYTES },
    onAccessLog: io.onAccessLog ?? defaultAccessLogSink,
    onInternalError: io.onInternalError ?? defaultInternalErrorSink,
  });

  // 4. listen + 信号 drain（单例：首个触发者定序；开闸即注销，重复信号走默认处置）。
  // 信号注册先于 listen——启动途中（bind 进行时）到达的信号同样要触发 drain，
  // 不允许「listen 竞态窗口吞 SIGTERM」。listen 途中 drain 有专门收口：
  // pending listen 期间 close() 会让 listen 与 close 双双永久悬挂（Node 实证），
  // 因此 drain 抢先时跳过优雅 close、直接 unref 解除保活，bind 结果不再有意义。
  let drainCode: number | undefined;
  let settleExit!: (code: number) => void;
  const exited = new Promise<number>((resolvePromise) => {
    settleExit = resolvePromise;
  });

  /** listen 三态（对象属性形态：闭包赋值 + 跨 await 读取，TS 流分析不窄化）：pending → listening（就绪）/ error（bind 失败）/ drained（drain 抢先收口） */
  const listenState: { outcome: "pending" | "listening" | "error" | "drained" } = { outcome: "pending" };
  let settleListen!: () => void;
  let failListen!: (error: Error) => void;
  const listenSettled = new Promise<void>((resolveListen, rejectListen) => {
    settleListen = resolveListen;
    failListen = rejectListen;
  });

  const runDrain = async (code: number): Promise<void> => {
    for (const cleanup of signalCleanup.splice(0)) {
      cleanup();
    }
    if (listenState.outcome === "pending") {
      // drain 抢在 listening 前：bind 结果无意义，收口 listen 等待并解除
      // 事件循环保活（进程退出交由 cli/main.ts exitGracefully 的兜底强退）
      listenState.outcome = "drained";
      server.unref();
      settleListen();
    } else {
      // 停收新连接（keep-alive idle 连接一并断）；in-flight 请求毫秒级落定
      // （submit 202 即返、get/list/cancel 即时查询——无等 job 的长请求面）
      server.closeIdleConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    let exitCode = code;
    try {
      await service.close(); // 取消 queued、等 running 落定
    } catch {
      exitCode = 1;
    }
    settleExit(exitCode);
  };

  const signalCleanup: Array<() => void> = [];
  const registerSignal = (signal: NodeJS.Signals, code: number): void => {
    const handler = (): void => {
      if (drainCode === undefined) {
        drainCode = code;
        void runDrain(code);
      }
    };
    (io.signals ?? process).on(signal, handler);
    signalCleanup.push(() => (io.signals ?? process).off(signal, handler));
  };
  registerSignal("SIGINT", SIGNAL_EXIT_CODES.SIGINT);
  registerSignal("SIGTERM", SIGNAL_EXIT_CODES.SIGTERM);

  // 5. listen（端口占用等绑定失败异常上抛 → 退 1）
  const onListenError = (error: Error): void => {
    if (listenState.outcome !== "pending") {
      return; // drain 已收口（unref 后 bind 失败迟到——不影响退出序）
    }
    listenState.outcome = "error";
    server.off("listening", onListenReady);
    failListen(error);
  };
  const onListenReady = (): void => {
    if (listenState.outcome !== "pending") {
      return; // drain 已抢先（防御——unref 不撤 listening 事件）
    }
    listenState.outcome = "listening";
    server.off("error", onListenError);
    settleListen();
  };
  server.once("error", onListenError);
  server.once("listening", onListenReady);
  server.listen(args.port, args.host);
  await listenSettled;
  if (listenState.outcome === "listening") {
    const address = server.address() as AddressInfo;
    const reportListening =
      io.onListening ??
      ((bound: { readonly host: string; readonly port: number }): void => {
        process.stderr.write(`reviewagent: http server listening on http://${bound.host}:${bound.port}\n`);
      });
    reportListening({ host: address.address, port: address.port });
  }

  // 长驻：drain 落定前不 resolve；事件循环由 server 监听保活
  return exited;
}
