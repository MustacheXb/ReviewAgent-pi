import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";

import { sseBody, type FakeReply } from "../provider/fake-fetch.js";
import { repoFixturePath } from "../testing/repos.js";
import { SAMPLE_DIFF } from "../testing/seam-fixtures.js";
import { collectFiles } from "../testing/scan-files.js";
import { createTempDirRegistry } from "../testing/temp-dir.js";
import { reserveFreePort } from "../testing/free-port.js";
import { ReviewHttpClient } from "../server/http-client.js";

// #31 pack 三形态冒烟（issue #31 AC：「reviewagent 最终 pack 产物三形态
// （CLI / stdio / server）冒烟」）：bin/reviewagent.js 是产品入口（pack 的
// bin 面），三形态各一测：
// - server 形态：缺省 worker 池装配 + 真 job 端到端（回环 stub 网关——CI 零
//   外网纪律，回环不算）→ succeeded——这同时是「dist/review-worker.mjs 进
//   产物且可解析」的证明（pool 缺省入口探测 cli.mjs 旁 review-worker.mjs，
//   #31 build.mjs 双入口的验收面）；
// - CLI review 一次性形态：`review` 子命令真跑一轮（config B 六回合）→
//   exit 0 + 落盘 record 含 F100；
// - stdio rpc 形态：`rpc` 子命令 JSONL 握手（capabilities）→ stdin EOF →
//   exit 0。
//
// 与 server-pack-smoke.e2e.ts（#28：不可达网关下的 server 启动 / 鉴权 /
// 信封面冒烟）互补：本档驱动三形态的执行链真跑。
//
// skipIf 守卫同 #28：CI 无 build:reviewagent 步骤（产物缺席时整档 skip——
// 本地 `pnpm build:reviewagent` 后经 `pnpm --filter review-pi test:e2e` 复跑；
// bundle 即 pack 内容物，tarball 无增量面）。
//
// 哨兵纪律同 #7：key 只允许出现在 Authorization 头；子进程 stdout/stderr 与
// 落盘面全量扫描。

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const PACKAGE_DIR = path.join(REPO_ROOT, "packages", "reviewagent");
const PRODUCT_BIN = path.join(PACKAGE_DIR, "bin", "reviewagent.js");
const BUNDLED_CLI = path.join(PACKAGE_DIR, "dist", "cli.mjs");
const BUNDLED_WORKER = path.join(PACKAGE_DIR, "dist", "review-worker.mjs");

const testLocal = test.skipIf(!existsSync(BUNDLED_CLI));

const tempDirs = createTempDirRegistry();
afterAll(() => {
  tempDirs.removeAll();
});

/** 哨兵 key：只该进 Authorization 头；出现在任何输出/落盘面即失败 */
const SENTINEL_KEY = "sk-pack-three-forms-sentinel-d5f1";

/** Bearer token（server 形态用；非凭据——哨兵只盯 REVIEWER_API_KEY） */
const AUTH_TOKEN = "tok-pack-three-forms";

/** 子进程通用 spawn 环境：stub 网关 + 哨兵凭据（启动期解析面） */
function productEnv(stubBaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    REVIEWER_URL: stubBaseUrl,
    REVIEWER_API_KEY: SENTINEL_KEY,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 回环 stub 网关（config B 六回合脚本；真 HTTP 传输层）----

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

/** 一轮零工具完成脚本（config B）：phase-5 出唯一候选 F100，phase-6 裁决通过 */
function oneFindingCorpus(): FakeReply[] {
  const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
  const candidate = {
    id: "F100",
    severity: "P2",
    category: "correctness",
    file: "sample.txt",
    line: 1,
    title: "Pack smoke finding title",
    description: "Pack smoke finding description",
    evidence: ["sample.txt:1"],
    rule: "pack-smoke-rule",
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

/** 脚本回放 stub：POST /v1/chat/completions 依序回放 SSE；耗尽 → 500 */
function startScriptedStub(replies: readonly FakeReply[]): Promise<LoopbackStub> {
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

// ---- 子进程面助手 ----

interface ChildOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: { status: number | null; signal: NodeJS.Signals | null };
}

/** 一次性跑产品 bin（CLI review 形态）：收集全量输出 + 退出结果 */
function runProduct(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ChildOutput> {
  const child: ChildProcess = spawn(process.execPath, [PRODUCT_BIN, ...args], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return drainChild(child, timeoutMs);
}

function drainChild(child: ChildProcess, timeoutMs: number): Promise<ChildOutput> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise<ChildOutput>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`product process did not exit within ${timeoutMs}ms; stderr tail: ${stderr.slice(-500)}`));
    }, timeoutMs);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exit: { status, signal } });
    });
  });
}

/** 哨兵纪律（输出 / 落盘面）：子进程 stdout/stderr 与扫描根全量零泄漏 */
function expectSentinelFreeText(
  outputs: ReadonlyArray<{ readonly label: string; readonly text: string }>,
  scanRoots: readonly string[],
): void {
  for (const { label, text } of outputs) {
    expect(text.includes(SENTINEL_KEY), `${label} must not contain the API key`).toBe(false);
  }
  for (const root of scanRoots) {
    for (const file of collectFiles(root)) {
      expect(readFileSync(file, "utf8").includes(SENTINEL_KEY), `${file} must not contain the API key`).toBe(false);
    }
  }
}

/** 哨兵纪律（传输面）：全部网关请求都是 Bearer 哨兵——仅适用于真跑过网关的形态 */
function expectSentinelTransport(stub: LoopbackStub): void {
  const requests = stub.requests();
  expect(requests.length).toBeGreaterThan(0);
  for (const record of requests) {
    expect(record.method).toBe("POST");
    expect(record.url).toBe("/v1/chat/completions");
    expect(record.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
  }
}

// ---- server 形态：缺省 worker 池 + 真 job 端到端 ----

testLocal(
  "pack 三形态之 server：缺省 worker 池装配——真 job 经 dist/review-worker.mjs 线程体跑通（succeeded F100）",
  async () => {
    // 双入口产物在场检查（stale bundle 即红——指向重建而非静默跳过）
    expect(existsSync(BUNDLED_WORKER), `${BUNDLED_WORKER} missing: rebuild with pnpm build:reviewagent`).toBe(true);

    const stub = await startScriptedStub(oneFindingCorpus());
    const workDir = tempDirs.makeTempDir("review-pi-pack-server-");
    const dataDir = path.join(workDir, "data");
    const tokenFile = path.join(workDir, "tokens.json");
    writeFileSync(
      tokenFile,
      JSON.stringify({
        tokens: {
          [AUTH_TOKEN]: {
            tenantId: "pack-tenant",
            subject: "pack-three-forms",
            scopes: ["review:submit", "review:read", "review:cancel"],
          },
        },
      }),
      "utf8",
    );
    const port = await reserveFreePort();

    // 不传 --executor：缺省 worker 池（#31 生产档）——pool 缺省入口解析探测
    // cli.mjs 旁 review-worker.mjs，本测即该解析在产物里的验收
    const child: ChildProcess = spawn(
      process.execPath,
      [
        PRODUCT_BIN,
        "server",
        "--auth-token-file",
        tokenFile,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--data-dir",
        dataDir,
      ],
      {
        cwd: REPO_ROOT,
        env: productEnv(stub.baseUrl),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    try {
      // 就绪轮询（healthz 匿名 liveness）
      const baseUrl = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (child.exitCode !== null) {
          throw new Error(`pack server 提前退出（code=${child.exitCode}）：${stderr.slice(-500)}`);
        }
        try {
          const res = await fetch(`${baseUrl}/healthz`);
          await res.body?.cancel().catch(() => undefined);
          if (res.status === 200) {
            break;
          }
        } catch {
          // 未就绪——继续轮询
        }
        if (Date.now() > deadline) {
          throw new Error(`pack server 30s 未就绪：${stderr.slice(-500)}`);
        }
        await sleep(200);
      }

      // 真 job 端到端：worker 线程体（review-worker.mjs）从池 spawn、六回合
      // 回环网关、落 succeeded——这是「第二入口进产物且可跑」的完整证明
      const client = new ReviewHttpClient({ baseUrl, token: AUTH_TOKEN });
      const job = await client.submit({
        caseId: "VUL4J-1",
        repoPath: repoFixturePath("sample"),
        diff: { kind: "inline", text: SAMPLE_DIFF },
        configId: "B",
      });
      const statusDeadline = Date.now() + 180_000;
      let view = job;
      for (;;) {
        view = await client.reviewGet(job.jobId);
        if (["succeeded", "failed", "cancelled"].includes(view.status)) {
          break;
        }
        if (Date.now() > statusDeadline) {
          throw new Error(`pack server job stuck at ${view.status}; stderr tail: ${stderr.slice(-500)}`);
        }
        await sleep(300);
      }
      expect(view.status).toBe("succeeded");
      expect(view.result?.findings).toHaveLength(1);
      expect(view.result?.findings[0]).toMatchObject({ id: "F100", severity: "P2" });

      // 哨兵纪律：stderr + dataDir 落盘面（jobs.sqlite 二进制 + 产物树）
      expectSentinelTransport(stub);
      expectSentinelFreeText([{ label: "stderr", text: stderr }], [dataDir]);
    } finally {
      // SIGTERM（POSIX 优雅 drain；Windows 硬终止单进程——无壳无孤儿面）
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 15_000).unref();
      });
      await stub.close();
    }
  },
);

// ---- CLI review 一次性形态 ----

testLocal("pack 三形态之 CLI review：一次性检视真跑——exit 0 + 落盘 record 含 F100", async () => {
  const stub = await startScriptedStub(oneFindingCorpus());
  const workDir = tempDirs.makeTempDir("review-pi-pack-cli-");
  try {
    // caseId = --mr 文件名去扩展名（VUL4J-1）
    const mrFile = path.join(workDir, "VUL4J-1.diff");
    writeFileSync(mrFile, SAMPLE_DIFF, "utf8");
    const outDir = path.join(workDir, "out");

    const result = await runProduct(
      ["review", "--repo", repoFixturePath("sample"), "--mr", mrFile, "--config", "B", "--out", outDir],
      productEnv(stub.baseUrl),
      180_000,
    );
    expect(result.exit.status).toBe(0);

    // 落盘真源：out 树内 record JSON 含 F100（路径形状不在此过约束——扫描面）
    const records = collectFiles(outDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readFileSync(file, "utf8"));
    expect(records.length).toBeGreaterThan(0);
    expect(records.some((text) => text.includes("F100"))).toBe(true);

    expectSentinelTransport(stub);
    expectSentinelFreeText(
      [
        { label: "stdout", text: result.stdout },
        { label: "stderr", text: result.stderr },
      ],
      [outDir],
    );
  } finally {
    await stub.close();
  }
});

// ---- stdio rpc 形态 ----

testLocal("pack 三形态之 stdio rpc：JSONL capabilities 握手 + stdin EOF → exit 0", async () => {
  const stub = await startScriptedStub(oneFindingCorpus());
  const workDir = tempDirs.makeTempDir("review-pi-pack-rpc-");
  try {
    const outDir = path.join(workDir, "out");
    const child: ChildProcess = spawn(process.execPath, [PRODUCT_BIN, "rpc", "--out", outDir], {
      cwd: REPO_ROOT,
      env: productEnv(stub.baseUrl),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const drained = drainChild(child, 60_000);
    let handshake: Record<string, unknown> | undefined;
    let handshakeError: unknown;
    try {
      // 帧纪律：stdout 每行恰好一个完整 JSON（capabilities 响应即握手证明）
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: "pack-1", method: "server.capabilities" })}\n`);
      handshake = await readLine(child);
    } catch (error) {
      handshakeError = error;
    } finally {
      child.stdin?.end(); // EOF → 优雅退出（exit 0——全平台面）
    }
    const result = await drained;
    if (handshakeError !== undefined) {
      throw handshakeError;
    }
    expect(handshake?.id).toBe("pack-1");
    expect(handshake?.error).toBeUndefined();
    expect((handshake?.result as { protocolVersion: number }).protocolVersion).toBe(2);
    expect(result.exit.status).toBe(0);
    // 握手不打网关（无 job → stub 零请求是预期）——只扫输出 / 落盘面
    expectSentinelFreeText(
      [
        { label: "stdout", text: result.stdout },
        { label: "stderr", text: result.stderr },
      ],
      [outDir],
    );
  } finally {
    await stub.close();
  }
});

/**
 * 读子进程 stdout 的下一行并就地 JSON.parse（帧纪律单点）。仅取首行——
 * 同流的后续字节由 drainChild 的独立监听全量累积（哨兵扫描面），此处
 * 不做回灌。
 */
function readLine(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.stdout?.removeListener("data", onChunk);
      reject(new Error("rpc stdout: no line within 30s"));
    }, 30_000);
    let buffer = "";
    const onChunk = (chunk: string): void => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      clearTimeout(timer);
      child.stdout?.removeListener("data", onChunk);
      try {
        resolve(JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", onChunk);
  });
}
