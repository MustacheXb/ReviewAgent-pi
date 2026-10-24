/**
 * #28 HTTP server demo（ADR-0013 决策 1 的端到端演示）：
 *
 *   自生成临时 token 文件 → spawn `review-pi server`（真 node:http 长驻）→
 *   typed ReviewHttpClient 跑通 capabilities → submit → 轮询 get → cancel →
 *   SIGTERM 优雅退出。
 *
 * 检视执行面：子进程注入 REVIEWER_URL=http://127.0.0.1:9/（不可达回环）+
 * demo key——演示的是 HTTP wire 协议链路（信封 / 202+Location / 幂等 / 状态
 * 流转 / Bearer 鉴权），不打真网关；job 会以 failed（连接拒绝）落定，cancel
 * 面按状态机语义呈现。key 只经 env 注入子进程，绝不落盘回显。
 *
 * 平台差异：Windows 无 POSIX 信号语义，child.kill() 即硬终止单进程 server
 * （无孙进程，无孤儿面）；POSIX 走 SIGTERM → 优雅 drain → 退出码 143。
 *
 * 运行（仓库根）：
 *   pnpm demo:http-server
 * （编译模式与 probe-gateway-cache.ts 同款：tsc 单文件 → .tmp-gen → node）
 *
 * 退出码：0 全链路跑通；1 任一步失败或 server 启动超时。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { HttpRpcResponseError, ReviewHttpClient } from "review-pi";

// 仓库根：demo 经 `pnpm demo:http-server`（仓库根）驱动，cwd 即根——不从
// import.meta.url 推（编译产物落 .tmp-gen/scripts/，相对推导错位）
const repoRoot = process.cwd();
const serverBin = path.join("packages", "review-pi", "bin", "review-pi.js");

/** server 就绪探测上限（毫秒）——listen + endpoint 解析应远快于此 */
const READY_TIMEOUT_MS = 15_000;
/** 轮询步进 */
const POLL_INTERVAL_MS = 150;
/** cancel 后等终态的上限（executor 对不可达网关的连接超时面之下） */
const FINAL_STATE_TIMEOUT_MS = 20_000;

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

function fail(message: string): never {
  process.stderr.write(`demo-http-server: ${message}\n`);
  process.exitCode = 1;
  process.exit(1);
}

/** 借端口法拿一个空闲端口（bind 0 → 读真分配值 → 立即释放；demo 容忍微小竞态） */
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

async function main(): Promise<void> {
  if (process.env.REVIEWER_URL !== undefined || process.env.REVIEWER_API_KEY !== undefined) {
    fail(
      "检测到 REVIEWER_* 环境变量——demo 刻意注入不可达回环端点演示 wire 链路，不消费真凭据。请 unset 后重跑。",
    );
  }

  // 1. 临时装配面：token 文件 + 输出根（自生成，退出清理）
  const workDir = mkdtempSync(path.join(tmpdir(), "review-pi-demo-http-"));
  const tokenFile = path.join(workDir, "tokens.json");
  const demoToken = "demo-token-local-only";
  writeFileSync(
    tokenFile,
    JSON.stringify(
      {
        tokens: {
          [demoToken]: {
            tenantId: "demo-tenant",
            subject: "demo-http",
            scopes: ["review:submit", "review:read", "review:cancel"],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  const outDir = path.join(workDir, "runs");
  const port = await reserveFreePort();
  log(`[demo] 临时 token 文件：${tokenFile}`);
  log(`[demo] 目标地址：http://127.0.0.1:${port}`);

  // 2. spawn 真 server 子进程（REVIEWER_* 注入不可达回环——不打真网关）
  const child = spawn(
    process.execPath,
    [serverBin, "server", "--auth-token-file", tokenFile, "--host", "127.0.0.1", "--port", String(port), "--out", outDir],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        REVIEWER_URL: "http://127.0.0.1:9/",
        REVIEWER_API_KEY: "demo-key-not-a-real-credential",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    process.stderr.write(`[server] ${chunk}`);
  });

  try {
    // 3. 等就绪（healthz 匿名 liveness）
    const client = new ReviewHttpClient({ baseUrl: `http://127.0.0.1:${port}`, token: demoToken });
    const readyDeadline = Date.now() + READY_TIMEOUT_MS;
    while (!(await client.healthz())) {
      if (Date.now() > readyDeadline) {
        fail(`server ${READY_TIMEOUT_MS}ms 内未就绪（healthz 不通）`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    log("[demo] server 就绪（GET /healthz → 200）");

    // 4. capabilities（发现面：features / limits）
    const info = await client.capabilities();
    log(`[demo] capabilities: protocolVersion=${info.protocolVersion} serverId=${info.serverId}`);
    log(`[demo]   features: submitHttpStatus=${String(info.features.submitHttpStatus)} idempotency=${String(info.features.idempotency)} defaultRepo=${String(info.features.defaultRepo)}`);
    log(`[demo]   limits: maxDiffBytes=${info.limits.maxDiffBytes} maxBodyBytes=${String(info.limits.maxBodyBytes)}`);

    // 5. submit（202 + Location 语义；clientRequestId 幂等键）
    const repoDir = path.join(workDir, "repo");
    const diffFile = path.join(workDir, "demo.diff");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      diffFile,
      '--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,3 @@\n export const answer = 42;\n+export const extra = "demo";\n',
      "utf8",
    );
    const submitted = await client.submit({
      caseId: "demo-mr-1",
      repoPath: repoDir,
      diff: { kind: "file", path: diffFile },
      issueDescription: "demo: 演示 HTTP 提交面（不可达网关，job 将以 failed 落定）",
      configId: "E",
      clientRequestId: "demo-client-req-1",
    });
    log(`[demo] submit → 202：jobId=${submitted.jobId} status=${submitted.status}`);
    log(`[demo]   Location 头语义：/v1/jobs/${submitted.jobId}`);

    // 6. 幂等重放（同 clientRequestId 同参 → 同 job，不重复检视）
    const replayed = await client.submit({
      caseId: "demo-mr-1",
      repoPath: repoDir,
      diff: { kind: "file", path: diffFile },
      issueDescription: "demo: 演示 HTTP 提交面（不可达网关，job 将以 failed 落定）",
      configId: "E",
      clientRequestId: "demo-client-req-1",
    });
    log(`[demo] 幂等重放 → 同 jobId=${replayed.jobId}（${replayed.jobId === submitted.jobId ? "命中" : "异常：未命中！"}）`);

    // 7. 轮询 get（状态流转可见）
    for (let round = 1; round <= 3; round += 1) {
      const view = await client.reviewGet(submitted.jobId);
      log(`[demo] get 轮询 #${round}：status=${view.status}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // 8. cancel（进行中 job 的打断面；已终态则幂等返回当前 view）
    const cancelled = await client.reviewCancel(submitted.jobId);
    log(`[demo] cancel → status=${cancelled.status}`);

    // 9. 轮询到终态（failed——网关不可达；或 cancelled——打断落定）
    const finalDeadline = Date.now() + FINAL_STATE_TIMEOUT_MS;
    let final = await client.reviewGet(submitted.jobId);
    while (final.status !== "succeeded" && final.status !== "failed" && final.status !== "cancelled") {
      if (Date.now() > finalDeadline) {
        fail(`job ${FINAL_STATE_TIMEOUT_MS}ms 内未到终态（status=${final.status}）`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      final = await client.reviewGet(submitted.jobId);
    }
    log(`[demo] 终态：status=${final.status}`);

    // 10. 列表面 + 鉴权负例（401 面：错误 token 的异常语义）
    const page = await client.reviewList();
    log(`[demo] list → ${page.jobs.length} 个 job（本租户视角）`);
    const badClient = new ReviewHttpClient({ baseUrl: `http://127.0.0.1:${port}`, token: "wrong-token" });
    const unauthorized = await badClient.capabilities().catch((error: unknown) => error as HttpRpcResponseError);
    log(
      `[demo] 错误 token → ${unauthorized instanceof HttpRpcResponseError ? `HttpRpcResponseError(code=${unauthorized.code}, httpStatus=${unauthorized.httpStatus})` : "意外：未抛异常"}`,
    );

    log("[demo] 全链路跑通 ✅");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    // 11. 优雅收尾：SIGTERM（POSIX → drain → 143；Windows → 硬终止单进程，无孤儿面）
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000).unref();
    });
    rmSync(workDir, { recursive: true, force: true });
    log("[demo] server 已停止，临时文件已清理");
  }
}

await main();
