import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTempDirRegistry } from "../testing/temp-dir.js";
import {
  createIdempotencyKeeper,
  createSqliteIdempotencyKeeper,
  fingerprintReviewRequest,
} from "./idempotency.js";

// #28 幂等口径单测（ADR-0013 决策 4）：(tenantId, clientRequestId) 唯一、
// 对比口径 = 执行相关字段内容哈希（归一化 repoPath、解析后 diff 文本、issue
// 文本、configId、modelId；metadata 不参与）、记录保留 7 天。HTTP wire 缝
// （-32016 冲突、重复提交返回既有 job）在 http-server 测试覆盖。
// #30 起幂等记录跨重启持久（sqlite keeper 与 job store 同库）——持久面
// 契约（跨实例可见 / 双清理面 / 覆盖与租户隔离）在文末 sqlite describe。

const tempDirs = createTempDirRegistry();

function makeTempDir(): string {
  return tempDirs.makeTempDir("review-pi-idem-");
}

afterEach(() => {
  tempDirs.removeAll();
});

const BASE_REQUEST = {
  caseId: "MR-1",
  repoPath: "/srv/repos/snapshot-1",
  diff: { kind: "inline", text: "--- a\n+++ b\n" },
  configId: "E",
} as const;

test("lookup 未记录 → undefined；record 后命中（recordedAt = now 锚点）", () => {
  const now = 1_700_000_000_000;
  const keeper = createIdempotencyKeeper({ now: () => now });
  expect(keeper.lookup("tenant-a", "req-1")).toBeUndefined();
  keeper.record("tenant-a", "req-1", "fp-1", "job-1");
  expect(keeper.lookup("tenant-a", "req-1")).toEqual({
    fingerprint: "fp-1",
    jobId: "job-1",
    recordedAt: now,
  });
});

test("tenant 隔离：不同租户同 clientRequestId 互不可见", () => {
  const keeper = createIdempotencyKeeper();
  keeper.record("tenant-a", "req-1", "fp-1", "job-a");
  expect(keeper.lookup("tenant-b", "req-1")).toBeUndefined();
});

test("record 覆盖：同 key 重录以最后一次为准（job 消失后的重提交路径）", () => {
  const keeper = createIdempotencyKeeper();
  keeper.record("tenant-a", "req-1", "fp-1", "job-1");
  keeper.record("tenant-a", "req-1", "fp-1", "job-2");
  expect(keeper.lookup("tenant-a", "req-1")?.jobId).toBe("job-2");
});

test("7 天保留：过期记录 lookup 不可见（惰性清理）", () => {
  let now = 1_700_000_000_000;
  const keeper = createIdempotencyKeeper({ now: () => now });
  keeper.record("tenant-a", "req-1", "fp-1", "job-1");

  now += 6 * 24 * 3600 * 1000;
  expect(keeper.lookup("tenant-a", "req-1")).toBeDefined();

  now += 2 * 24 * 3600 * 1000; // 累计 8 天
  expect(keeper.lookup("tenant-a", "req-1")).toBeUndefined();
});

test("fingerprint：同请求两次一致；metadata 不参与（ADR-0013 决策 4）", async () => {
  const a = await fingerprintReviewRequest({ ...BASE_REQUEST, metadata: { rev: 1 } });
  const b = await fingerprintReviewRequest({ ...BASE_REQUEST, metadata: { rev: 2 } });
  expect(a).toBeTypeOf("string");
  expect(a).toBe(b);
});

test("fingerprint：执行相关字段逐项变化 → 不同（repoPath / diff 文本 / issue / configId / modelId）", async () => {
  const base = await fingerprintReviewRequest({ ...BASE_REQUEST });
  expect(await fingerprintReviewRequest({ ...BASE_REQUEST, repoPath: "/srv/repos/snapshot-2" })).not.toBe(base);
  expect(
    await fingerprintReviewRequest({ ...BASE_REQUEST, diff: { kind: "inline", text: "other" } }),
  ).not.toBe(base);
  expect(
    await fingerprintReviewRequest({ ...BASE_REQUEST, issueDescription: "CVE-1 described" }),
  ).not.toBe(base);
  expect(await fingerprintReviewRequest({ ...BASE_REQUEST, configId: "B" })).not.toBe(base);
  expect(await fingerprintReviewRequest({ ...BASE_REQUEST, modelId: "other-model" })).not.toBe(base);
});

test("fingerprint：caseId 不参与（ADR-0013 决策 4 明文口径——caseId 是审计目录派生，不进执行语义哈希）", async () => {
  const base = await fingerprintReviewRequest({ ...BASE_REQUEST });
  expect(await fingerprintReviewRequest({ ...BASE_REQUEST, caseId: "MR-2" })).toBe(base);
});

test("fingerprint：repoPath 走 resolvePath 归一（尾斜杠 / Windows MSYS 盘符形态同址相同）", async () => {
  const dir = makeTempDir();
  const base = await fingerprintReviewRequest({ ...BASE_REQUEST, repoPath: dir });
  // 尾分隔符形态（跨平台：node path resolve 归一）
  expect(await fingerprintReviewRequest({ ...BASE_REQUEST, repoPath: `${dir}/` })).toBe(base);
  // Windows Git Bash 盘符形态（/c/Users/... → C:\Users\...；normalizePath 面）
  if (process.platform === "win32") {
    const msys = dir
      .replace(/^([A-Za-z]):[\\/]/, (_match, drive: string) => `/${drive.toLowerCase()}/`)
      .replaceAll("\\", "/");
    expect(await fingerprintReviewRequest({ ...BASE_REQUEST, repoPath: msys })).toBe(base);
  }
});

test("fingerprint：diff file 按文件内容（与同文本 inline 相同；不同路径同内容相同；内容变化不同）", async () => {
  const dir = makeTempDir();
  const diffFile = path.join(dir, "mr.diff");
  const otherFile = path.join(dir, "renamed.diff");
  const text = "--- a\n+++ b\n";
  writeFileSync(diffFile, text, "utf8");
  writeFileSync(otherFile, text, "utf8");

  const viaFile = await fingerprintReviewRequest({
    ...BASE_REQUEST,
    diff: { kind: "file", path: diffFile },
  });
  expect(await fingerprintReviewRequest({ ...BASE_REQUEST, diff: { kind: "inline", text } })).toBe(viaFile);
  expect(
    await fingerprintReviewRequest({
      ...BASE_REQUEST,
      diff: { kind: "file", path: otherFile },
    }),
  ).toBe(viaFile);

  writeFileSync(diffFile, `${text}+extra\n`, "utf8");
  expect(
    await fingerprintReviewRequest({
      ...BASE_REQUEST,
      diff: { kind: "file", path: diffFile },
    }),
  ).not.toBe(viaFile);
});

test("fingerprint：可选字段缺席与空串同口径（issueDescription / modelId）", async () => {
  const absent = await fingerprintReviewRequest({ ...BASE_REQUEST });
  expect(await fingerprintReviewRequest({ ...BASE_REQUEST, issueDescription: "" })).toBe(absent);
  expect(await fingerprintReviewRequest({ ...BASE_REQUEST, modelId: "" })).toBe(absent);
});

test("fingerprint：diff file 不可读 → undefined（交由 service 域校验收口，不在此造哈希）", async () => {
  const dir = makeTempDir();
  const missing = path.join(dir, "nope.diff");
  expect(
    await fingerprintReviewRequest({
      ...BASE_REQUEST,
      diff: { kind: "file", path: missing },
    }),
  ).toBeUndefined();
});

// ---- sqlite 持久面（#30：幂等记录跨重启不失忆——重启后同 clientRequestId
// 重放仍返回既有 job，不重复检视）----

describe("sqlite keeper（持久面）", () => {
  test("跨实例持久：record → close → 重开 lookup 命中（与 memory 同记录形态）", () => {
    const dataDir = makeTempDir();
    const now = 1_700_000_000_000;
    const first = createSqliteIdempotencyKeeper({ dataDir, now: () => now });
    first.record("tenant-a", "req-1", "fp-1", "job-1");
    first.close();
    // 「重启」：同 dataDir 新连接——记录必须在
    const second = createSqliteIdempotencyKeeper({ dataDir, now: () => now });
    expect(second.lookup("tenant-a", "req-1")).toEqual({
      fingerprint: "fp-1",
      jobId: "job-1",
      recordedAt: now,
    });
    second.close();
    second.close(); // 幂等
  });

  test("过期行双清理面：构造期清扫 + lookup 惰性清理（7 天窗外视同未记录）", () => {
    const dataDir = makeTempDir();
    let now = 1_700_000_000_000;
    const first = createSqliteIdempotencyKeeper({ dataDir, now: () => now });
    first.record("tenant-a", "req-1", "fp-1", "job-1");
    first.close();

    now += 8 * 24 * 3600 * 1000; // 8 天后「重启」——构造期清扫已把过期行删净
    const second = createSqliteIdempotencyKeeper({ dataDir, now: () => now });
    expect(second.lookup("tenant-a", "req-1")).toBeUndefined();
    second.close();
    // 无人 lookup 的过期行不滞留：三开（窗口推进后）同样查不到
    const third = createSqliteIdempotencyKeeper({ dataDir, now: () => now });
    expect(third.lookup("tenant-a", "req-1")).toBeUndefined();
    third.close();
  });

  test("租户隔离与覆盖语义（与 memory keeper 同契约）", () => {
    const dataDir = makeTempDir();
    const keeper = createSqliteIdempotencyKeeper({ dataDir });
    keeper.record("tenant-a", "req-1", "fp-1", "job-1");
    keeper.record("tenant-a", "req-1", "fp-1", "job-2"); // 覆盖：最后一次为准
    keeper.record("tenant-b", "req-1", "fp-1", "job-b"); // 租户隔离
    expect(keeper.lookup("tenant-a", "req-1")?.jobId).toBe("job-2");
    expect(keeper.lookup("tenant-b", "req-1")?.jobId).toBe("job-b");
    keeper.close();
  });
});
