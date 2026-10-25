import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

import { checkRuntimeArtifacts, CLI_COMPILED_ENTRY } from "../../bin/lib/cli-runtime.js";
import { sseBody, type FakeReply } from "../provider/fake-fetch.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import {
  acquireDistArtifactLock,
  type DistArtifactLockRelease,
} from "../testing/dist-artifact-lock.js";
import type { HttpReviewJobView } from "./http-view.js";
import { ReviewHttpClient, type ReviewHttpClientEvent } from "./http-client.js";

// #30 P3a 进程级崩溃恢复验收（issue #30 AC，对齐 rpc.process.test.ts 真 bin
// 进程测试先例）：spawn 真 server（dist 编译入口 + --data-dir sqlite 装配）
// → 挂住 running job + 留 queued job → SIGKILL（不 drain——崩溃语义）→
// 重启（同 dataDir）→ 断言：
// - queued 作业重入队续跑成功（执行输入从 store 全量恢复——二相位 stub 语料）；
// - running 作业 → failed（-32015 SERVER_RESTART，不假装续跑）；
// - SSE `Last-Event-ID` 跨重启补齐（事件日志持久化：running 转移事件在崩溃
//   前已落库，恢复失败转移事件重启后照常补发）；
// - 产物目录按 job 隔离（experimentId = jobId——sqlite 装配面）；
// - `node:sqlite` 不可用 → 启动 fail fast 人话（含 `--store memory` 逃生口
//   指引，不静默降级）。
//
// spawn 直指 dist 编译入口（不经 bin 壳）：bin 的非 rpc 分支是 spawnSync——
// SIGKILL 只杀 bin 壳会留下 server 真身孤儿（Windows 孙进程幸存面）；直杀
// 真身才是崩溃语义。
//
// 哨兵纪律同 #7/#24：key 只允许出现在 Authorization 头；stderr / 落盘面
// （含 jobs.sqlite 二进制与产物树）全量扫描。

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(packageDir, "..", "..");

/** 哨兵 key：只该进 Authorization 头；出现在任何输出/落盘面即失败 */
const SENTINEL_KEY = "sk-restart-smoke-sentinel-b2d4";

/** Bearer token（token 文件注入面；非凭据——哨兵只盯 REVIEWER_API_KEY） */
const AUTH_TOKEN = "tok-restart";

const tempDirs: string[] = [];

/** 文件级 dist 产物锁（见 testing/dist-artifact-lock.ts）：本文件全程 spawn
 *  真 server，与 bin.process.test.ts 的 mtime 回拨用例 / rpc.process.test.ts
 *  的真 bin spawn 跨 fork 互斥 */
let releaseDistLock: DistArtifactLockRelease | undefined;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  releaseDistLock?.();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄释放延迟：tmp 泄漏无害，不 FAIL suite
    }
  }
});

// ---- 自愈构建：与 bin 同一真源判鲜（cli-runtime 腿表），陈旧即按腿重建 ----
beforeAll(async () => {
  releaseDistLock = await acquireDistArtifactLock();
  const check = checkRuntimeArtifacts();
  if (check.ok) {
    return;
  }
  const staleCommands = new Set(check.refusals.map((refusal) => refusal.buildCommand));
  const buildOrder = [
    "pnpm build:pi",
    "pnpm --filter review-llm build",
    "pnpm --filter review-pi build",
  ];
  for (const command of buildOrder) {
    if (!staleCommands.has(command)) {
      continue;
    }
    const run = spawn(command, { cwd: repoRoot, shell: true, timeout: 480_000 });
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        let stdout = "";
        let stderr = "";
        run.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        run.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        run.on("close", (status) => resolve({ status, stdout, stderr }));
      },
    );
    if (result.status !== 0) {
      throw new Error(`self-heal build failed (${command}, exit ${result.status}):\n${result.stdout}${result.stderr}`);
    }
  }
}, 600_000);

// ---- 二相位 stub：第 1 请求挂住（制造 running 崩溃面），后续回放脚本 ----

interface StubRequestRecord {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
}

interface TwoPhaseStub {
  readonly baseUrl: string;
  readonly requests: () => readonly StubRequestRecord[];
  readonly close: () => Promise<void>;
}

/** 一轮零工具完成脚本（config B）：phase-5 出唯一候选 F100，phase-6 裁决通过 + complete */
function oneFindingCorpus(): FakeReply[] {
  const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
  const candidate = {
    id: "F100",
    severity: "P2",
    category: "correctness",
    file: "sample.txt",
    line: 1,
    title: "Sentinel finding title",
    description: "Sentinel finding description",
    evidence: ["sample.txt:1"],
    rule: "sentinel-rule",
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

/**
 * 二相位回环网关 stub：首个 POST 挂住（回 SSE 头永不 end——崩溃的 running
 * job 挂在 body 上）；后续请求依序回放脚本回复的 SSE（重启后恢复的 queued
 * job 续跑语料）。
 */
function startTwoPhaseStub(replies: readonly FakeReply[]): Promise<TwoPhaseStub> {
  let firstHeld = false;
  const queue = [...replies];
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
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        if (!firstHeld) {
          firstHeld = true;
          response.writeHead(200, { "content-type": "text/event-stream" });
          return; // 永不 end：连接挂住，直到客户端进程死亡断开
        }
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
  });
  return new Promise<TwoPhaseStub>((resolve) => {
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

// ---- server 进程面助手 ----

interface ServerHandle {
  readonly baseUrl: string;
  readonly stderr: () => string;
  readonly kill: () => void;
  readonly waitForClose: (timeoutMs: number) => Promise<{ status: number | null; signal: NodeJS.Signals | null }>;
}

interface SpawnServerOptions {
  readonly dataDir: string;
  readonly tokenFile: string;
  readonly port: number;
  /** stub 网关（REVIEWER_URL 注入面；fail-fast 用例给不可达回环即可——启动期只解析不连接） */
  readonly stubBaseUrl: string;
  /** 追加 node 旗标（fail-fast 面注入 --no-experimental-sqlite） */
  readonly extraNodeArgs?: readonly string[];
}

/** spawn 真 server（dist 编译入口直杀真身，不经 bin 壳）并收 stderr */
function spawnServer(options: SpawnServerOptions): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      ...(options.extraNodeArgs ?? []),
      CLI_COMPILED_ENTRY,
      "server",
      "--auth-token-file",
      options.tokenFile,
      "--host",
      "127.0.0.1",
      "--port",
      String(options.port),
      "--data-dir",
      options.dataDir,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        REVIEWER_URL: options.stubBaseUrl,
        REVIEWER_API_KEY: SENTINEL_KEY,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let closeInfo: { status: number | null; signal: NodeJS.Signals | null } | undefined;
  const closeWaiters: Array<(info: { status: number | null; signal: NodeJS.Signals | null }) => void> = [];
  child.on("close", (status, signal) => {
    closeInfo = { status, signal };
    for (const waiter of closeWaiters.splice(0)) {
      waiter(closeInfo);
    }
  });
  return {
    baseUrl: `http://127.0.0.1:${options.port}`,
    stderr: () => stderr,
    kill: () => {
      child.kill("SIGKILL"); // 崩溃语义：不给 drain 机会（Windows = TerminateProcess 硬杀）
    },
    waitForClose(timeoutMs: number) {
      if (closeInfo !== undefined) {
        return Promise.resolve(closeInfo);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = closeWaiters.indexOf(settled);
          if (index !== -1) {
            closeWaiters.splice(index, 1);
          }
          reject(new Error(`server did not exit within ${timeoutMs}ms; stderr tail: ${stderr.slice(-500)}`));
        }, timeoutMs);
        const settled = (info: { status: number | null; signal: NodeJS.Signals | null }): void => {
          clearTimeout(timer);
          resolve(info);
        };
        closeWaiters.push(settled);
      });
    },
  };
}

/** 借端口法拿空闲端口（bind 0 → 读真分配值 → 释放；容忍微小竞态） */
async function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.once("error", reject);
  });
}

/** 轮询 healthz 就绪（匿名 liveness；上限防挂） */
async function waitForHealthz(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      // body 必须消费：未读 body 的 keep-alive 连接在 server 视角非 idle
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 200) {
        return;
      }
    } catch {
      // 未就绪（ECONNREFUSED）——继续轮询
    }
    if (Date.now() > deadline) {
      throw new Error(`server ${baseUrl} not healthy within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** 轮询 get 直到目标状态；到达别的终态 = 提前失败（人话带 error 摘要） */
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
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`timeout waiting for job ${jobId} to reach ${status}`);
}

/** 收 SSE 事件直到谓词成真（`Last-Event-ID` 续传位由调用方给）；超时抛人话 */
async function collectEvents(
  client: ReviewHttpClient,
  jobId: string,
  lastEventId: number,
  until: (event: ReviewHttpClientEvent) => boolean,
  timeoutMs: number,
): Promise<ReviewHttpClientEvent[]> {
  const collected: ReviewHttpClientEvent[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for await (const event of client.events(jobId, { lastEventId, signal: controller.signal })) {
      collected.push(event);
      if (until(event)) {
        return collected;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  // 流自然收尾（超时 abort / 服务端断开）而未达谓词
  throw new Error(
    `SSE: expected event not received within ${timeoutMs}ms; collected: ${JSON.stringify(
      collected.map((event) => [event.seq, event.status]),
    )}`,
  );
}

/** 递归收集目录下全部文件路径（落盘面哨兵扫描用） */
function collectFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}

/** token 文件（单租户：崩溃恢复链 + artifact 下载全量 scope） */
function writeTokenFile(file: string): void {
  writeFileSync(
    file,
    JSON.stringify({
      tokens: {
        [AUTH_TOKEN]: {
          tenantId: "restart-tenant",
          subject: "restart-process",
          scopes: ["review:submit", "review:read", "review:cancel", "artifact:read"],
        },
      },
    }),
    "utf8",
  );
}

// ---- 主链：崩溃 → 重启恢复 ----

test(
  "进程级崩溃恢复：SIGKILL 不 drain → 重启（同 dataDir）——queued 续跑 / running→failed(-32015) / SSE 跨重启补齐",
  async () => {
    const stub = await startTwoPhaseStub(oneFindingCorpus());
    const dataDir = makeTempDir("review-pi-restart-data-");
    const tokenFile = path.join(makeTempDir("review-pi-restart-tokens-"), "tokens.json");
    writeTokenFile(tokenFile);

    // A 实例：sqlite 装配（--data-dir；--out 缺省即 dataDir——spec 产物根同 data-dir）
    const serverA = spawnServer({ dataDir, tokenFile, port: await reserveFreePort(), stubBaseUrl: stub.baseUrl });
    // job 快照跨 A/B 两段引用（提交视图：jobId 是跨重启的稳定身份）
    let job1: HttpReviewJobView | undefined;
    let job2: HttpReviewJobView | undefined;
    try {
      await waitForHealthz(serverA.baseUrl, 30_000);
      const clientA = new ReviewHttpClient({ baseUrl: serverA.baseUrl, token: AUTH_TOKEN });

      // job1：running 后挂在 stub 第一相位（崩溃面）
      job1 = await clientA.submit({
        caseId: "MR-HANG",
        repoPath: repoFixturePath("sample"),
        diff: { kind: "inline", text: goldenFixture("vul4j-1.diff") },
        configId: "B",
      });
      await waitForStatus(clientA, job1.jobId, "running", 30_000);
      // running 先于 fetch 发出：等请求真到达 stub 再崩溃——挂住的才是在飞请求
      const stubDeadline = Date.now() + 10_000;
      while (stub.requests().length < 1 && Date.now() < stubDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(stub.requests().length).toBeGreaterThanOrEqual(1);

      // job2：queued（并发 1，被 job1 占住）——重启恢复的续跑面
      job2 = await clientA.submit({
        caseId: "MR-QUEUED",
        repoPath: repoFixturePath("sample"),
        diff: { kind: "inline", text: goldenFixture("vul4j-1.diff") },
        configId: "B",
      });
      expect(job2.status).toBe("queued");
    } finally {
      // 崩溃：SIGKILL 不 drain（无论上文成败，server 都要收口）
      serverA.kill();
      await serverA.waitForClose(30_000);
    }
    expect(job1).toBeDefined();
    expect(job2).toBeDefined();

    // B 实例：同 dataDir 重启（恢复发生在构造期，先于任何查询）
    const serverB = spawnServer({ dataDir, tokenFile, port: await reserveFreePort(), stubBaseUrl: stub.baseUrl });
    try {
      await waitForHealthz(serverB.baseUrl, 30_000);
      const clientB = new ReviewHttpClient({ baseUrl: serverB.baseUrl, token: AUTH_TOKEN });

      // queued 续跑：job2 重入队执行（stub 第二相位六回复）→ succeeded
      const recovered = await waitForStatus(clientB, job2!.jobId, "succeeded", 180_000);
      expect(recovered.result?.findings).toHaveLength(1);
      expect(recovered.result?.findings[0]).toMatchObject({ id: "F100", severity: "P2" });

      // running → failed（-32015 SERVER_RESTART，不假装续跑）
      const interrupted = await clientB.reviewGet(job1!.jobId);
      expect(interrupted.status).toBe("failed");
      expect(interrupted.error?.message).toContain("-32015");
      expect(interrupted.error?.message).toContain("SERVER_RESTART");

      // SSE 跨重启补齐（事件日志持久化）：
      // job1 崩溃前的帧 = running 转移 + phase 边界 progress 帧（status 同为
      // running——onProgress 在 phase/round 边界也 emitEvent；不假设确切
      // 帧数），恢复失败转移是重启后补上的末帧。
      // seq 连续（1..lastSeq 无空洞）= 重放不丢崩溃前任何一帧。
      const job1Events = await collectEvents(
        clientB,
        job1!.jobId,
        0,
        (event) => event.status === "failed",
        30_000,
      );
      expect(job1Events[0]).toMatchObject({ seq: 1, status: "running" });
      const job1Seqs = job1Events.map((event) => event.seq);
      expect(job1Seqs).toEqual(job1Seqs.map((_, index) => index + 1));
      expect(job1Events.filter((event) => event.status === "failed")).toHaveLength(1);
      const job1Final = job1Events[job1Events.length - 1]!;
      expect(job1Final.status).toBe("failed");
      expect(job1Final.error?.message).toContain("-32015");
      expect(job1Final.error?.message).toContain("SERVER_RESTART");

      // job2 重启前零事件（submit 不发事件）→ 恢复后事件 seq 从 1 起连续
      const job2Events = await collectEvents(
        clientB,
        job2!.jobId,
        0,
        (event) => event.status === "succeeded",
        30_000,
      );
      expect(job2Events[0]).toMatchObject({ seq: 1, status: "running" });
      const job2Seqs = job2Events.map((event) => event.seq);
      expect(job2Seqs).toEqual(job2Seqs.map((_, index) => index + 1));
      expect(job2Events[job2Events.length - 1]?.status).toBe("succeeded");

      // 产物面：job2 产物目录按 job 隔离（experimentId = jobId——sqlite 装配）
      expect(existsSync(path.join(dataDir, "jobs.sqlite"))).toBe(true);
      expect(existsSync(path.join(dataDir, job2!.jobId, "audit"))).toBe(true);
      const audit = JSON.parse(await clientB.downloadArtifact(job2!.jobId, "audit")) as { runId: string };
      expect(audit.runId).not.toBe("");
      const record = JSON.parse(await clientB.downloadArtifact(job2!.jobId, "record")) as {
        baseline: { findings: { id: string }[] };
      };
      expect(record.baseline.findings.map((finding) => finding.id)).toEqual(["F100"]);

      // 传输层：挂住 1 + 恢复六回合 = 7 请求全带哨兵头
      const requests = stub.requests();
      expect(requests).toHaveLength(7);
      for (const request of requests) {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/chat/completions");
        expect(request.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
      }

      // 哨兵泄漏：stderr（A/B）+ dataDir 全量落盘面（含 jobs.sqlite 二进制与产物树）
      const diskTexts = collectFiles(dataDir).map((file) => ({
        label: path.basename(file),
        text: readFileSync(file, "utf8"),
      }));
      const haystacks = [
        { label: "stderr-A", text: serverA.stderr() },
        { label: "stderr-B", text: serverB.stderr() },
        ...diskTexts,
      ];
      for (const { label, text } of haystacks) {
        expect(text.includes(SENTINEL_KEY), `${label} must not contain the API key`).toBe(false);
      }
    } finally {
      serverB.kill();
      await serverB.waitForClose(30_000);
      await stub.close();
    }
  },
  240_000,
);

// ---- 启动失败面：node:sqlite 不可用 fail fast ----

test("node:sqlite 不可用 → 启动 fail fast：exit 1 + 人话（--store memory 逃生口指引，不静默降级）", async () => {
  const dataDir = makeTempDir("review-pi-restart-nosqlite-");
  const tokenFile = path.join(makeTempDir("review-pi-restart-tokens-"), "tokens.json");
  writeTokenFile(tokenFile);

  const server = spawnServer({
    dataDir,
    tokenFile,
    port: await reserveFreePort(),
    stubBaseUrl: "http://127.0.0.1:9/v1", // 只需启动期解析（不连接）
    extraNodeArgs: ["--no-experimental-sqlite"], // 剥掉 node:sqlite（构造期 fail fast 面）
  });

  const exit = await server.waitForClose(30_000);
  expect(exit.status).toBe(1);
  expect(server.stderr()).toContain("node:sqlite is not available");
  expect(server.stderr()).toContain("--store memory");
  expect(server.stderr()).not.toContain(SENTINEL_KEY);
}, 60_000);
