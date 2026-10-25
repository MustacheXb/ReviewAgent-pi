import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

import { sseBody, type FakeReply } from "../provider/fake-fetch.js";
import { collectFiles } from "../testing/scan-files.js";
import { repoFixturePath } from "../testing/repos.js";
import { SAMPLE_DIFF } from "../testing/seam-fixtures.js";
import { createTempDirRegistry } from "../testing/temp-dir.js";
import { ensureFreshDistArtifacts } from "../testing/dist-self-heal.js";
import type { DistArtifactLockRelease } from "../testing/dist-artifact-lock.js";
import { WorkerPoolReviewExecutor } from "../rpc/worker-pool.js";
import { runServerMain } from "./main.js";
import { ReviewHttpClient } from "./http-client.js";

// #31 P3b soak 长跑验收（issue #31 AC）：生产装配形态（sqlite + worker 池 +
// 并发 2）连续作业——无死单（全体终态）、无泄漏（worker 数恒 ≤ 池大小、close
// 后归零）、吞吐稳定（预算窗口内完成数下限）。覆盖面：
// - queued 取消（确定性：慢 job 占住双 worker，快 job 排队被 cancel）；
// - 运行中取消（真 worker abort 协作取消——慢 job 逐回合延迟给足窗口）；
// - drain 收口：排空中收 SIGTERM（fake 信号面——Windows / POSIX 同径；真
//   信号进程面在 drain.process.test.ts POSIX 门控）→ 窗口 503 → 排空 →
//   退出 143 → 池归零；
// - 终态真源直读 jobs.sqlite（drain 后权威对照，不经 HTTP 面）。
//
// 装配 = runServerMain 注入真实 WorkerPoolReviewExecutor（dist 线程体 +
// execArgv 剥离 vitest --conditions source 陷阱 + env 注入 stub 凭据）——
// 与生产装配同构；main.ts 对注入池做 instanceof 识别，drain 尾收口同 lane。
//
// 哨兵纪律同 #7/#24/#30：key 只允许出现在 Authorization 头；诊断面（池
// onDiagnostic 收集）与落盘面（dataDir 全树含 jobs.sqlite）全量扫描。

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER_ENTRY = path.join(packageDir, "dist", "rpc", "worker-entry.js");

// `node:sqlite` 经 createRequire 运行时加载（vitest/vite 变换层无法 value-import
// node: 前缀内建——"Failed to load url sqlite"；同 sqlite-store.ts 的 ADR-0013
// 决策 8 模式：type-only import 走类型面，运行时绕开 vite 解析器）
const { DatabaseSync: OpenDatabase } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSync;
};

/** 哨兵 key：只该进 Authorization 头；出现在任何诊断/落盘面即失败 */
const SENTINEL_KEY = "sk-soak-sentinel-9a3c";

/** Bearer token（非凭据——哨兵只盯 REVIEWER_API_KEY） */
const AUTH_TOKEN = "tok-soak";

/** 慢 job 每回合延迟（制造运行中取消的真窗口） */
const SLOW_REPLY_DELAY_MS = 400;

/** 预算：连续提交窗口（毫秒）——worker 首启 ~1-2s 计入 */
const SUBMIT_BUDGET_MS = 25_000;

const tempDirs = createTempDirRegistry();

let releaseDistLock: DistArtifactLockRelease | undefined;

beforeAll(async () => {
  releaseDistLock = await ensureFreshDistArtifacts();
  if (!existsSync(WORKER_ENTRY)) {
    throw new Error(`worker entry missing after self-heal build: ${WORKER_ENTRY}`);
  }
}, 600_000);

afterAll(() => {
  releaseDistLock?.();
  tempDirs.removeAll();
});

// ---- 回环 stub：按 caseId 路由快/慢 + 每 job 独立语料游标（永不耗尽） ----

interface StubRequestRecord {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
}

interface SoakStub {
  readonly baseUrl: string;
  readonly requests: () => readonly StubRequestRecord[];
  readonly close: () => Promise<void>;
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
    title: "Soak finding title",
    description: "Soak finding description",
    evidence: ["sample.txt:1"],
    rule: "soak-rule",
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
 * soak 回环网关：POST /v1/chat/completions 按 body 内 caseId（SOAKSLOW- /
 * SOAKFAST- 前缀，kernel 每回合携全量历史——caseId 恒在场）路由：
 * - 每 caseId 独立游标消费 6 回合语料（并发 job 交错不串台）；
 * - SOAKSLOW 每回合延迟 400ms（运行中取消的真窗口）；
 * - 游标越界（>6 回合）→ 500（config B 恒 6 回合——越界即内核行为异常，
 *   该 job 落 failed，soak 的「零 failed」断言会捕获）。
 */
function startSoakStub(): Promise<SoakStub> {
  const replies = oneFindingCorpus();
  const cursors = new Map<string, number>();
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
        const body = Buffer.concat(chunks).toString("utf8");
        const match = /SOAK(?:SLOW|FAST)-\d+/.exec(body);
        const key = match?.[0] ?? "unknown";
        const index = cursors.get(key) ?? 0;
        cursors.set(key, index + 1);
        const reply = replies[index];
        if (reply === undefined) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: `stub: round overrun for ${key}` } }));
          return;
        }
        const delay = key.startsWith("SOAKSLOW") ? SLOW_REPLY_DELAY_MS : 0;
        setTimeout(() => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(sseBody(reply));
        }, delay);
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `stub: unexpected ${request.method} ${request.url}` } }));
    });
  });
  return new Promise<SoakStub>((resolve) => {
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

// ---- 驱动面 ----

/** 终态集合（status 单源字符串——view 契约稳定面） */
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

interface JobRecord {
  jobId: string;
  readonly caseId: string;
  status: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function writeTokenFile(file: string): void {
  writeFileSync(
    file,
    JSON.stringify({
      tokens: {
        [AUTH_TOKEN]: {
          tenantId: "soak-tenant",
          subject: "soak",
          scopes: ["review:submit", "review:read", "review:cancel", "artifact:read"],
        },
      },
    }),
    "utf8",
  );
}

async function submitJob(client: ReviewHttpClient, caseId: string): Promise<JobRecord> {
  const view = await client.submit({
    caseId,
    repoPath: repoFixturePath("sample"),
    diff: { kind: "inline", text: SAMPLE_DIFF },
    configId: "B",
  });
  return { jobId: view.jobId, caseId, status: view.status };
}

/** 刷新一批 job 的最新状态（读面） */
async function refresh(client: ReviewHttpClient, jobs: readonly JobRecord[]): Promise<void> {
  for (const job of jobs) {
    if (TERMINAL.has(job.status)) {
      continue;
    }
    const view = await client.reviewGet(job.jobId);
    job.status = view.status;
  }
}

/** 等全体终态（每轮全量刷新；超时人话带当前状态面） */
async function waitAllTerminal(client: ReviewHttpClient, jobs: readonly JobRecord[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await refresh(client, jobs);
    if (jobs.every((job) => TERMINAL.has(job.status))) {
      return;
    }
    if (Date.now() > deadline) {
      const stuck = jobs.filter((job) => !TERMINAL.has(job.status)).map((job) => `${job.caseId}:${job.status}`);
      throw new Error(`soak jobs stuck non-terminal after ${timeoutMs}ms: ${stuck.join(", ")}`);
    }
    await sleep(50);
  }
}

/**
 * 运行中取消：轮询至 running 即 cancel（真 worker abort 面——慢 job 逐回合
 * 400ms 给足窗口）。job 先行落定 → 返回 false（cancel 幂等面，不算失败）。
 */
async function cancelMidRun(client: ReviewHttpClient, job: JobRecord, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await client.reviewGet(job.jobId);
    job.status = view.status;
    if (view.status === "running") {
      await client.reviewCancel(job.jobId);
      return true;
    }
    if (TERMINAL.has(view.status)) {
      return false;
    }
    if (Date.now() > deadline) {
      throw new Error(`cancelMidRun: ${job.caseId} stuck ${job.status} for ${timeoutMs}ms`);
    }
    await sleep(30);
  }
}

test(
  "soak：sqlite + worker 池 + 并发 2 连续作业——queued/运行中取消、全体终态零 failed、worker 恒 ≤2 且 close 归零、drain 窗口 503、哨兵纪律",
  async () => {
    const stub = await startSoakStub();
    const dataDir = tempDirs.makeTempDir("review-pi-soak-data-");
    const tokenFile = path.join(tempDirs.makeTempDir("review-pi-soak-tokens-"), "tokens.json");
    writeTokenFile(tokenFile);

    const diagnostics: string[] = [];
    const pool = new WorkerPoolReviewExecutor({
      size: 2,
      workerEntry: WORKER_ENTRY,
      runsRoot: path.resolve(dataDir),
      env: { ...process.env, REVIEWER_URL: stub.baseUrl, REVIEWER_API_KEY: SENTINEL_KEY },
      // vitest fork 的 --conditions source 陷阱：显式剥离（生产进程 execArgv 为空）
      execArgv: [],
      experimentIdOf: (jobId) => jobId,
      onDiagnostic: (message) => {
        diagnostics.push(message);
      },
    });
    const signals = new EventEmitter();
    const listened: { host: string; port: number }[] = [];
    const exited = runServerMain(
      {
        host: "127.0.0.1",
        port: 0,
        out: dataDir, // sqlite 面缺省产物根 = dataDir（生产派生同形）
        authTokenFile: tokenFile,
        executor: "worker",
        concurrency: 2,
        store: "sqlite",
        dataDir,
      },
      {
        executor: pool,
        endpoint: { baseUrl: stub.baseUrl, apiKey: SENTINEL_KEY },
        signals,
        onListening: (address) => listened.push(address),
      },
    );
    try {
      // 就绪（bind 0 系统分配端口）
      const deadline = Date.now() + 30_000;
      while (listened.length === 0) {
        if (Date.now() > deadline) {
          throw new Error("soak server did not listen within 30s");
        }
        await sleep(20);
      }
      const client = new ReviewHttpClient({ baseUrl: `http://127.0.0.1:${listened[0]!.port}`, token: AUTH_TOKEN });

      // ---- 阶段 1：取消面（确定性夹具）----
      // 双 SLOW 占住两个 worker（~2.4s+）→ 4 FAST 确定性排队；取消 2 个排队
      // job（queued 取消路径）+ 等 SLOW-1 running 后取消（运行中取消路径——
      // 真 worker abort 协作取消）
      const slow1 = await submitJob(client, "SOAKSLOW-1");
      const slow2 = await submitJob(client, "SOAKSLOW-2");
      const fast1 = await submitJob(client, "SOAKFAST-1");
      const fast2 = await submitJob(client, "SOAKFAST-2");
      const fast3 = await submitJob(client, "SOAKFAST-3");
      const fast4 = await submitJob(client, "SOAKFAST-4");
      expect(fast1.status).toBe("queued");
      expect(fast4.status).toBe("queued");
      await client.reviewCancel(fast1.jobId);
      await client.reviewCancel(fast2.jobId);
      const cancelledMidRun = await cancelMidRun(client, slow1);
      const phase1 = [slow1, slow2, fast1, fast2, fast3, fast4];
      await waitAllTerminal(client, phase1, 120_000);
      expect(cancelledMidRun).toBe(true);
      expect(slow1.status).toBe("cancelled");
      expect(slow2.status).toBe("succeeded");
      expect(fast1.status).toBe("cancelled");
      expect(fast2.status).toBe("cancelled");
      expect(fast3.status).toBe("succeeded");
      expect(fast4.status).toBe("succeeded");

      // ---- 阶段 2：连续作业（吞吐 + 泄漏采样）----
      // outstanding（非终态）补位至 5；每第 4 个 SLOW 并尝试运行中取消。
      const phase2: JobRecord[] = [];
      const start = Date.now();
      let seq = 0;
      let midRunCancelLanded = 0;
      while (Date.now() - start < SUBMIT_BUDGET_MS) {
        await refresh(client, phase2);
        const outstanding = phase2.filter((job) => !TERMINAL.has(job.status));
        if (outstanding.length < 5) {
          seq += 1;
          const slow = seq % 4 === 0;
          // caseId 偏移 +100：与阶段 1 的 caseId 空间隔离（stub 游标按 caseId
          // 键控——复用已耗尽游标的 caseId 会判越界回 500，job 假性 failed）
          const job = await submitJob(client, `${slow ? "SOAKSLOW" : "SOAKFAST"}-${seq + 100}`);
          phase2.push(job);
          if (slow && (await cancelMidRun(client, job))) {
            midRunCancelLanded += 1;
          }
        } else {
          await sleep(40);
        }
        // 泄漏采样：池恒 ≤ 2（崩溃替换也先摘牌再懒补）
        expect(pool.workerCount).toBeLessThanOrEqual(2);
      }
      await waitAllTerminal(client, phase2, 120_000);
      const succeededCount =
        phase1.filter((job) => job.status === "succeeded").length +
        phase2.filter((job) => job.status === "succeeded").length;
      const cancelledCount =
        phase1.filter((job) => job.status === "cancelled").length +
        phase2.filter((job) => job.status === "cancelled").length;
      // 吞吐下限（保守——CI 机器余量；两 worker × 快 job 亚秒级 + 首启 ~2s）
      expect(succeededCount).toBeGreaterThanOrEqual(10);
      expect(cancelledCount).toBeGreaterThanOrEqual(4); // 阶段 1 已确定性 3 + 运行中取消
      expect(midRunCancelLanded).toBeGreaterThanOrEqual(1);

      // ---- 阶段 3：drain 收口（排空中收信号）----
      const drainSlow1 = await submitJob(client, "SOAKSLOW-901");
      const drainSlow2 = await submitJob(client, "SOAKSLOW-902");
      const drainQueued = await submitJob(client, "SOAKFAST-903");
      signals.emit("SIGTERM");

      // 窗口断言（§8.6「先失败 readiness，再 drain」——监听保持绑定）
      const rejected = await fetch(`http://127.0.0.1:${listened[0]!.port}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "soak-drain",
          method: "review.submit",
          params: {
            caseId: "SOAKFAST-999",
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
      const ready = await fetch(`http://127.0.0.1:${listened[0]!.port}/readyz`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      expect(ready.status).toBe(503);
      const live = await fetch(`http://127.0.0.1:${listened[0]!.port}/healthz`);
      expect(live.status).toBe(200);

      // 排空：drain 等 running（SLOW ~2.4s+）——轮询至终态（服务面随排空收口，
      // 连接拒绝即视为已完成观察）
      const drainJobs = [drainSlow1, drainSlow2, drainQueued];
      const drainDeadline = Date.now() + 60_000;
      for (;;) {
        try {
          await refresh(client, drainJobs);
        } catch {
          break; // 监听已收——排空完成（终态真源随后直读 sqlite）
        }
        if (drainJobs.every((job) => TERMINAL.has(job.status))) {
          break;
        }
        if (Date.now() > drainDeadline) {
          throw new Error(
            `drain jobs stuck: ${drainJobs.map((job) => `${job.caseId}:${job.status}`).join(", ")}`,
          );
        }
        await sleep(50);
      }
      expect(await exited).toBe(143);
      // 池收口：close 落定后 worker 归零（无泄漏——否则进程面悬挂）
      expect(pool.workerCount).toBe(0);

      // ---- 终态真源直读（drain 后权威对照，不经 HTTP 面）----
      const db = new OpenDatabase(path.join(dataDir, "jobs.sqlite"), { readOnly: true });
      try {
        const rows = db.prepare("SELECT job_id, status FROM jobs").all() as {
          job_id: string;
          status: string;
        }[];
        expect(rows.length).toBeGreaterThan(0);
        // drain 语义直读：running 排空至 succeeded、queued 落 cancelled
        // （SERVER_DRAIN 取消路径——非 failed）
        const statusByJob = new Map(rows.map((row) => [row.job_id, row.status] as const));
        expect(statusByJob.get(drainSlow1.jobId)).toBe("succeeded");
        expect(statusByJob.get(drainSlow2.jobId)).toBe("succeeded");
        expect(statusByJob.get(drainQueued.jobId)).toBe("cancelled");
        const byJob = new Map(phase1.concat(phase2, drainJobs).map((job) => [job.jobId, job] as const));
        for (const row of rows) {
          // 零死单 + 零 failed（stub 语料良性——failed 即内核/池异常，soak 必须红）
          expect(TERMINAL.has(row.status), `job ${row.job_id} non-terminal: ${row.status}`).toBe(true);
          expect(row.status, `job ${row.job_id} unexpectedly failed`).not.toBe("failed");
          const record = byJob.get(row.job_id);
          // HTTP 观察与持久真源对照：仅对「HTTP 已观察到终态」的 job 逐字比对
          // ——drain 尾巴上监听先收、终态转移发生在关闭之后，观察面停在
          // running 属固有窗口（真源已由上方 drain 语义直读覆盖）
          if (record !== undefined && TERMINAL.has(record.status)) {
            expect(row.status).toBe(record.status);
          }
        }
      } finally {
        db.close();
      }

      // ---- 哨兵纪律 ----
      // 传输面：全数 Bearer 哨兵
      const requests = stub.requests();
      expect(requests.length).toBeGreaterThan(0);
      for (const record of requests) {
        expect(record.method).toBe("POST");
        expect(record.url).toBe("/v1/chat/completions");
        expect(record.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
      }
      // 诊断面 + 落盘面（dataDir 全树：jobs.sqlite 二进制 + 产物树）
      expect(diagnostics.some((message) => message.includes(SENTINEL_KEY))).toBe(false);
      for (const file of collectFiles(dataDir)) {
        expect(readFileSync(file, "utf8").includes(SENTINEL_KEY), `${file} must not contain the API key`).toBe(false);
      }
    } finally {
      // 失败路径兜底：收池 + drain 开闸（幂等——已收口则 no-op）
      await pool.close().catch(() => undefined);
      signals.emit("SIGTERM");
      await exited.catch(() => undefined);
      await stub.close();
    }
  },
  300_000,
);
