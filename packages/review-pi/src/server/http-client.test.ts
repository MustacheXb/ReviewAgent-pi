import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import type { RpcServerInfo } from "../rpc/main.js";
import { FakeReviewRunExecutor } from "../rpc/executor.js";
import { createReviewService, type ReviewService } from "../rpc/service.js";
import { createTokenFileAuthenticator } from "./auth.js";
import { HttpRpcResponseError, ReviewHttpClient } from "./http-client.js";
import { HTTP_RPC_FEATURES, createReviewHttpServer } from "./http-server.js";
import { createIdempotencyKeeper } from "./idempotency.js";

// #28 typed ReviewHttpClient 缝测：对真 node:http server（临时端口）走
// capabilities → submit → get/list/cancel 全链路 + 错误异常面。信封 / 状态码 /
// 头的传输层契约在 http-server.test.ts 已锁——这里只测 client 的解包与异常
// 透传语义（demo 脚本同款链路）。

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
          scopes: ["review:submit", "review:read", "review:cancel"],
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

  const service = createReviewService({ executor: new FakeReviewRunExecutor() });
  const serverInfo: RpcServerInfo = {
    protocolVersion: 2,
    serverId: "test-server",
    methods: ["server.capabilities", "review.submit", "review.get", "review.list", "review.cancel"],
    features: HTTP_RPC_FEATURES,
    limits: { maxDiffBytes: service.limits.maxDiffBytes, maxQueueDepth: 100, concurrency: 1 },
  };
  const server = createReviewHttpServer({
    service,
    authenticator: createTokenFileAuthenticator({ tokenFile }),
    idempotency: createIdempotencyKeeper(),
    serverInfo,
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
    close: async () => {
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
