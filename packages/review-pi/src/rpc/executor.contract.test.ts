import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

import { PHASE_ORDER } from "../loop/phases.js";
import { sseBody, type FakeReply } from "../provider/fake-fetch.js";
import { repoFixturePath } from "../testing/repos.js";
import {
  SAMPLE_DIFF,
  configDToolCorpus,
  expectEmptyTree,
  sixPhaseNoToolCorpus,
  tempRunsRoot,
} from "../testing/seam-fixtures.js";
import { ensureFreshDistArtifacts } from "../testing/dist-self-heal.js";
import type { DistArtifactLockRelease } from "../testing/dist-artifact-lock.js";
import { collectFiles } from "../testing/scan-files.js";
import { ReviewAbortedError } from "../run/review-run.js";
import { KernelReviewRunExecutor, ReviewExecutionError } from "./executor.js";
import type { ReviewRunExecutor, ReviewRunProgress } from "./executor.js";
import { WorkerPoolReviewExecutor } from "./worker-pool.js";

// #31 P3b executor 同构契约测试套（issue #31 AC：「worker 池适配器与
// in-process executor 跑同一契约测试套」）。同一套测试对两个工厂各跑一遍：
// - in-process：KernelReviewRunExecutor（`--executor inprocess` 逃生口的真身），
//   globalThis.fetch 直连回环 stub 网关（真 HTTP 传输层，非 fakeFetch）；
// - worker-pool：WorkerPoolReviewExecutor + 编译产物 dist/rpc/worker-entry.ts
//   （真线程体：resolveReviewerEndpoint + 线程内 KernelReviewRunExecutor），
//   凭据经 env 注入线程。
//
// 契约面（两实现必须不可区分的行为）：
// - 成功投影：summary 口径 + 磁盘真源独立对照 + 落盘位形（experimentId 缺省
//   恒 reviewagent-rpc / experimentIdOf 注入按 job 隔离）；
// - 错误合同：publicMessage 固定 generic，诊断细节（Error.message 载体 + sink）
//   同串双通道，绝不进协议面；失败 run 零落盘；
// - 取消不是失败：运行中 abort（挂住网关）→ ReviewAbortedError 原样语义、
//   零落盘、零诊断；
// - progress 透传：onProgress 观测缝（相位边界事件）不变。
//
// worker-pool 专有面（并发隔离 / 硬取消宽限 terminate / 崩溃替换 / close
// 语义）在 worker-pool.test.ts（假入口替身）——本套只锁两实现共享的端口契约。
// 哨兵纪律同 #7：key 只允许出现在 Authorization 头；诊断面与落盘面全量扫描。

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER_ENTRY = path.join(packageDir, "dist", "rpc", "worker-entry.js");

/** 哨兵 key：只该进 Authorization 头；出现在任何诊断/落盘面即失败 */
const SENTINEL_KEY = "sk-contract-sentinel-4c1f";

/** 文件级 dist 产物锁（worker-pool 变体 spawn 真 worker 线程体——判鲜/重建/回拨互斥） */
let releaseDistLock: DistArtifactLockRelease | undefined;

beforeAll(async () => {
  releaseDistLock = await ensureFreshDistArtifacts();
  if (!existsSync(WORKER_ENTRY)) {
    throw new Error(`worker entry missing after self-heal build: ${WORKER_ENTRY}`);
  }
}, 600_000);

afterAll(() => {
  releaseDistLock?.();
});

// ---- 回环 stub 网关（真 HTTP 传输层；SSE 渲染单源 sseBody）----

interface StubRequestRecord {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
}

interface LoopbackStub {
  readonly baseUrl: string;
  readonly requests: () => readonly StubRequestRecord[];
  readonly close: () => Promise<void>;
}

function stubServer(
  onRequest: (request: http.IncomingMessage, response: http.ServerResponse, log: StubRequestRecord) => void,
): Promise<LoopbackStub> {
  const requests: StubRequestRecord[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const record: StubRequestRecord = {
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization ?? "",
      };
      requests.push(record);
      onRequest(request, response, record);
    });
  });
  return new Promise<LoopbackStub>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests: () => requests.map((record) => ({ ...record })),
        close: () =>
          new Promise<void>((closed) => {
            server.closeAllConnections?.();
            server.close(() => closed());
          }),
      });
    });
  });
}

/** 脚本回放 stub：POST /v1/chat/completions 依序回放 SSE；脚本耗尽 → 500 */
function startScriptedStub(replies: readonly FakeReply[]): Promise<LoopbackStub> {
  const queue = [...replies];
  return stubServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const reply = queue.shift();
      if (reply === undefined) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "stub: scripted replies exhausted" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sseBody(reply));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `stub: unexpected ${request.method} ${request.url}` } }));
  });
}

/** 挂住 stub：回 SSE 头但永不 end——取消只能靠内核 abort（运行中取消面） */
function startHangingStub(): Promise<LoopbackStub> {
  return stubServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      return; // 永不 end
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `stub: unexpected ${request.method} ${request.url}` } }));
  });
}

// ---- 契约夹具：两工厂同形 ----

interface ContractFixture {
  readonly executor: ReviewRunExecutor;
  readonly diagnostics: string[];
  readonly runsRoot: string;
  readonly requests: () => readonly StubRequestRecord[];
  readonly dispose: () => Promise<void>;
}

interface FixtureOptions {
  readonly stub: LoopbackStub;
  readonly runsRoot: string;
  readonly experimentIdOf?: (jobId: string) => string;
}

type ContractExecutorFactory = (options: FixtureOptions) => ContractFixture;

/** in-process 工厂：globalThis.fetch 直连回环 stub（无注入传输层） */
const inProcessFactory: ContractExecutorFactory = ({ stub, runsRoot, experimentIdOf }) => {
  const diagnostics: string[] = [];
  const executor = new KernelReviewRunExecutor({
    endpoint: { baseUrl: stub.baseUrl, apiKey: SENTINEL_KEY },
    runsRoot,
    ...(experimentIdOf !== undefined ? { experimentIdOf } : {}),
    onDiagnostic: (message) => {
      diagnostics.push(message);
    },
  });
  return {
    executor,
    diagnostics,
    runsRoot,
    requests: stub.requests,
    dispose: async () => {
      await stub.close();
    },
  };
};

/** worker-pool 工厂：真编译线程体 + env 注入凭据（生产默认形态的等价装配） */
const workerPoolFactory: ContractExecutorFactory = ({ stub, runsRoot, experimentIdOf }) => {
  const diagnostics: string[] = [];
  const pool = new WorkerPoolReviewExecutor({
    size: 1,
    workerEntry: WORKER_ENTRY,
    runsRoot,
    env: { ...process.env, REVIEWER_URL: stub.baseUrl, REVIEWER_API_KEY: SENTINEL_KEY },
    // vitest fork 以 `--conditions source` 等旗标启动——Worker 继承会把依赖
    // 解析改道 TS 源码；显式剥离回干净旗标面（生产进程 execArgv 通常为空）
    execArgv: [],
    abortGraceMs: 5_000,
    ...(experimentIdOf !== undefined ? { experimentIdOf } : {}),
    onDiagnostic: (message) => {
      diagnostics.push(message);
    },
  });
  return {
    executor: pool,
    diagnostics,
    runsRoot,
    requests: stub.requests,
    dispose: async () => {
      await pool.close();
      await stub.close();
    },
  };
};

const BASE_REQUEST = {
  caseId: "VUL4J-1",
  repoPath: repoFixturePath("sample"),
  diff: SAMPLE_DIFF,
  issueDescription: "Issue description under review.",
} as const;

/** 轮询等待谓词为真（worker 线程启动/模块装载是秒级异步推进点） */
async function waitFor(predicate: () => boolean, description: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 哨兵纪律断言：Authorization 头全数命中 + 诊断/落盘面零泄漏 */
function expectSentinelDiscipline(fixture: ContractFixture): void {
  const requests = fixture.requests();
  expect(requests.length).toBeGreaterThan(0);
  for (const record of requests) {
    expect(record.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
  }
  expect(fixture.diagnostics.some((message) => message.includes(SENTINEL_KEY))).toBe(false);
  for (const file of collectFiles(fixture.runsRoot)) {
    expect(readFileSync(file, "utf8").includes(SENTINEL_KEY)).toBe(false);
  }
}

/** 同构契约套：两工厂各跑一遍（断言逐字同形——分叉即端口契约破口） */
function contractSuite(variant: string, factory: ContractExecutorFactory): void {
  test(`[${variant}] 成功投影：summary 口径 + 磁盘真源 + 落盘位形（experimentId 恒 reviewagent-rpc）+ 哨兵纪律`, async () => {
    const stub = await startScriptedStub(configDToolCorpus());
    const fixture = factory({ stub, runsRoot: tempRunsRoot("rpc-contract-success-") });
    try {
      const summary = await fixture.executor.execute(
        { ...BASE_REQUEST, configId: "D" },
        { jobId: "job-contract-1", signal: new AbortController().signal },
      );

      // 摘要口径（config D：1 轮、1 次工具调用、零 usage、未截断）
      expect(summary.runId).not.toBe("");
      expect(summary.findings).toEqual([]);
      expect(summary.rounds).toBe(1);
      expect(summary.toolCalls).toBe(1);
      expect(summary.truncated).toBe(false);
      expect(summary.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });

      // 磁盘真源独立对照（非自证等值）：record.baseline 与 summary 同值
      const record = JSON.parse(readFileSync(summary.recordPath, "utf8")) as {
        readonly baseline: {
          readonly findings: readonly unknown[];
          readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
          readonly rounds: number;
          readonly toolCalls: number;
          readonly audit: { readonly truncated: boolean };
        };
      };
      expect(record.baseline.findings).toEqual(summary.findings);
      expect(record.baseline.usage).toEqual(summary.usage);
      expect(record.baseline.rounds).toBe(summary.rounds);
      expect(record.baseline.toolCalls).toBe(summary.toolCalls);
      expect(record.baseline.audit.truncated).toBe(summary.truncated);

      // 落盘位形：experimentId 缺省恒 reviewagent-rpc、rep-1
      const audit = JSON.parse(readFileSync(summary.auditPath, "utf8")) as { readonly runId: string };
      expect(audit.runId).toBe(summary.runId);
      expect(summary.recordPath).toBe(
        path.join(fixture.runsRoot, "reviewagent-rpc", "runs", "vul4j", "VUL4J-1", "D", "rep-1.json"),
      );
      expect(summary.auditPath).toContain(
        path.join(fixture.runsRoot, "reviewagent-rpc", "audit", "vul4j", "VUL4J-1", "D", "rep-1", "audit"),
      );

      expectSentinelDiscipline(fixture);
    } finally {
      await fixture.dispose();
    }
  }, 120_000);

  test(`[${variant}] experimentIdOf 注入：产物目录按 job 隔离（sqlite 装配形态）`, async () => {
    const stub = await startScriptedStub(configDToolCorpus());
    const jobId = "job-1700000000000-7";
    const fixture = factory({
      stub,
      runsRoot: tempRunsRoot("rpc-contract-jobid-"),
      experimentIdOf: (id) => id,
    });
    try {
      const summary = await fixture.executor.execute(
        { ...BASE_REQUEST, configId: "D" },
        { jobId, signal: new AbortController().signal },
      );
      expect(summary.recordPath).toBe(
        path.join(fixture.runsRoot, jobId, "runs", "vul4j", "VUL4J-1", "D", "rep-1.json"),
      );
      expect(summary.auditPath).toContain(
        path.join(fixture.runsRoot, jobId, "audit", "vul4j", "VUL4J-1", "D", "rep-1", "audit"),
      );
      expectSentinelDiscipline(fixture);
    } finally {
      await fixture.dispose();
    }
  }, 120_000);

  test(`[${variant}] 错误合同：脚本耗尽 → ReviewExecutionError（generic publicMessage + 诊断同串双通道 + 零落盘）`, async () => {
    const stub = await startScriptedStub(sixPhaseNoToolCorpus().slice(0, 1));
    const fixture = factory({ stub, runsRoot: tempRunsRoot("rpc-contract-error-") });
    try {
      let caught: unknown;
      try {
        await fixture.executor.execute(
          { ...BASE_REQUEST, configId: "A" },
          { jobId: "job-contract-error-1", signal: new AbortController().signal },
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ReviewExecutionError);
      const executionError = caught as ReviewExecutionError;
      // 协议面安全文案：固定 generic——异常原文（路径/URL/堆栈）绝不进 view
      expect(executionError.publicMessage).toBe("review execution failed");
      // 诊断同串双通道：Error.message 载体与 sink 收到同一条（线程边界不折损）
      expect(executionError.message).toContain("review turn failed");
      expect(fixture.diagnostics.length).toBeGreaterThan(0);
      expect(fixture.diagnostics[fixture.diagnostics.length - 1]).toBe(executionError.message);
      expect(fixture.diagnostics.join("\n")).toContain("job-contract-error-1");
      // 失败 run 也不落盘（审计在循环完成后统一写——中途失败零残留）
      expectEmptyTree(fixture.runsRoot);
      // 哨兵：500 错误诊断也不携带 key
      expect(fixture.diagnostics.some((message) => message.includes(SENTINEL_KEY))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  }, 120_000);

  test(`[${variant}] 运行中取消：挂住网关 → abort → ReviewAbortedError，零落盘零诊断`, async () => {
    const stub = await startHangingStub();
    const fixture = factory({ stub, runsRoot: tempRunsRoot("rpc-contract-abort-") });
    try {
      const controller = new AbortController();
      const executing = fixture.executor.execute(
        { ...BASE_REQUEST, configId: "A" },
        { jobId: "job-contract-abort-1", signal: controller.signal },
      );
      // 等第 1 个请求真到达网关（此刻必已 running——取消落在运行中途）
      await waitFor(() => fixture.requests().length >= 1, "the first gateway request");

      controller.abort();
      await expect(executing).rejects.toBeInstanceOf(ReviewAbortedError); // 取消不是失败

      // 半途中止零落盘 + 取消不写诊断（与 in-process 合同逐字同形）
      expectEmptyTree(fixture.runsRoot);
      expect(fixture.diagnostics).toHaveLength(0);
    } finally {
      await fixture.dispose();
    }
  }, 120_000);

  test(`[${variant}] progress 透传：onProgress 收到相位边界事件（六相位全到场）`, async () => {
    const stub = await startScriptedStub(sixPhaseNoToolCorpus());
    const fixture = factory({ stub, runsRoot: tempRunsRoot("rpc-contract-progress-") });
    try {
      const progress: ReviewRunProgress[] = [];
      await fixture.executor.execute(
        { ...BASE_REQUEST, configId: "A" },
        {
          jobId: "job-contract-progress-1",
          signal: new AbortController().signal,
          onProgress: (event) => {
            progress.push(event);
          },
        },
      );

      expect(progress.length).toBeGreaterThanOrEqual(PHASE_ORDER.length);
      expect(progress[0]!.phase).toBe(PHASE_ORDER[0]); // 首事件 = 第一相位入口
      // 六相位全到场（相位名单单源 PHASE_ORDER；轮内顺序不在此过约束）
      const seen = new Set(progress.map((event) => event.phase));
      for (const phase of PHASE_ORDER) {
        expect(seen.has(phase)).toBe(true);
      }
      expect(progress.every((event) => event.round >= 1)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  }, 120_000);
}

contractSuite("in-process", inProcessFactory);
contractSuite("worker-pool", workerPoolFactory);
