import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { acquireDistArtifactLock } from "./dist-artifact-lock.js";

// dist 产物锁单测：互斥 / 不可重入 / 陈旧窃取三态 / 释放所有权校验。
// 全部打在临时键上（lockPath 覆写）——绝不触碰真实键（真实键由两个进程
// 测试文件在并行 fork 里持有，撞上即假红）。

const tempDirs: string[] = [];

function scratchLockPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-dist-lock-test-"));
  tempDirs.push(dir);
  return path.join(dir, "dist.lock");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("互斥且同进程不可重入：持锁期间二次获取超时，释放后立即可再取", async () => {
  const lockPath = scratchLockPath();
  const release = await acquireDistArtifactLock({ lockPath });
  await expect(acquireDistArtifactLock({ lockPath, timeoutMs: 400 })).rejects.toThrow(
    /dist artifact lock timeout/,
  );
  release();
  // 释放后锁文件应已清除，再取即时成功
  expect(existsSync(lockPath)).toBe(false);
  const reAcquired = await acquireDistArtifactLock({ lockPath, timeoutMs: 2_000 });
  expect(readFileSync(lockPath, "utf8")).toBe(`${process.pid}`);
  reAcquired();
});

test("死 pid 残锁立即窃取：不等空内容宽限，acquire 快速成功", async () => {
  const lockPath = scratchLockPath();
  // 4194303：Windows pid 必为 4 的倍数（奇数不可能存活）；Linux 在默认
  // pid_max 之内但恰好存活概率≈0——三平台确定性足够
  writeFileSync(lockPath, "4194303");
  const release = await acquireDistArtifactLock({ lockPath, timeoutMs: 5_000 });
  expect(readFileSync(lockPath, "utf8")).toBe(`${process.pid}`);
  release();
});

test("不可解析内容宽限：新鲜空锁不被窃取，超龄（mtime 回拨）后被窃取", async () => {
  const lockPath = scratchLockPath();
  writeFileSync(lockPath, "");
  // 新鲜空锁：处于 open→write 空窗等价态，宽限期内不得窃取
  await expect(acquireDistArtifactLock({ lockPath, timeoutMs: 400 })).rejects.toThrow(
    /dist artifact lock timeout/,
  );
  // 回拨锁龄到 6s（> 5s 宽限）→ 下一轮即窃取
  const backdated = new Date(Date.now() - 6_000);
  utimesSync(lockPath, backdated, backdated);
  const release = await acquireDistArtifactLock({ lockPath, timeoutMs: 5_000 });
  expect(readFileSync(lockPath, "utf8")).toBe(`${process.pid}`);
  release();
});

test("释放带所有权校验：锁已易主时 release 不误删新持有者的锁文件", async () => {
  const lockPath = scratchLockPath();
  const release = await acquireDistArtifactLock({ lockPath });
  // 模拟本锁被判陈旧遭窃、后继者已写入自己的 pid
  writeFileSync(lockPath, "4194303");
  release(); // 不得 unlink——文件内容已非本进程
  expect(readFileSync(lockPath, "utf8")).toBe("4194303");
  unlinkSync(lockPath);
});
