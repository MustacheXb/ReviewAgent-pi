import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import type { RpcServerInfo } from "../rpc/main.js";
import type { Finding } from "../contracts/finding.js";
import { FakeReviewRunExecutor, fakeReviewRunSummary } from "../rpc/executor.js";
import { createReviewService, type ReviewService } from "../rpc/service.js";
import { createTokenFileAuthenticator } from "./auth.js";
import {
  HTTP_RPC_FEATURES,
  createReviewHttpServer,
  type AccessLogEvent,
  type InternalErrorLogEvent,
} from "./http-server.js";
import { createIdempotencyKeeper } from "./idempotency.js";
import {
  createSseEndpoint,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_MAX_BACKLOG_BYTES,
  DEFAULT_MAX_SUBSCRIPTIONS_PER_JOB,
  DEFAULT_MAX_SUBSCRIPTIONS_PER_TENANT,
  type SseEndpoint,
  type SseLimits,
} from "./sse.js";
import { createArtifactEndpoint } from "./artifacts.js";

// #28 HTTP wire 缝测试：真 node:http server（临时端口）+ 裸 fetch——断言
// 信封 / 状态码 / 头的传输层契约；服务层以下（状态机 / 队列 / 租户过滤）
// 不重复测业务（rpc/service.test.ts 已锁）。每用例独立实例：幂等表、队列、
// access log 断言互不污染。
// #29 P2b：SSE 面同款裸 fetch / 原生 ReadableStream 读取——帧序列化 /
// Last-Event-ID 重放 / reset / 心跳 / 订阅上限 / 慢消费者 / closeAll 收口。

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

interface TestServer {
  readonly baseUrl: string;
  readonly service: ReviewService;
  readonly executor: FakeReviewRunExecutor;
  readonly sse: SseEndpoint;
  readonly logs: readonly AccessLogEvent[];
  readonly repoDir: string;
  close(): Promise<void>;
}

/** 起一套独立 server（listen 0 临时端口）；token 集固定三枚覆盖鉴权矩阵 */
async function startTestServer(
  options: {
    readonly maxDiffBytes?: number;
    readonly maxQueueDepth?: number;
    /** service 内存事件日志上限（reset/gap 用例压窗用） */
    readonly maxJobEvents?: number;
    /** SSE 面上限（订阅数 / 心跳 / 慢消费者——按用例收窄） */
    readonly sseLimits?: Partial<SseLimits>;
    /** 产物保留窗口（天——过期用例收窄用） */
    readonly artifactRetentionDays?: number;
  } = {},
): Promise<TestServer> {
  const repoDir = makeTempDir("review-pi-http-repo-");
  const tokenFile = path.join(makeTempDir("review-pi-http-tokens-"), "tokens.json");
  writeFileSync(
    tokenFile,
    JSON.stringify({
      tokens: {
        "tok-platform": {
          tenantId: "platform-x",
          subject: "svc-runner",
          scopes: ["review:submit", "review:read", "review:cancel", "artifact:read"],
        },
        "tok-tenant-b": {
          tenantId: "tenant-b",
          subject: "svc-b",
          scopes: ["review:submit", "review:read", "review:cancel", "artifact:read"],
        },
        "tok-submit-only": {
          tenantId: "platform-x",
          subject: "svc-limited",
          scopes: ["review:submit"],
        },
        "tok-no-artifact": {
          tenantId: "platform-x",
          subject: "svc-no-artifact",
          scopes: ["review:submit", "review:read", "review:cancel"],
        },
      },
    }),
    "utf8",
  );

  const executor = new FakeReviewRunExecutor();
  const service = createReviewService({
    executor,
    ...(options.maxDiffBytes !== undefined || options.maxQueueDepth !== undefined
      ? {
          limits: {
            ...(options.maxDiffBytes !== undefined ? { maxDiffBytes: options.maxDiffBytes } : {}),
            ...(options.maxQueueDepth !== undefined ? { maxQueueDepth: options.maxQueueDepth } : {}),
          },
        }
      : {}),
    ...(options.maxJobEvents !== undefined ? { maxJobEvents: options.maxJobEvents } : {}),
  });
  const sse = createSseEndpoint({
    service,
    ...(options.sseLimits !== undefined ? { limits: options.sseLimits } : {}),
  });
  const artifactEndpoint = createArtifactEndpoint({
    service,
    ...(options.artifactRetentionDays !== undefined
      ? { retentionDays: options.artifactRetentionDays }
      : {}),
  });
  const serverInfo: RpcServerInfo = {
    protocolVersion: 2,
    serverId: "test-server",
    methods: ["server.capabilities", "review.submit", "review.get", "review.list", "review.cancel"],
    features: HTTP_RPC_FEATURES,
    limits: {
      maxDiffBytes: service.limits.maxDiffBytes,
      maxQueueDepth: service.limits.maxQueueDepth,
      concurrency: 1,
      maxBodyBytes: 1024 * 1024,
    },
  };
  const logs: AccessLogEvent[] = [];
  const server = createReviewHttpServer({
    service,
    authenticator: createTokenFileAuthenticator({ tokenFile }),
    idempotency: createIdempotencyKeeper(),
    serverInfo,
    sse,
    artifacts: artifactEndpoint,
    onAccessLog: (event) => logs.push(event),
    limits: { maxBodyBytes: 1024 * 1024 },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    service,
    executor,
    sse,
    logs,
    repoDir,
    close: async () => {
      // SSE 长连接先断（open stream 会卡死 server.close——与 main.ts drain 同序）
      sse.closeAll();
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

/** POST /rpc 一发（JSON-RPC envelope 断言面；string body 直发——parse error 用例） */
function rpcFetch(
  baseUrl: string,
  body: unknown,
  options: { readonly token?: string; readonly headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.token !== undefined ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** review.submit 参数样例（repoPath 默认指向临时仓库目录） */
function submitParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caseId: "MR-101",
    repoPath: "/nonexistent-repo-for-shape-tests",
    diff: { kind: "inline", text: "--- a\n+++ b\n@@ -1 +1 @@\n+x\n" },
    configId: "E",
    ...overrides,
  };
}

const CAPABILITIES_REQUEST = { jsonrpc: "2.0", id: "c1", method: "server.capabilities" };

afterEach(async () => {
  // 每用例内联 close（见 startTestServer.close）；此处兜底由 GC 前端口释放保证
});

// ---- 端点面 ----

test("GET /healthz 匿名 200 + {status:ok}（无 Authorization 也通过；liveness 只证明进程在）", async () => {
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  } finally {
    await server.close();
  }
});

test("GET /readyz 鉴权后 200 + {status:ready}；无 token → 401 envelope（-32006）", async () => {
  const server = await startTestServer();
  try {
    const unauthed = await fetch(`${server.baseUrl}/readyz`);
    expect(unauthed.status).toBe(401);
    expect(await unauthed.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32006, message: "missing or invalid bearer token" },
    });

    const res = await fetch(`${server.baseUrl}/readyz`, {
      headers: { Authorization: "Bearer tok-platform" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
  } finally {
    await server.close();
  }
});

test("GET /v1/capabilities 鉴权后 200 + serverInfo（与 server.capabilities 方法同源同构）", async () => {
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/v1/capabilities`, {
      headers: { Authorization: "Bearer tok-platform" },
    });
    expect(res.status).toBe(200);
    const info = (await res.json()) as RpcServerInfo;
    expect(info.protocolVersion).toBe(2);
    expect(info.features.submitHttpStatus).toBe(202);
    expect(info.features.idempotency).toBe(true);
    expect(info.features.defaultRepo).toBeNull();
    expect(info.limits.maxBodyBytes).toBe(1024 * 1024);
  } finally {
    await server.close();
  }
});

test("非契约路径 → 404（裸 JSON，不在 JSON-RPC 错误面内）", async () => {
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/v2/rpc`);
    expect(res.status).toBe(404);
  } finally {
    await server.close();
  }
});

// ---- 鉴权面 ----

test("POST /rpc 无 Authorization → 401 + id:null envelope（-32006）+ WWW-Authenticate", async () => {
  const server = await startTestServer();
  try {
    const res = await rpcFetch(server.baseUrl, CAPABILITIES_REQUEST);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32006, message: "missing or invalid bearer token" },
    });
  } finally {
    await server.close();
  }
});

test("POST /rpc 未知 token → 401 envelope（id:null——token 不可信时无调用方身份可回显）", async () => {
  const server = await startTestServer();
  try {
    const res = await rpcFetch(server.baseUrl, CAPABILITIES_REQUEST, { token: "tok-wrong" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { id: unknown; error: { code: number } };
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32006);
  } finally {
    await server.close();
  }
});

test("scope 执法：submit-only token 调 review.get → 403 envelope（-32007）；capabilities 认证即可", async () => {
  const server = await startTestServer();
  try {
    const denied = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: 7, method: "review.get", params: { jobId: "job-x" } },
      { token: "tok-submit-only" },
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32007, message: "token lacks required scope: review:read" },
    });

    const allowed = await rpcFetch(server.baseUrl, CAPABILITIES_REQUEST, { token: "tok-submit-only" });
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { id: string }).id).toBe("c1");
  } finally {
    await server.close();
  }
});

// ---- 信封纪律 ----

test("body 非法 JSON → 200 + -32700（id:null）；batch 数组 → 200 + -32600", async () => {
  const server = await startTestServer();
  try {
    const parseError = await rpcFetch(server.baseUrl, "{ not json", { token: "tok-platform" });
    expect(parseError.status).toBe(200);
    expect(await parseError.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });

    const batch = await rpcFetch(server.baseUrl, [CAPABILITIES_REQUEST], { token: "tok-platform" });
    expect(batch.status).toBe(200);
    expect(await batch.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
  } finally {
    await server.close();
  }
});

test("未知方法 / shutdown → 200 + -32601（HTTP 面不暴露进程生命周期方法）", async () => {
  const server = await startTestServer();
  try {
    for (const method of ["review.unknown", "shutdown"]) {
      const res = await rpcFetch(
        server.baseUrl,
        { jsonrpc: "2.0", id: "x", method },
        { token: "tok-platform" },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; error: { code: number; message: string } };
      expect(body.id).toBe("x");
      expect(body.error.code).toBe(-32601);
      expect(body.error.message).toContain(method);
    }
  } finally {
    await server.close();
  }
});

// ---- submit / get / list / cancel ----

test("review.submit 成功 → 202 + Location: /v1/jobs/{jobId} + envelope result（status queued）", async () => {
  const server = await startTestServer();
  try {
    const res = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "s1", method: "review.submit", params: submitParams({ repoPath: server.repoDir }) },
      { token: "tok-platform" },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; result: { jobId: string; status: string } };
    expect(body.id).toBe("s1");
    expect(body.result.status).toBe("queued");
    expect(res.headers.get("location")).toBe(`/v1/jobs/${body.result.jobId}`);
  } finally {
    await server.close();
  }
});

test("HTTP 面 repoPath 必填：缺席 → 200 + -32602（无 cwd 缺省链，ADR-0013 决策 3）", async () => {
  const server = await startTestServer();
  try {
    const { repoPath: _repoPath, ...withoutRepo } = submitParams();
    const res = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "s2", method: "review.submit", params: withoutRepo },
      { token: "tok-platform" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain("repoPath");
  } finally {
    await server.close();
  }
});

test("review.get / review.list / review.cancel 全 200 + envelope；get 未知 job → -32001", async () => {
  const server = await startTestServer();
  try {
    const missing = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "g0", method: "review.get", params: { jobId: "job-none" } },
      { token: "tok-platform" },
    );
    expect(missing.status).toBe(200);
    const missingBody = (await missing.json()) as { error: { code: number; data: { jobId: string } } };
    expect(missingBody.error.code).toBe(-32001);
    expect(missingBody.error.data).toEqual({ jobId: "job-none" });

    const submit = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "s", method: "review.submit", params: submitParams({ repoPath: server.repoDir }) },
      { token: "tok-platform" },
    );
    const { jobId } = ((await submit.json()) as { result: { jobId: string } }).result;

    const got = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "g1", method: "review.get", params: { jobId } },
      { token: "tok-platform" },
    );
    expect(got.status).toBe(200);
    expect(((await got.json()) as { result: { jobId: string } }).result.jobId).toBe(jobId);

    const listed = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "l1", method: "review.list" },
      { token: "tok-platform" },
    );
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { result: { jobs: { jobId: string }[] } };
    expect(listBody.result.jobs.map((job) => job.jobId)).toContain(jobId);

    const cancelled = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "c1", method: "review.cancel", params: { jobId } },
      { token: "tok-platform" },
    );
    expect(cancelled.status).toBe(200);
    const cancelBody = (await cancelled.json()) as { result: { jobId: string; status: string } };
    // fetch 往返期间 job 已被 pump 到 running（fake 立即起跑）——running 的
    // cancel 语义是 cancelling（执行侧收场后落 cancelled；状态机在 service 层已锁）
    expect(cancelBody.result.status).toBe("cancelling");
  } finally {
    await server.close();
  }
});

test("租户隔离：platform 的 job 对 tenant-b 不可见——get/cancel 统一 -32001（不泄漏存在性）", async () => {
  const server = await startTestServer();
  try {
    const submit = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "s", method: "review.submit", params: submitParams({ repoPath: server.repoDir }) },
      { token: "tok-platform" },
    );
    const { jobId } = ((await submit.json()) as { result: { jobId: string } }).result;

    for (const [id, method] of [
      ["g", "review.get"],
      ["c", "review.cancel"],
    ] as const) {
      const res = await rpcFetch(
        server.baseUrl,
        { jsonrpc: "2.0", id, method, params: { jobId } },
        { token: "tok-tenant-b" },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32001);
    }
  } finally {
    await server.close();
  }
});

test("params 自报 tenantId 无效：Principal 恒由 token 派生（job 属 token 租户）", async () => {
  const server = await startTestServer();
  try {
    const submit = await rpcFetch(
      server.baseUrl,
      {
        jsonrpc: "2.0",
        id: "s",
        method: "review.submit",
        params: submitParams({ repoPath: server.repoDir, tenantId: "tenant-b-impersonated" }),
      },
      { token: "tok-platform" },
    );
    const { jobId } = ((await submit.json()) as { result: { jobId: string } }).result;

    const asTenantB = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "g", method: "review.get", params: { jobId } },
      { token: "tok-tenant-b" },
    );
    expect(((await asTenantB.json()) as { error: { code: number } }).error.code).toBe(-32001);
  } finally {
    await server.close();
  }
});

// ---- 幂等 ----

test("幂等命中：同 clientRequestId 同参再提交 → 202 + 同 jobId，不新建 job", async () => {
  const server = await startTestServer();
  try {
    const params = submitParams({ repoPath: server.repoDir, clientRequestId: "mr-1-rev-1" });
    const first = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "s1", method: "review.submit", params },
      { token: "tok-platform" },
    );
    const second = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "s2", method: "review.submit", params },
      { token: "tok-platform" },
    );
    expect(second.status).toBe(202);
    const firstJob = ((await first.json()) as { result: { jobId: string } }).result.jobId;
    expect(((await second.json()) as { result: { jobId: string } }).result.jobId).toBe(firstJob);

    const list = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "l", method: "review.list" },
      { token: "tok-platform" },
    );
    const jobs = ((await list.json()) as { result: { jobs: unknown[] } }).result.jobs;
    expect(jobs).toHaveLength(1);
  } finally {
    await server.close();
  }
});

test("幂等命中 202 的 Location 同构：重复提交也回 Location 头（既有 job 的资源位）", async () => {
  const server = await startTestServer();
  try {
    const params = submitParams({ repoPath: server.repoDir, clientRequestId: "mr-loc" });
    const first = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "s1", method: "review.submit", params },
      { token: "tok-platform" },
    );
    const second = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "s2", method: "review.submit", params },
      { token: "tok-platform" },
    );
    expect(second.headers.get("location")).toBe(first.headers.get("location"));
  } finally {
    await server.close();
  }
});

test("幂等冲突：同 clientRequestId 异参 → 200 + -32016（data 携 clientRequestId）；不覆盖既有 job", async () => {
  const server = await startTestServer();
  try {
    await rpcFetch(
      server.baseUrl,
      {
        jsonrpc: "2.0",
        id: "s1",
        method: "review.submit",
        params: submitParams({ repoPath: server.repoDir, clientRequestId: "mr-conflict" }),
      },
      { token: "tok-platform" },
    );
    const conflict = await rpcFetch(
      server.baseUrl,
      {
        jsonrpc: "2.0",
        id: "s2",
        method: "review.submit",
        params: submitParams({
          repoPath: server.repoDir,
          clientRequestId: "mr-conflict",
          issueDescription: "different issue text",
        }),
      },
      { token: "tok-platform" },
    );
    expect(conflict.status).toBe(200);
    expect(await conflict.json()).toEqual({
      jsonrpc: "2.0",
      id: "s2",
      error: {
        code: -32016,
        message: "clientRequestId already used with different parameters",
        data: { clientRequestId: "mr-conflict" },
      },
    });

    const list = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "l", method: "review.list" },
      { token: "tok-platform" },
    );
    expect(((await list.json()) as { result: { jobs: unknown[] } }).result.jobs).toHaveLength(1);
  } finally {
    await server.close();
  }
});

test("幂等口径：metadata 不参与（同 id 变 metadata → 命中）；无 clientRequestId 两次提交 → 两个 job", async () => {
  const server = await startTestServer();
  try {
    const first = await rpcFetch(
      server.baseUrl,
      {
        jsonrpc: "2.0",
        id: "s1",
        method: "review.submit",
        params: submitParams({
          repoPath: server.repoDir,
          clientRequestId: "mr-meta",
          metadata: { rev: 1 },
        }),
      },
      { token: "tok-platform" },
    );
    const second = await rpcFetch(
      server.baseUrl,
      {
        jsonrpc: "2.0",
        id: "s2",
        method: "review.submit",
        params: submitParams({
          repoPath: server.repoDir,
          clientRequestId: "mr-meta",
          metadata: { rev: 2 },
        }),
      },
      { token: "tok-platform" },
    );
    expect(((await second.json()) as { result: { jobId: string } }).result.jobId).toBe(
      ((await first.json()) as { result: { jobId: string } }).result.jobId,
    );

    const a = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "s3", method: "review.submit", params: submitParams({ repoPath: server.repoDir, caseId: "MR-a" }) },
      { token: "tok-platform" },
    );
    const b = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "s4", method: "review.submit", params: submitParams({ repoPath: server.repoDir, caseId: "MR-b" }) },
      { token: "tok-platform" },
    );
    expect(((await b.json()) as { result: { jobId: string } }).result.jobId).not.toBe(
      ((await a.json()) as { result: { jobId: string } }).result.jobId,
    );
  } finally {
    await server.close();
  }
});

test("幂等键租户隔离：不同租户同 clientRequestId 互不冲突（各建各的 job）", async () => {
  const server = await startTestServer();
  try {
    const a = await rpcFetch(
      server.baseUrl,
      {
        jsonrpc: "2.0",
        id: "s1",
        method: "review.submit",
        params: submitParams({ repoPath: server.repoDir, clientRequestId: "shared-id" }),
      },
      { token: "tok-platform" },
    );
    const b = await rpcFetch(
      server.baseUrl,
      {
        jsonrpc: "2.0",
        id: "s2",
        method: "review.submit",
        params: submitParams({ repoPath: server.repoDir, clientRequestId: "shared-id" }),
      },
      { token: "tok-tenant-b" },
    );
    expect(b.status).toBe(202);
    expect(((await b.json()) as { result: { jobId: string } }).result.jobId).not.toBe(
      ((await a.json()) as { result: { jobId: string } }).result.jobId,
    );
  } finally {
    await server.close();
  }
});

test("并发同 key 提交：共享同一次 submit——两响应同 jobId，list 长度 1", async () => {
  const server = await startTestServer();
  try {
    const params = submitParams({ repoPath: server.repoDir, clientRequestId: "mr-race" });
    const [a, b] = await Promise.all([
      rpcFetch(server.baseUrl, { jsonrpc: "2.0", id: "s1", method: "review.submit", params }, { token: "tok-platform" }),
      rpcFetch(server.baseUrl, { jsonrpc: "2.0", id: "s2", method: "review.submit", params }, { token: "tok-platform" }),
    ]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(((await b.json()) as { result: { jobId: string } }).result.jobId).toBe(
      ((await a.json()) as { result: { jobId: string } }).result.jobId,
    );

    const list = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "l", method: "review.list" },
      { token: "tok-platform" },
    );
    expect(((await list.json()) as { result: { jobs: unknown[] } }).result.jobs).toHaveLength(1);
  } finally {
    await server.close();
  }
});

test("并发同 key 异参提交：后到者判 -32016（不透传首者的 job——串行链落定后指纹对比）", async () => {
  const server = await startTestServer();
  try {
    // 异参必须体现在指纹字段（diff 文本）——caseId 不参与指纹口径
    const [a, b] = await Promise.all([
      rpcFetch(
        server.baseUrl,
        { jsonrpc: "2.0", id: "s1", method: "review.submit", params: submitParams({ repoPath: server.repoDir, clientRequestId: "mr-race-conflict" }) },
        { token: "tok-platform" },
      ),
      rpcFetch(
        server.baseUrl,
        {
          jsonrpc: "2.0",
          id: "s2",
          method: "review.submit",
          params: submitParams({
            repoPath: server.repoDir,
            clientRequestId: "mr-race-conflict",
            diff: { kind: "inline", text: "--- a\n+++ b\n@@ -1 +1 @@\n+y\n" },
          }),
        },
        { token: "tok-platform" },
      ),
    ]);
    // 到达序不定：恰好一个 202（首者受理）+ 一个 200+envelope（异参被拒）
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    const bodies = (await Promise.all([a.json(), b.json()])) as Array<{
      result?: { jobId: string };
      error?: { code: number; data: { clientRequestId: string } };
    }>;
    const rejected = bodies.find((body) => body.error !== undefined);
    const accepted = bodies.find((body) => body.result !== undefined);
    expect(rejected?.error?.code).toBe(-32016);
    expect(rejected?.error?.data.clientRequestId).toBe("mr-race-conflict");
    expect(accepted?.result?.jobId).toBeTruthy();

    // 被拒者未入队：list 仍只有首者的 1 个 job
    const list = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "l", method: "review.list" },
      { token: "tok-platform" },
    );
    expect(((await list.json()) as { result: { jobs: unknown[] } }).result.jobs).toHaveLength(1);
  } finally {
    await server.close();
  }
});

// ---- 上限 / 限流 / drain ----

test("body 超限（Content-Length 预检门）→ 413 + id:null envelope（-32004 + data.maxBodyBytes）", async () => {
  const server = await startTestServer();
  try {
    const oversized = { jsonrpc: "2.0", id: "big", method: "review.submit", params: submitParams({ repoPath: server.repoDir, padding: "x".repeat(2 * 1024 * 1024) }) };
    const res = await rpcFetch(server.baseUrl, oversized, { token: "tok-platform" });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32004, message: "request body exceeds maxBodyBytes", data: { maxBodyBytes: 1024 * 1024 } },
    });
  } finally {
    await server.close();
  }
});

test("diff 超限（service maxDiffBytes）→ 413 + envelope（-32004，id:null——非 200 状态即传输面）", async () => {
  const server = await startTestServer({ maxDiffBytes: 64 });
  try {
    const res = await rpcFetch(
      server.baseUrl,
      {
        jsonrpc: "2.0",
        id: "s",
        method: "review.submit",
        params: submitParams({ repoPath: server.repoDir, diff: { kind: "inline", text: "x".repeat(128) } }),
      },
      { token: "tok-platform" },
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { id: string | null; error: { code: number; data: { maxDiffBytes: number } } };
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32004);
    expect(body.error.data.maxDiffBytes).toBe(64);
  } finally {
    await server.close();
  }
});

test("queue_full → 429 + Retry-After（秒）+ envelope（-32002，id:null——非 200 状态即传输面）", async () => {
  const server = await startTestServer({ maxQueueDepth: 1 });
  try {
    // 第 1 个 running（fake 挂起）+ 第 2 个 queued → 第 3 个触发 queue_full
    for (const id of ["s1", "s2"]) {
      const res = await rpcFetch(
        server.baseUrl,
        { jsonrpc: "2.0", id, method: "review.submit", params: submitParams({ repoPath: server.repoDir, caseId: `MR-${id}` }) },
        { token: "tok-platform" },
      );
      expect(res.status).toBe(202);
    }
    const rejected = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "s3", method: "review.submit", params: submitParams({ repoPath: server.repoDir, caseId: "MR-s3" }) },
      { token: "tok-platform" },
    );
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toMatch(/^\d+$/);
    const body = (await rejected.json()) as { id: string | null; error: { code: number } };
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32002);
  } finally {
    await server.close();
  }
});

test("draining：service.close() 后 submit → 503 + Retry-After + -32010；readyz → 503", async () => {
  const server = await startTestServer();
  await server.service.close();
  try {
    const res = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "s", method: "review.submit", params: submitParams({ repoPath: server.repoDir }) },
      { token: "tok-platform" },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32010);

    const ready = await fetch(`${server.baseUrl}/readyz`, {
      headers: { Authorization: "Bearer tok-platform" },
    });
    expect(ready.status).toBe(503);
    expect(((await ready.json()) as { error: { code: number } }).error.code).toBe(-32010);

    // liveness 不受 drain 影响（进程还活着）
    const health = await fetch(`${server.baseUrl}/healthz`);
    expect(health.status).toBe(200);
  } finally {
    await server.close();
  }
});

test("repoPath 不存在 → 200 + -32012（域校验错误，不是传输错误）", async () => {
  const server = await startTestServer();
  try {
    const res = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "s", method: "review.submit", params: submitParams({ repoPath: "/definitely/not/here" }) },
      { token: "tok-platform" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32012);
    // 安全细节纪律：消息不含路径值
    expect(body.error.message).not.toContain("/definitely");
  } finally {
    await server.close();
  }
});

// ---- 请求关联与日志面 ----

test("X-Request-Id：自带合法值回显；缺失生成（响应头恒有值）", async () => {
  const server = await startTestServer();
  try {
    const custom = await rpcFetch(server.baseUrl, CAPABILITIES_REQUEST, {
      token: "tok-platform",
      headers: { "X-Request-Id": "trace-42" },
    });
    expect(custom.headers.get("x-request-id")).toBe("trace-42");

    const generated = await rpcFetch(server.baseUrl, CAPABILITIES_REQUEST, { token: "tok-platform" });
    expect(generated.headers.get("x-request-id")).toMatch(/^req-/);
  } finally {
    await server.close();
  }
});

test("access log 白名单：字段集 = requestId/method/path/status/tenantId/durationMs；token 值绝不出现", async () => {
  const server = await startTestServer();
  try {
    await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "s", method: "review.submit", params: submitParams({ repoPath: server.repoDir }) },
      { token: "tok-platform" },
    );
    await rpcFetch(server.baseUrl, CAPABILITIES_REQUEST); // 401 面
    await fetch(`${server.baseUrl}/healthz`);

    const submitLog = server.logs.find((entry) => entry.path === "/rpc" && entry.status === 202);
    expect(submitLog).toBeDefined();
    expect(submitLog?.tenantId).toBe("platform-x");
    expect(submitLog?.requestId).toMatch(/^req-/);
    expect(typeof submitLog?.durationMs).toBe("number");

    const unauthedLog = server.logs.find((entry) => entry.path === "/rpc" && entry.status === 401);
    expect(unauthedLog?.tenantId).toBeUndefined();

    // 白名单之外零字段；Authorization 值不进日志（redaction 结构性实现）
    const serialized = JSON.stringify(server.logs);
    expect(serialized).not.toContain("tok-platform");
    expect(serialized).not.toContain("Bearer");
    for (const entry of server.logs) {
      expect(Object.keys(entry).every((key) =>
        ["requestId", "method", "path", "status", "tenantId", "durationMs"].includes(key),
      )).toBe(true);
    }
  } finally {
    await server.close();
  }
});

test("capabilities 方法（POST /rpc）与 GET /v1/capabilities 同源同构", async () => {
  const server = await startTestServer();
  try {
    const viaRpc = await rpcFetch(server.baseUrl, CAPABILITIES_REQUEST, { token: "tok-platform" });
    const viaGet = await fetch(`${server.baseUrl}/v1/capabilities`, {
      headers: { Authorization: "Bearer tok-platform" },
    });
    expect(await viaGet.json()).toEqual(((await viaRpc.json()) as { result: unknown }).result);
  } finally {
    await server.close();
  }
});

// ---- 内部异常面（协议面固定文案 + 服务端日志缝留痕）----

test("内部异常（非 RpcError）→ 200 + 固定文案 Internal error + onInternalError 缝留痕（异常原文不进协议面）", async () => {
  // 单独组装：service.get 抛非 RpcError——dispatch 兜底分支（fake 只需满足
  // 本用例触达的方法面，其余形状以 cast 收口）
  const tokenFile = path.join(makeTempDir("review-pi-http-tokens-"), "tokens.json");
  writeFileSync(
    tokenFile,
    JSON.stringify({
      tokens: { "tok-platform": { tenantId: "platform-x", subject: "svc-runner", scopes: ["review:read"] } },
    }),
    "utf8",
  );
  const internalErrors: InternalErrorLogEvent[] = [];
  const failing = {
    submit: async () => {
      throw new Error("unreachable in this test");
    },
    get: async () => {
      throw new Error("boom: /etc/reviewagent-secret.pem");
    },
    list: async () => ({ jobs: [], total: 0 }),
    cancel: async () => {
      throw new Error("unreachable in this test");
    },
    close: async () => undefined,
    isDraining: () => false,
    limits: { maxDiffBytes: 8 * 1024 * 1024, maxQueueDepth: 64 },
  } as unknown as ReviewService;
  const serverInfo: RpcServerInfo = {
    protocolVersion: 2,
    serverId: "test-server",
    methods: ["review.get"],
    features: HTTP_RPC_FEATURES,
    limits: { maxDiffBytes: 8 * 1024 * 1024, maxQueueDepth: 64, concurrency: 1, maxBodyBytes: 1024 * 1024 },
  };
  const server = createReviewHttpServer({
    service: failing,
    authenticator: createTokenFileAuthenticator({ tokenFile }),
    idempotency: createIdempotencyKeeper(),
    serverInfo,
    onInternalError: (event) => internalErrors.push(event),
    limits: { maxBodyBytes: 1024 * 1024 },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await rpcFetch(
      `http://127.0.0.1:${port}`,
      { jsonrpc: "2.0", id: "g1", method: "review.get", params: { jobId: "job-x" } },
      { token: "tok-platform" },
    );
    expect(res.status).toBe(200);
    // 协议面固定文案：异常原文（含可能的路径/key）绝不回显
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: "g1",
      error: { code: -32603, message: "Internal error" },
    });
    // 服务端日志缝留痕：name/message 白名单（运维可见 500 面）
    expect(internalErrors).toHaveLength(1);
    expect(internalErrors[0]!.requestId).toBeTruthy();
    expect(internalErrors[0]!.method).toBe("POST");
    expect(internalErrors[0]!.path).toBe("/rpc");
    expect(internalErrors[0]!.errorName).toBe("Error");
    expect(internalErrors[0]!.errorMessage).toContain("boom");
  } finally {
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---- SSE 事件流（#29 P2b：GET /v1/jobs/{jobId}/events）----

/** SSE 帧解析：event/id/data 三行（retry/心跳注释帧无 data——undefined 省键） */
function parseFrame(frame: string): {
  readonly event?: string;
  readonly id?: string;
  readonly data?: unknown;
} {
  const lines = frame.split("\n");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const idLine = lines.find((line) => line.startsWith("id: "));
  const dataLine = lines.find((line) => line.startsWith("data: "));
  return {
    ...(eventLine !== undefined ? { event: eventLine.slice("event: ".length) } : {}),
    ...(idLine !== undefined ? { id: idLine.slice("id: ".length) } : {}),
    ...(dataLine !== undefined ? { data: JSON.parse(dataLine.slice("data: ".length)) } : {}),
  };
}

interface SseStream {
  readonly res: Response;
  /** 已收帧原始文本（含 retry / 心跳注释帧；后台 pump 持续追加） */
  readonly frames: readonly string[];
  /** 读到 count 帧（5s 截止返回现有集——由断言收口，不在此 fail） */
  readFrames(count: number): Promise<string[]>;
  /** 等流结束（closeAll / 慢消费者断开面）；5s 截止返回当前态 */
  waitEnded(): Promise<boolean>;
  abort(): void;
}

/** 打开 SSE 流（裸 fetch + 原生 ReadableStream——wire 契约断言面） */
async function openEventStream(
  baseUrl: string,
  jobId: string,
  options: { readonly token?: string; readonly lastEventId?: number } = {},
): Promise<SseStream> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/v1/jobs/${jobId}/events`, {
    headers: {
      ...(options.token !== undefined ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.lastEventId !== undefined ? { "Last-Event-ID": String(options.lastEventId) } : {}),
    },
    signal: controller.signal,
  });
  const frames: string[] = [];
  const state = { ended: false };
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          frames.push(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // abort / 服务端 destroy：帧收集终止（断言面在 frames/ended，不掩盖业务失败）
    } finally {
      state.ended = true;
    }
  })();
  const readFrames = async (count: number): Promise<string[]> => {
    const deadline = Date.now() + 5000;
    while (frames.length < count && !state.ended && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return [...frames];
  };
  return {
    res,
    frames,
    readFrames,
    waitEnded: async (): Promise<boolean> => {
      const deadline = Date.now() + 5000;
      while (!state.ended && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return state.ended;
    },
    abort: () => controller.abort(),
  };
}

/** 轮询等待条件成立（超时抛错——SSE/进程面的异步落定点） */
async function pollUntil(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) {
    throw new Error(`timed out waiting for: ${what}`);
  }
}

/** 微任务排干（executor resolve → settleJob 链落定；service.test 同款） */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 提交一个 job（fake executor 持 running 直到 resolve/reject），返回 jobId */
async function submitJob(server: TestServer, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await rpcFetch(
    server.baseUrl,
    { jsonrpc: "2.0", id: "s", method: "review.submit", params: submitParams({ repoPath: server.repoDir, ...overrides }) },
    { token: "tok-platform" },
  );
  return ((await res.json()) as { result: { jobId: string } }).result.jobId;
}

test("SSE 鉴权与 scope 面：无 token → 401；缺 review:read → 403；未知/异租户 job → 200 + -32001（JSON 信封，非流）", async () => {
  const server = await startTestServer();
  try {
    const jobId = await submitJob(server);

    const unauthed = await fetch(`${server.baseUrl}/v1/jobs/${jobId}/events`);
    expect(unauthed.status).toBe(401);
    expect(((await unauthed.json()) as { error: { code: number } }).error.code).toBe(-32006);

    const forbidden = await fetch(`${server.baseUrl}/v1/jobs/${jobId}/events`, {
      headers: { Authorization: "Bearer tok-submit-only" },
    });
    expect(forbidden.status).toBe(403);
    const forbiddenBody = (await forbidden.json()) as { error: { code: number; message: string } };
    expect(forbiddenBody.error.code).toBe(-32007);
    expect(forbiddenBody.error.message).toContain("review:read");

    // 未知 job 与异租户同面（越权统一 not found——不泄漏存在性）
    const unknown = await fetch(`${server.baseUrl}/v1/jobs/job-none/events`, {
      headers: { Authorization: "Bearer tok-platform" },
    });
    expect(unknown.status).toBe(200);
    expect(unknown.headers.get("content-type")).toBe("application/json");
    expect(await unknown.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unknown job: job-none", data: { jobId: "job-none" } },
    });

    const foreign = await fetch(`${server.baseUrl}/v1/jobs/${jobId}/events`, {
      headers: { Authorization: "Bearer tok-tenant-b" },
    });
    expect(foreign.status).toBe(200);
    expect(((await foreign.json()) as { error: { code: number } }).error.code).toBe(-32001);
  } finally {
    await server.close();
  }
});

test("SSE 基线：fresh 连接 → retry 首帧 + seq1 running 重放；头三件套（event-stream/no-cache/no-buffering）", async () => {
  const server = await startTestServer();
  try {
    const jobId = await submitJob(server);
    const stream = await openEventStream(server.baseUrl, jobId, { token: "tok-platform" });
    try {
      expect(stream.res.status).toBe(200);
      expect(stream.res.headers.get("content-type")).toBe("text/event-stream");
      expect(stream.res.headers.get("cache-control")).toBe("no-cache");
      expect(stream.res.headers.get("x-accel-buffering")).toBe("no");
      const frames = await stream.readFrames(2);
      expect(frames[0]).toBe("retry: 5000");
      const parsed = parseFrame(frames[1]!);
      expect(parsed.event).toBe("job");
      expect(parsed.id).toBe("1");
      expect(parsed.data).toMatchObject({ seq: 1, jobId, status: "running" });
    } finally {
      stream.abort();
    }
  } finally {
    await server.close();
  }
});

test("SSE live：连接后 executor 落定 → succeeded 帧 live 到达；result 为 HTTP 投影（auditRef/recordRef，无服务器路径）", async () => {
  const server = await startTestServer();
  try {
    const jobId = await submitJob(server);
    const stream = await openEventStream(server.baseUrl, jobId, { token: "tok-platform" });
    try {
      await stream.readFrames(2); // retry + seq1 running
      server.executor.executions[0]!.resolve(
        fakeReviewRunSummary({
          runId: "run-sse-1",
          auditPath: "C:\\secret\\audit.json",
          recordPath: "C:\\secret\\record.json",
        }),
      );
      const frames = await stream.readFrames(3);
      const parsed = parseFrame(frames[2]!);
      expect(parsed.event).toBe("job");
      expect(parsed.id).toBe("2");
      const data = parsed.data as { status: string; result: Record<string, unknown> };
      expect(data.status).toBe("succeeded");
      expect(data.result.auditRef).toBe("artifact:audit/run-sse-1");
      expect(data.result.recordRef).toBe("artifact:record/run-sse-1");
      expect("auditPath" in data.result).toBe(false);
      expect("recordPath" in data.result).toBe(false);
    } finally {
      stream.abort();
    }
  } finally {
    await server.close();
  }
});

test("SSE cancel：running → cancelling（seq2）→ cancelled（seq3）；failed 转移走 error 帧", async () => {
  const server = await startTestServer();
  try {
    const jobId = await submitJob(server);
    const stream = await openEventStream(server.baseUrl, jobId, { token: "tok-platform" });
    try {
      await stream.readFrames(2);
      const cancelled = await rpcFetch(
        server.baseUrl,
        { jsonrpc: "2.0", id: "c", method: "review.cancel", params: { jobId } },
        { token: "tok-platform" },
      );
      expect(((await cancelled.json()) as { result: { status: string } }).result.status).toBe("cancelling");
      // 执行侧以错误收场（abort 响应）→ cancelled
      server.executor.executions[0]!.reject(new Error("aborted"));
      const frames = await stream.readFrames(4);
      expect(parseFrame(frames[2]!).data).toMatchObject({ seq: 2, status: "cancelling" });
      expect(parseFrame(frames[3]!).data).toMatchObject({ seq: 3, status: "cancelled" });
    } finally {
      stream.abort();
    }

    // failed 转移：event 名换 error（data 仍携完整视图，含 error.message）
    const failedJobId = await submitJob(server, { caseId: "MR-fail" });
    const failedStream = await openEventStream(server.baseUrl, failedJobId, { token: "tok-platform" });
    try {
      await failedStream.readFrames(2);
      server.executor.executions[1]!.reject(new Error("D:\\secret\\gateway is down"));
      const frames = await failedStream.readFrames(3);
      const parsed = parseFrame(frames[2]!);
      expect(parsed.event).toBe("error");
      expect(parsed.id).toBe("2");
      // 非合同异常固定 generic 文案（spec §9——异常原文不进协议面）
      expect(parsed.data).toMatchObject({ seq: 2, status: "failed", error: { message: "review execution failed" } });
    } finally {
      failedStream.abort();
    }
  } finally {
    await server.close();
  }
});

test("SSE 断线重连：Last-Event-ID 之后补发（id=1 → 只补 seq2）；已到最新 → 仅 retry 帧无 data 帧", async () => {
  const server = await startTestServer();
  try {
    const jobId = await submitJob(server);
    server.executor.executions[0]!.resolve(fakeReviewRunSummary({ runId: "run-reconnect" }));
    await flushAsync(); // seq1 running + seq2 succeeded 已落定并入库

    const reconnected = await openEventStream(server.baseUrl, jobId, { token: "tok-platform", lastEventId: 1 });
    try {
      const frames = await reconnected.readFrames(2);
      expect(frames[0]).toBe("retry: 5000");
      const parsed = parseFrame(frames[1]!);
      expect(parsed.event).toBe("job");
      expect(parsed.id).toBe("2");
      expect(parsed.data).toMatchObject({ seq: 2, status: "succeeded" });
    } finally {
      reconnected.abort();
    }

    // 已到最新（id=2）：空重放——纯 live 等 150ms（心跳 20s 不打扰）
    const upToDate = await openEventStream(server.baseUrl, jobId, { token: "tok-platform", lastEventId: 2 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(upToDate.frames).toEqual(["retry: 5000"]);
    } finally {
      upToDate.abort();
    }
  } finally {
    await server.close();
  }
});

test("SSE reset：保留窗覆盖不到 Last-Event-ID → reset 帧携最新快照（memory store 清理面；#30 保留窗口同语义）", async () => {
  const server = await startTestServer({ maxJobEvents: 1 });
  try {
    const jobId = await submitJob(server);
    server.executor.executions[0]!.resolve(fakeReviewRunSummary({ runId: "run-gap" }));
    await flushAsync(); // seq1（running）被清理，只留 seq2

    const stream = await openEventStream(server.baseUrl, jobId, { token: "tok-platform" }); // fresh = afterSeq 0 → gap
    try {
      const frames = await stream.readFrames(2);
      expect(frames[0]).toBe("retry: 5000");
      const parsed = parseFrame(frames[1]!);
      expect(parsed.event).toBe("reset");
      expect(parsed.id).toBe("2");
      expect(parsed.data).toMatchObject({ seq: 2, status: "succeeded" });
    } finally {
      stream.abort();
    }
  } finally {
    await server.close();
  }
});

test("SSE 缺省上限钉住（spec §4.3 / ADR-0013 决策 7）：心跳 20s、8/job、32/租户、积压 1 MiB", () => {
  // 契约数值防漂移：行为面测试注入小值全覆盖，缺省值在此单列钉住
  expect(DEFAULT_HEARTBEAT_MS).toBe(20_000);
  expect(DEFAULT_MAX_SUBSCRIPTIONS_PER_JOB).toBe(8);
  expect(DEFAULT_MAX_SUBSCRIPTIONS_PER_TENANT).toBe(32);
  expect(DEFAULT_MAX_BACKLOG_BYTES).toBe(1024 * 1024);
});

test("SSE 订阅上限（job 维）：第三连接 429 + Retry-After + -32013；断开即恢复配额", async () => {
  const server = await startTestServer({ sseLimits: { maxSubscriptionsPerJob: 2 } });
  try {
    const jobId = await submitJob(server);
    const first = await openEventStream(server.baseUrl, jobId, { token: "tok-platform" });
    const second = await openEventStream(server.baseUrl, jobId, { token: "tok-platform" });
    try {
      expect(server.sse.activeSubscriptions).toBe(2);

      const third = await fetch(`${server.baseUrl}/v1/jobs/${jobId}/events`, {
        headers: { Authorization: "Bearer tok-platform" },
      });
      expect(third.status).toBe(429);
      expect(third.headers.get("retry-after")).toBe("5");
      expect(await third.json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32013,
          message: "subscription limit reached for job",
          data: { limit: 2 },
        },
      });

      // 断开一个 → 配额恢复（计数随连接 close 递减）
      first.abort();
      await pollUntil(() => server.sse.activeSubscriptions === 1, "subscription count after abort");
      const recovered = await fetch(`${server.baseUrl}/v1/jobs/${jobId}/events`, {
        headers: { Authorization: "Bearer tok-platform" },
      });
      expect(recovered.status).toBe(200);
      expect(recovered.headers.get("content-type")).toBe("text/event-stream");
      await recovered.body?.cancel();
    } finally {
      second.abort();
    }
  } finally {
    await server.close();
  }
});

test("SSE 订阅上限（租户维）：同租户跨 job 第二连接 429（message 报因；data.limit 报上限值）", async () => {
  const server = await startTestServer({ sseLimits: { maxSubscriptionsPerTenant: 1 } });
  try {
    const jobIdA = await submitJob(server);
    const jobIdB = await submitJob(server, { caseId: "MR-102" }); // queued（并发位被 A 占）
    const first = await openEventStream(server.baseUrl, jobIdA, { token: "tok-platform" });
    try {
      const second = await fetch(`${server.baseUrl}/v1/jobs/${jobIdB}/events`, {
        headers: { Authorization: "Bearer tok-platform" },
      });
      expect(second.status).toBe(429);
      const body = (await second.json()) as { error: { code: number; data: { limit: number } } };
      expect(body.error.code).toBe(-32013);
      expect(body.error.data.limit).toBe(1);
    } finally {
      first.abort();
    }
  } finally {
    await server.close();
  }
});

test("SSE 慢消费者：写队列积压超上限即断开（客户端凭 Last-Event-ID 重连或转 get 轮询——决策 7）", async () => {
  const server = await startTestServer({ sseLimits: { maxBacklogBytes: 1 } });
  try {
    const jobId = await submitJob(server);
    // 首个 data 帧写出即超 1B 积压上限 → terminate（destroy）。destroy 可能抢在
    // 响应头送达前（flush 异步）——fetch 直接抛错或流终止，均为断连证据
    let disconnected = false;
    try {
      const stream = await openEventStream(server.baseUrl, jobId, { token: "tok-platform" });
      disconnected = await stream.waitEnded();
    } catch {
      disconnected = true; // 握手期即被 destroy（同步断开面）
    }
    expect(disconnected).toBe(true);
    await pollUntil(() => server.sse.activeSubscriptions === 0, "subscription teardown after backlog disconnect");
  } finally {
    await server.close();
  }
});

test("SSE 心跳：静默期注释帧保活（: heartbeat——不进客户端事件面）", async () => {
  const server = await startTestServer({ sseLimits: { heartbeatMs: 25 } });
  try {
    const jobId = await submitJob(server);
    const stream = await openEventStream(server.baseUrl, jobId, { token: "tok-platform" });
    try {
      await pollUntil(
        () => stream.frames.filter((frame) => frame === ": heartbeat").length >= 3,
        "heartbeat frames",
      );
      expect(stream.frames.filter((frame) => frame === ": heartbeat").length).toBeGreaterThanOrEqual(3);
    } finally {
      stream.abort();
    }
  } finally {
    await server.close();
  }
});

test("SSE closeAll：drain 收口断开全部订阅（main.ts 在 server.close 前调——open stream 会卡死 close）", async () => {
  const server = await startTestServer();
  try {
    const jobId = await submitJob(server);
    const stream = await openEventStream(server.baseUrl, jobId, { token: "tok-platform" });
    await stream.readFrames(2);
    expect(server.sse.activeSubscriptions).toBe(1);

    server.sse.closeAll();
    expect(await stream.waitEnded()).toBe(true);
    await pollUntil(() => server.sse.activeSubscriptions === 0, "subscription teardown after closeAll");
  } finally {
    await server.close();
  }
});

test("SSE drain 面：draining 期新订阅 → 503 + -32010 + Retry-After", async () => {
  const server = await startTestServer();
  try {
    await server.service.close(); // 无 job：立即落定，draining = true
    const res = await fetch(`${server.baseUrl}/v1/jobs/job-any/events`, {
      headers: { Authorization: "Bearer tok-platform" },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32010, message: "server is draining" },
    });
  } finally {
    await server.close();
  }
});

test("SSE access log：长连接断开（close 面）也留痕且不重复（SSE 无 finish 事件）", async () => {
  const server = await startTestServer();
  try {
    const jobId = await submitJob(server);
    const stream = await openEventStream(server.baseUrl, jobId, { token: "tok-platform" });
    await stream.readFrames(2);
    stream.abort();
    await pollUntil(
      () => server.logs.some((log) => log.path === `/v1/jobs/${jobId}/events`),
      "SSE access log entry",
    );
    const logged = server.logs.filter((log) => log.path === `/v1/jobs/${jobId}/events`);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ method: "GET", status: 200, tenantId: "platform-x" });
  } finally {
    await server.close();
  }
});

// ---- artifact 下载（#29 P2b：GET /v1/jobs/{jobId}/artifacts/{audit|record}）----

test("artifact 鉴权面：无 token → 401；缺 artifact:read → 403（audit/record 各自独立执法）", async () => {
  const server = await startTestServer();
  try {
    const jobId = await submitJob(server);
    const unauthed = await fetch(`${server.baseUrl}/v1/jobs/${jobId}/artifacts/audit`);
    expect(unauthed.status).toBe(401);

    for (const kind of ["audit", "record"] as const) {
      const forbidden = await fetch(`${server.baseUrl}/v1/jobs/${jobId}/artifacts/${kind}`, {
        headers: { Authorization: "Bearer tok-no-artifact" },
      });
      expect(forbidden.status).toBe(403);
      const body = (await forbidden.json()) as { error: { code: number; message: string } };
      expect(body.error.code).toBe(-32007);
      expect(body.error.message).toContain("artifact:read");
    }
  } finally {
    await server.close();
  }
});

test("artifact 错误面：未知/异租户/非终态 job → 200 + -32001（越权统一 not found；无产物不另造码）", async () => {
  const server = await startTestServer();
  try {
    const unknown = await fetch(`${server.baseUrl}/v1/jobs/job-none/artifacts/audit`, {
      headers: { Authorization: "Bearer tok-platform" },
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unknown job: job-none", data: { jobId: "job-none" } },
    });

    const jobId = await submitJob(server); // running（未落定）
    const running = await fetch(`${server.baseUrl}/v1/jobs/${jobId}/artifacts/audit`, {
      headers: { Authorization: "Bearer tok-platform" },
    });
    expect(running.status).toBe(200);
    expect(await running.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "job has no artifacts (status: running)", data: { jobId } },
    });

    const foreign = await fetch(`${server.baseUrl}/v1/jobs/${jobId}/artifacts/audit`, {
      headers: { Authorization: "Bearer tok-tenant-b" },
    });
    expect(foreign.status).toBe(200);
    expect(((await foreign.json()) as { error: { code: number } }).error.code).toBe(-32001);
  } finally {
    await server.close();
  }
});

test("artifact 下载：audit / record 独立可取——application/json 流 + attachment 文件名", async () => {
  const server = await startTestServer();
  try {
    const artifactDir = makeTempDir("review-pi-http-artifacts-");
    const auditContent = JSON.stringify({ wireBody: "replayable-request-bytes" });
    const recordContent = JSON.stringify({ findings: [], verdicts: [] });
    const auditPath = path.join(artifactDir, "audit-run-art-1.json");
    const recordPath = path.join(artifactDir, "record-run-art-1.json");
    writeFileSync(auditPath, auditContent, "utf8");
    writeFileSync(recordPath, recordContent, "utf8");

    const jobId = await submitJob(server);
    server.executor.executions[0]!.resolve(
      fakeReviewRunSummary({ runId: "run-art-1", auditPath, recordPath }),
    );
    await flushAsync();

    const audit = await fetch(`${server.baseUrl}/v1/jobs/${jobId}/artifacts/audit`, {
      headers: { Authorization: "Bearer tok-platform" },
    });
    expect(audit.status).toBe(200);
    expect(audit.headers.get("content-type")).toBe("application/json");
    expect(audit.headers.get("content-disposition")).toBe('attachment; filename="audit-run-art-1.json"');
    expect(await audit.text()).toBe(auditContent);

    const record = await fetch(`${server.baseUrl}/v1/jobs/${jobId}/artifacts/record`, {
      headers: { Authorization: "Bearer tok-platform" },
    });
    expect(record.status).toBe(200);
    expect(record.headers.get("content-disposition")).toBe('attachment; filename="record-run-art-1.json"');
    expect(await record.text()).toBe(recordContent);
  } finally {
    await server.close();
  }
});

test("artifact 过期：超出保留窗口 → 404 + -32017（retentionDays=0 即刻过期；#30 清理任务同码）", async () => {
  const server = await startTestServer({ artifactRetentionDays: 0 });
  try {
    const artifactDir = makeTempDir("review-pi-http-artifacts-");
    const auditPath = path.join(artifactDir, "audit-run-exp.json");
    writeFileSync(auditPath, "{}", "utf8");
    const jobId = await submitJob(server);
    server.executor.executions[0]!.resolve(
      fakeReviewRunSummary({ runId: "run-exp", auditPath, recordPath: path.join(artifactDir, "record-run-exp.json") }),
    );
    await flushAsync();
    await new Promise((resolve) => setTimeout(resolve, 10)); // elapsed > 0 天

    const res = await fetch(`${server.baseUrl}/v1/jobs/${jobId}/artifacts/audit`, {
      headers: { Authorization: "Bearer tok-platform" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32017, message: "artifact expired", data: { jobId } },
    });
  } finally {
    await server.close();
  }
});

test("artifact 缺失：窗口内但文件不在（清理先行/落盘失败遗留）→ 404 + -32017 同面（不泄漏 fs 细节）", async () => {
  const server = await startTestServer();
  try {
    const goneDir = path.join(makeTempDir("review-pi-http-gone-"), "never-written");
    const jobId = await submitJob(server);
    server.executor.executions[0]!.resolve(
      fakeReviewRunSummary({
        runId: "run-gone",
        auditPath: path.join(goneDir, "audit.json"),
        recordPath: path.join(goneDir, "record.json"),
      }),
    );
    await flushAsync();

    const res = await fetch(`${server.baseUrl}/v1/jobs/${jobId}/artifacts/record`, {
      headers: { Authorization: "Bearer tok-platform" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32017, message: "artifact expired or missing", data: { jobId } },
    });
  } finally {
    await server.close();
  }
});

test("artifact drain 面：draining 期下载不受阻（读面——与 SSE 新订阅不同，不持长连接）", async () => {
  const server = await startTestServer();
  try {
    const artifactDir = makeTempDir("review-pi-http-artifacts-");
    const auditPath = path.join(artifactDir, "audit-run-drain.json");
    writeFileSync(auditPath, '{"drain":true}', "utf8");
    const jobId = await submitJob(server);
    server.executor.executions[0]!.resolve(
      fakeReviewRunSummary({
        runId: "run-drain",
        auditPath,
        recordPath: path.join(artifactDir, "record-run-drain.json"),
      }),
    );
    await flushAsync();

    await server.service.close(); // 无 running job：立即落定，draining = true
    const res = await fetch(`${server.baseUrl}/v1/jobs/${jobId}/artifacts/audit`, {
      headers: { Authorization: "Bearer tok-platform" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"drain":true}');
  } finally {
    await server.close();
  }
});

test("/rpc 面视图投影：succeeded job 的 get/list 响应携带 auditRef/recordRef，不泄漏服务器路径（ADR-0013 决策 8）", async () => {
  const server = await startTestServer();
  try {
    const jobId = await submitJob(server);
    // 五字段携区分值过 wire（AC5：findings/usage/rounds/toolCalls/truncated）
    const finding: Finding = {
      id: "F-wire-1",
      severity: "P2",
      category: "correctness",
      file: "a.ts",
      line: 3,
      title: "wire test finding: english source passthrough",
      description: "original english finding body (ADR-0010: presentation projection stays out of machine protocol)",
      evidence: ["a.ts:3"],
      rule: "wire-test-rule",
      confidence: 0.9,
    };
    server.executor.executions[0]!.resolve(
      fakeReviewRunSummary({
        runId: "run-rpc-view",
        auditPath: "C:\\secret\\srv\\audit.json",
        recordPath: "C:\\secret\\srv\\record.json",
        findings: [finding],
        usage: { inputTokens: 111, outputTokens: 22 },
        rounds: 7,
        toolCalls: 5,
        truncated: true,
      }),
    );
    await flushAsync();

    const got = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "g", method: "review.get", params: { jobId } },
      { token: "tok-platform" },
    );
    const getResult = ((await got.json()) as { result: { result?: Record<string, unknown> } }).result;
    expect(getResult?.result?.auditRef).toBe("artifact:audit/run-rpc-view");
    expect(getResult?.result?.recordRef).toBe("artifact:record/run-rpc-view");
    expect("auditPath" in (getResult?.result ?? {})).toBe(false);
    expect("recordPath" in (getResult?.result ?? {})).toBe(false);
    // AC5：终态结果五字段显式 wire 断言（findings 英文原始源直通，投影不裁剪）
    expect(getResult?.result?.findings).toEqual([finding]);
    expect(getResult?.result?.usage).toEqual({ inputTokens: 111, outputTokens: 22 });
    expect(getResult?.result?.rounds).toBe(7);
    expect(getResult?.result?.toolCalls).toBe(5);
    expect(getResult?.result?.truncated).toBe(true);

    const listed = await rpcFetch(
      server.baseUrl,
      { jsonrpc: "2.0", id: "l", method: "review.list", params: { status: "succeeded" } },
      { token: "tok-platform" },
    );
    const listBody = (await listed.json()) as { result: { jobs: { result?: Record<string, unknown> }[] } };
    expect(listBody.result.jobs[0]!.result?.auditRef).toBe("artifact:audit/run-rpc-view");
    expect("recordPath" in (listBody.result.jobs[0]!.result ?? {})).toBe(false);
  } finally {
    await server.close();
  }
});
