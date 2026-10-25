/**
 * #22 S1 main（纯会话核心）：parse → dispatch → 单一 onOutput 缝。
 * #24 S3 追加 runRpcMain 进程面（stdin 读循环 + EOF/信号 drain）：经 RpcMainIo
 * 注入缝（PassThrough stdin / 记录 sink / EventEmitter 信号面 / fake executor）
 * 进程内驱动——退出码定序（EOF/shutdown 0、SIGINT 130、SIGTERM 143）与 drain
 * 单例语义（首触发一次性定序、drain 中二信号 no-op）在此锚定；真 bin 的
 * 进程级契约（跨进程退出码、帧纪律）另见 rpc.process.test.ts。
 * #27 v2（ADR-0013）：submit 走统一 ReviewRequest；capabilities protocolVersion
 * 2 + stdio features 声明；limits 无 repoRootEnforced。
 */

import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, realpath } from "node:fs/promises";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "vitest";

import { FakeReviewRunExecutor, fakeReviewRunSummary } from "./executor.js";
import { createRpcSession, runRpcMain, type RpcServerInfo } from "./main.js";
import { createReviewService } from "./service.js";
import { createStdioGuard, type RawStdioSink } from "./stdio-guard.js";

const FIXED_DATE = new Date("2026-10-21T00:00:00.000Z");
const fixedNow = (): Date => FIXED_DATE;

const SERVER_INFO: RpcServerInfo = {
  protocolVersion: 2,
  serverId: "review-pi",
  methods: [
    "server.capabilities",
    "review.submit",
    "review.get",
    "review.list",
    "review.cancel",
    "shutdown",
  ],
  features: {
    sse: false,
    artifactDownload: false,
    idempotency: false,
    listFilters: ["status"],
    defaultRepo: "cwd",
    diffKinds: ["file", "inline"],
  },
  limits: {
    maxDiffBytes: 8 * 1024 * 1024,
    maxQueueDepth: 100,
    maxRepoFiles: 20_000,
    maxRepoBytes: 512 * 1024 * 1024,
    concurrency: 1,
  },
};

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rpc-session-"));
  return realpath(dir);
}

const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface SessionHarness {
  readonly session: ReturnType<typeof createRpcSession>;
  readonly executor: FakeReviewRunExecutor;
  readonly outputLines: string[];
}

function makeSession(): SessionHarness {
  const executor = new FakeReviewRunExecutor();
  const outputLines: string[] = [];
  const service = createReviewService({ executor, now: fixedNow });
  const session = createRpcSession({
    service,
    serverInfo: SERVER_INFO,
    onOutput: (line) => outputLines.push(line),
  });
  return { session, executor, outputLines };
}

test("session：server.capabilities → 协议版本/方法表/limits（单行 JSONL）", async () => {
  const { session, outputLines } = makeSession();

  await session.handleLine('{"jsonrpc":"2.0","id":1,"method":"server.capabilities"}');

  expect(outputLines).toEqual([
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: SERVER_INFO })}\n`,
  ]);
});

test("in-process 全链路：submit→get→list→cancel(终态幂等)→shutdown；事件 seq 单调；shutdown 后拒单 -32010", async () => {
  const { session, executor, outputLines } = makeSession();
  const repo = await makeTmpDir();
  const jobId = `job-${FIXED_DATE.getTime()}-1`;
  const submitRequest = (id: number): string =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "review.submit",
      params: {
        caseId: "VUL4J-1",
        repoPath: repo,
        diff: { kind: "inline", text: "--- a\n+++ b\n" },
        configId: "E",
      },
    });

  await session.handleLine('{"jsonrpc":"2.0","id":1,"method":"server.capabilities"}');
  await session.handleLine(submitRequest(2));
  await flushAsync();
  executor.executions[0]!.resolve(fakeReviewRunSummary({ runId: "run-1" }));
  await flushAsync();
  await session.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "review.get", params: { jobId } }),
  );
  await session.handleLine('{"jsonrpc":"2.0","id":4,"method":"review.list"}');
  await session.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 5, method: "review.cancel", params: { jobId } }),
  );
  await session.handleLine('{"jsonrpc":"2.0","id":6,"method":"shutdown"}');

  // 输出纪律：每行单 JSON 文档 + LF 结尾
  for (const line of outputLines) {
    expect(line.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(line)).not.toThrow();
  }

  const responsesById = new Map<
    number,
    { result?: unknown; error?: { code?: number }; id?: number; method?: string; params?: unknown }
  >();
  const events: Array<{ seq: number; job: { status: string } }> = [];
  for (const line of outputLines) {
    const document = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number };
    };
    if (document.method === "review.event") {
      events.push(document.params as { seq: number; job: { status: string } });
    } else if (typeof document.id === "number") {
      responsesById.set(document.id, document);
    }
  }

  expect(responsesById.get(2)?.result).toMatchObject({ jobId, status: "queued" });
  expect(responsesById.get(3)?.result).toMatchObject({
    jobId,
    status: "succeeded",
    result: { runId: "run-1" },
  });
  expect(responsesById.get(4)?.result).toMatchObject({
    jobs: [{ jobId, status: "succeeded" }],
  });
  // 终态 cancel：幂等返回终态 view（-32005 保留码不发射）
  expect(responsesById.get(5)?.result).toMatchObject({ jobId, status: "succeeded" });
  // shutdown 响应先回，drain 后行
  expect(responsesById.get(6)?.result).toEqual({ status: "shutdown" });
  // 事件序：状态转移点，seq 连接级单调
  expect(events.map((event) => [event.seq, event.job.status])).toEqual([
    [1, "running"],
    [2, "succeeded"],
  ]);

  // shutdown 后继续发单 → server_draining
  await session.handleLine(submitRequest(7));
  const lastLine = outputLines[outputLines.length - 1]!;
  expect(JSON.parse(lastLine)).toMatchObject({
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32010 },
  });
});

test("session：错误映射——parse -32700(id:null) / 未知方法 -32601 / 参数违例 -32602 / 未知 job -32001", async () => {
  const { session, outputLines } = makeSession();

  await session.handleLine("{not json");
  await session.handleLine('{"jsonrpc":"2.0","id":2,"method":"bogus.method"}');
  await session.handleLine('{"jsonrpc":"2.0","id":3,"method":"review.get","params":{}}');
  await session.handleLine('{"jsonrpc":"2.0","id":4,"method":"review.get","params":{"jobId":"job-x"}}');

  const parsed = outputLines.map((line) => JSON.parse(line));
  expect(parsed.map((document) => [document.id, document.error?.code])).toEqual([
    [null, -32700],
    [2, -32601],
    [3, -32602],
    [4, -32001],
  ]);
});

test("session：内部异常 → -32603 固定文案（异常 message 不进协议面）", async () => {
  const outputLines: string[] = [];
  const stubService: Parameters<typeof createRpcSession>[0]["service"] = {
    submit: async () => {
      throw new Error("D:\\secret\\internal\\path is broken");
    },
    get: async () => undefined,
    list: async () => ({ jobs: [] }),
    cancel: async () => {
      throw new Error("unreachable");
    },
    readEvents: async () => undefined,
    artifacts: async () => undefined,
    subscribe: () => () => {},
    close: async () => {},
    isDraining: () => false,
    limits: { maxDiffBytes: 1, maxQueueDepth: 1, maxRepoFiles: 1, maxRepoBytes: 1 },
  };
  const session = createRpcSession({
    service: stubService,
    serverInfo: SERVER_INFO,
    onOutput: (line) => outputLines.push(line),
  });

  await session.handleLine(
    '{"jsonrpc":"2.0","id":1,"method":"review.submit","params":{"caseId":"C","repoPath":"r","diff":{"kind":"inline","text":"d"},"configId":"A"}}',
  );

  expect(JSON.parse(outputLines[0]!)).toEqual({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "Internal error" },
  });
  // 异常 message（含路径细节）绝不进协议面
  expect(outputLines[0]!.includes("secret")).toBe(false);
});

test("组合装配：session 输出缝接 stdio-guard——协议行只进 raw stdout，接管面直写改道 stderr（stdout 纯度）", async () => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutSink: RawStdioSink = {
    write: (chunk: string | Buffer, callback?: (error?: Error | null) => void) => {
      stdoutChunks.push(String(chunk));
      callback?.(null);
      return true;
    },
  };
  const stderrSink: RawStdioSink = {
    write: (chunk: string | Buffer, callback?: (error?: Error | null) => void) => {
      stderrChunks.push(String(chunk));
      callback?.(null);
      return true;
    },
  };
  const guard = createStdioGuard({ stdout: stdoutSink, stderr: stderrSink });
  guard.takeOverStdout();
  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor, now: fixedNow });
  const session = createRpcSession({
    service,
    serverInfo: SERVER_INFO,
    onOutput: (line) => guard.writeRawStdout(line),
  });

  await session.handleLine('{"jsonrpc":"2.0","id":1,"method":"server.capabilities"}');
  await guard.flushRawStdout();

  // 协议流：恰好一行 capabilities 响应 + flush 的零字节冲写（S3 真 bin 装配同构）
  expect(stdoutChunks).toEqual([
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: SERVER_INFO })}\n`,
    "",
  ]);

  // 故意写非协议诊断（模拟 console.log / 第三方库直写 stdout）→ 改道 stderr，
  // 协议流零混入
  stdoutSink.write("diagnostic: something happened\n");
  expect(stderrChunks).toEqual(["diagnostic: something happened\n"]);
  expect(stdoutChunks).toHaveLength(2); // 协议行 + 零字节冲写，无诊断混入
});

// ---- runRpcMain 进程面（#24 S3：stdin 循环 + EOF/信号 drain，注入缝驱动）----

interface RpcMainHarness {
  readonly stdin: PassThrough;
  readonly stdoutWrites: string[];
  readonly stderrWrites: string[];
  readonly signals: EventEmitter;
  readonly executor: FakeReviewRunExecutor;
  /** runRpcMain 的 resolve 值 = 进程退出码 */
  readonly exited: Promise<number>;
}

/**
 * 进程内装配 runRpcMain：全注入缝替身（无真 I/O、无真 endpoint）——
 * PassThrough 作命令流、记录 sink 接协议输出（flush 的零字节写也在场，可断言
 * flush 发生/跳过）、EventEmitter 作信号面（emit 即信号到达）、fake executor
 * 挂起控制 running job。
 */
async function makeRpcMain(): Promise<RpcMainHarness> {
  const stdin = new PassThrough();
  const makeRecordingSink = (writes: string[]): RawStdioSink => ({
    write: (chunk: string | Buffer, callback?: (error?: Error | null) => void) => {
      writes.push(String(chunk));
      callback?.(null);
      return true;
    },
  });
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];
  const signals = new EventEmitter();
  const executor = new FakeReviewRunExecutor();
  const exited = runRpcMain(
    { out: await makeTmpDir(), concurrency: 1 },
    {
      stdin,
      stdout: makeRecordingSink(stdoutWrites),
      stderr: makeRecordingSink(stderrWrites),
      endpoint: { baseUrl: "http://rpc-test.invalid", apiKey: "test-rpc-key" },
      executor,
      signals,
      nowMs: () => FIXED_DATE.getTime(),
    },
  );
  return { stdin, stdoutWrites, stderrWrites, signals, executor, exited };
}

/** 发一行 JSON-RPC 命令（LF 结尾，与真宿主写序一致） */
const sendLine = (h: RpcMainHarness, document: unknown): void => {
  h.stdin.write(`${JSON.stringify(document)}\n`);
};

/** stdoutWrites（含 flush 的零字节冲写）→ 协议文档数组 */
function protocolDocuments(h: RpcMainHarness): Array<Record<string, unknown>> {
  return h.stdoutWrites
    .filter((write) => write.length > 0)
    .map((write) => JSON.parse(write) as Record<string, unknown>);
}

/** 轮询等待谓词为真（fake executor 挂起驱动的异步推进点） */
async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("runRpcMain 进程面（S3：stdin 循环 + EOF/信号 drain，注入缝驱动）", () => {
  test("stdin EOF → 已读入行处理完（in-flight 边界）→ drain → flush → 0", async () => {
    const h = await makeRpcMain();
    sendLine(h, { jsonrpc: "2.0", id: 1, method: "server.capabilities" });
    // 不等行处理落定就 EOF——drain 必须快照并等完 in-flight 行（reader 的
    // data 事件先于 end，行处理已在 inFlight 集内）
    h.stdin.end();

    expect(await h.exited).toBe(0);

    // 已读入的命令处理完：capabilities 响应在场（统一契约 v2）
    expect(
      protocolDocuments(h).some(
        (document) => document.id === 1 && (document.result as RpcServerInfo | undefined)?.protocolVersion === 2,
      ),
    ).toBe(true);
    // flush 面：drain 收尾的零字节冲写是最后一步写
    expect(h.stdoutWrites[h.stdoutWrites.length - 1]).toBe("");
  });

  test("shutdown → 响应先回 → 服务端 drain 自退（stdin 不 end）→ flush → 0", async () => {
    const h = await makeRpcMain();
    sendLine(h, { jsonrpc: "2.0", id: 1, method: "shutdown" });

    expect(await h.exited).toBe(0);
    expect(
      protocolDocuments(h).some(
        (document) =>
          document.id === 1 && (document.result as { status?: string } | undefined)?.status === "shutdown",
      ),
    ).toBe(true);
    expect(h.stdoutWrites[h.stdoutWrites.length - 1]).toBe("");
  });

  test("SIGINT → 130，信号路径跳过 stdout flush（宿主可能已停读）", async () => {
    const h = await makeRpcMain();
    sendLine(h, { jsonrpc: "2.0", id: 1, method: "server.capabilities" });
    await flushAsync();
    h.signals.emit("SIGINT");

    expect(await h.exited).toBe(130);
    // 无零字节冲写（flush 跳过）；已有协议行不受影响
    expect(h.stdoutWrites.includes("")).toBe(false);
    expect(
      protocolDocuments(h).some((document) => document.id === 1),
    ).toBe(true);
  });

  test("SIGTERM → 143，信号路径跳过 stdout flush", async () => {
    const h = await makeRpcMain();
    sendLine(h, { jsonrpc: "2.0", id: 1, method: "server.capabilities" });
    await flushAsync();
    h.signals.emit("SIGTERM");

    expect(await h.exited).toBe(143);
    expect(h.stdoutWrites.includes("")).toBe(false);
  });

  test("drain 进行中第二信号 no-op：首触发一次性定序不被覆写（M1 拍板）", async () => {
    const h = await makeRpcMain();
    const repo = await makeTmpDir();
    sendLine(h, {
      jsonrpc: "2.0",
      id: 1,
      method: "review.submit",
      params: {
        caseId: "VUL4J-1",
        repoPath: repo,
        diff: { kind: "inline", text: "--- a\n+++ b\n" },
        configId: "E",
      },
    });
    // 等执行真挂起（fake executor 挂住 = running job 在飞）
    await waitFor(() => h.executor.executions.length === 1, "the executor to pick up the job");

    // 首触发 SIGINT：drain 开闸（service.close 等 running job 落定），同时
    // runDrain 同步前奏已注销全部信号处理器
    h.signals.emit("SIGINT");
    await flushAsync();
    await flushAsync();
    // drain 中到达的第二信号：处理器已注销，emit 无效果——若存在「覆写退出
    // 码」路径，此处会把 130 改写成 143
    h.signals.emit("SIGTERM");

    // running job 落定 → drain 收尾：退出码仍是首触发定死的 130
    h.executor.executions[0]!.resolve(fakeReviewRunSummary({ runId: "run-1" }));
    expect(await h.exited).toBe(130);
    expect(h.stdoutWrites.includes("")).toBe(false);
  });
});
