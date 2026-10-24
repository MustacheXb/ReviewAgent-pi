import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 跨 fork 的 dist 产物互斥锁（CI ubuntu 实证竞态修复，#27 收尾）：
 * vitest forks 池并行跑测试文件时，bin.process.test.ts 的 mtime 回拨用例把
 * 共享 `dist/cli/main.js` 拨回 30 天，另一 fork 的 rpc.process.test.ts 恰在
 * 窗口内 spawn 真 bin → 判鲜门拒跑（「源树新于产物」）。本锁让「dist mtime
 * 变更（回拨用例 / 自愈构建）」与「真 bin spawn」显式互斥，不再靠时序运气。
 *
 * 参与方约定（主套件内 spawn 真 bin 或改写 dist 的只有两个进程面文件）：
 * 两个进程测试文件以文件级（beforeAll 取 / afterAll 放）持锁——文件内测试
 * 本就串行，两文件互斥后回拨窗口、自愈重建、真 bin spawn 三者两两不相交。
 * 不可重入：同进程二次获取会等到超时（消费方无嵌套持锁场景，刻意不实现）。
 *
 * 锁文件落在 tmpdir（不进工作树），键含本包目录散列——多 checkout 互不干扰；
 * 内容 = 持有者 pid。陈旧判定（三态）：
 * - 内容可解析为正 pid：持有进程已死（process.kill(pid,0) ESRCH）立即窃取；
 *   存活则锁龄超 15min 才兜底窃取（pid 复用等奇观，合法持有不会这么久）；
 * - 内容不可解析（含 openSync(wx) 到 writeFileSync 之间的空窗）：宽限 5s
 *   后窃取——空窗是毫秒级，宽限量级必须远大于之。
 * 窃取 = unlink 后重走 wx 竞争，输者照常轮询。
 */

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultLockPath = path.join(
  tmpdir(),
  `review-pi-dist-lock-${createHash("sha256").update(packageDir).digest("hex").slice(0, 16)}.lock`,
);

export interface DistArtifactLockOptions {
  /** 等待上限须低于消费文件的 beforeAll 600s 预算（让锁超时报错先于 vitest 泛化超时浮出） */
  readonly timeoutMs?: number;
  /** 锁文件路径覆写（仅测试用——单测须打在临时键上，不与真实持锁方抢道） */
  readonly lockPath?: string;
}

const DEFAULT_TIMEOUT_MS = 570_000;
const POLL_INTERVAL_MS = 50;
/** 空内容宽限：openSync(wx) 到 writeFileSync(pid) 之间有毫秒级空窗，不可误判为可窃取 */
const UNPARSEABLE_GRACE_MS = 5_000;
/** 锁龄兜底：合法持有者不会持锁超过 beforeAll 全预算（含自愈构建） */
const STALE_LOCK_MS = 15 * 60_000;

/** 持有进程是否存活（signal 0 = 存活探测；Windows 上 EPERM 视为存活——保守） */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryAcquire(lockPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch {
    return false;
  }
  try {
    writeFileSync(fd, `${process.pid}`);
  } finally {
    closeSync(fd);
  }
  return true;
}

function stealIfStale(lockPath: string): void {
  let content: string;
  let ageMs: number;
  try {
    content = readFileSync(lockPath, "utf8");
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return; // 竞态中已被他人清理/重写——下轮 wx 自会分胜负
  }
  const pid = Number.parseInt(content, 10);
  const stale = Number.isInteger(pid) && pid > 0
    ? !isPidAlive(pid) || ageMs > STALE_LOCK_MS
    : ageMs > UNPARSEABLE_GRACE_MS;
  if (!stale) {
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // 已被他人抢占——下轮 wx 自会分胜负
  }
}

export type DistArtifactLockRelease = () => void;

/**
 * 取跨 fork dist 产物锁；resolve 值为释放函数。释放只在锁文件仍登记本
 * 进程时 unlink（防误删后继持有者）；测试收尾路径上释放失败不抛。
 */
export async function acquireDistArtifactLock(
  options: DistArtifactLockOptions = {},
): Promise<DistArtifactLockRelease> {
  const lockPath = options.lockPath ?? defaultLockPath;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryAcquire(lockPath)) {
      return () => {
        try {
          if (readFileSync(lockPath, "utf8").trim() === `${process.pid}`) {
            unlinkSync(lockPath);
          }
        } catch {
          // 锁文件已不在（被窃取后清理）——本进程本就不再持有
        }
      };
    }
    stealIfStale(lockPath);
    if (Date.now() > deadline) {
      throw new Error(
        `dist artifact lock timeout after ${timeoutMs}ms — 另一 fork 持锁过久或锁残留：${lockPath}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
