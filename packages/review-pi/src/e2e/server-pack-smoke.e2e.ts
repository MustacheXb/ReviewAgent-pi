import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// #28 pack 冒烟：`reviewagent` 打包产物（esbuild bundle dist/cli.mjs——pack
// tarball 的内容物同源）必须含 server 形态且真跑通最小 wire 面：
// spawn → healthz 就绪 → capabilities（Bearer）→ 401 面 → SIGTERM 收尾。
//
// 不打真网关：子进程注入不可达回环 REVIEWER_URL（CI 零网络纪律）——本测
// 只证「server 形态进了产物 + 进程面活着 + 鉴权/信封面正确」，检视执行链
// 的真跑冒烟在 smoke-gateway-config-* 另有档。
//
// skipIf 守卫：CI 无 build:reviewagent 步骤（产物缺席时整档 skip——本地
// `pnpm build:reviewagent` 后可复跑；bundle 即 pack 内容物，tarball 无增量面）。

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const BUNDLED_CLI = path.join(REPO_ROOT, "packages", "reviewagent", "dist", "cli.mjs");

const testLocal = test.skipIf(!existsSync(BUNDLED_CLI));

/** 借端口法拿空闲端口（bind 0 → 读真分配值 → 释放；冒烟容忍微小竞态） */
async function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.once("error", reject);
  });
}

/** spawn bundled server 并等 healthz 就绪；失败抛人话（含子进程 stderr 尾部） */
async function startBundledServer(
  cliPath: string,
  tokenFile: string,
  outDir: string,
  port: number,
): Promise<{ child: ChildProcess; baseUrl: string; stderrTail(): string }> {
  const child = spawn(
    process.execPath,
    [cliPath, "server", "--auth-token-file", tokenFile, "--host", "127.0.0.1", "--port", String(port), "--out", outDir],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        REVIEWER_URL: "http://127.0.0.1:9/",
        REVIEWER_API_KEY: "pack-smoke-not-a-real-credential",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const stderrChunks: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
    if (stderrChunks.length > 20) {
      stderrChunks.shift(); // 只留尾部（诊断够用，不无限积压）
    }
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000; // 本机 spawn 慢周期（3-5s/次）留足余量
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`bundled server 提前退出（code=${child.exitCode}）：${stderrChunks.join("")}`);
    }
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.status === 200) {
        return { child, baseUrl, stderrTail: () => stderrChunks.join("") };
      }
    } catch {
      // 未就绪（ECONNREFUSED）——继续轮询
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`bundled server 30s 未就绪：${stderrChunks.join("")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

testLocal("pack 冒烟：bundle 含 server 形态——spawn → healthz → capabilities → 401 → SIGTERM", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "review-pi-pack-smoke-"));
  const tokenFile = path.join(workDir, "tokens.json");
  writeFileSync(
    tokenFile,
    JSON.stringify({
      tokens: {
        "pack-smoke-token": {
          tenantId: "pack-smoke-tenant",
          subject: "pack-smoke",
          scopes: ["review:submit", "review:read", "review:cancel"],
        },
      },
    }),
    "utf8",
  );
  const port = await reserveFreePort();

  const { child, baseUrl } = await startBundledServer(BUNDLED_CLI, tokenFile, path.join(workDir, "runs"), port);
  try {
    // liveness（匿名）
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    // 鉴权面：缺 token → 401 + id:null envelope
    const unauthed = await fetch(`${baseUrl}/v1/capabilities`);
    expect(unauthed.status).toBe(401);
    expect(await unauthed.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32006, message: "missing or invalid bearer token" },
    });

    // capabilities（Bearer）：HTTP 形态声明与 #28/#29 AC 对齐
    const authed = await fetch(`${baseUrl}/v1/capabilities`, {
      headers: { Authorization: "Bearer pack-smoke-token" },
    });
    expect(authed.status).toBe(200);
    const info = (await authed.json()) as {
      protocolVersion: number;
      methods: string[];
      features: {
        submitHttpStatus?: number;
        idempotency: boolean;
        defaultRepo: "cwd" | null;
        sse?: boolean;
        artifactDownload?: boolean;
      };
      limits: { maxBodyBytes?: number; artifactRetentionDays?: number };
    };
    expect(info.protocolVersion).toBe(2);
    expect(info.methods).toContain("review.submit");
    expect(info.methods).not.toContain("shutdown"); // HTTP 方法表不含进程生命周期方法
    expect(info.features.submitHttpStatus).toBe(202);
    expect(info.features.idempotency).toBe(true);
    expect(info.features.defaultRepo).toBeNull();
    // #29 P2b：SSE 事件流 + artifact 下载进形态声明；保留窗口缺省 30 天
    expect(info.features.sse).toBe(true);
    expect(info.features.artifactDownload).toBe(true);
    expect(info.limits.maxBodyBytes).toBe(32 * 1024 * 1024);
    expect(info.limits.artifactRetentionDays).toBe(30);

    // JSON-RPC 方法面（POST /rpc + 信封纪律）
    const capabilities = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer pack-smoke-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "smoke-1", method: "server.capabilities" }),
    });
    expect(capabilities.status).toBe(200);
    expect(((await capabilities.json()) as { id: string }).id).toBe("smoke-1");
  } finally {
    // SIGTERM（POSIX 优雅 drain；Windows 硬终止单进程——无壳无孤儿面）
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 10_000).unref();
    });
    rmSync(workDir, { recursive: true, force: true });
  }
});
