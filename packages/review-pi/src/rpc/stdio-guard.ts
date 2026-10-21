/**
 * #22 S1 stdio-guard：stdout 接管 + raw 写队列 + backpressure（spec #21 §2/§9、
 * ADR-0012 决策 2——pi output-guard 等价物）。
 *
 * 机制等价自 pi `packages/coding-agent/src/core/output-guard.ts`（锚定 6671c604，
 * 与 checkout HEAD 间逐字节零变化——机制层稳定）。与 pi 的形态差异：pi 是模块级
 * 单例，直接替换 process.stdout.write；本仓改为工厂 + 可注入 sink——单测无需
 * 劫持真实 process.stdout（vitest worker 的 reporter 依赖它），机制语义不变：
 *
 * - 接管后任何绕过协议层的 stdout 直写（console.log / 第三方库）改道 stderr，
 *   stdout 只留协议文档；
 * - 协议输出走 writeRawStdout 的 promise 尾链（保序），非阻塞错误
 *   （ENOBUFS/EAGAIN/EWOULDBLOCK）按 pi 实证节奏 10ms 重试；
 * - 退出前 waitForRawStdoutBackpressure / flushRawStdout 排干写队列。
 */

/** 最小写面：process.stdout/stderr 与测试假 sink 共同满足的形状 */
export interface RawStdioSink {
  write(chunk: string | Buffer, callback?: (error?: Error | null) => void): boolean;
}

/** pi RAW_STDOUT_RETRY_DELAY_MS 同值 */
const RAW_STDOUT_RETRY_DELAY_MS = 10;

export interface StdioGuardOptions {
  /** 协议流目标；缺省 process.stdout */
  readonly stdout?: RawStdioSink;
  /** 诊断改道目标；缺省 process.stderr */
  readonly stderr?: RawStdioSink;
  /** 非阻塞写错误的重试间隔；缺省 10ms */
  readonly retryDelayMs?: number;
  /** 写队列致命失败的处置（pi 为 process.exit(1)）；缺省同 pi */
  readonly onFatalError?: (error: unknown) => void;
}

export interface StdioGuard {
  takeOverStdout(): void;
  restoreStdout(): void;
  isStdoutTakenOver(): boolean;
  writeRawStdout(text: string): void;
  waitForRawStdoutBackpressure(): Promise<void>;
  flushRawStdout(): Promise<void>;
}

interface TakeoverState {
  readonly rawStdoutWrite: RawStdioSink["write"];
  readonly rawStderrWrite: RawStdioSink["write"];
  readonly originalStdoutWrite: RawStdioSink["write"];
}

export function createStdioGuard(options: StdioGuardOptions = {}): StdioGuard {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const retryDelayMs = options.retryDelayMs ?? RAW_STDOUT_RETRY_DELAY_MS;
  const onFatalError = options.onFatalError ?? ((error: unknown) => {
    // pi 同款：stdout 写失败即协议面不可恢复（宿主可能已消失）
    void error;
    process.exit(1);
  });

  let takeoverState: TakeoverState | undefined;
  let rawStdoutWriteTail: Promise<void> = Promise.resolve();

  return {
    takeOverStdout(): void {
      if (takeoverState) return;
      const state: TakeoverState = {
        rawStdoutWrite: stdout.write.bind(stdout),
        rawStderrWrite: stderr.write.bind(stderr),
        originalStdoutWrite: stdout.write.bind(stdout),
      };
      takeoverState = state;
      // 接管：此后一切直接 stdout 写（console.log / 第三方库）改道 stderr。
      // pi 同款三参判型分派：write(chunk, callback) 与 write(chunk, encoding, callback)
      // 两种调用形态都不得丢回调（丢回调 = 等待 flush 的调用方永久挂起）。
      stdout.write = ((
        chunk: string | Buffer,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ): boolean => {
        if (typeof encodingOrCallback === "function") {
          return state.rawStderrWrite(String(chunk), encodingOrCallback);
        }
        return state.rawStderrWrite(String(chunk), callback);
      }) as typeof stdout.write;
    },

    restoreStdout(): void {
      if (!takeoverState) return;
      const state = takeoverState;
      takeoverState = undefined;
      stdout.write = state.originalStdoutWrite as typeof stdout.write;
    },

    isStdoutTakenOver(): boolean {
      return takeoverState !== undefined;
    },

    writeRawStdout(text: string): void {
      if (text.length === 0) return;
      const state = takeoverState;
      if (!state) return;
      // pi 同款 fire-and-forget 尾链：保序追加，致命失败走 onFatalError
      rawStdoutWriteTail = rawStdoutWriteTail
        .then(() => writeRawStdoutChunk(state.rawStdoutWrite, text, retryDelayMs))
        .catch((error: unknown) => {
          onFatalError(error);
        });
    },

    async waitForRawStdoutBackpressure(): Promise<void> {
      // 尾链在等待期间不再增长即视为稳定（pi 同款循环）
      while (true) {
        const tail = rawStdoutWriteTail;
        await tail;
        if (tail === rawStdoutWriteTail) return;
      }
    },

    async flushRawStdout(): Promise<void> {
      // pi 同款：backpressure 稳定后补一次零字节写，确保底层句柄 flush
      const state = takeoverState;
      if (!state) return;
      while (true) {
        const tail = rawStdoutWriteTail;
        await tail;
        if (tail === rawStdoutWriteTail) {
          await writeRawStdoutChunk(state.rawStdoutWrite, "", retryDelayMs);
          return;
        }
      }
    },
  };
}

/** 单次 raw 写：非阻塞错误（ENOBUFS/EAGAIN/EWOULDBLOCK）按节奏重试，其余上抛 */
function writeRawStdoutChunk(
  write: RawStdioSink["write"],
  text: string,
  retryDelayMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const attempt = (): void => {
      write(text, (error?: Error | null) => {
        if (isNonBlockingWriteError(error)) {
          setTimeout(attempt, retryDelayMs);
          return;
        }
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    };
    attempt();
  });
}

function isNonBlockingWriteError(error: Error | null | undefined): boolean {
  if (!error) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOBUFS" || code === "EAGAIN" || code === "EWOULDBLOCK";
}
