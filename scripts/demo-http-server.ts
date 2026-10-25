/**
 * #29 HTTP server demo 全链路（ADR-0013 决策 7/8 的端到端演示）：
 *
 *   进程内回环 stub 网关（脚本化 SSE——与包内 fake 适配器同渲染器 sseBody）
 *   → spawn `review-pi server`（真 node:http 长驻，REVIEWER_URL 指向 stub）
 *   → typed ReviewHttpClient 跑通 capabilities → submit（config B，真检视执行）
 *   → SSE 订阅（seq 单调推进）→ 断线重连（Last-Event-ID 续传，不重不丢）
 *   → cancel（queued 直取终态）→ get（result 只回 artifact 逻辑引用）
 *   → artifact 下载（audit/record 内容读回）→ scope 负例（artifact:read 分开
 *   授权）→ SIGTERM 优雅退出。
 *
 * 检视执行面：stub 网关回放 config B 六相位脚本（phase-5 出唯一候选 F100、
 * phase-6 裁决通过 + complete）——job 以 succeeded 落定、真产物落盘，artifact
 * 下载端点有真内容可服务；不打真网关，key 只经 env 注入子进程，绝不落盘回显。
 * stub 带 pause/resume 门：submit 后暂停，让「queued cancel」与「SSE 断线重连」
 * 两段演示确定性成立（job 卡在相位边界，恢复后事件续流）。
 *
 * 平台差异：Windows 无 POSIX 信号语义，child.kill() 即硬终止单进程 server
 * （无孙进程，无孤儿面）；POSIX 走 SIGTERM → 优雅 drain（SSE closeAll 先于
 * server.close——open stream 不卡退出）→ 退出码 143。
 *
 * 运行（仓库根）：
 *   pnpm demo:http-server
 * （编译模式与 probe-gateway-cache.ts 同款：tsc 单文件 → .tmp-gen → node）
 *
 * 退出码：0 全链路跑通；1 任一步失败或 server 启动超时。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  HttpRpcResponseError,
  REVIEW_MODEL_ID,
  ReviewHttpClient,
  sseBody,
  type FakeReply,
  type ReviewHttpClientEvent,
} from "review-pi";

// 仓库根：demo 经 `pnpm demo:http-server`（仓库根）驱动，cwd 即根——不从
// import.meta.url 推（编译产物落 .tmp-gen/scripts/，相对推导错位）
const repoRoot = process.cwd();
const serverBin = path.join("packages", "review-pi", "bin", "review-pi.js");

/** server 就绪探测上限（毫秒）——listen + endpoint 解析应远快于此 */
const READY_TIMEOUT_MS = 15_000;
/** 轮询步进 */
const POLL_INTERVAL_MS = 150;
/** 各演示段的等待上限（stub 恢复后六相位毫秒级完成；留足慢机余量） */
const STEP_TIMEOUT_MS = 30_000;

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
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.once("error", reject);
  });
}

/** 段级看门狗：一步卡死给人话并退出（demo 不允许无声悬挂） */
async function withDeadline<T>(work: Promise<T>, label: string, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} ${timeoutMs}ms 内未完成`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

// ---- 回环 stub 网关（bin.process.test.ts startLoopbackStub 同款 + pause 门） ----

interface StubGateway {
  /** 子进程 REVIEWER_URL 目标（含 /v1 后缀） */
  readonly baseUrl: string;
  /** 暂停处置（到达的请求挂起——queued cancel 演示的确定性前提） */
  pause(): void;
  /** 恢复处置（挂起请求依序放行） */
  resume(): void;
  close(): Promise<void>;
}

/**
 * 回环网关 stub：GET /v1/models（健康面）、POST /v1/chat/completions
 * （stream:false → JSON completion 回显；stream:true → 依序回放脚本回复的
 * SSE，sseBody 与 fake 适配器同渲染器）。脚本耗尽即 500——脚本错配是 demo
 * 自身的 bug，要炸出来不能静默复用旧回复。
 */
function startStubGateway(replies: readonly FakeReply[]): Promise<StubGateway> {
  const queue = [...replies];
  let paused = false;
  const held: Array<() => void> = [];
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        body = undefined;
      }
      const deliver = (): void => {
        if (request.method === "GET" && request.url === "/v1/models") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [{ id: REVIEW_MODEL_ID }] }));
          return;
        }
        if (request.method === "POST" && request.url === "/v1/chat/completions") {
          const wantsStream = (body as { stream?: unknown } | undefined)?.stream === true;
          if (!wantsStream) {
            // 非流式探针（如 max_tokens:1 ping）：回显模型 + 合法 usage
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                model: (body as { model?: unknown } | undefined)?.model ?? REVIEW_MODEL_ID,
                choices: [
                  { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }),
            );
            return;
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
        response.end(
          JSON.stringify({ error: { message: `stub: unexpected ${request.method} ${request.url}` } }),
        );
      };
      if (paused) {
        held.push(deliver);
        return;
      }
      deliver();
    });
  });
  return new Promise<StubGateway>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        pause: () => {
          paused = true;
        },
        resume: () => {
          paused = false;
          for (const deliver of held.splice(0)) {
            deliver();
          }
        },
        close: () =>
          new Promise<void>((closed) => {
            server.closeAllConnections?.();
            server.close(() => closed());
          }),
      });
    });
  });
}

/** config B 六相位脚本（一轮零工具完成）：phase-5 出唯一候选 F100，phase-6 裁决通过 + complete。
 * 注意 finding 文案必须纯英文——内核裁决后有 NON_ENGLISH 拒收门（demo 实证）。 */
function demoCorpus(): FakeReply[] {
  const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
  const candidate = {
    id: "F100",
    severity: "P2",
    category: "correctness",
    file: "example.ts",
    line: 2,
    title: "Demo finding: exported constant added without review confirmation",
    description: "demo: the sole scripted candidate produced by the stub gateway (artifact chain demo)",
    evidence: ["example.ts:2"],
    rule: "demo-rule",
    confidence: 0.5,
  };
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: JSON.stringify({ candidates: [candidate] }), usage: ZERO },
    {
      text: JSON.stringify({
        verdicts: [{ id: "F100", pass: true, reason: "stub verdict: evidence holds" }],
        complete: true,
      }),
      usage: ZERO,
    },
  ];
}

/** SSE 事件单行日志（seq / 帧名 / 状态 / 相位或产物摘要） */
function describeEvent(event: ReviewHttpClientEvent): string {
  const progress = event.progress !== undefined ? ` phase=${event.progress.phase} round=${event.progress.round}` : "";
  const findings = event.result !== undefined ? ` findings=${event.result.findings.length} rounds=${event.result.rounds}` : "";
  return `seq=${event.seq} event=${event.event} status=${event.status}${progress}${findings}`;
}

async function main(): Promise<void> {
  if (process.env.REVIEWER_URL !== undefined || process.env.REVIEWER_API_KEY !== undefined) {
    fail(
      "检测到 REVIEWER_* 环境变量——demo 刻意注入回环 stub 网关演示全链路，不消费真凭据。请 unset 后重跑。",
    );
  }

  // 1. 临时装配面：token 文件（两把——全量 / 无 artifact:read）+ 仓库快照 + diff + 输出根
  const workDir = mkdtempSync(path.join(tmpdir(), "review-pi-demo-http-"));
  const tokenFile = path.join(workDir, "tokens.json");
  const fullToken = "demo-token-full";
  const noArtifactToken = "demo-token-no-artifact";
  writeFileSync(
    tokenFile,
    JSON.stringify(
      {
        tokens: {
          [fullToken]: {
            tenantId: "demo-tenant",
            subject: "demo-http",
            scopes: ["review:submit", "review:read", "review:cancel", "artifact:read"],
          },
          [noArtifactToken]: {
            tenantId: "demo-tenant",
            subject: "demo-http-limited",
            scopes: ["review:submit", "review:read"],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  const repoDir = path.join(workDir, "repo");
  const diffFile = path.join(workDir, "demo.diff");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(path.join(repoDir, "example.ts"), 'export const answer = 42;\n', "utf8");
  writeFileSync(
    diffFile,
    '--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,3 @@\n export const answer = 42;\n+export const extra = "demo";\n',
    "utf8",
  );
  const outDir = path.join(workDir, "runs");

  // 2. 回环 stub 网关（进程内，bind 0）+ 真 server 子进程（检视执行走真 runReview）
  const stub = await startStubGateway(demoCorpus());
  const port = await reserveFreePort();
  log(`[demo] 临时 token 文件：${tokenFile}`);
  log(`[demo] stub 网关：${stub.baseUrl}`);
  log(`[demo] 目标地址：http://127.0.0.1:${port}`);

  const child = spawn(
    process.execPath,
    [
      serverBin,
      "server",
      "--auth-token-file",
      tokenFile,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--out",
      outDir,
      "--artifact-retention-days",
      "7",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        REVIEWER_URL: stub.baseUrl,
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
    const client = new ReviewHttpClient({ baseUrl: `http://127.0.0.1:${port}`, token: fullToken });
    const readyDeadline = Date.now() + READY_TIMEOUT_MS;
    while (!(await client.healthz())) {
      if (Date.now() > readyDeadline) {
        fail(`server ${READY_TIMEOUT_MS}ms 内未就绪（healthz 不通）`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    log("[demo] server 就绪（GET /healthz → 200）");

    // 4. capabilities（发现面：#29 新增 features.sse / artifactDownload 与
    //    limits.artifactRetentionDays 旗标透传）
    const info = await withDeadline(client.capabilities(), "capabilities");
    log(`[demo] capabilities: protocolVersion=${info.protocolVersion} serverId=${info.serverId}`);
    log(
      `[demo]   features: sse=${String(info.features.sse)} artifactDownload=${String(info.features.artifactDownload)} submitHttpStatus=${String(info.features.submitHttpStatus)} idempotency=${String(info.features.idempotency)}`,
    );
    log(
      `[demo]   limits: maxDiffBytes=${info.limits.maxDiffBytes} maxBodyBytes=${String(info.limits.maxBodyBytes)} artifactRetentionDays=${String(info.limits.artifactRetentionDays)}（--artifact-retention-days 7 旗标透传）`,
    );

    // 5. 暂停 stub → submit（config B——job 将卡在首个相位，为断线重连与
    //    queued cancel 两段演示创造确定性窗口）
    stub.pause();
    const request = {
      caseId: "demo-mr-1",
      repoPath: repoDir,
      diff: { kind: "file" as const, path: diffFile },
      issueDescription: "demo: 演示 SSE 进度流 + artifact 下载全链路（stub 网关）",
      configId: "B" as const,
      clientRequestId: "demo-client-req-1",
    };
    const submitted = await withDeadline(client.submit(request), "submit");
    log(`[demo] submit → 202：jobId=${submitted.jobId} status=${submitted.status}`);

    // 6. 幂等重放（同 clientRequestId 同参 → 同 job，不重复检视）
    const replayed = await withDeadline(client.submit(request), "幂等重放 submit");
    log(
      `[demo] 幂等重放 → 同 jobId=${replayed.jobId}（${replayed.jobId === submitted.jobId ? "命中" : "异常：未命中！"}）`,
    );

    // 7. SSE 第一次订阅：拿到首个事件（running，seq=1）即断开——模拟断线
    let lastSeq: number | undefined;
    for await (const event of client.events(submitted.jobId)) {
      log(`[demo] SSE 事件：${describeEvent(event)}`);
      lastSeq = event.seq;
      break; // 模拟断线：消费方提前退出
    }
    if (lastSeq !== 1) {
      fail(`SSE 首事件应为 running（seq=1），实际 lastSeq=${String(lastSeq)}`);
    }
    log(`[demo] 断线（消费方退出）——已收到 seq=${String(lastSeq)}`);

    // 8. cancel 演示：并发 1 且 job-A 卡在 stub → job-B 确定性 queued，
    //    cancel 直取终态 cancelled（不触 stub，脚本零消耗）
    const jobB = await withDeadline(
      client.submit({
        caseId: "demo-mr-cancel",
        repoPath: repoDir,
        diff: { kind: "file", path: diffFile },
        issueDescription: "demo: queued cancel 面",
        configId: "B",
      }),
      "submit（cancel 演示）",
    );
    if (jobB.status !== "queued") {
      fail(`cancel 演示前提破坏：job-B 应为 queued（实际 ${jobB.status}——stub 门失效？）`);
    }
    const cancelled = await withDeadline(client.reviewCancel(jobB.jobId), "cancel");
    log(`[demo] cancel（queued 直取终态）：jobId=${jobB.jobId} → status=${cancelled.status}`);
    if (cancelled.status !== "cancelled") {
      fail(`queued cancel 应落 cancelled（实际 ${cancelled.status}）`);
    }

    // 9. 断线重连：Last-Event-ID=1 续传；300ms 后恢复 stub，事件应续流
    //    （不重收 seq=1、首事件 seq=2——重放与 live 双面覆盖）
    setTimeout(() => {
      log("[demo] 恢复 stub 网关——job-A 继续推进");
      stub.resume();
    }, 300).unref();
    log("[demo] SSE 重连（Last-Event-ID: 1）——等待事件续流…");
    const events: ReviewHttpClientEvent[] = [];
    await withDeadline(
      (async () => {
        for await (const event of client.events(submitted.jobId, { lastEventId: 1 })) {
          log(`[demo] SSE 事件：${describeEvent(event)}`);
          events.push(event);
          if (event.status === "succeeded") {
            break;
          }
        }
      })(),
      "SSE 重连消费",
    );
    if (events.length === 0 || events[0]!.seq !== 2) {
      fail(`重连首事件应为 seq=2（不重收、不丢事件），实际 ${String(events[0]?.seq)}`);
    }
    const seqs = events.map((event) => event.seq);
    if (seqs.some((seq, index) => index > 0 && seq <= seqs[index - 1]!)) {
      fail(`重连后 seq 应严格单调，实际 ${seqs.join(",")}`);
    }
    const final = events[events.length - 1]!;
    if (final.status !== "succeeded") {
      fail(`SSE 末事件应为 succeeded（实际 ${final.status}）`);
    }

    // 10. get 终态视图：result 只回 artifact 逻辑引用（服务器路径不外泄）
    const view = await withDeadline(client.reviewGet(submitted.jobId), "get 终态");
    log(
      `[demo] get 终态：status=${view.status} result.auditRef=${view.result?.auditRef} result.recordRef=${view.result?.recordRef}`,
    );
    if (view.result === undefined || !view.result.auditRef.startsWith("artifact:audit/")) {
      fail(`result.auditRef 应为逻辑引用（artifact:audit/<runId>），实际 ${String(view.result?.auditRef)}`);
    }

    // 11. artifact 下载：逻辑引用 → 真产物内容（audit/record 落盘即 JSON）
    const auditBody = await withDeadline(client.downloadArtifact(submitted.jobId, "audit"), "audit 下载");
    const recordBody = await withDeadline(client.downloadArtifact(submitted.jobId, "record"), "record 下载");
    const preview = (body: string): string => body.split("\n", 1)[0]!.slice(0, 100);
    log(`[demo] artifact 下载（audit）：${Buffer.byteLength(auditBody, "utf8")} 字节，预览：${preview(auditBody)}`);
    log(`[demo] artifact 下载（record）：${Buffer.byteLength(recordBody, "utf8")} 字节，预览：${preview(recordBody)}`);
    if (auditBody.length === 0 || recordBody.length === 0) {
      fail("artifact 下载内容不应为空");
    }

    // 12. scope 负例：artifact:read 与 review:read 分开授权——无 artifact:read
    //     的 token 下载 → 403/-32007，但 SSE 订阅（review:read）不受影响
    const noArtifactClient = new ReviewHttpClient({ baseUrl: `http://127.0.0.1:${port}`, token: noArtifactToken });
    const denied = await noArtifactClient.downloadArtifact(submitted.jobId, "audit").catch(
      (error: unknown) => error,
    );
    if (
      denied instanceof HttpRpcResponseError &&
      denied.code === -32007 &&
      denied.httpStatus === 403
    ) {
      log("[demo] scope 负例（无 artifact:read）→ HttpRpcResponseError(code=-32007, httpStatus=403)");
    } else {
      fail(`scope 负例应拒以 403/-32007，实际：${String(denied)}`);
    }
    let noArtifactSawEvent = false;
    for await (const event of noArtifactClient.events(submitted.jobId)) {
      noArtifactSawEvent = event.seq >= 1; // review:read 足够订阅——只证可达，不消费
      break;
    }
    if (!noArtifactSawEvent) {
      fail("无 artifact:read 的 token 应仍可订阅 SSE（review:read 分开授权）");
    }
    log("[demo] 同 token 的 SSE 订阅正常（review:read 与 artifact:read 分开授权）");

    log("[demo] 全链路跑通 ✅");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    // 13. 优雅收尾：SIGTERM（POSIX → SSE closeAll → drain → 143；Windows →
    //     硬终止单进程，无孤儿面）
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000).unref();
    });
    await stub.close();
    rmSync(workDir, { recursive: true, force: true });
    log("[demo] server 已停止，stub 已关闭，临时文件已清理");
  }
}

await main();
