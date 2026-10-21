import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { checkRuntimeArtifacts } from "../../bin/lib/cli-runtime.js";
import { sseBody, type FakeReply } from "../provider/fake-fetch.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { ReviewRpcClient, RpcResponseError } from "./client.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type { ReviewJobStatus } from "./protocol.js";
import type { ReviewJobView } from "./service.js";

// #24 S3 进程面验收：spawn 真 bin（bin/review-pi.js rpc → dist 内核长驻），
// 在真进程边界上验收 stdio JSONL 长驻契约（spec #21 / ADR-0012）：
// - A 组：宿主客户端（ReviewRpcClient）驱动全方法链路（capabilities/submit/
//   get/list/cancel/shutdown）+ 事件流 + 落盘 + 传输层哨兵 + shutdown → 0；
// - B 组：raw JSONL 手写 wire——stdout 每行恰好一个完整 JSON（帧纪律，不经
//   客户端的宽容忽略）+ stdin EOF → 0（Windows 0xC0000409 回归兼在场：
//   真 fetch 过的进程只能 exitCode + 自然排干）；
// - C 组（POSIX 门控）：SIGINT → 130 / SIGTERM → 143（bin 转发 + 内核 drain）；
// - D 组：running cancel 进程级——stub 挂住 SSE 响应 → cancel → 内核 abort →
//   cancelling → cancelled，--out 零落盘（无审计/RunRecord）。
//
// 与 bin.process.test.ts 的关系：loopback stub 与 oneFindingCorpus 是按 rpc 面
// 需要的窄化重写（rpc 长驻不发 smoke 探针——只有 POST SSE 路径），wire 渲染
// 单源仍是 sseBody（fake 适配器同款）。该文件零改动（旧子命令契约零回归）。
//
// 哨兵纪律同 #7：key 只允许出现在 Authorization 头；stderr/落盘面全量扫描。

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const BIN_PATH = path.join(packageDir, "bin", "review-pi.js");

/** 哨兵 key：只该进 Authorization 头；出现在任何输出/落盘面即失败 */
const SENTINEL_KEY = "sk-process-smoke-sentinel-7f31";
/** .env.local 诱饵（显式环境变量必须胜出——诱饵值连传输层都不该到） */
const DECOY_KEY = "sk-decoy-from-env-local";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上进程 cwd 句柄释放有延迟（rpc 进程刚退）——tmp 泄漏无害，
      // 清理失败不 FAIL suite
    }
  }
});

// ---- 自愈构建：与 bin 同一真源判鲜（cli-runtime 腿表），陈旧即按腿重建 ----
// CI 有显式 dist 前置构建，本钩子通常 no-op；本地源码新于产物时自愈。
beforeAll(async () => {
  const check = checkRuntimeArtifacts();
  if (check.ok) {
    return;
  }
  const staleCommands = new Set(check.refusals.map((refusal) => refusal.buildCommand));
  // 腿间有依赖序：vendored pi 四包（root 脚本按依赖序）→ review-llm → 本包
  const buildOrder = [
    "pnpm build:pi",
    "pnpm --filter review-llm build",
    "pnpm --filter review-pi build",
  ];
  for (const command of buildOrder) {
    if (!staleCommands.has(command)) {
      continue;
    }
    const run = spawn(command, {
      cwd: repoRoot,
      shell: true,
      timeout: 480_000,
    });
    // spawn（非 spawnSync）：shell 命令的输出在 close 时落定
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

// ---- loopback stub：真 HTTP 传输层上的 canned 网关（rpc 面：只有 SSE 路径）----

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

/** 回环网关 stub：POST /v1/chat/completions 依序回放脚本回复的 SSE（rpc 长驻不发探针，无 GET/非流式路径） */
function startLoopbackStub(replies: readonly FakeReply[]): Promise<LoopbackStub> {
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

/** 挂住 stub（D 组）：回 SSE 头但永不 end——检视 fetch 挂在 body 上，取消只能靠内核 abort */
function startHangingStub(): Promise<LoopbackStub> {
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
        response.writeHead(200, { "content-type": "text/event-stream" });
        // 永不 end：连接挂住，直到客户端 abort 断开
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `stub: unexpected ${request.method} ${request.url}` } }));
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

// ---- 语料 / 环境助手 ----

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

/** 子进程环境（哨兵网关显式注入；REVIEWER_* 优先序压过本机 DEEPSEEK_* 残留） */
function stubEnv(stubBaseUrl: string): Record<string, string> {
  return { REVIEWER_URL: stubBaseUrl, REVIEWER_API_KEY: SENTINEL_KEY };
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

/** 哨兵泄漏断言：stderr/落盘面全量不含 key */
function expectNoKeyLeak(haystacks: readonly { label: string; text: string }[]): void {
  for (const { label, text } of haystacks) {
    expect(text.includes(SENTINEL_KEY), `${label} must not contain the API key`).toBe(false);
    expect(text.includes(DECOY_KEY), `${label} must not contain the .env.local decoy key`).toBe(false);
  }
}

/** 提交参数（A/B/D 组共用：config B 零工具，六回复脚本对应形态） */
function submitParams() {
  return {
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    configId: "B" as const,
  };
}

const TERMINAL_STATUSES: readonly string[] = ["succeeded", "failed", "cancelled"];

/** 轮询等待谓词成真（D 组：等挂住的 fetch 真到达 stub 再取消） */
async function waitFor(what: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** 轮询 get 直到目标状态；途中到达别的终态 = 提前失败（人话带 error 摘要） */
async function waitForJobStatus(
  client: ReviewRpcClient,
  jobId: string,
  status: ReviewJobStatus,
  timeoutMs: number,
): Promise<ReviewJobView> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = await client.get(jobId);
    if (view.status === status) {
      return view;
    }
    if (TERMINAL_STATUSES.includes(view.status)) {
      throw new Error(
        `job ${jobId} reached terminal status ${view.status} while waiting for ${status}` +
          (view.error !== undefined ? `: ${view.error.message}` : ""),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timeout waiting for job ${jobId} to reach ${status}; stderr tail: ${client.getStderr()}`);
}

// ---- raw JSONL 驱动（B/C 组：手写 wire，帧纪律单点断言）----

interface RawRpcSession {
  send(document: unknown): void;
  /** 下一行 stdout；就地 JSON.parse——帧纪律（每行恰好一个完整 JSON）在此收口 */
  nextLine(timeoutMs?: number): Promise<Record<string, unknown>>;
  endStdin(): void;
  kill(signal: NodeJS.Signals): void;
  waitForClose(timeoutMs: number): Promise<{ status: number | null; signal: string | null }>;
  readonly stderr: string;
  /** 读面 JSON.parse 失败计数（B 组断言恒 0——非 JSON 字节混进 stdout 即失败） */
  readonly parseFailures: number;
}

interface RawSpawnOptions {
  readonly outDir: string;
  /** 合并到 process.env 之上的环境变量（stubEnv 注入面） */
  readonly env?: Record<string, string>;
  /** 整包替换的进程环境（fail-fast 测试要 delete 本机残留凭据） */
  readonly rawEnv?: NodeJS.ProcessEnv;
  /** 预写进 cwd 的 .env.local（诱饵面） */
  readonly seedEnvLocal?: string;
}

/** spawn 真 bin 长驻（cwd = 干净 tmpdir）；stdout 走自家 LF-only reader */
function spawnRawRpc(options: RawSpawnOptions): RawRpcSession {
  const cwd = makeTempDir("review-pi-rpc-cwd-");
  if (options.seedEnvLocal !== undefined) {
    writeFileSync(path.join(cwd, ".env.local"), options.seedEnvLocal, "utf8");
  }
  const child = spawn(process.execPath, [BIN_PATH, "rpc", "--out", options.outDir], {
    cwd,
    env: options.rawEnv ?? { ...process.env, ...options.env },
  });
  let stderr = "";
  let parseFailures = 0;
  const pendingLines: Record<string, unknown>[] = [];
  const lineWaiters: Array<(line: Record<string, unknown>) => void> = [];
  let closeInfo: { status: number | null; signal: string | null } | undefined;
  const closeWaiters: Array<(info: { status: number | null; signal: string | null }) => void> = [];

  attachJsonlLineReader(child.stdout, (line) => {
    let document: unknown;
    try {
      document = JSON.parse(line);
    } catch {
      parseFailures += 1;
      document = { __unparseableLine: line };
    }
    const value = document as Record<string, unknown>;
    const waiter = lineWaiters.shift();
    if (waiter !== undefined) {
      waiter(value);
    } else {
      pendingLines.push(value);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.on("close", (status, signal) => {
    closeInfo = { status, signal };
    for (const waiter of closeWaiters.splice(0)) {
      waiter(closeInfo);
    }
  });

  return {
    send(document) {
      child.stdin.write(serializeJsonLine(document));
    },
    nextLine(timeoutMs = 30_000) {
      const buffered = pendingLines.shift();
      if (buffered !== undefined) {
        return Promise.resolve(buffered);
      }
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = lineWaiters.indexOf(settled);
          if (index !== -1) {
            lineWaiters.splice(index, 1);
          }
          reject(new Error(`raw rpc: no stdout line within ${timeoutMs}ms; stderr tail: ${stderr.slice(-500)}`));
        }, timeoutMs);
        const settled = (line: Record<string, unknown>): void => {
          clearTimeout(timer);
          resolve(line);
        };
        lineWaiters.push(settled);
      });
    },
    endStdin() {
      child.stdin.end();
    },
    kill(signal) {
      child.kill(signal);
    },
    waitForClose(timeoutMs) {
      if (closeInfo !== undefined) {
        return Promise.resolve(closeInfo);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = closeWaiters.indexOf(settled);
          if (index !== -1) {
            closeWaiters.splice(index, 1);
          }
          reject(new Error(`raw rpc: process did not exit within ${timeoutMs}ms; stderr tail: ${stderr.slice(-500)}`));
        }, timeoutMs);
        const settled = (info: { status: number | null; signal: string | null }): void => {
          clearTimeout(timer);
          resolve(info);
        };
        closeWaiters.push(settled);
      });
    },
    get stderr() {
      return stderr;
    },
    get parseFailures() {
      return parseFailures;
    },
  };
}

// ---- A 组：宿主客户端全方法链路 ----

test(
  "全方法链路（client 驱动）：六方法 + 事件流 seq 单调 + 审计落盘 + 传输层哨兵 + shutdown→exit 0",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    let client: ReviewRpcClient | undefined;
    try {
      const outDir = makeTempDir("review-pi-rpc-out-");
      // cwd 种 .env.local 诱饵：显式环境变量必须胜出（诱饵 URL 是死端口）
      const cwd = makeTempDir("review-pi-rpc-cwd-");
      writeFileSync(
        path.join(cwd, ".env.local"),
        `REVIEWER_URL=http://127.0.0.1:9/v1\nREVIEWER_API_KEY=${DECOY_KEY}\n`,
        "utf8",
      );

      const events: { seq: number; job: { jobId: string; status: string } }[] = [];
      client = new ReviewRpcClient({
        rpcArgs: ["--out", outDir],
        env: stubEnv(stub.baseUrl),
        cwd,
      });
      client.onEvent((event) => {
        events.push(event);
      });
      await client.start();

      // capabilities：协议版本 / 六方法表 / limits 派生 / serverId
      const caps = await client.capabilities();
      expect(caps.protocolVersion).toBe(1);
      expect(caps.serverId).toMatch(/^\d+-\d+$/);
      expect(caps.methods).toEqual([
        "server.capabilities",
        "review.submit",
        "review.get",
        "review.list",
        "review.cancel",
        "shutdown",
      ]);
      expect(caps.limits).toEqual({
        maxDiffBytes: 8 * 1024 * 1024,
        maxQueueDepth: 100,
        concurrency: 1,
        repoRootEnforced: false,
      });

      // submit → 恒 queued 快照（响应先于 worker 启动）
      const submitted = await client.submit(submitParams());
      expect(submitted.status).toBe("queued");
      expect(submitted.jobId).not.toBe("");
      expect(submitted.caseId).toBe("VUL4J-1");
      expect(submitted.configId).toBe("B");

      // 检视完成（stub 六回复）→ result 携带 findings
      const completed = await waitForJobStatus(client, submitted.jobId, "succeeded", 120_000);
      expect(completed.result?.findings).toHaveLength(1);
      expect(completed.result?.findings[0]).toMatchObject({ id: "F100", severity: "P2" });
      expect(completed.result?.rounds).toBe(1);

      // 事件流：seq 单调不减、running/completed 在场、全程同 job
      const seqs = events.map((event) => event.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(events.some((event) => event.job.status === "running")).toBe(true);
      expect(events.some((event) => event.job.status === "succeeded")).toBe(true);
      for (const event of events) {
        expect(event.job.jobId).toBe(submitted.jobId);
      }

      // get / list（全量 + 状态过滤）
      const got = await client.get(submitted.jobId);
      expect(got.status).toBe("succeeded");
      const all = await client.list();
      expect(all.jobs.some((job) => job.jobId === submitted.jobId)).toBe(true);
      const doneList = await client.list("succeeded");
      expect(doneList.jobs.some((job) => job.jobId === submitted.jobId)).toBe(true);
      const queuedList = await client.list("queued");
      expect(queuedList.jobs.some((job) => job.jobId === submitted.jobId)).toBe(false);

      // cancel 幂等面：终态 job 返回当前 view（不退化不复活）
      const cancelled = await client.cancel(submitted.jobId);
      expect(cancelled.status).toBe("succeeded");

      // 未知 job → 协议错误（RpcResponseError -32001 透传）
      await expect(client.get("job-does-not-exist")).rejects.toBeInstanceOf(RpcResponseError);
      await expect(client.get("job-does-not-exist")).rejects.toMatchObject({ code: -32001 });

      // 传输层：恰好六回合全带哨兵 Authorization 头（rpc 长驻不发探针）
      const requests = stub.requests();
      expect(requests).toHaveLength(6);
      for (const request of requests) {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/chat/completions");
        expect(request.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
      }

      // 落盘：审计 + RunRecord（≥2 文件）；哨兵纪律（stderr + 落盘全量扫描）
      expect(collectFiles(outDir).length).toBeGreaterThanOrEqual(2);
      const diskTexts = collectFiles(outDir).map((file) => ({
        label: path.basename(file),
        text: readFileSync(file, "utf8"),
      }));
      // stderr：.env.local 诱饵被显式环境变量压过（装载摘要在场 + skipped）
      expect(client.getStderr()).toContain(".env.local");
      expect(client.getStderr()).toContain("skipped");
      expectNoKeyLeak([{ label: "stderr", text: client.getStderr() }, ...diskTexts]);

      // shutdown → 响应 → 服务端 drain 自退（真 fetch 过的进程 exitCode 自然
      // 排干——Windows 0xC0000409 回归在此在场：退出码必须是 0 不是 3221226505）
      await client.shutdown();
      await client.stop();
      expect(client.getExitInfo()?.code).toBe(0);
    } finally {
      // 失败路径也收口进程（可选链——start 前失败则 client 未构造）
      await client?.stop().catch(() => undefined);
      await stub.close();
    }
  },
  180_000,
);

// ---- B 组：raw JSONL 帧纪律 + EOF → 0 ----

test(
  "raw wire：stdout 每行恰好一个完整 JSON（零 parse 失败）+ 检视全链 + stdin EOF → exit 0",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const outDir = makeTempDir("review-pi-rpc-out-");
      const session = spawnRawRpc({ outDir, env: stubEnv(stub.baseUrl) });

      // capabilities（响应行）
      session.send({ jsonrpc: "2.0", id: "raw-1", method: "server.capabilities" });
      const caps = await session.nextLine();
      expect(caps.id).toBe("raw-1");
      expect((caps.result as { protocolVersion?: number })?.protocolVersion).toBe(1);

      // submit → 轮询读行直到 completed 事件（响应与事件混流，逐行过 JSON.parse）
      session.send({
        jsonrpc: "2.0",
        id: "raw-2",
        method: "review.submit",
        params: submitParams(),
      });
      let jobId = "";
      let completedSeen = false;
      const deadline = Date.now() + 120_000;
      while (!completedSeen && Date.now() < deadline) {
        const line = await session.nextLine(30_000);
        if (line.id === "raw-2" && line.error === undefined) {
          jobId = ((line.result as { jobId?: string }) ?? {}).jobId ?? "";
        }
        if (line.method === "review.event") {
          const job = (line.params as { job?: { status?: string; jobId?: string } }).job;
          if (job?.status === "succeeded") {
            completedSeen = true;
            expect(job.jobId).toBe(jobId);
          }
        }
      }
      expect(completedSeen).toBe(true);
      expect(jobId).not.toBe("");

      // stdin EOF（无 shutdown 命令）→ drain（无在跑 job）→ flush → 0
      session.endStdin();
      const exit = await session.waitForClose(30_000);
      expect(exit.status).toBe(0);

      // 帧纪律收口：stdout 零非 JSON 行；stderr/落盘哨兵
      expect(session.parseFailures).toBe(0);
      expect(collectFiles(outDir).length).toBeGreaterThanOrEqual(2);
      const diskTexts = collectFiles(outDir).map((file) => ({
        label: path.basename(file),
        text: readFileSync(file, "utf8"),
      }));
      expectNoKeyLeak([{ label: "stderr", text: session.stderr }, ...diskTexts]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

// ---- C 组：信号退出码（POSIX 门控——Windows kill() 是硬杀无信号语义，宿主优雅退出走 EOF）----

const describeIfPosix = process.platform === "win32" ? describe.skip : describe;

describeIfPosix("信号退出码（POSIX）", () => {
  test("SIGINT → exit 130（bin 转发 → 内核 drain 跳过 flush）", async () => {
    const outDir = makeTempDir("review-pi-rpc-out-");
    const session = spawnRawRpc({ outDir, env: stubEnv("http://127.0.0.1:9/v1") });
    session.send({ jsonrpc: "2.0", id: "sig-1", method: "server.capabilities" });
    const caps = await session.nextLine();
    expect((caps.result as { protocolVersion?: number })?.protocolVersion).toBe(1);

    session.kill("SIGINT");
    const exit = await session.waitForClose(30_000);
    expect(exit.status).toBe(130);
  });

  test("SIGTERM → exit 143", async () => {
    const outDir = makeTempDir("review-pi-rpc-out-");
    const session = spawnRawRpc({ outDir, env: stubEnv("http://127.0.0.1:9/v1") });
    session.send({ jsonrpc: "2.0", id: "sig-2", method: "server.capabilities" });
    await session.nextLine();

    session.kill("SIGTERM");
    const exit = await session.waitForClose(30_000);
    expect(exit.status).toBe(143);
  });

  test("SIGHUP → exit 129（bin 转发——终端挂断不留服务端孤儿）", async () => {
    const outDir = makeTempDir("review-pi-rpc-out-");
    const session = spawnRawRpc({ outDir, env: stubEnv("http://127.0.0.1:9/v1") });
    session.send({ jsonrpc: "2.0", id: "sig-3", method: "server.capabilities" });
    await session.nextLine();

    session.kill("SIGHUP");
    const exit = await session.waitForClose(30_000);
    expect(exit.status).toBe(129);
  });
});

// ---- D 组：running cancel 进程级 ----

test(
  "running cancel（进程级）：stub 挂住 SSE → cancel → cancelling → cancelled + --out 零落盘 + 无审计",
  async () => {
    const stub = await startHangingStub();
    let client: ReviewRpcClient | undefined;
    try {
      const outDir = makeTempDir("review-pi-rpc-out-");
      const events: { seq: number; job: { jobId: string; status: string } }[] = [];
      client = new ReviewRpcClient({
        rpcArgs: ["--out", outDir],
        env: stubEnv(stub.baseUrl),
        cwd: makeTempDir("review-pi-rpc-cwd-"),
      });
      client.onEvent((event) => {
        events.push(event);
      });
      await client.start();

      // submit → running（fetch 挂在 stub 上）→ cancel → cancelled
      const submitted = await client.submit(submitParams());
      await waitForJobStatus(client, submitted.jobId, "running", 30_000);
      // running 状态先于 HTTP 发出（worker 启动 → 状态转移 → 才发 fetch）：
      // 等 fetch 真到达 stub 再取消——保证中断的是在飞请求，不是发前取消
      await waitFor("the hanging stub to receive a request", () => stub.requests().length >= 1, 10_000);
      const cancelling = await client.cancel(submitted.jobId);
      expect(cancelling.status).toBe("cancelling");
      const finalView = await waitForJobStatus(client, submitted.jobId, "cancelled", 30_000);
      // cancelled 不是失败：error 省键
      expect(finalView.error).toBeUndefined();

      // 事件面：cancelling → cancelled 转移都在场
      expect(events.some((event) => event.job.status === "cancelling")).toBe(true);
      expect(events.some((event) => event.job.status === "cancelled")).toBe(true);

      // 落盘面：abort 路径零文件（审计与 RunRecord 均不写）
      expect(collectFiles(outDir)).toEqual([]);

      // 传输层：挂住的连接带哨兵头；哨兵纪律（stderr 面）
      expect(stub.requests().length).toBeGreaterThanOrEqual(1);
      for (const request of stub.requests()) {
        expect(request.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
      }
      expectNoKeyLeak([{ label: "stderr", text: client.getStderr() }]);

      // 进程收口：EOF drain（无在跑 job）→ 0
      await client.stop();
      expect(client.getExitInfo()?.code).toBe(0);
    } finally {
      // 失败路径也收口进程（可选链——start 前失败则 client 未构造）
      await client?.stop().catch(() => undefined);
      await stub.close();
    }
  },
  120_000,
);

// ---- 启动失败面 ----

test("启动失败：缺凭据（无 REVIEWER_*/DEEPSEEK_* 且 cwd 无 .env.local）→ exit 1 + stderr 人话", async () => {
  const env = { ...process.env };
  delete env.REVIEWER_URL;
  delete env.REVIEWER_API_KEY;
  delete env.DEEPSEEK_URL;
  delete env.DEEPSEEK_API_KEY;
  const session = spawnRawRpc({ outDir: makeTempDir("review-pi-rpc-out-"), rawEnv: env });

  const exit = await session.waitForClose(30_000);
  expect(exit.status).toBe(1);
  // 人话文案（review-llm resolver 单源）；key 缺失错误不含任何 key 值
  expect(session.stderr).toContain("key is missing");
  expect(session.stderr).toContain("REVIEWER_API_KEY");
  expect(session.stderr).not.toContain(SENTINEL_KEY);
});
