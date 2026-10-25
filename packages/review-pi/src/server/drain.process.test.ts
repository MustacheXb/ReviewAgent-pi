import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { sseBody, type FakeReply } from "../provider/fake-fetch.js";
import { reserveFreePort } from "../testing/free-port.js";
import { createTempDirRegistry } from "../testing/temp-dir.js";
import { repoFixturePath } from "../testing/repos.js";
import { SAMPLE_DIFF } from "../testing/seam-fixtures.js";
import { ensureFreshDistArtifacts } from "../testing/dist-self-heal.js";
import type { DistArtifactLockRelease } from "../testing/dist-artifact-lock.js";
import { collectFiles } from "../testing/scan-files.js";
import { spawnReviewServer, waitForHealthz } from "../testing/server-process.js";
import type { HttpReviewJobView } from "./http-view.js";
import { ReviewHttpClient } from "./http-client.js";

// #31 P3b 进程级优雅 drain 验收（issue #31 AC，对齐 rpc.process.test.ts 真
// 进程信号测试先例）：
//
// A 组（POSIX 门控）：spawn 生产形态 server（worker 池 + sqlite + 并发 2）→
// job1 挂住 worker 1（stub 首请求闸门）、job2 在 worker 2 正常完成（worker
// 独立性）→ 真信号 SIGTERM → drain 窗口（submit 503 + -32010 + Retry-After
// / readyz 503 / healthz 200 / 读面照常——方案 §8.6「先失败 readiness，再
// drain」）→ 放行闸门 → running 排空 → 进程优雅退出 143（exitCode 落定，
// 非信号死）→ sqlite 真源直读（排空语义的权威对照）。
// Windows 门控理由（同 rpc.process.test.ts C 组）：child.kill() 在 Windows 是
// TerminateProcess 硬杀、无信号语义——SIGTERM 根本到不了进程；Windows 面的
// 优雅 drain 语义由 main.test.ts（进程内 fake 信号全链路）与 soak.test.ts
// （fake 信号 + 真池同构装配）覆盖，CI ubuntu 跑本组。
//
// B 组（全平台）：--executor inprocess 逃生口进程冒烟——submit → succeeded
// （逃生口在生产进程形态可用）；POSIX 收 SIGTERM 优雅 143；Windows teardown
// 用 SIGKILL 硬收（退出码不作断言——硬杀无优雅语义）。
//
// 哨兵纪律同 #7/#24/#30：key 只允许出现在 Authorization 头；stderr / 落盘面
// （含 jobs.sqlite 二进制与产物树）全量扫描。

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(packageDir, "..", "..");

/** 哨兵 key：只该进 Authorization 头；出现在任何输出/落盘面即失败 */
const SENTINEL_KEY = "sk-drain-sentinel-7e2a";

/** Bearer token（token 文件注入面；非凭据——哨兵只盯 REVIEWER_API_KEY） */
const AUTH_TOKEN = "tok-drain";

/** POSIX 门控（Windows kill() 无信号语义——见文件头） */
const describeIfPosix = process.platform === "win32" ? describe.skip : describe;

// `node:sqlite` 经 createRequire 运行时加载（vitest/vite 变换层无法
// value-import node: 前缀内建——同 sqlite-store.ts 的 ADR-0013 决策 8 模式）
const { DatabaseSync: OpenDatabase } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSync;
};

const tempDirs = createTempDirRegistry();

/** 文件级 dist 产物锁（spawn 真 server——与 bin.process / rpc.process /
 *  restart.process 的真 bin spawn 跨 fork 互斥） */
let releaseDistLock: DistArtifactLockRelease | undefined;

afterAll(() => {
  releaseDistLock?.();
  tempDirs.removeAll();
});

beforeAll(async () => {
  releaseDistLock = await ensureFreshDistArtifacts();
}, 600_000);

// ---- 回环 stub 网关 ----

interface StubRequestRecord {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
}

/** 一轮零工具完成脚本（config B）：phase-5 出唯一候选 F100，phase-6 裁决通过 */
function oneFindingCorpus(): FakeReply[] {
  const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
  const candidate = {
    id: "F100",
    severity: "P2",
    category: "correctness",
    file: "sample.txt",
    line: 1,
    title: "Drain finding title",
    description: "Drain finding description",
    evidence: ["sample.txt:1"],
    rule: "drain-rule",
    confidence: 0.5,
  };
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: JSON.stringify({ candidates: [candidate] }), usage: ZERO },
    {
      text: JSON.stringify({ verdicts: [{ id: "F100", pass: true, reason: "stub verdict: evidence holds" }], complete: true }),
      usage: ZERO,
    },
  ];
}

interface LoopbackStub {
  readonly baseUrl: string;
  readonly requests: () => readonly StubRequestRecord[];
  readonly close: () => Promise<void>;
}

function stubServer(
  onRequest: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void,
): Promise<LoopbackStub> {
  const requests: StubRequestRecord[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization ?? "",
      });
      onRequest(request, response, Buffer.concat(chunks).toString("utf8"));
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

/** 脚本回放 stub（B 组）：POST /v1/chat/completions 依序回放 SSE；耗尽 → 500 */
function startScriptedStub(replies: readonly FakeReply[]): Promise<LoopbackStub> {
  const queue = [...replies];
  return stubServer((request, response, _body) => {
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

interface HeldGateStub extends LoopbackStub {
  /** 放行挂住的首请求（drain 窗口观察完成后调用——排空开闸） */
  readonly release: () => void;
}

/**
 * 闸门 stub（A 组）：每 caseId 独立语料游标（并发 job 交错不串台，同 soak
 * stub 设计）；首个到达的请求回 SSE 头但 body 挂住直到 release()——制造
 * 「running job 挂在网关」的 drain 排空面。游标越界 → 500（config B 恒 6
 * 回合——越界即异常，job 落 failed 被断言捕获）。
 */
function startHeldGateStub(): Promise<HeldGateStub> {
  const replies = oneFindingCorpus();
  const cursors = new Map<string, number>();
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let firstHeld = false;
  const promise = stubServer((request, response, body) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `stub: unexpected ${request.method} ${request.url}` } }));
      return;
    }
    const key = /MR-[A-Z]+/.exec(body)?.[0] ?? "unknown";
    const index = cursors.get(key) ?? 0;
    cursors.set(key, index + 1);
    const reply = replies[index];
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (reply === undefined) {
      response.end(JSON.stringify({ error: { message: `stub: round overrun for ${key}` } }));
      return;
    }
    if (!firstHeld) {
      firstHeld = true;
      void gate.then(() => {
        response.end(sseBody(reply));
      });
      return;
    }
    response.end(sseBody(reply));
  });
  return promise.then((stub) => ({ ...stub, release: () => releaseGate() }));
}

// ---- 驱动面助手 ----

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询 get 直到目标状态；到达别的终态 = 提前失败（人话带 error 摘要）——同 restart.process */
async function waitForStatus(
  client: ReviewHttpClient,
  jobId: string,
  status: string,
  timeoutMs: number,
): Promise<HttpReviewJobView> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = await client.reviewGet(jobId);
    if (view.status === status) {
      return view;
    }
    if (["succeeded", "failed", "cancelled"].includes(view.status)) {
      throw new Error(
        `job ${jobId} reached terminal status ${view.status} while waiting for ${status}` +
          (view.error !== undefined ? `: ${view.error.message}` : ""),
      );
    }
    await sleep(300);
  }
  throw new Error(`timeout waiting for job ${jobId} to reach ${status}`);
}

/**
 * 轮询至 drain 窗口开（SIGTERM 异步到达——不能假设发信号即开窗）。用
 * readyz 探测（GET 无副作用）：窗口确认开之前发 submit probe 会真建 job
 * 污染夹具（信号未达时 submit 照常 202 入队执行）。
 */
async function waitForDrainingWindow(baseUrl: string, token: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${baseUrl}/readyz`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 503) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`server did not fail readiness within ${timeoutMs}ms after SIGTERM`);
    }
    await sleep(100);
  }
}

/** 哨兵纪律断言：传输面全数命中 + stderr / 落盘面零泄漏 */
function expectSentinelDiscipline(
  server: { readonly stderr: () => string },
  stub: LoopbackStub,
  dataDir: string,
): void {
  const requests = stub.requests();
  expect(requests.length).toBeGreaterThan(0);
  for (const record of requests) {
    expect(record.method).toBe("POST");
    expect(record.url).toBe("/v1/chat/completions");
    expect(record.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
  }
  expect(server.stderr().includes(SENTINEL_KEY), "stderr must not contain the API key").toBe(false);
  for (const file of collectFiles(dataDir)) {
    expect(readFileSync(file, "utf8").includes(SENTINEL_KEY), `${file} must not contain the API key`).toBe(false);
  }
}

/** token 文件（单租户：提交 / 读 / 取消 / artifact 全量 scope） */
function writeTokenFile(file: string): void {
  writeFileSync(
    file,
    JSON.stringify({
      tokens: {
        [AUTH_TOKEN]: {
          tenantId: "drain-tenant",
          subject: "drain-process",
          scopes: ["review:submit", "review:read", "review:cancel", "artifact:read"],
        },
      },
    }),
    "utf8",
  );
}

// ---- A 组：真进程 SIGTERM 优雅 drain（POSIX 门控） ----

describeIfPosix("进程级优雅 drain（POSIX 门控——Windows kill() 无信号语义）", () => {
  test(
    "worker 池生产形态：SIGTERM → 窗口 503/-32010/Retry-After + readyz 503 + healthz 200 + 读面照常 → 排空 → exit 143 + sqlite 真源 succeeded",
    async () => {
      const stub = await startHeldGateStub();
      const dataDir = tempDirs.makeTempDir("review-pi-drain-data-");
      const tokenFile = path.join(tempDirs.makeTempDir("review-pi-drain-tokens-"), "tokens.json");
      writeTokenFile(tokenFile);

      const server = spawnReviewServer({
        repoRoot,
        dataDir,
        tokenFile,
        port: await reserveFreePort(),
        stubBaseUrl: stub.baseUrl,
        env: { REVIEWER_URL: stub.baseUrl, REVIEWER_API_KEY: SENTINEL_KEY },
        extraServerArgs: ["--executor", "worker", "--concurrency", "2"],
      });
      try {
        await waitForHealthz(server.baseUrl, 30_000);
        const client = new ReviewHttpClient({ baseUrl: server.baseUrl, token: AUTH_TOKEN });

        // job1：占住 worker 1（round-1 挂在闸门上）——drain 排空面的 running job
        const job1 = await client.submit({
          caseId: "MR-HANG",
          repoPath: repoFixturePath("sample"),
          diff: { kind: "inline", text: SAMPLE_DIFF },
          configId: "B",
        });
        await waitForStatus(client, job1.jobId, "running", 30_000);
        // 等 round-1 真到达闸门（此刻挂住的才是在飞请求）
        const stubDeadline = Date.now() + 10_000;
        while (stub.requests().length < 1 && Date.now() < stubDeadline) {
          await sleep(100);
        }
        expect(stub.requests().length).toBeGreaterThanOrEqual(1);

        // job2：worker 2 正常完成（worker 1 挂死不影响独立 worker——池隔离性）
        const job2 = await client.submit({
          caseId: "MR-FLOW",
          repoPath: repoFixturePath("sample"),
          diff: { kind: "inline", text: SAMPLE_DIFF },
          configId: "B",
        });
        const flowed = await waitForStatus(client, job2.jobId, "succeeded", 180_000);
        expect(flowed.result?.findings).toHaveLength(1);
        expect(flowed.result?.findings[0]).toMatchObject({ id: "F100", severity: "P2" });

        // SIGTERM：优雅 drain 开闸（真信号面——本组的本体）
        server.kill("SIGTERM");

        // drain 窗口（§8.6「先失败 readiness，再 drain」；信号异步到达——先无
        // 副作用地轮询 readyz 至 503，窗口确认开后再发 submit probe 断言完整
        // 拒绝合同）
        await waitForDrainingWindow(server.baseUrl, AUTH_TOKEN, 15_000);
        const rejected = await fetch(`${server.baseUrl}/rpc`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${AUTH_TOKEN}` },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "drain-window-probe",
            method: "review.submit",
            params: {
              caseId: "MR-REJECTED",
              repoPath: repoFixturePath("sample"),
              diff: { kind: "inline", text: SAMPLE_DIFF },
              configId: "B",
            },
          }),
        });
        expect(rejected.status).toBe(503);
        expect(rejected.headers.get("retry-after")).toBe("5");
        expect(await rejected.json()).toMatchObject({
          id: null,
          error: { code: -32010, message: "server is draining" },
        });
        const ready = await fetch(`${server.baseUrl}/readyz`, {
          headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
        });
        expect(ready.status).toBe(503);
        await ready.body?.cancel().catch(() => undefined);
        const live = await fetch(`${server.baseUrl}/healthz`);
        expect(live.status).toBe(200);
        await live.body?.cancel().catch(() => undefined);
        // 读面照常（监听保持绑定直到排空完成）：job1 仍 running 可查
        const held = await client.reviewGet(job1.jobId);
        expect(held.status).toBe("running");

        // 放行闸门：job1 排空 → 服务收口 → 进程优雅退出（exitCode 143，非信号死）
        stub.release();
        const exit = await server.waitForClose(60_000);
        expect(exit.status).toBe(143);
        expect(exit.signal).toBe(null);

        // sqlite 真源直读（进程已退无锁竞争）：排空语义权威对照 + 零 failed
        const db = new OpenDatabase(path.join(dataDir, "jobs.sqlite"), { readOnly: true });
        try {
          const rows = db.prepare("SELECT job_id, status FROM jobs").all() as {
            job_id: string;
            status: string;
          }[];
          const statusByJob = new Map(rows.map((row) => [row.job_id, row.status] as const));
          expect(statusByJob.get(job1.jobId)).toBe("succeeded");
          expect(statusByJob.get(job2.jobId)).toBe("succeeded");
          expect(rows.filter((row) => row.status === "failed")).toHaveLength(0);
        } finally {
          db.close();
        }

        // 传输面：job1 六回合（1 挂 + 5 放行后）+ job2 六回合 = 12，全数 Bearer
        expect(stub.requests()).toHaveLength(12);
        expectSentinelDiscipline(server, stub, dataDir);
      } finally {
        // 兜底收口（成功路径进程已退——kill/waitForClose 均为 no-op）
        server.kill("SIGKILL");
        await server.waitForClose(30_000).catch(() => undefined);
        await stub.close();
      }
    },
    240_000,
  );
});

// ---- B 组：--executor inprocess 逃生口进程冒烟（全平台） ----

test(
  "--executor inprocess 逃生口进程冒烟：submit → succeeded；POSIX SIGTERM 优雅 143 / Windows 硬收",
  async () => {
    const stub = await startScriptedStub(oneFindingCorpus());
    const dataDir = tempDirs.makeTempDir("review-pi-inproc-data-");
    const tokenFile = path.join(tempDirs.makeTempDir("review-pi-inproc-tokens-"), "tokens.json");
    writeTokenFile(tokenFile);

    const server = spawnReviewServer({
      repoRoot,
      dataDir,
      tokenFile,
      port: await reserveFreePort(),
      stubBaseUrl: stub.baseUrl,
      env: { REVIEWER_URL: stub.baseUrl, REVIEWER_API_KEY: SENTINEL_KEY },
      extraServerArgs: ["--executor", "inprocess"],
    });
    try {
      await waitForHealthz(server.baseUrl, 30_000);
      const client = new ReviewHttpClient({ baseUrl: server.baseUrl, token: AUTH_TOKEN });

      // 逃生口在生产进程形态可用：检视照常执行完成（主线程执行器 + sqlite 装配）
      const job = await client.submit({
        caseId: "MR-INPROC",
        repoPath: repoFixturePath("sample"),
        diff: { kind: "inline", text: SAMPLE_DIFF },
        configId: "B",
      });
      const done = await waitForStatus(client, job.jobId, "succeeded", 180_000);
      expect(done.result?.findings).toHaveLength(1);
      expect(done.result?.findings[0]).toMatchObject({ id: "F100", severity: "P2" });

      // 优雅退出：POSIX 真信号 → 143；Windows kill() 是 TerminateProcess 硬杀
      // （无信号语义）——teardown 收口即可，退出码不作断言
      server.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
      const exit = await server.waitForClose(30_000);
      if (process.platform !== "win32") {
        expect(exit.status).toBe(143);
        expect(exit.signal).toBe(null);
      }

      expect(stub.requests()).toHaveLength(6);
      expectSentinelDiscipline(server, stub, dataDir);
    } finally {
      // 兜底收口（成功路径进程已退——kill/waitForClose 均为 no-op）
      server.kill("SIGKILL");
      await server.waitForClose(30_000).catch(() => undefined);
      await stub.close();
    }
  },
  120_000,
);
