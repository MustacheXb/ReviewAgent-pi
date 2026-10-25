import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkRuntimeArtifacts } from "../../bin/lib/cli-runtime.js";
import { acquireDistArtifactLock, type DistArtifactLockRelease } from "./dist-artifact-lock.js";

/**
 * dist 产物自愈（#31 收拢：此前 bin/rpc/restart 三个进程面测试文件各自内联
 * 同一份 beforeAll）。语义与原内联形态逐字一致：
 * 1. 先取跨 fork dist 产物锁（testing/dist-artifact-lock.ts——与 mtime 回拨
 *    用例 / 并行 fork 的真 bin spawn 互斥）；
 * 2. 判鲜（cli-runtime 腿表真源），新鲜即 no-op；
 * 3. 陈旧腿按依赖序重建：vendored pi 四包（root 脚本按依赖序一次构建）→
 *    review-llm → 本包。
 *
 * CI 有显式 dist 前置构建，本助手通常 no-op；本地源码新于产物时自愈。
 * 返回锁释放函数——消费方文件级 beforeAll 取、afterAll 放（文件内测试本就
 * 串行，文件间经锁互斥）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** 腿间有依赖序（构建命令去重后按此序执行） */
const BUILD_ORDER: readonly string[] = [
  "pnpm build:pi",
  "pnpm --filter review-llm build",
  "pnpm --filter review-pi build",
];

/**
 * 取锁并保证 dist 新鲜；resolve 值为锁释放函数（afterAll 调用）。
 * 判鲜不通过时按腿重建；任一构建失败抛出带命令与输出的错误（先于 vitest
 * 泛化超时浮出——等待上限低于消费方 beforeAll 600s 预算，由锁的超时保证）。
 */
export async function ensureFreshDistArtifacts(): Promise<DistArtifactLockRelease> {
  const release = await acquireDistArtifactLock();
  const check = checkRuntimeArtifacts();
  if (check.ok) {
    return release;
  }
  const staleCommands = new Set(check.refusals.map((refusal) => refusal.buildCommand));
  for (const command of BUILD_ORDER) {
    if (!staleCommands.has(command)) {
      continue;
    }
    const run = spawn(command, {
      cwd: repoRoot,
      shell: true,
      timeout: 480_000,
    });
    // spawn（非 spawnSync）：shell 命令的输出在 close 时落定
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        let stdout = "";
        let stderr = "";
        run.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        run.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        run.on("close", (status) => resolve({ status, stdout, stderr }));
      },
    );
    if (result.status !== 0) {
      throw new Error(`self-heal build failed (${command}, exit ${result.status}):\n${result.stdout}${result.stderr}`);
    }
  }
  return release;
}
