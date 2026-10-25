import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import type { RpcServerInfo } from "../rpc/main.js";
import { FakeReviewRunExecutor, fakeReviewRunSummary } from "../rpc/executor.js";
import { createReviewService, type ReviewService } from "../rpc/service.js";
import { createTokenFileAuthenticator } from "./auth.js";
import { HttpRpcResponseError, ReviewHttpClient, type ReviewHttpClientEvent } from "./http-client.js";
import type { HttpReviewJobView } from "./http-view.js";
import { HTTP_RPC_FEATURES, createReviewHttpServer } from "./http-server.js";
import { createIdempotencyKeeper } from "./idempotency.js";
import { createSseEndpoint, type SseEndpoint } from "./sse.js";
import { createArtifactEndpoint } from "./artifacts.js";

// #28 typed ReviewHttpClient 缝测：对真 node:http server（临时端口）走
// capabilities → submit → get/list/cancel 全链路 + 错误异常面。信封 / 状态码 /
// 头的传输层契约在 http-server.test.ts 已锁——这里只测 client 的解包与异常
// 透传语义（demo 脚本同款链路）。
// #29 P2b 增补：events() async generator（SSE 订阅/重放/断流收尾）与
// downloadArtifact()（成功读回 + 错误面透传）的客户端面语义。

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface ClientFixture {
  readonly client: ReviewHttpClient;
  readonly badTokenClient: ReviewHttpClient;
  readonly submitOnlyClient: ReviewHttpClient;
  readonly repoDir: string;
  readonly service: ReviewService;
  readonly executor: FakeReviewRunExecutor;
  readonly sse: SseEndpoint;
  close(): Promise<void>;
}

async function startFixture(): Promise<ClientFixture> {
  const repoDir = makeTempDir("review-pi-client-repo-");
  const tokenFile = path.join(makeTempDir("review-pi-client-tokens-"), "tokens.json");
  writeFileSync(
    tokenFile,
    JSON.stringify({
      tokens: {
        "tok-full": {
          tenantId: "platform-x",
          subject: "svc-runner",
          scopes: ["review:submit", "review:read", "review:cancel", "artifact:read"],
        },
        "tok-submit-only": {
          tenantId: "platform-x",
          subject: "svc-limited",
          scopes: ["review:submit"],
        },
      },
    }),
    "utf8",
  );

  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({ executor });
  const serverInfo: RpcServerInfo = {
    protocolVersion: 2,
    serverId: "test-server",
    methods: ["server.capabilities", "review.submit", "review.get", "review.list", "review.cancel"],
    features: HTTP_RPC_FEATURES,
    limits: { maxDiffBytes: service.limits.maxDiffBytes, maxQueueDepth: 100, concurrency: 1 },
  };
  const sse = createSseEndpoint({ service });
  const artifacts = createArtifactEndpoint({ service });
  const server = createReviewHttpServer({
    service,
    authenticator: createTokenFileAuthenticator({ tokenFile }),
    idempotency: createIdempotencyKeeper(),
    serverInfo,
    sse,
    artifacts,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    client: new ReviewHttpClient({ baseUrl, token: "tok-full" }),
    badTokenClient: new ReviewHttpClient({ baseUrl, token: "tok-wrong" }),
    submitOnlyClient: new ReviewHttpClient({ baseUrl, token: "tok-submit-only" }),
    repoDir,
    service,
    executor,
    sse,
    close: async () => {
      sse.closeAll(); // 长连接先于 server.close 收口（否则 close 挂起等 SSE 流）
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

afterEach(async () => {
  // fixture 由各用例 try/finally close（见 startFixture.close）
});

test("capabilities：typed 返回 serverInfo（submitHttpStatus 202 / idempotency true / defaultRepo null）", async () => {
  const fixture = await startFixture();
  try {
    const info = await fixture.client.capabilities();
    expect(info.protocolVersion).toBe(2);
    expect(info.features.submitHttpStatus).toBe(202);
    expect(info.features.idempotency).toBe(true);
    expect(info.features.defaultRepo).toBeNull();
  } finally {
    await fixture.close();
  }
});

test("submit → get → list → cancel 全链路：typed view 形状与 job 生命周期透传", async () => {
  const fixture = await startFixture();
  try {
    const submitted = await fixture.client.submit({
      caseId: "MR-101",
      repoPath: fixture.repoDir,
      diff: { kind: "inline", text: "--- a\n+++ b\n@@ -1 +1 @@\n+x\n" },
      configId: "E",
      clientRequestId: "demo-rev-1",
    });
    expect(submitted.jobId).toMatch(/^job-/);
    expect(["queued", "running"]).toContain(submitted.status);

    const got = await fixture.client.reviewGet(submitted.jobId);
    expect(got.jobId).toBe(submitted.jobId);

    const page = await fixture.client.reviewList({ status: "running" });
    expect(page.jobs.map((job) => job.jobId)).toContain(submitted.jobId);

    const cancelled = await fixture.client.reviewCancel(submitted.jobId);
    expect(cancelled.status).toBe("cancelling");

    // 幂等重放（demo 的网络重试语义）：同 clientRequestId 同参 → 同 job
    const replayed = await fixture.client.submit({
      caseId: "MR-101",
      repoPath: fixture.repoDir,
      diff: { kind: "inline", text: "--- a\n+++ b\n@@ -1 +1 @@\n+x\n" },
      configId: "E",
      clientRequestId: "demo-rev-1",
    });
    expect(replayed.jobId).toBe(submitted.jobId);
  } finally {
    await fixture.close();
  }
});

test("应用错误 → RpcResponseError（code/message/data 透传；-32001 未知 job）", async () => {
  const fixture = await startFixture();
  try {
    await expect(fixture.client.reviewGet("job-none")).rejects.toMatchObject({
      name: "HttpRpcResponseError",
      code: -32001,
      data: { jobId: "job-none" },
    });
  } finally {
    await fixture.close();
  }
});

test("传输错误 → HttpRpcResponseError（httpStatus / retryAfterSeconds 暴露给重试决策）", async () => {
  const fixture = await startFixture();
  try {
    // 401：坏 token
    const unauthorized = await fixture.badTokenClient.capabilities().catch((error: unknown) => error);
    expect(unauthorized).toBeInstanceOf(HttpRpcResponseError);
    expect(unauthorized).toMatchObject({ code: -32006, httpStatus: 401 });

    // 403：scope 不足（submit-only token 调 read 面）
    const forbidden = await fixture.submitOnlyClient.reviewGet("job-x").catch((error: unknown) => error);
    expect(forbidden).toBeInstanceOf(HttpRpcResponseError);
    expect(forbidden).toMatchObject({ code: -32007, httpStatus: 403 });

    // 503：draining——retryAfterSeconds 暴露（Retry-After 秒）
    await fixture.service.close();
    const draining = await fixture.client
      .submit({
        caseId: "MR-drain",
        repoPath: fixture.repoDir,
        diff: { kind: "inline", text: "+x\n" },
        configId: "E",
      })
      .catch((error: unknown) => error);
    expect(draining).toBeInstanceOf(HttpRpcResponseError);
    expect(draining).toMatchObject({ code: -32010, httpStatus: 503 });
    expect((draining as HttpRpcResponseError).retryAfterSeconds).toBeGreaterThan(0);
  } finally {
    await fixture.close();
  }
});

test("幂等冲突 → RpcResponseError(-32016)（data 携 clientRequestId）", async () => {
  const fixture = await startFixture();
  try {
    const base = {
      caseId: "MR-conflict",
      repoPath: fixture.repoDir,
      diff: { kind: "inline" as const, text: "+x\n" },
      configId: "E" as const,
      clientRequestId: "conflict-1",
    };
    await fixture.client.submit(base);
    await expect(
      fixture.client.submit({ ...base, issueDescription: "different parameters" }),
    ).rejects.toMatchObject({ code: -32016, data: { clientRequestId: "conflict-1" } });
  } finally {
    await fixture.close();
  }
});

test("healthz：匿名 liveness 探测（200 → true；进程不在 → false，不抛）", async () => {
  const fixture = await startFixture();
  try {
    expect(await fixture.client.healthz()).toBe(true);
  } finally {
    await fixture.close();
  }
  // close 后端口已释放：连接失败 → false（不抛——liveness 探测不产生异常面）
  expect(await fixture.client.healthz()).toBe(false);
});

// ---- #29 P2b：events() / downloadArtifact() 客户端面 ----

/** 轮询等待（异步态落定；10ms 步进，超时抛错定位等待目标） */
async function pollUntil(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 提交并以指定产物路径裁决成功（等待终态；返回 succeeded 视图） */
async function succeedJob(
  fixture: ClientFixture,
  caseId: string,
  auditPath: string,
  recordPath: string,
): Promise<HttpReviewJobView> {
  const submitted = await fixture.client.submit({
    caseId,
    repoPath: fixture.repoDir,
    diff: { kind: "inline", text: "+x\n" },
    configId: "E",
  });
  await pollUntil("execution start", () => fixture.executor.executions.length > 0);
  fixture.executor.executions[0]!.resolve(
    fakeReviewRunSummary({ runId: `run-${caseId}`, auditPath, recordPath }),
  );
  const deadline = Date.now() + 5000;
  for (;;) {
    const view = await fixture.client.reviewGet(submitted.jobId);
    if (view.status === "succeeded") {
      return view;
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for job ${submitted.jobId} to succeed`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("events()：for await 逐事件（seq 单调、HTTP 投影、break 收流降订阅计数）", async () => {
  const fixture = await startFixture();
  try {
    const artifactDir = makeTempDir("review-pi-client-artifacts-");
    const auditPath = path.join(artifactDir, "audit.json");
    const recordPath = path.join(artifactDir, "record.json");
    writeFileSync(auditPath, '{"audit":true}', "utf8");
    writeFileSync(recordPath, '{"record":true}', "utf8");

    const submitted = await fixture.client.submit({
      caseId: "MR-sse",
      repoPath: fixture.repoDir,
      diff: { kind: "inline", text: "+x\n" },
      configId: "E",
    });
    const events: ReviewHttpClientEvent[] = [];
    for await (const event of fixture.client.events(submitted.jobId)) {
      events.push(event);
      if (event.status === "running") {
        // running 已达（重放或 live 均）——裁决成功让流推进到终态
        fixture.executor.executions[0]!.resolve(
          fakeReviewRunSummary({ runId: "run-sse", auditPath, recordPath }),
        );
      }
      if (event.status === "succeeded") {
        break; // 提前退出：generator finally 收 reader，服务端订阅计数应归零
      }
    }

    // 事件面契约：seq per-job 单调（首事件 = 1，submit 不发事件）+ job 帧名
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events.map((event) => event.status)).toEqual(["running", "succeeded"]);
    expect(events.every((event) => event.event === "job")).toBe(true);
    // HTTP 投影：result 携逻辑引用（artifact:audit|record/<runId>），无服务器路径
    expect(events[1]!.result).toMatchObject({
      auditRef: "artifact:audit/run-sse",
      recordRef: "artifact:record/run-sse",
    });
    expect(JSON.stringify(events[1]!.result)).not.toContain("auditPath");
    // break 收流：订阅在服务端侧注销（连接释放传播）
    await pollUntil("subscription teardown", () => fixture.sse.activeSubscriptions === 0);
  } finally {
    await fixture.close();
  }
});

test("events()：lastEventId 续传（Last-Event-ID 位之后的事件补发，不重收）", async () => {
  const fixture = await startFixture();
  try {
    const artifactDir = makeTempDir("review-pi-client-artifacts-");
    const auditPath = path.join(artifactDir, "audit.json");
    const recordPath = path.join(artifactDir, "record.json");
    writeFileSync(auditPath, '{"audit":true}', "utf8");
    writeFileSync(recordPath, '{"record":true}', "utf8");
    const succeeded = await succeedJob(fixture, "MR-replay", auditPath, recordPath);

    // fresh 连接（无 Last-Event-ID）：全量重放 running(1) + succeeded(2)
    const fresh: ReviewHttpClientEvent[] = [];
    for await (const event of fixture.client.events(succeeded.jobId)) {
      fresh.push(event);
      if (fresh.length >= 2) {
        break;
      }
    }
    expect(fresh.map((event) => event.seq)).toEqual([1, 2]);

    // 断线重连（Last-Event-ID: 1）：只补发 seq>1
    const resumed: ReviewHttpClientEvent[] = [];
    for await (const event of fixture.client.events(succeeded.jobId, { lastEventId: 1 })) {
      resumed.push(event);
      if (resumed.length >= 1) {
        break;
      }
    }
    expect(resumed.map((event) => event.seq)).toEqual([2]);
    expect(resumed[0]!.status).toBe("succeeded");
  } finally {
    await fixture.close();
  }
});

test("events() 错误面：未知 job → -32001（200 信封）；scope 不足 → -32007（403）", async () => {
  const fixture = await startFixture();
  try {
    const collect = async (iterate: () => AsyncGenerator<ReviewHttpClientEvent>): Promise<number> => {
      let count = 0;
      for await (const _event of iterate()) {
        count += 1;
      }
      return count;
    };

    // 未知 job：200 + JSON 错误信封（非 event-stream）→ 统一异常面
    await expect(collect(() => fixture.client.events("job-none"))).rejects.toMatchObject({
      name: "HttpRpcResponseError",
      code: -32001,
      httpStatus: 200,
      data: { jobId: "job-none" },
    });

    // submit-only token（无 review:read）：403 传输面
    await expect(collect(() => fixture.submitOnlyClient.events("job-x"))).rejects.toMatchObject({
      name: "HttpRpcResponseError",
      code: -32007,
      httpStatus: 403,
    });
  } finally {
    await fixture.close();
  }
});

test("downloadArtifact()：succeeded 产物内容读回（audit/record 与落盘逐字节一致）", async () => {
  const fixture = await startFixture();
  try {
    const artifactDir = makeTempDir("review-pi-client-artifacts-");
    const auditPath = path.join(artifactDir, "audit-dl.json");
    const recordPath = path.join(artifactDir, "record-dl.json");
    const auditBody = JSON.stringify({ findings: [], kind: "audit" }, null, 2);
    const recordBody = JSON.stringify({ rounds: 3, kind: "record" }, null, 2);
    writeFileSync(auditPath, auditBody, "utf8");
    writeFileSync(recordPath, recordBody, "utf8");
    const succeeded = await succeedJob(fixture, "MR-dl", auditPath, recordPath);

    // result 投影给的是逻辑引用，下载端点解析回内容
    expect(succeeded.result).toMatchObject({
      auditRef: "artifact:audit/run-MR-dl",
      recordRef: "artifact:record/run-MR-dl",
    });
    expect(await fixture.client.downloadArtifact(succeeded.jobId, "audit")).toBe(auditBody);
    expect(await fixture.client.downloadArtifact(succeeded.jobId, "record")).toBe(recordBody);
  } finally {
    await fixture.close();
  }
});

test("downloadArtifact() 错误面：非终态 → -32001；scope 不足 → -32007；文件缺失 → -32017", async () => {
  const fixture = await startFixture();
  try {
    // succeeded 但产物文件已不在（窗口内缺失）：404 + -32017（与过期同面收口）
    const artifactDir = makeTempDir("review-pi-client-artifacts-");
    const auditPath = path.join(artifactDir, "audit-gone.json");
    const recordPath = path.join(artifactDir, "record-gone.json");
    writeFileSync(auditPath, "{}", "utf8");
    writeFileSync(recordPath, "{}", "utf8");
    const succeeded = await succeedJob(fixture, "MR-dl-gone", auditPath, recordPath);
    rmSync(auditPath, { force: true });
    await expect(fixture.client.downloadArtifact(succeeded.jobId, "audit")).rejects.toMatchObject({
      name: "HttpRpcResponseError",
      code: -32017,
      httpStatus: 404,
      data: { jobId: succeeded.jobId },
    });

    // running job（并发 1 占位不裁决）：无产物面 → 200 + -32001（与未知 job 同码、文案区分）
    const running = await fixture.client.submit({
      caseId: "MR-dl-running",
      repoPath: fixture.repoDir,
      diff: { kind: "inline", text: "+x\n" },
      configId: "E",
    });
    await expect(fixture.client.downloadArtifact(running.jobId, "audit")).rejects.toMatchObject({
      name: "HttpRpcResponseError",
      code: -32001,
      httpStatus: 200,
    });

    // submit-only token（无 artifact:read）：403 传输面
    await expect(
      fixture.submitOnlyClient.downloadArtifact(running.jobId, "audit"),
    ).rejects.toMatchObject({
      name: "HttpRpcResponseError",
      code: -32007,
      httpStatus: 403,
    });
  } finally {
    await fixture.close();
  }
});
