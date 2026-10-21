/**
 * #22 S1 main（纯会话核心）：parse → dispatch → 单一 onOutput 缝。
 * 本票不含进程 I/O（stdin/stdout 接线、信号、退出码是 S3 的真 bin 面）；
 * in-process 全链路测试在这里驱动全部六个方法。
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, realpath } from "node:fs/promises";

import { expect, test } from "vitest";

import { FakeReviewRunExecutor, fakeReviewRunSummary } from "./executor.js";
import { createRpcSession, type RpcServerInfo } from "./main.js";
import { createReviewService } from "./service.js";
import { createStdioGuard, type RawStdioSink } from "./stdio-guard.js";

const FIXED_DATE = new Date("2026-10-21T00:00:00.000Z");
const fixedNow = (): Date => FIXED_DATE;

const SERVER_INFO: RpcServerInfo = {
  protocolVersion: 1,
  serverId: "review-pi",
  methods: [
    "server.capabilities",
    "review.submit",
    "review.get",
    "review.list",
    "review.cancel",
    "shutdown",
  ],
  limits: {
    maxDiffBytes: 8 * 1024 * 1024,
    maxQueueDepth: 100,
    concurrency: 1,
    repoRootEnforced: false,
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
      params: { caseId: "VUL4J-1", repoPath: repo, diff: "--- a\n+++ b\n", configId: "E" },
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
    get: () => undefined,
    list: () => ({ jobs: [] }),
    cancel: async () => {
      throw new Error("unreachable");
    },
    subscribe: () => () => {},
    close: async () => {},
    isDraining: () => false,
    limits: { maxDiffBytes: 1, maxQueueDepth: 1 },
  };
  const session = createRpcSession({
    service: stubService,
    serverInfo: SERVER_INFO,
    onOutput: (line) => outputLines.push(line),
  });

  await session.handleLine(
    '{"jsonrpc":"2.0","id":1,"method":"review.submit","params":{"caseId":"C","repoPath":"r","diff":"d","configId":"A"}}',
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
