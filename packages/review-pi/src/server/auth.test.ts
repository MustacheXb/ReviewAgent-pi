import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { REVIEW_SCOPES } from "../rpc/context.js";
import { createTokenFileAuthenticator } from "./auth.js";

// #28 Bearer Authenticator（ADR-0013 决策 5）：token→principal JSON 映射文件、
// 每请求 mtime+size 检测热轮换（不重启）、缺文件/非法内容 fail fast 拒启动、
// scope 值单源 REVIEW_SCOPES。401/403 的 HTTP 映射在 http-server 缝测，本档
// 只测 principal 派生与文件面。

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-auth-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 合法映射文件的最小样例（demo 脚本同款形态） */
function writeTokenFile(file: string, tokens: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify({ tokens }, null, 2), "utf8");
}

const PLATFORM_TOKENS = {
  "tok-platform": {
    tenantId: "platform-x",
    subject: "svc-runner",
    scopes: ["review:submit", "review:read", "review:cancel"],
  },
};

test("缺 token 文件 fail fast：构造即抛人话错误（含路径，不含文件内容）", () => {
  const dir = makeTempDir();
  const missing = path.join(dir, "tokens.json");
  expect(() => createTokenFileAuthenticator({ tokenFile: missing })).toThrow(/token file/i);
});

test("非法 JSON fail fast：构造即抛（消息不含原文内容——文件内容可能是敏感面）", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "tokens.json");
  writeFileSync(file, "{ not json", "utf8");
  expect(() => createTokenFileAuthenticator({ tokenFile: file })).toThrow(/token file/i);
});

test("结构违例 fail fast：顶层缺 tokens / tenantId 空串 / scopes 非数组 / scope 值未知", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "tokens.json");

  // 顶层缺 tokens 外层（直接写裸 principal 映射）
  writeFileSync(file, JSON.stringify({ "tok": { tenantId: "t", subject: "s", scopes: [] } }), "utf8");
  expect(() => createTokenFileAuthenticator({ tokenFile: file })).toThrow(/tokens/i);

  writeTokenFile(file, {
    "tok": { tenantId: "", subject: "s", scopes: ["review:read"] },
  });
  expect(() => createTokenFileAuthenticator({ tokenFile: file })).toThrow(/tenantId/i);

  writeTokenFile(file, {
    "tok": { tenantId: "t", subject: "s", scopes: "review:read" },
  });
  expect(() => createTokenFileAuthenticator({ tokenFile: file })).toThrow(/scopes/i);

  writeTokenFile(file, {
    "tok": { tenantId: "t", subject: "s", scopes: ["review:read", "megazord"] },
  });
  expect(() => createTokenFileAuthenticator({ tokenFile: file })).toThrow(/scope/i);
});

test("空 token 字符串是文件错误：空串 key 拒绝（防 Bearer 空白匹配面）", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "tokens.json");
  writeTokenFile(file, {
    "": { tenantId: "t", subject: "s", scopes: [] },
  });
  expect(() => createTokenFileAuthenticator({ tokenFile: file })).toThrow(/token/i);
});

test("authenticate：无 header / 非 Bearer 形态 / 未知 token → undefined", async () => {
  const dir = makeTempDir();
  const file = path.join(dir, "tokens.json");
  writeTokenFile(file, PLATFORM_TOKENS);
  const auth = createTokenFileAuthenticator({ tokenFile: file });

  expect(await auth.authenticate(undefined)).toBeUndefined();
  expect(await auth.authenticate("Basic dXNlcjpwYXNz")).toBeUndefined();
  expect(await auth.authenticate("Bearer")).toBeUndefined();
  expect(await auth.authenticate("Bearer ")).toBeUndefined();
  expect(await auth.authenticate("Bearer tok-unknown")).toBeUndefined();
});

test("authenticate：Bearer 有效 token → Principal（tenantId/subject/scopes 透传）", async () => {
  const dir = makeTempDir();
  const file = path.join(dir, "tokens.json");
  writeTokenFile(file, PLATFORM_TOKENS);
  const auth = createTokenFileAuthenticator({ tokenFile: file });

  const principal = await auth.authenticate("Bearer tok-platform");
  expect(principal).toEqual({
    tenantId: "platform-x",
    subject: "svc-runner",
    scopes: ["review:submit", "review:read", "review:cancel"],
  });
});

test("authenticate：bearer scheme 大小写不敏感（RFC 7235）", async () => {
  const dir = makeTempDir();
  const file = path.join(dir, "tokens.json");
  writeTokenFile(file, PLATFORM_TOKENS);
  const auth = createTokenFileAuthenticator({ tokenFile: file });

  expect((await auth.authenticate("bearer tok-platform"))?.tenantId).toBe("platform-x");
  expect((await auth.authenticate("BEARER tok-platform"))?.tenantId).toBe("platform-x");
});

test("返回的 Principal 是副本：外部改 scopes 数组不污染内部表", async () => {
  const dir = makeTempDir();
  const file = path.join(dir, "tokens.json");
  writeTokenFile(file, PLATFORM_TOKENS);
  const auth = createTokenFileAuthenticator({ tokenFile: file });

  const first = await auth.authenticate("Bearer tok-platform");
  (first?.scopes as unknown as string[]).push("admin");
  const second = await auth.authenticate("Bearer tok-platform");
  expect(second?.scopes).toEqual(["review:submit", "review:read", "review:cancel"]);
});

test("热轮换：文件内容更新（mtime+size 变化）不重启即生效——新 token 可用、旧 token 失效", async () => {
  const dir = makeTempDir();
  const file = path.join(dir, "tokens.json");
  writeTokenFile(file, PLATFORM_TOKENS);
  const auth = createTokenFileAuthenticator({ tokenFile: file });

  expect((await auth.authenticate("Bearer tok-platform"))?.tenantId).toBe("platform-x");

  // 轮换：换成租户 B 的 token 集；utimes 显式拨新 mtime（避免同毫秒写入 mtime 不变）
  writeTokenFile(file, {
    "tok-tenant-b": { tenantId: "tenant-b", subject: "svc-b", scopes: ["review:read"] },
  });
  utimesSync(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));

  expect(await auth.authenticate("Bearer tok-platform")).toBeUndefined();
  expect((await auth.authenticate("Bearer tok-tenant-b"))?.tenantId).toBe("tenant-b");
});

test("size 变化也触发重读（同 mtime 写入的兜底键）", async () => {
  const dir = makeTempDir();
  const file = path.join(dir, "tokens.json");
  writeTokenFile(file, PLATFORM_TOKENS);
  const fixed = new Date(1_700_000_000_000);
  utimesSync(file, fixed, fixed);
  const auth = createTokenFileAuthenticator({ tokenFile: file });
  expect((await auth.authenticate("Bearer tok-platform"))?.tenantId).toBe("platform-x");

  // 同 mtime、不同 size（内容更短）→ 仍应重读
  writeTokenFile(file, {
    "tok-b": { tenantId: "b", subject: "s", scopes: [] },
  });
  utimesSync(file, fixed, fixed);

  expect(await auth.authenticate("Bearer tok-platform")).toBeUndefined();
  expect((await auth.authenticate("Bearer tok-b"))?.tenantId).toBe("b");
});

test("轮换窗口读失败：保留旧表继续服务 + 诊断缝收到消息", async () => {
  const dir = makeTempDir();
  const file = path.join(dir, "tokens.json");
  writeTokenFile(file, PLATFORM_TOKENS);
  const diagnostics: string[] = [];
  const auth = createTokenFileAuthenticator({
    tokenFile: file,
    onDiagnostic: (message) => diagnostics.push(message),
  });

  // 半写态：写空文件（非法 JSON）+ 拨新 mtime
  writeFileSync(file, "", "utf8");
  utimesSync(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));

  // 旧表仍可用（轮换原子性由运维保证；服务端不因半写文件拒服务）
  expect((await auth.authenticate("Bearer tok-platform"))?.tenantId).toBe("platform-x");
  expect(diagnostics.length).toBe(1);
  expect(diagnostics[0]).toContain("token file");
});

test("全量 scope 集：admin/artifact:read 等五值合法", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "tokens.json");
  writeTokenFile(file, {
    "tok-admin": { tenantId: "ops", subject: "admin-svc", scopes: [...REVIEW_SCOPES] },
  });
  const auth = createTokenFileAuthenticator({ tokenFile: file });
  expect(auth).toBeDefined();
});
