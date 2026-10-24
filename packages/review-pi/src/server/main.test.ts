import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { FakeReviewRunExecutor } from "../rpc/executor.js";
import type { ReviewerEndpoint } from "../provider/reviewer-endpoint.js";
import { runServerMain } from "./main.js";

// #28 server 进程面测试（#24 rpc/main.test 同构模式）：token 文件 fail fast、
// 注入装配（fake executor + 受控信号面）、onListening 缝、信号 drain 的退出码
// 契约。HTTP wire 契约（信封/状态码/鉴权）在 http-server.test.ts 已锁——这里
// 只测进程装配面。绑定一律 127.0.0.1:0（系统分配端口，测试互不抢）。

/** 注入用假 endpoint（executor 是 fake，永不真调——只满足启动期解析面） */
const FAKE_ENDPOINT: ReviewerEndpoint = { baseUrl: "http://127.0.0.1:9", apiKey: "test-key" };

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

/** 受控信号面（RpcSignalTarget 形状；测试里 emit 模拟信号到达） */
function fakeSignalTarget(): EventEmitter {
  return new EventEmitter();
}

function writeTokens(file: string): void {
  writeFileSync(
    file,
    JSON.stringify({
      tokens: {
        "tok-demo": {
          tenantId: "demo-tenant",
          subject: "demo",
          scopes: ["review:submit", "review:read", "review:cancel"],
        },
      },
    }),
    "utf8",
  );
}

function serverArgs(overrides: Record<string, unknown> = {}): {
  host: string;
  port: number;
  out: string;
  authTokenFile: string;
  concurrency: number;
} {
  return {
    host: "127.0.0.1",
    port: 0,
    out: makeTempDir("review-pi-server-out-"),
    authTokenFile: path.join(makeTempDir("review-pi-server-tokens-"), "tokens.json"),
    concurrency: 1,
    ...overrides,
  };
}

test("缺 token 文件 fail fast：启动前抛人话错误（含路径）", async () => {
  const args = serverArgs();
  await expect(runServerMain(args, { executor: new FakeReviewRunExecutor() })).rejects.toThrow(
    /token file/i,
  );
});

test("token 文件非法内容 fail fast：拒启动不半活", async () => {
  const args = serverArgs();
  writeFileSync(args.authTokenFile, "{ not json", "utf8");
  await expect(runServerMain(args, { executor: new FakeReviewRunExecutor() })).rejects.toThrow(
    /token file/i,
  );
});

test("endpoint 缺 key fail fast：resolveReviewerEndpoint 上抛退 1 面（REVIEWER_* 启动期单次解析）", async () => {
  const args = serverArgs();
  writeTokens(args.authTokenFile);
  const previousUrl = process.env.REVIEWER_URL;
  const previousKey = process.env.REVIEWER_API_KEY;
  delete process.env.REVIEWER_URL;
  delete process.env.REVIEWER_API_KEY;
  try {
    // endpoint 不注入 → 走真装配的 resolveReviewerEndpoint()（缺 key 上抛）
    await expect(runServerMain(args, { executor: new FakeReviewRunExecutor() })).rejects.toThrow(
      /REVIEWER/i,
    );
  } finally {
    if (previousUrl !== undefined) process.env.REVIEWER_URL = previousUrl;
    if (previousKey !== undefined) process.env.REVIEWER_API_KEY = previousKey;
  }
});

test("正常启动：onListening 缝收到真分配端口（bind 0）；ready 面可用", async () => {
  const args = serverArgs();
  writeTokens(args.authTokenFile);
  const signals = fakeSignalTarget();
  const listened: { host: string; port: number }[] = [];
  const executor = new FakeReviewRunExecutor();

  const exited = runServerMain(args, {
    executor,
    endpoint: FAKE_ENDPOINT,
    signals,
    onListening: (address) => listened.push(address),
  });

  // drain 前进程长驻：轮询等 listening 缝（毫秒级；上限 5s 防挂）
  const deadline = Date.now() + 5_000;
  while (listened.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(listened).toHaveLength(1);
  expect(listened[0].host).toBe("127.0.0.1");
  expect(listened[0].port).toBeGreaterThan(0);

  // ready 面经真 HTTP 探测（liveness 匿名 200——wire 契约在 http-server.test 已锁）
  const health = await fetch(`http://127.0.0.1:${listened[0].port}/healthz`);
  expect(health.status).toBe(200);
  // body 必须消费：未读 body 的 keep-alive 连接在 server 视角非 idle，
  // closeIdleConnections 杀不掉、server.close 要等 keep-alive 超时
  expect(await health.json()).toEqual({ status: "ok" });

  signals.emit("SIGTERM");
  expect(await exited).toBe(143);
});

test("SIGINT drain：退出码 130；drain 落定后进程面 resolve", async () => {
  const args = serverArgs();
  writeTokens(args.authTokenFile);
  const signals = fakeSignalTarget();
  const exited = runServerMain(args, {
    executor: new FakeReviewRunExecutor(),
    endpoint: FAKE_ENDPOINT,
    signals,
    onListening: () => undefined,
  });
  signals.emit("SIGINT");
  expect(await exited).toBe(130);
});

test("重复信号：drain 开闸即注销——第二次信号不再改判退出码", async () => {
  const args = serverArgs();
  writeTokens(args.authTokenFile);
  const signals = fakeSignalTarget();
  const exited = runServerMain(args, {
    executor: new FakeReviewRunExecutor(),
    endpoint: FAKE_ENDPOINT,
    signals,
    onListening: () => undefined,
  });
  signals.emit("SIGTERM");
  signals.emit("SIGINT"); // drain 已开闸：不注册即无效果（EventEmitter 面天然如此）
  expect(await exited).toBe(143);
});

test("端口占用：bind 失败异常上抛（cli reportErrorAndExit → 1 面）", async () => {
  // 先占一个端口
  const blocker = await new Promise<{ close(): Promise<void>; port: number }>((resolve) => {
    const server = createServer(() => undefined);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        port,
        close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
  try {
    const args = serverArgs({ port: blocker.port });
    writeTokens(args.authTokenFile);
    await expect(
      runServerMain(args, {
        executor: new FakeReviewRunExecutor(),
        endpoint: FAKE_ENDPOINT,
        signals: fakeSignalTarget(),
        onListening: () => undefined,
      }),
    ).rejects.toThrow(/EADDRINUSE/i);
  } finally {
    await blocker.close();
  }
});
